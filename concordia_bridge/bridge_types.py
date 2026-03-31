"""Shared data types for the AgenC x Concordia bridge."""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Optional, Sequence
import json


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
    max_steps: int = 50
    gm_instructions: str = ""
    gm_model: str = "grok-3-mini"
    gm_provider: str = "ollama"
    gm_api_key: str = ""
    gm_base_url: str = ""
    engine_type: str = "sequential"  # "sequential" | "simultaneous"
    gm_prefab: str = "generic"
    bridge_url: str = "http://localhost:3200"
    event_port: int = 3201
    control_port: int = 3202
    embedding_model: str = "all-MiniLM-L6-v2"
    reflection_interval: int = 5  # Run reflection every N steps
    consolidation_interval: int = 20  # Run consolidation every N steps
    retention_interval: int = 20  # Run retention every N steps
    encryption_key: str = ""
    scenes: Optional[list] = None  # Optional SceneSpec list
