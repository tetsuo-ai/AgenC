"""Shared helpers for Concordia simulation run identity payloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, MutableMapping

from concordia_bridge.bridge_types import SimulationConfig, SimulationEvent


@dataclass(frozen=True)
class SimulationIdentity:
    simulation_id: str
    lineage_id: str | None = None
    parent_simulation_id: str | None = None


def identity_from_config(config: SimulationConfig) -> SimulationIdentity:
    return SimulationIdentity(
        simulation_id=config.simulation_id,
        lineage_id=config.lineage_id,
        parent_simulation_id=config.parent_simulation_id,
    )


def identity_payload(identity: SimulationIdentity) -> dict[str, Any]:
    return {
        "simulation_id": identity.simulation_id,
        "lineage_id": identity.lineage_id,
        "parent_simulation_id": identity.parent_simulation_id,
    }


def with_identity_payload(
    payload: Mapping[str, Any],
    identity: SimulationIdentity,
) -> dict[str, Any]:
    merged = dict(payload)
    merged.update(identity_payload(identity))
    return merged


def apply_identity_to_event(
    event: SimulationEvent,
    identity: SimulationIdentity,
    *,
    world_id: str = "",
    workspace_id: str = "",
) -> SimulationEvent:
    if not event.simulation_id:
        event.simulation_id = identity.simulation_id
    if not event.world_id and world_id:
        event.world_id = world_id
    if not event.workspace_id and workspace_id:
        event.workspace_id = workspace_id
    if event.lineage_id is None:
        event.lineage_id = identity.lineage_id
    if event.parent_simulation_id is None:
        event.parent_simulation_id = identity.parent_simulation_id
    return event


def identity_from_payload(payload: Mapping[str, Any]) -> SimulationIdentity:
    simulation_id = payload.get("simulation_id")
    lineage_id = payload.get("lineage_id")
    parent_simulation_id = payload.get("parent_simulation_id")
    return SimulationIdentity(
        simulation_id=str(simulation_id or ""),
        lineage_id=str(lineage_id) if lineage_id else None,
        parent_simulation_id=(
            str(parent_simulation_id) if parent_simulation_id else None
        ),
    )
