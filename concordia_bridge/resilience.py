"""
Resilience utilities for the Concordia bridge.

Provides retry logic, health checks, and circuit breaker patterns
for the ProxyEntity ↔ Bridge communication.

Phase 8 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import logging
import time
from typing import Callable, Optional, TypeVar

import requests

logger = logging.getLogger(__name__)

T = TypeVar("T")


def retry_with_backoff(
    fn: Callable[[], T],
    max_retries: int = 3,
    initial_delay_s: float = 1.0,
    max_delay_s: float = 30.0,
    backoff_factor: float = 2.0,
    on_retry: Optional[Callable[[int, Exception], None]] = None,
) -> T:
    """Retry a function with exponential backoff.

    Returns the function result on success.
    Raises the last exception after all retries are exhausted.
    """
    delay = initial_delay_s
    last_exc: Optional[Exception] = None

    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if attempt >= max_retries:
                break
            if on_retry:
                on_retry(attempt + 1, exc)
            logger.debug(
                "Retry %d/%d after %.1fs: %s",
                attempt + 1, max_retries, delay, exc,
            )
            time.sleep(delay)
            delay = min(delay * backoff_factor, max_delay_s)

    raise last_exc  # type: ignore[misc]


def check_bridge_health(
    bridge_url: str,
    timeout_s: float = 5.0,
) -> dict:
    """Check bridge server health. Returns status dict or raises."""
    response = requests.get(f"{bridge_url}/health", timeout=timeout_s)
    response.raise_for_status()
    return response.json()


def wait_for_bridge(
    bridge_url: str,
    max_wait_s: float = 60.0,
    poll_interval_s: float = 2.0,
) -> bool:
    """Wait for the bridge server to become healthy.

    Returns True if healthy within timeout, False otherwise.
    """
    start = time.time()
    while time.time() - start < max_wait_s:
        try:
            health = check_bridge_health(bridge_url, timeout_s=poll_interval_s)
            if health.get("status") == "ok":
                logger.info("Bridge server is healthy")
                return True
        except Exception:
            pass
        time.sleep(poll_interval_s)

    logger.warning("Bridge server not healthy after %.0fs", max_wait_s)
    return False


class CircuitBreaker:
    """Simple circuit breaker for bridge communication.

    After `failure_threshold` consecutive failures, the breaker opens
    and short-circuits calls for `recovery_timeout_s` seconds before
    allowing a probe call.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout_s: float = 30.0,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self._failure_count = 0
        self._last_failure_time: float = 0
        self._state: str = "closed"  # closed, open, half_open

    @property
    def state(self) -> str:
        if self._state == "open":
            if time.time() - self._last_failure_time >= self.recovery_timeout_s:
                self._state = "half_open"
        return self._state

    def record_success(self) -> None:
        self._failure_count = 0
        self._state = "closed"

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.time()
        if self._failure_count >= self.failure_threshold:
            self._state = "open"
            logger.warning(
                "Circuit breaker OPEN after %d failures", self._failure_count,
            )

    @property
    def is_open(self) -> bool:
        return self.state == "open"

    def call(self, fn: Callable[[], T]) -> T:
        """Execute fn through the circuit breaker.

        Raises RuntimeError if the breaker is open.
        """
        if self.state == "open":
            raise RuntimeError("Circuit breaker is open — call blocked")

        try:
            result = fn()
            self.record_success()
            return result
        except Exception as exc:
            self.record_failure()
            raise exc
