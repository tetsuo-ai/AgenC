"""
kv_store.py — In-process KV slot manager mirroring PMLL memory_silo_t semantics.

This module provides a pure-Python KV store whose slot structure mirrors the
``memory_silo_t`` type defined in PMLL.h::

    typedef struct {
        int *tree;
        int  size;
    } memory_silo_t;

Each KV slot tracks an index (position in the silo), the string key, the
string value, and a ``resolved`` flag — analogous to ``init_silo()``
allocating slots and ``update_silo()`` writing values into them
(PMLL.c::init_silo / PMLL.c::update_silo).

Session isolation is achieved by keying stores on ``session_id``, so
parallel agent tasks cannot interfere with each other.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple


@dataclass
class _KVSlot:
    """A single KV slot, mirroring one entry in memory_silo_t.

    Fields parallel PMLL.c::update_silo(silo, var, value, depth):
      - index    → position in the silo tree array
      - key      → symbolic variable name
      - value    → stored value string
      - resolved → True once a value has been committed (update_silo called)
    """

    index: int
    key: str
    value: str
    resolved: bool = True


class PMMemoryStore:
    """Per-session KV store mirroring PMLL memory_silo_t.

    Mirrors the C-level silo initialised by ``PMLL.c::init_silo()`` and
    written to by ``PMLL.c::update_silo()``.  This pure-Python
    implementation keeps the same conceptual slot structure while
    remaining dependency-free at runtime (no C compilation required).

    Each instance represents one session's isolated memory silo.
    A module-level registry keyed by ``session_id`` is maintained by the
    server layer.
    """

    def __init__(self, silo_size: int = 256) -> None:
        # Maps key → _KVSlot; order of insertion gives the slot index.
        # Mirrors the tree array in memory_silo_t (PMLL.h).
        self._slots: Dict[str, _KVSlot] = {}
        self.silo_size = silo_size

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def peek(self, key: str) -> Tuple[bool, Optional[str], Optional[int]]:
        """Non-destructive existence check — analogous to reading the silo tree.

        Returns:
            (hit, value, index) where ``hit`` is True when the key is cached.
        """
        slot = self._slots.get(key)
        if slot is not None and slot.resolved:
            return True, slot.value, slot.index
        return False, None, None

    def set(self, key: str, value: str) -> int:
        """Store *key/value*, allocating a new slot index if needed.

        Mirrors PMLL.c::update_silo() writing a var/value pair into the
        silo tree at the computed depth.

        Returns:
            The slot index for the stored entry.
        """
        if key in self._slots:
            # Update existing slot in-place (Ouroboros cache update).
            self._slots[key].value = value
            self._slots[key].resolved = True
            return self._slots[key].index

        index = len(self._slots)
        self._slots[key] = _KVSlot(index=index, key=key, value=value)
        return index

    def flush(self) -> int:
        """Clear all KV slots for this session.

        Returns:
            The number of slots that were cleared.
        """
        count = len(self._slots)
        self._slots.clear()
        return count

    # ------------------------------------------------------------------
    # Introspection helpers
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._slots)

    def __contains__(self, key: object) -> bool:
        return key in self._slots


# Module-level registry: session_id → PMMemoryStore
# Mirrors the global silo pool managed by pml_t in PMLL.h.
_session_stores: Dict[str, PMMemoryStore] = {}


def get_store(session_id: str, silo_size: int = 256) -> PMMemoryStore:
    """Return (or lazily create) the store for *session_id*."""
    if session_id not in _session_stores:
        _session_stores[session_id] = PMMemoryStore(silo_size=silo_size)
    return _session_stores[session_id]


def drop_store(session_id: str) -> int:
    """Remove the store for *session_id*, returning the cleared slot count."""
    store = _session_stores.pop(session_id, None)
    return len(store) if store is not None else 0
