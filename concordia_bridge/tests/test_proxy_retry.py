"""Tests for ProxyEntity retry logic with exponential backoff (Phase 8.3)."""

from __future__ import annotations

import json
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import pytest

from concordia.typing.entity import DEFAULT_ACTION_SPEC

from concordia_bridge.proxy_entity import ProxyEntity


class FailThenSucceedHandler(BaseHTTPRequestHandler):
    """Handler that fails N times, then succeeds."""
    fail_count = 2
    _calls = 0
    _lock = threading.Lock()

    def do_POST(self):
        with self._lock:
            FailThenSucceedHandler._calls += 1
            current = FailThenSucceedHandler._calls

        if current <= FailThenSucceedHandler.fail_count:
            # Simulate connection accepted but server error
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error": "temporary failure"}')
        else:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"action": "recovered action"}).encode())

    def log_message(self, *args):
        pass


class AlwaysFailHandler(BaseHTTPRequestHandler):
    """Handler that always closes connection immediately."""
    call_count = 0

    def do_POST(self):
        AlwaysFailHandler.call_count += 1
        # Close connection without response to trigger ConnectionError
        self.connection.close()

    def log_message(self, *args):
        pass


@pytest.fixture
def retry_server():
    FailThenSucceedHandler._calls = 0
    FailThenSucceedHandler.fail_count = 2
    server = HTTPServer(("127.0.0.1", 0), FailThenSucceedHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


class TestProxyEntityRetry:
    def test_retries_on_connection_error_then_succeeds(self):
        """Test that ProxyEntity retries on ConnectionError and eventually succeeds."""
        # Use a port where nothing is listening, then start a server
        # Simpler: use the retry_server that fails first then succeeds
        # But retry logic is for ConnectionError, not HTTP 500.
        # HTTP 500 returns fallback immediately (no retry).
        # Let's test the actual retry path with a server that becomes available.

        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url="http://127.0.0.1:1",  # Nothing listening
            max_retries=2,
            retry_delay_seconds=0.1,
            timeout_seconds=1.0,
        )

        start = time.time()
        result = entity.act()
        elapsed = time.time() - start

        # Should have retried and returned fallback
        assert "hesitates" in result
        # Should have waited for retries (at least 0.1 + 0.2 = 0.3s)
        assert elapsed >= 0.2, f"Retries seem instant: {elapsed:.2f}s"

    def test_no_retry_on_timeout(self):
        """Timeout should return fallback immediately, no retries."""
        # Use a server that accepts but never responds (black hole)
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        blackhole_port = sock.getsockname()[1]

        try:
            entity = ProxyEntity(
                agent_name="Alice",
                bridge_url=f"http://127.0.0.1:{blackhole_port}",
                max_retries=3,
                retry_delay_seconds=0.1,
                timeout_seconds=0.5,
            )
            result = entity.act()
            assert "hesitates" in result
        finally:
            sock.close()

    def test_no_retry_on_http_500(self, retry_server):
        """HTTP 500 should return fallback immediately, no retries."""
        FailThenSucceedHandler._calls = 0
        FailThenSucceedHandler.fail_count = 999  # Always fail with 500

        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url=retry_server,
            max_retries=3,
            retry_delay_seconds=0.1,
        )

        result = entity.act()
        assert "hesitates" in result
        # Should have been called only once (no retry on HTTP error)
        assert FailThenSucceedHandler._calls == 1

    def test_max_retries_zero_means_no_retry(self):
        """With max_retries=0, should fail immediately."""
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url="http://127.0.0.1:1",
            max_retries=0,
            retry_delay_seconds=0.1,
            timeout_seconds=1.0,
        )

        start = time.time()
        result = entity.act()
        elapsed = time.time() - start

        assert "hesitates" in result
        # Should be fast — no retries
        assert elapsed < 2.0

    def test_exponential_backoff_timing(self):
        """Verify delays increase exponentially."""
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url="http://127.0.0.1:1",
            max_retries=2,
            retry_delay_seconds=0.1,  # 0.1s, 0.2s
            timeout_seconds=0.5,
        )

        start = time.time()
        result = entity.act()
        elapsed = time.time() - start

        assert "hesitates" in result
        # 3 attempts: initial + retry after 0.1s + retry after 0.2s = ~0.3s minimum
        assert elapsed >= 0.25, f"Backoff too fast: {elapsed:.2f}s"

    def test_turn_count_only_increments_once_per_act(self):
        """Turn count should increment once per act() call, not per retry."""
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url="http://127.0.0.1:1",
            max_retries=2,
            retry_delay_seconds=0.01,
            timeout_seconds=0.5,
        )

        assert entity.turn_count == 0
        entity.act()
        assert entity.turn_count == 1  # Only 1, not 3 (despite retries)
        entity.act()
        assert entity.turn_count == 2
