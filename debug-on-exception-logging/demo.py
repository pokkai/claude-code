#!/usr/bin/env python3
"""Runnable demo of the dump-on-exception logging pattern.

Run it two ways:

    python3 demo.py            # forces an exception -> DEBUG history is dumped
    python3 demo.py --no-fail  # clean run -> NO DEBUG output at all

On the failing run you'll see the normal INFO output on stdout, then the full
DEBUG backlog (everything since start of script) plus the traceback on stderr.
On the clean run only the INFO lines appear -- the DEBUG buffer is discarded.
"""

import logging
import sys

from debug_logging import dump_on_exception, setup_debug_dump_logging

log = logging.getLogger("demo")


def do_work(should_fail: bool) -> None:
    log.info("Starting work")
    log.debug("Loaded config: %s", {"retries": 3, "timeout": 30})

    for i in range(3):
        log.debug("Processing item %d", i)
        log.info("Handled item %d", i)

    log.debug("Reticulating splines...")
    log.debug("Cache state: %s", {"hits": 42, "misses": 7})

    if should_fail:
        log.debug("About to do the risky thing with a bad value")
        risky_value = 1 / 0  # noqa: F841  -> ZeroDivisionError

    log.info("Work finished cleanly")


def main() -> int:
    should_fail = "--no-fail" not in sys.argv

    # Configure the whole logging system with the pattern.
    setup_debug_dump_logging(install_excepthook=False)

    if should_fail:
        # The reference pattern: an exception inside the block logs at ERROR,
        # which flushes the buffered DEBUG history, then re-raises.
        try:
            with dump_on_exception():
                do_work(should_fail=True)
        except ZeroDivisionError:
            # Swallow here just so the demo exits 0 after showing the dump.
            print(
                "\n(demo) ^^ Above is the dumped DEBUG history + traceback.",
                file=sys.stderr,
            )
            return 0
    else:
        do_work(should_fail=False)
        print("\n(demo) Clean run: notice there was NO DEBUG output above.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
