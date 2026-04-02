"""
Compatibility shim for the original event stream module.

`SimulationEvent` remains defined in `bridge_types.py`; this module preserves
the import path referenced by the Concordia implementation plan.
"""

from concordia_bridge.bridge_types import SimulationEvent

__all__ = ["SimulationEvent"]
