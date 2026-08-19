"""Dump buffered DEBUG logs only when an exception occurs.

Pattern (from https://stackoverflow.com/questions/29927293/):
    * The app logs normally at INFO level to its usual output.
    * Every DEBUG record is buffered in memory from the start of the script
      using ``logging.handlers.MemoryHandler``.
    * The buffer is flushed to output ONLY when an ERROR-level record is logged
      (i.e. when something goes wrong), giving you the full DEBUG history that
      led up to the failure.
    * On a clean run the buffer is simply discarded, so DEBUG noise never
      reaches normal output.

Typical usage::

    from debug_logging import setup_debug_dump_logging, dump_on_exception

    log = setup_debug_dump_logging(install_excepthook=True)

    with dump_on_exception():
        run_my_app()

Or, using the plain try/except form from the reference answer::

    log = setup_debug_dump_logging()
    try:
        run_my_app()
    except Exception:
        log.exception("Fatal error - dumping debug history")  # flushes buffer
        raise
"""

from __future__ import annotations

import contextlib
import logging
import logging.handlers
import sys

__all__ = [
    "setup_debug_dump_logging",
    "dump_on_exception",
    "install_dump_excepthook",
    "DumpOnTriggerMemoryHandler",
]

# A capacity large enough that the buffer effectively never trims on its own.
# See ``DumpOnTriggerMemoryHandler`` for what capacity means here. For very
# long-running processes you can pass a smaller ``capacity`` to keep only the
# most recent N records -- see the README for the trade-off.
_EFFECTIVELY_UNBOUNDED = 1_000_000_000


class DumpOnTriggerMemoryHandler(logging.handlers.MemoryHandler):
    """A MemoryHandler that dumps the buffer ONLY on a flush-level record.

    The stock :class:`logging.handlers.MemoryHandler` is not quite enough on its
    own for the "dump only on exception" use case, for two reasons:

    * It flushes (dumps) whenever the buffer reaches ``capacity``. We instead
      want ``capacity`` to *cap memory* by dropping the oldest records, never to
      dump.
    * ``logging.shutdown()`` calls ``flush()`` explicitly on every handler at
      interpreter exit, so even with ``flushOnClose=False`` a clean run would
      dump the whole DEBUG buffer. We make an unconditional ``flush()`` a no-op
      and dump only through the flush-level trigger.
    """

    def shouldFlush(self, record: logging.LogRecord) -> bool:
        # Dump only when a record at/above flushLevel arrives -- never merely
        # because the buffer filled up.
        return record.levelno >= self.flushLevel

    def emit(self, record: logging.LogRecord) -> None:
        self.buffer.append(record)
        # Ring-buffer behaviour: keep at most ``capacity`` recent records.
        if self.capacity and len(self.buffer) > self.capacity:
            del self.buffer[0]
        if self.shouldFlush(record):
            self.dump()

    def dump(self) -> None:
        """Emit every buffered record to the target, then clear the buffer."""
        self.acquire()
        try:
            if self.target is not None:
                for record in self.buffer:
                    self.target.handle(record)
            self.buffer.clear()
        finally:
            self.release()

    def flush(self) -> None:
        # Deliberately a no-op. Dumping happens via dump() on a flush-level
        # record only, so an unconditional flush() -- e.g. from
        # logging.shutdown() -- never leaks the DEBUG buffer on a clean run.
        pass


def setup_debug_dump_logging(
    logger: logging.Logger | None = None,
    *,
    normal_level: int = logging.INFO,
    normal_stream=sys.stdout,
    dump_stream=sys.stderr,
    flush_level: int = logging.ERROR,
    capacity: int = _EFFECTIVELY_UNBOUNDED,
    normal_format: str = "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    dump_format: str = "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    install_excepthook: bool = False,
) -> logging.Logger:
    """Configure ``logger`` (root by default) with the dump-on-exception pattern.

    Two handlers are attached:

    * A normal :class:`~logging.StreamHandler` at ``normal_level`` (INFO by
      default) -- the app's usual output, unchanged.
    * A :class:`DumpOnTriggerMemoryHandler` at DEBUG that buffers *every* record
      and dumps the whole buffer to ``dump_stream`` only when a record at
      ``flush_level`` (ERROR by default) or higher is logged. On a clean run the
      buffer is discarded, so DEBUG detail never reaches output.

    :param logger: logger to configure; ``None`` means the root logger.
    :param install_excepthook: also route unhandled exceptions through the
        logger (see :func:`install_dump_excepthook`) so the buffer is dumped
        even when your code never catches the exception itself.
    :returns: the configured logger.
    """
    log = logger if logger is not None else logging.getLogger()

    # DEBUG so records are actually created and reach the MemoryHandler.
    log.setLevel(logging.DEBUG)

    # 1. Normal output: INFO and above, as the app already does.
    normal_handler = logging.StreamHandler(normal_stream)
    normal_handler.setLevel(normal_level)
    normal_handler.setFormatter(logging.Formatter(normal_format))
    log.addHandler(normal_handler)

    # 2. Where the buffered DEBUG history is written when we dump.
    dump_target = logging.StreamHandler(dump_stream)
    dump_target.setLevel(logging.DEBUG)
    dump_target.setFormatter(logging.Formatter(dump_format))

    # 3. The in-memory buffer. Captures DEBUG and up; dumps to dump_target
    #    only when a >= flush_level record arrives.
    memory_handler = DumpOnTriggerMemoryHandler(
        capacity=capacity,
        flushLevel=flush_level,
        target=dump_target,
        flushOnClose=False,
    )
    memory_handler.setLevel(logging.DEBUG)
    log.addHandler(memory_handler)

    if install_excepthook:
        install_dump_excepthook(log)

    return log


def install_dump_excepthook(logger: logging.Logger | None = None) -> None:
    """Route unhandled exceptions through ``logger.error`` before the process dies.

    Logging the exception at ERROR triggers the MemoryHandler flush, so the full
    DEBUG history is dumped even for exceptions your code never catches.
    ``KeyboardInterrupt`` is left to the default handler so Ctrl-C still works
    normally.
    """
    log = logger if logger is not None else logging.getLogger()
    previous_hook = sys.excepthook

    def _hook(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            previous_hook(exc_type, exc_value, exc_traceback)
            return
        log.error(
            "Unhandled exception - dumping debug history",
            exc_info=(exc_type, exc_value, exc_traceback),
        )
        previous_hook(exc_type, exc_value, exc_traceback)

    sys.excepthook = _hook


@contextlib.contextmanager
def dump_on_exception(
    logger: logging.Logger | None = None,
    message: str = "Exception occurred - dumping debug history",
):
    """Context manager that logs (and thus dumps) on any exception, then re-raises.

    ::

        with dump_on_exception():
            run_my_app()
    """
    log = logger if logger is not None else logging.getLogger()
    try:
        yield
    except Exception:
        log.exception(message)  # ERROR level -> flushes the buffered DEBUG logs
        raise
