"""
server.py — PMLL Memory MCP Server entrypoint.

Exposes five MCP tools for Claude Sonnet/Opus agents:

  init    — Set up the PMLL memory silo and Q-promise chain for a session.
  peek    — Non-destructive context check (core deduplication primitive).
  set     — Store a KV pair in the session's PMLL silo.
  resolve — Resolve a pending Q-promise continuation.
  flush   — Clear all short-term KV slots at agent task completion.

The server is designed as the **3rd initializer** alongside Playwright and
other MCP tools.  Agents call ``init`` once at task start, then use
``peek`` before any expensive MCP tool invocation to avoid redundant calls.

Architecture:
    - KV layer  → ``PMMemoryStore`` (mirrors PMLL.c memory_silo_t)
    - Async layer → ``QPromiseRegistry`` (mirrors Q_promise_lib QMemNode chain)
    - Guard function → ``peek_context()`` (peek.py)

Usage:
    python -m pmll_memory_mcp.server          # stdio transport (default)
    pmll-memory-mcp                           # via installed entry-point

License: MIT
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

from mcp.server.fastmcp import FastMCP

from .kv_store import get_store, drop_store
from .q_promise_bridge import QPromiseRegistry
from .peek import peek_context

# ---------------------------------------------------------------------------
# MCP server instance
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "pmll-memory-mcp",
    instructions=(
        "PMLL Memory MCP — short-term KV context memory and Q-promise "
        "deduplication for Claude agent tasks. "
        "Call `init` once at task start, `peek` before every expensive "
        "MCP tool to check the cache, `set` to populate it, `resolve` to "
        "finalise async promises, and `flush` at task completion."
    ),
)

# Module-level Q-promise registry shared across all sessions.
# Mirrors the global QMemNode chain pool in Q_promise_lib.
_promise_registry = QPromiseRegistry()

# Track which sessions have been initialised (session_id → silo_size).
_active_sessions: Dict[str, int] = {}


# ---------------------------------------------------------------------------
# Tool: init
# ---------------------------------------------------------------------------
@mcp.tool()
def init(session_id: str, silo_size: int = 256) -> Dict[str, Any]:
    """Initialise the PMLL memory silo for an agent session.

    Call this **once** at the start of every agent task, as the 3rd
    initializer alongside Playwright.  Sets up the KV silo and prepares
    the Q-promise chain for the session.

    Args:
        session_id: Unique identifier for this agent task (e.g. a UUID).
        silo_size:  Maximum number of KV slots (mirrors memory_silo_t.size).

    Returns:
        ``{"status": "initialized", "session_id": str, "silo_size": int}``
    """
    # Lazily create the store; also resets an existing session's silo.
    store = get_store(session_id, silo_size=silo_size)
    store.silo_size = silo_size
    _active_sessions[session_id] = silo_size
    return {"status": "initialized", "session_id": session_id, "silo_size": silo_size}


# ---------------------------------------------------------------------------
# Tool: peek
# ---------------------------------------------------------------------------
@mcp.tool()
def peek(session_id: str, key: str) -> Dict[str, Any]:
    """Non-destructive context check — the core deduplication primitive.

    Call this **before** any Playwright or other MCP tool invocation to
    check whether the required context already exists in the PMLL silo or
    is in-flight as a Q-promise.

    Args:
        session_id: The session identifier (from ``init``).
        key:        The context key to look up.

    Returns:
        ``{"hit": True, "value": str, "index": int}``        — KV cache hit
        ``{"hit": True, "status": "pending", "promise_id": str}`` — in-flight
        ``{"hit": False}``                                    — full miss
    """
    store = get_store(session_id)
    return peek_context(key, session_id, store, _promise_registry)


# ---------------------------------------------------------------------------
# Tool: set
# ---------------------------------------------------------------------------
@mcp.tool()
def set(session_id: str, key: str, value: str) -> Dict[str, Any]:
    """Store a KV pair in the session's PMLL memory silo.

    Call after a successful (non-cached) MCP tool invocation to populate
    the silo so future ``peek`` calls return a cache hit.

    Mirrors PMLL.c::update_silo() writing a var/value pair into the silo.

    Args:
        session_id: The session identifier (from ``init``).
        key:        The context key.
        value:      The string value to cache.

    Returns:
        ``{"status": "stored", "index": int}``
    """
    store = get_store(session_id)
    index = store.set(key, value)
    return {"status": "stored", "index": index}


# ---------------------------------------------------------------------------
# Tool: resolve
# ---------------------------------------------------------------------------
@mcp.tool()
def resolve(session_id: str, promise_id: str) -> Dict[str, Any]:
    """Check or resolve a Q-promise continuation.

    Mirrors the ``QThenCallback`` mechanism in Q_promise_lib/Q_promises.h —
    the callback is invoked when a QMemNode's payload becomes available.

    If the promise is already resolved, returns its payload immediately.
    If still pending, returns ``{"status": "pending", "payload": null}``.

    Args:
        session_id:  The session identifier (for context; not used to
                     namespace promises in this implementation).
        promise_id:  The promise identifier previously registered.

    Returns:
        ``{"status": "resolved" | "pending", "payload": str | null}``
    """
    found, status, payload = _promise_registry.peek_promise(promise_id)
    if not found:
        return {"status": "pending", "payload": None}
    return {"status": status, "payload": payload}


# ---------------------------------------------------------------------------
# Tool: flush
# ---------------------------------------------------------------------------
@mcp.tool()
def flush(session_id: str) -> Dict[str, Any]:
    """Clear all short-term KV slots for a session.

    Call at agent task completion to free memory.  Mirrors the teardown
    of a memory_silo_t allocation (PMLL.c::free_pml).

    Args:
        session_id: The session identifier (from ``init``).

    Returns:
        ``{"status": "flushed", "cleared_count": int}``
    """
    cleared = drop_store(session_id)
    _active_sessions.pop(session_id, None)
    return {"status": "flushed", "cleared_count": cleared}


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
def main() -> None:
    """Run the MCP server over stdio (default transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
