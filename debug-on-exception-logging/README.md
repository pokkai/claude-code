# Dump debug logs on exception

Keep your normal output clean at **INFO** level, but capture every **DEBUG**
line from the start of the script in memory — and dump that full history *only
if an exception occurs*. This gives you rich post-mortem context for failures
without drowning normal runs in debug noise.

Based on the pattern in
[this StackOverflow answer](https://stackoverflow.com/questions/29927293/dump-debug-logs-if-exception-occured),
using Python's `logging.handlers.MemoryHandler`.

## How it works

- Your logger is set to `DEBUG` so DEBUG records are actually created.
- A normal `StreamHandler` at `INFO` writes the usual output (unchanged).
- A memory-buffering handler captures **every** record (DEBUG and up) from the
  start of the script.
- The buffer is dumped to output **only** when a record at `ERROR` (the flush
  level) or higher is logged — i.e. when something goes wrong.
- On a clean run the buffer is simply discarded: no DEBUG ever reaches output.

### Why a custom `MemoryHandler`?

The stock `MemoryHandler` needs two tweaks for this use case, both handled by
`DumpOnTriggerMemoryHandler` in `debug_logging.py`:

1. It flushes (dumps) whenever the buffer hits `capacity`. We want `capacity` to
   *cap memory* by dropping the oldest records — never to dump. So dumping is
   tied strictly to the flush level.
2. `logging.shutdown()` calls `flush()` on every handler at interpreter exit, so
   even with `flushOnClose=False` a **clean** run would leak the whole DEBUG
   buffer. We make an unconditional `flush()` a no-op; dumping happens only via
   the flush-level trigger.

## Quick start

Drop `debug_logging.py` next to your code and:

```python
from debug_logging import setup_debug_dump_logging, dump_on_exception

log = setup_debug_dump_logging(install_excepthook=True)

with dump_on_exception():
    run_my_app()
```

Or use the plain try/except form from the reference answer:

```python
import logging
from debug_logging import setup_debug_dump_logging

setup_debug_dump_logging()
log = logging.getLogger(__name__)

try:
    run_my_app()
except Exception:
    log.exception("Fatal error - dumping debug history")  # flushes the buffer
    raise
```

Any of these will flush the buffer, because they all log at `ERROR`:

- `logging.getLogger(...).exception(...)` or `.error(...)` in an `except` block.
- The `dump_on_exception()` context manager (logs and re-raises).
- An unhandled exception, if you passed `install_excepthook=True` (routes it
  through the logger before the process dies; `KeyboardInterrupt` is left alone).

## Try the demo

```console
$ python3 demo.py            # forces an exception -> DEBUG history is dumped
$ python3 demo.py --no-fail  # clean run -> only INFO, no DEBUG dump
```

On the failing run you'll see the normal INFO lines, then the full DEBUG backlog
(everything since start) plus the traceback. On the clean run only INFO appears.

## Options

`setup_debug_dump_logging()` accepts:

| Argument             | Default            | Purpose                                                        |
|----------------------|--------------------|----------------------------------------------------------------|
| `logger`             | root logger        | Which logger to configure.                                     |
| `normal_level`       | `logging.INFO`     | Level for the normal (always-on) output handler.               |
| `normal_stream`      | `sys.stdout`       | Where normal output goes.                                      |
| `dump_stream`        | `sys.stderr`       | Where the buffered DEBUG history is dumped on error.           |
| `flush_level`        | `logging.ERROR`    | Log level that triggers the dump.                              |
| `capacity`           | effectively ∞      | Max records kept in the buffer (oldest dropped past this).     |
| `normal_format`      | asctime/level/name | Formatter for normal output.                                   |
| `dump_format`        | asctime/level/name | Formatter for the dumped history.                              |
| `install_excepthook` | `False`            | Also dump on **unhandled** exceptions via `sys.excepthook`.    |

## Memory trade-off

By default the buffer holds **all** records for the life of the process, which
is fine for scripts and short-lived jobs. For a long-running service, pass a
bounded `capacity` (e.g. `capacity=5000`) so the handler keeps only the most
recent N records and drops the oldest — you still get the recent context leading
up to a failure, without unbounded memory growth.
