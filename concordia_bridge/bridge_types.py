"""Shared data types for the AgenC x Concordia bridge."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Mapping, Optional
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
    embedding_model: str = "all-MiniLM-L6-v2"
    reflection_interval: int = 5  # Run reflection every N steps (used by TS adapter memory-lifecycle)
    consolidation_interval: int = 20  # Run consolidation every N steps (used by TS adapter memory-lifecycle)
    retention_interval: int = 20  # Run retention every N steps (used by TS adapter memory-lifecycle)
    encryption_key: str = ""  # At-rest encryption key (used by TS adapter memory-wiring)
    scenes: Optional[list] = None  # Optional SceneSpec list


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
        embedding_model=raw.get("embedding_model", "all-MiniLM-L6-v2"),
        reflection_interval=raw.get("reflection_interval", 5),
        consolidation_interval=raw.get("consolidation_interval", 20),
        retention_interval=raw.get("retention_interval", 20),
        encryption_key=raw.get("encryption_key", ""),
        scenes=raw.get("scenes"),
    )
