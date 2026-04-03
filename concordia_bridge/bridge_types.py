"""Shared data types for the AgenC x Concordia bridge."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Optional
from uuid import uuid4


# ============================================================================
# Simulation Events (streamed to viewer via WebSocket)
# ============================================================================

@dataclass
class SimulationEvent:
    """An event emitted during simulation for real-time streaming."""

    type: str  # "step", "observation", "action", "resolution", "scene_change",
    #            "terminate", "collective_emergence", "reflection", "error"
    step: int
    timestamp: float = field(default_factory=time.time)
    simulation_id: str = ""
    world_id: str = ""
    workspace_id: str = ""
    lineage_id: Optional[str] = None
    parent_simulation_id: Optional[str] = None
    agent_name: Optional[str] = None
    content: Optional[str] = None
    action_spec: Optional[dict] = None
    resolved_event: Optional[str] = None
    scene: Optional[str] = None
    metadata: Optional[dict] = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), default=str)

    @classmethod
    def from_json(cls, data: str) -> "SimulationEvent":
        return cls(**json.loads(data))


# ============================================================================
# Agent Configuration
# ============================================================================

@dataclass
class AgentConfig:
    """Configuration for a single agent in a Concordia simulation."""

    id: str
    name: str
    personality: str
    goal: str = ""


# ============================================================================
# Scene Configuration
# ============================================================================

def _slugify_scene(value: object, fallback: str) -> str:
    if isinstance(value, str):
        normalized = "".join(
            char.lower() if char.isalnum() else "-"
            for char in value.strip()
        )
        collapsed = "-".join(part for part in normalized.split("-") if part)
        if collapsed:
            return collapsed
    return fallback


def _as_string(value: object, fallback: str = "") -> str:
    return value if isinstance(value, str) else fallback


def _as_optional_string(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _as_optional_int(value: object) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _as_positive_int(value: object, fallback: int) -> int:
    parsed = _as_optional_int(value)
    return parsed if parsed is not None and parsed > 0 else fallback


@dataclass
class SceneWorldEventSpec:
    summary: str
    observation: Optional[str] = None
    trigger_round: int = 1
    event_id: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SceneSpec:
    scene_id: str
    name: str
    description: str
    num_rounds: int = 1
    zone_id: Optional[str] = None
    location_id: Optional[str] = None
    time_of_day: Optional[str] = None
    day_index: Optional[int] = None
    gm_instructions: str = ""
    world_events: list[SceneWorldEventSpec] = field(default_factory=list)

    @property
    def scene_type(self) -> dict[str, str]:
        return {"name": self.name}


def normalize_scene_specs(raw_scenes: object) -> Optional[list[SceneSpec]]:
    if not isinstance(raw_scenes, list):
        return None

    scenes: list[SceneSpec] = []
    for index, raw_scene in enumerate(raw_scenes):
        if not isinstance(raw_scene, Mapping):
            continue
        fallback_id = f"scene-{index + 1}"
        name = _as_string(raw_scene.get("name"), f"Scene {index + 1}")
        scene_id = _slugify_scene(raw_scene.get("scene_id") or name, fallback_id)
        description = _as_string(raw_scene.get("description"), name)
        raw_world_events = raw_scene.get("world_events")
        world_events: list[SceneWorldEventSpec] = []
        if isinstance(raw_world_events, list):
            for event_index, raw_event in enumerate(raw_world_events):
                if not isinstance(raw_event, Mapping):
                    continue
                summary = _as_string(raw_event.get("summary")).strip()
                if not summary:
                    continue
                world_events.append(SceneWorldEventSpec(
                    summary=summary,
                    observation=_as_optional_string(raw_event.get("observation")),
                    trigger_round=_as_positive_int(raw_event.get("trigger_round"), 1),
                    event_id=_as_optional_string(raw_event.get("event_id")) or f"{scene_id}-event-{event_index + 1}",
                    metadata=dict(raw_event.get("metadata", {})) if isinstance(raw_event.get("metadata"), Mapping) else {},
                ))
        scenes.append(SceneSpec(
            scene_id=scene_id,
            name=name,
            description=description,
            num_rounds=_as_positive_int(raw_scene.get("num_rounds"), 1),
            zone_id=_as_optional_string(raw_scene.get("zone_id")),
            location_id=_as_optional_string(raw_scene.get("location_id")),
            time_of_day=_as_optional_string(raw_scene.get("time_of_day")),
            day_index=_as_optional_int(raw_scene.get("day_index")),
            gm_instructions=_as_string(raw_scene.get("gm_instructions")),
            world_events=world_events,
        ))
    return scenes or None


# ============================================================================
# Simulation Configuration
# ============================================================================

@dataclass
class SimulationConfig:
    """Full configuration for running a Concordia simulation with AgenC agents."""

    world_id: str
    workspace_id: str
    premise: str
    agents: list[AgentConfig]
    simulation_id: str = field(default_factory=lambda: str(uuid4()))
    lineage_id: Optional[str] = None
    parent_simulation_id: Optional[str] = None
    user_id: Optional[str] = None
    max_steps: int = 50
    gm_instructions: str = ""
    gm_model: str = "grok-3-mini"
    gm_provider: str = "ollama"
    gm_api_key: str = ""
    gm_base_url: str = ""
    engine_type: str = "simultaneous"  # "sequential" | "simultaneous"
    gm_prefab: str = "generic"
    bridge_url: str = "http://localhost:3200"
    event_port: int = 3201
    control_port: int = 3202
    simultaneous_max_workers: int = 8
    proxy_action_timeout_seconds: float = 120.0
    proxy_action_max_retries: int = 2
    proxy_retry_delay_seconds: float = 2.0
    embedding_model: str = "all-MiniLM-L6-v2"
    reflection_interval: int = 5  # Run reflection every N steps (used by TS adapter memory-lifecycle)
    consolidation_interval: int = 20  # Run consolidation every N steps (used by TS adapter memory-lifecycle)
    retention_interval: int = 20  # Run retention every N steps (used by TS adapter memory-lifecycle)
    encryption_key: str = ""  # At-rest encryption key (used by TS adapter memory-wiring)
    scenes: Optional[list[SceneSpec]] = None  # Optional SceneSpec list


def build_simulation_config(
    raw: Mapping[str, object],
    agents: list[AgentConfig],
    *,
    default_world_id: str = "default",
    default_workspace_id: str = "concordia-sim",
    default_simulation_id: Optional[str] = None,
    default_lineage_id: Optional[str] = None,
    default_parent_simulation_id: Optional[str] = None,
    default_max_steps: int = 50,
) -> SimulationConfig:
    simulation_id = raw.get("simulation_id", default_simulation_id or str(uuid4()))
    return SimulationConfig(
        world_id=raw.get("world_id", default_world_id),
        workspace_id=raw.get("workspace_id", default_workspace_id),
        premise=raw.get("premise", ""),
        agents=agents,
        simulation_id=simulation_id,
        lineage_id=raw.get("lineage_id", default_lineage_id),
        parent_simulation_id=raw.get(
            "parent_simulation_id",
            default_parent_simulation_id,
        ),
        user_id=raw.get("user_id"),
        max_steps=raw.get("max_steps", default_max_steps),
        gm_instructions=raw.get("gm_instructions", ""),
        gm_model=raw.get("gm_model", "grok-3-mini"),
        gm_provider=raw.get("gm_provider", "ollama"),
        gm_api_key=raw.get("gm_api_key", ""),
        gm_base_url=raw.get("gm_base_url", ""),
        engine_type=raw.get("engine_type", "simultaneous"),
        gm_prefab=raw.get("gm_prefab", "generic"),
        bridge_url=raw.get("bridge_url", "http://localhost:3200"),
        event_port=raw.get("event_port", 3201),
        control_port=raw.get("control_port", 3202),
        simultaneous_max_workers=raw.get("simultaneous_max_workers", 8),
        proxy_action_timeout_seconds=raw.get("proxy_action_timeout_seconds", 120.0),
        proxy_action_max_retries=raw.get("proxy_action_max_retries", 2),
        proxy_retry_delay_seconds=raw.get("proxy_retry_delay_seconds", 2.0),
        embedding_model=raw.get("embedding_model", "all-MiniLM-L6-v2"),
        reflection_interval=raw.get("reflection_interval", 5),
        consolidation_interval=raw.get("consolidation_interval", 20),
        retention_interval=raw.get("retention_interval", 20),
        encryption_key=raw.get("encryption_key", ""),
        scenes=normalize_scene_specs(raw.get("scenes")),
    )
