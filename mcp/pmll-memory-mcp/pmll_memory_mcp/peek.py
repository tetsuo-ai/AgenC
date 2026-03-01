"""
peek.py — Main guard function for MCP context deduplication.

``peek_context()`` is the primary primitive that agents call **before**
any expensive MCP tool invocation (e.g. a Playwright navigation or a
remote API call).  It checks two layers:

1. The in-process KV store (``PMMemoryStore``) — analogous to reading the
   PMLL memory silo (PMLL.c::init_silo / update_silo) for a cached result.
2. The Q-promise registry (``QPromiseRegistry``) — analogous to checking
   whether a ``QMemNode`` chain is still in-flight (Q_promise_lib pending).

If both layers miss, the caller is expected to proceed with the real tool
call and then invoke ``store.set(key, value)`` to populate the cache for
future agents.
"""

from __future__ import annotations

from typing import Any, Dict

from .kv_store import PMMemoryStore
from .q_promise_bridge import QPromiseRegistry


def peek_context(
    key: str,
    session_id: str,
    store: PMMemoryStore,
    promise_registry: QPromiseRegistry,
) -> Dict[str, Any]:
    """Check whether *key* is already resolved for *session_id*.

    The function implements a two-stage guard:

    Stage 1 — KV store hit (PMLL silo cache):
        If the key exists and is resolved, return the cached value
        immediately.  This eliminates the need to re-invoke the
        corresponding MCP tool entirely.

    Stage 2 — Q-promise pending check:
        If the key is registered as an in-flight promise, return a
        ``pending`` indicator so the caller can await resolution rather
        than launching a duplicate tool call.

    Stage 3 — Full miss:
        Neither layer has seen this key.  The caller should proceed with
        the real MCP tool call and then call ``store.set(key, value)``
        to populate the cache.

    Args:
        key:              The context key to look up (e.g. a URL, task ID).
        session_id:       Identifies the current agent session (for logging).
        store:            The session's ``PMMemoryStore`` instance.
        promise_registry: Shared ``QPromiseRegistry`` instance.

    Returns:
        One of:
          - ``{"hit": True, "value": str, "index": int}``                   — KV hit
          - ``{"hit": True, "status": "pending", "promise_id": str}``        — in-flight
          - ``{"hit": False}``                                                — full miss
    """
    # Stage 1: KV store check (PMLL silo read)
    hit, value, index = store.peek(key)
    if hit:
        return {"hit": True, "value": value, "index": index}

    # Stage 2: Q-promise in-flight check
    found, status, _payload = promise_registry.peek_promise(key)
    if found and status == "pending":
        return {"hit": True, "status": "pending", "promise_id": key}

    # Stage 3: Full miss — caller proceeds with the actual tool call
    return {"hit": False}
