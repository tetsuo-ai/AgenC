"""Tests for peek_context (peek.py)."""

from pmll_memory_mcp.kv_store import PMMemoryStore
from pmll_memory_mcp.q_promise_bridge import QPromiseRegistry
from pmll_memory_mcp.peek import peek_context


class TestPeekContext:
    """Unit tests for the peek_context guard function."""

    def test_kv_hit(self) -> None:
        store = PMMemoryStore()
        store.set("https://example.com", "page html")
        registry = QPromiseRegistry()

        result = peek_context("https://example.com", "s1", store, registry)
        assert result["hit"] is True
        assert result["value"] == "page html"
        assert result["index"] == 0

    def test_promise_pending(self) -> None:
        store = PMMemoryStore()
        registry = QPromiseRegistry()
        registry.register("https://example.com")

        result = peek_context("https://example.com", "s1", store, registry)
        assert result["hit"] is True
        assert result["status"] == "pending"
        assert result["promise_id"] == "https://example.com"

    def test_full_miss(self) -> None:
        store = PMMemoryStore()
        registry = QPromiseRegistry()

        result = peek_context("https://example.com", "s1", store, registry)
        assert result["hit"] is False

    def test_kv_takes_priority_over_promise(self) -> None:
        store = PMMemoryStore()
        store.set("key", "cached")
        registry = QPromiseRegistry()
        registry.register("key")

        result = peek_context("key", "s1", store, registry)
        assert result["hit"] is True
        assert result["value"] == "cached"
