"""Parent-death guard for Concordia runner processes."""

from __future__ import annotations

from collections.abc import Callable
import ctypes
import logging
import os
import signal
import sys
import threading
import time

logger = logging.getLogger(__name__)

_PARENT_POLL_INTERVAL_SECONDS = 1.0
_PR_SET_PDEATHSIG = 1


def resolve_expected_parent_pid(raw_pid: str | None = None) -> int | None:
    """Return the current parent PID when it is meaningful to watch."""
    candidate = raw_pid
    if candidate is not None:
        try:
            pid = int(candidate)
        except (TypeError, ValueError):
            return None
        return pid if pid > 1 else None

    parent_pid = os.getppid()
    return parent_pid if parent_pid > 1 else None


def parent_process_exists(parent_pid: int) -> bool:
    try:
        os.kill(parent_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def should_terminate_for_parent_exit(
    expected_parent_pid: int | None,
    current_parent_pid: int,
    parent_exists: bool,
) -> bool:
    if expected_parent_pid is None:
        return current_parent_pid in (0, 1)
    if current_parent_pid == expected_parent_pid and parent_exists:
        return False
    if current_parent_pid in (0, 1):
        return True
    return (not parent_exists) or current_parent_pid != expected_parent_pid


def _terminate_current_process() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


def _install_linux_parent_death_signal() -> bool:
    if not sys.platform.startswith("linux"):
        return False

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        result = libc.prctl(_PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to install Linux parent-death signal: %s", exc)
        return False

    if result != 0:
        errno = ctypes.get_errno()
        logger.warning(
            "Failed to install Linux parent-death signal: errno=%s",
            errno,
        )
        return False

    return True


def _watch_parent_process(
    expected_parent_pid: int,
    on_parent_exit: Callable[[], None],
    poll_interval_seconds: float,
) -> None:
    while True:
        time.sleep(poll_interval_seconds)
        current_parent_pid = os.getppid()
        if should_terminate_for_parent_exit(
            expected_parent_pid,
            current_parent_pid,
            parent_process_exists(expected_parent_pid),
        ):
            logger.warning(
                "Parent process exited; terminating Concordia runner "
                "(expected_parent_pid=%s current_parent_pid=%s)",
                expected_parent_pid,
                current_parent_pid,
            )
            on_parent_exit()
            return


def install_parent_death_guard(
    *,
    raw_parent_pid: str | None = None,
    on_parent_exit: Callable[[], None] | None = None,
    poll_interval_seconds: float = _PARENT_POLL_INTERVAL_SECONDS,
) -> int | None:
    """Terminate the runner if its parent daemon dies unexpectedly."""
    expected_parent_pid = resolve_expected_parent_pid(raw_parent_pid)
    if expected_parent_pid is None:
        return None

    terminator = on_parent_exit or _terminate_current_process
    _install_linux_parent_death_signal()

    current_parent_pid = os.getppid()
    if should_terminate_for_parent_exit(
        expected_parent_pid,
        current_parent_pid,
        parent_process_exists(expected_parent_pid),
    ):
        logger.warning(
            "Parent process already exited before guard activation "
            "(expected_parent_pid=%s current_parent_pid=%s)",
            expected_parent_pid,
            current_parent_pid,
        )
        terminator()
        return expected_parent_pid

    watcher = threading.Thread(
        target=_watch_parent_process,
        args=(expected_parent_pid, terminator, poll_interval_seconds),
        name="concordia-parent-death",
        daemon=True,
    )
    watcher.start()
    return expected_parent_pid
