"""
q_promise_bridge.py — Registry for in-flight Q-promise continuations.

Mirrors the ``QMemNode`` singly-linked chain defined in
``Q_promise_lib/Q_promises.h``::

    typedef struct QMemNode {
        long              index;
        const char       *payload;
        struct QMemNode  *next;
    } QMemNode;

In the C library a chain is traversed via ``q_then(head, cb)``, invoking a
callback for every node.  Here we model the same lifecycle in pure Python:
each promise starts as ``"pending"`` (``QMemNode.payload == NULL``) and
transitions to ``"resolved"`` once ``resolve()`` is called with a payload.

The ``peek_promise()`` method is a non-destructive status check — the
Python equivalent of walking the chain without modifying it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class _QPromise:
    """One promise entry, mirroring a single QMemNode in the chain.

    Fields:
      - promise_id  → logical identifier (replaces the numeric ``index``)
      - status      → ``"pending"`` | ``"resolved"``  (NULL vs non-NULL payload)
      - payload     → resolved data string, or None while pending
    """

    promise_id: str
    status: str = "pending"  # "pending" | "resolved"
    payload: Optional[str] = None


class QPromiseRegistry:
    """In-process registry of Q-promise continuations.

    Provides the same lifecycle as the C ``QMemNode`` chain:
      - ``register()``      — allocate a new pending node
      - ``resolve()``       — write the payload (analogous to q_then callback)
      - ``peek_promise()``  — read status without consuming the entry

    Multiple sessions share a single registry; the ``promise_id`` is the
    caller's responsibility to namespace (e.g. ``"{session_id}:{key}"``).
    """

    def __init__(self) -> None:
        self._promises: Dict[str, _QPromise] = {}

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def register(self, promise_id: str) -> None:
        """Add a new pending promise (allocate a QMemNode with NULL payload)."""
        self._promises[promise_id] = _QPromise(promise_id=promise_id)

    def resolve(self, promise_id: str, payload: str) -> bool:
        """Mark *promise_id* as resolved with *payload*.

        Mirrors the ``QThenCallback`` being invoked for a node.

        Returns:
            True if the promise existed and was resolved; False if unknown.
        """
        promise = self._promises.get(promise_id)
        if promise is None:
            return False
        promise.status = "resolved"
        promise.payload = payload
        return True

    def peek_promise(
        self, promise_id: str
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """Non-destructive status check.

        Returns:
            (found, status, payload) — ``found`` is False when the promise
            ID is unknown.
        """
        promise = self._promises.get(promise_id)
        if promise is None:
            return False, None, None
        return True, promise.status, promise.payload

    # ------------------------------------------------------------------
    # Introspection helpers
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._promises)

    def __contains__(self, promise_id: object) -> bool:
        return promise_id in self._promises
