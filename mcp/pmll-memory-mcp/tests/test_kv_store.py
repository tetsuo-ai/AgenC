"""Tests for PMMemoryStore (kv_store.py)."""

from pmll_memory_mcp.kv_store import PMMemoryStore, get_store, drop_store, _session_stores


class TestPMMemoryStore:
    """Unit tests for the per-session KV store."""

    def test_set_and_peek(self) -> None:
        store = PMMemoryStore()
        idx = store.set("url:example.com", "page content")
        assert idx == 0

        hit, value, index = store.peek("url:example.com")
        assert hit is True
        assert value == "page content"
        assert index == 0

    def test_peek_miss(self) -> None:
        store = PMMemoryStore()
        hit, value, index = store.peek("nonexistent")
        assert hit is False
        assert value is None
        assert index is None

    def test_set_overwrites_existing(self) -> None:
        store = PMMemoryStore()
        store.set("key", "v1")
        store.set("key", "v2")

        hit, value, index = store.peek("key")
        assert hit is True
        assert value == "v2"
        assert index == 0  # index unchanged on overwrite

    def test_multiple_keys(self) -> None:
        store = PMMemoryStore()
        store.set("a", "1")
        store.set("b", "2")
        store.set("c", "3")

        assert len(store) == 3
        assert "a" in store
        assert "b" in store
        assert "c" in store

    def test_flush(self) -> None:
        store = PMMemoryStore()
        store.set("a", "1")
        store.set("b", "2")
        cleared = store.flush()

        assert cleared == 2
        assert len(store) == 0
        hit, _, _ = store.peek("a")
        assert hit is False

    def test_silo_size(self) -> None:
        store = PMMemoryStore(silo_size=128)
        assert store.silo_size == 128


class TestSessionRegistry:
    """Tests for the module-level session store registry."""

    def setup_method(self) -> None:
        _session_stores.clear()

    def test_get_store_creates_new(self) -> None:
        store = get_store("session-1")
        assert isinstance(store, PMMemoryStore)

    def test_get_store_returns_same(self) -> None:
        s1 = get_store("session-1")
        s2 = get_store("session-1")
        assert s1 is s2

    def test_drop_store(self) -> None:
        store = get_store("session-1")
        store.set("x", "y")
        cleared = drop_store("session-1")
        assert cleared == 1

    def test_drop_nonexistent(self) -> None:
        cleared = drop_store("missing")
        assert cleared == 0
