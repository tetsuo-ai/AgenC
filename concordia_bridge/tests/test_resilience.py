"""Tests for resilience utilities."""

from __future__ import annotations

import time
import pytest

from concordia_bridge.resilience import (
    retry_with_backoff,
    CircuitBreaker,
)


class TestRetryWithBackoff:
    def test_succeeds_first_try(self) -> None:
        result = retry_with_backoff(lambda: 42)
        assert result == 42

    def test_retries_on_failure(self) -> None:
        attempt = [0]

        def flaky():
            attempt[0] += 1
            if attempt[0] < 3:
                raise ValueError("not yet")
            return "ok"

        result = retry_with_backoff(flaky, max_retries=3, initial_delay_s=0.01)
        assert result == "ok"
        assert attempt[0] == 3

    def test_raises_after_max_retries(self) -> None:
        def always_fail():
            raise RuntimeError("always fails")

        with pytest.raises(RuntimeError, match="always fails"):
            retry_with_backoff(always_fail, max_retries=2, initial_delay_s=0.01)

    def test_calls_on_retry_callback(self) -> None:
        retries = []

        def fail_twice():
            if len(retries) < 2:
                raise ValueError("fail")
            return "ok"

        def on_retry(attempt, exc):
            retries.append((attempt, str(exc)))

        retry_with_backoff(
            fail_twice, max_retries=3, initial_delay_s=0.01, on_retry=on_retry,
        )
        assert len(retries) == 2


class TestCircuitBreaker:
    def test_starts_closed(self) -> None:
        cb = CircuitBreaker()
        assert cb.state == "closed"
        assert not cb.is_open

    def test_opens_after_threshold(self) -> None:
        cb = CircuitBreaker(failure_threshold=3)
        for _ in range(3):
            cb.record_failure()
        assert cb.state == "open"
        assert cb.is_open

    def test_stays_closed_below_threshold(self) -> None:
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "closed"

    def test_resets_on_success(self) -> None:
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        assert cb.state == "closed"

    def test_half_open_after_recovery(self) -> None:
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout_s=0.05)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "open"
        time.sleep(0.06)
        assert cb.state == "half_open"

    def test_call_succeeds_through_breaker(self) -> None:
        cb = CircuitBreaker()
        result = cb.call(lambda: 42)
        assert result == 42

    def test_call_blocked_when_open(self) -> None:
        cb = CircuitBreaker(failure_threshold=1)
        cb.record_failure()
        with pytest.raises(RuntimeError, match="Circuit breaker is open"):
            cb.call(lambda: 42)

    def test_call_records_failure(self) -> None:
        cb = CircuitBreaker(failure_threshold=3)

        def fail():
            raise ValueError("boom")

        with pytest.raises(ValueError):
            cb.call(fail)
        assert cb._failure_count == 1
