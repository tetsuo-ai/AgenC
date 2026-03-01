"""Tests for QPromiseRegistry (q_promise_bridge.py)."""

from pmll_memory_mcp.q_promise_bridge import QPromiseRegistry


class TestQPromiseRegistry:
    """Unit tests for the Q-promise continuation registry."""

    def test_register_and_peek(self) -> None:
        reg = QPromiseRegistry()
        reg.register("p1")

        found, status, payload = reg.peek_promise("p1")
        assert found is True
        assert status == "pending"
        assert payload is None

    def test_resolve(self) -> None:
        reg = QPromiseRegistry()
        reg.register("p1")
        resolved = reg.resolve("p1", "result data")

        assert resolved is True
        found, status, payload = reg.peek_promise("p1")
        assert status == "resolved"
        assert payload == "result data"

    def test_resolve_unknown(self) -> None:
        reg = QPromiseRegistry()
        assert reg.resolve("unknown", "data") is False

    def test_peek_unknown(self) -> None:
        reg = QPromiseRegistry()
        found, status, payload = reg.peek_promise("missing")
        assert found is False
        assert status is None
        assert payload is None

    def test_len_and_contains(self) -> None:
        reg = QPromiseRegistry()
        reg.register("a")
        reg.register("b")

        assert len(reg) == 2
        assert "a" in reg
        assert "c" not in reg
