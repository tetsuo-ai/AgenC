"""
Compatibility shim — do not add logic here.

``SimulationEvent`` is defined in ``bridge_types.py``; this module exists solely
to preserve the import path (``concordia_bridge.event_stream``) referenced by
the original Concordia implementation plan (see CONCORDIA_TODO.MD).

New code should import directly from ``concordia_bridge.bridge_types``.
"""

from concordia_bridge.bridge_types import SimulationEvent

__all__ = ["SimulationEvent"]
