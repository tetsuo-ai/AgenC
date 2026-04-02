"""
Simulation checkpoint/resume — save and restore simulation state.

Saves: GM memory, entity logs, step counter, world config.
AgenC agent memory persists automatically via SQLite — checkpoints
only need to capture Concordia-side state.

Phase 7.3 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional, Sequence

import requests

from concordia.typing.entity import EntityWithLogging

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig

logger = logging.getLogger(__name__)

CHECKPOINT_DIR = os.path.expanduser("~/.agenc/concordia/checkpoints")


def save_checkpoint(
    config: SimulationConfig,
    step: int,
    game_master: object,
    entities: Sequence[EntityWithLogging],
    checkpoint_dir: str = CHECKPOINT_DIR,
) -> str:
    """Save a simulation checkpoint to disk.

    Returns the checkpoint file path.
    """
    Path(checkpoint_dir).mkdir(parents=True, exist_ok=True)

    # Collect entity logs
    entity_logs = {}
    entity_states = {}
    for entity in entities:
        try:
            entity_logs[entity.name] = entity.get_last_log()
        except Exception:
            entity_logs[entity.name] = {}
        if hasattr(entity, "get_state"):
            try:
                entity_states[entity.name] = _serialize_state(entity.get_state())
            except Exception as exc:
                logger.warning("Failed to get state for entity %s: %s", entity.name, exc)

    # Collect GM state if available
    gm_state = {}
    if hasattr(game_master, "get_state"):
        try:
            gm_state = game_master.get_state()
        except Exception as exc:
            logger.warning("Failed to get GM state: %s", exc)

    checkpoint = {
        "version": 1,
        "world_id": config.world_id,
        "workspace_id": config.workspace_id,
        "user_id": config.user_id,
        "step": step,
        "max_steps": config.max_steps,
        "timestamp": time.time(),
        "config": asdict(config),
        "entity_logs": entity_logs,
        "entity_states": entity_states,
        "gm_state": _serialize_state(gm_state),
        "agent_ids": [a.id for a in config.agents],
    }

    filename = f"{config.world_id}_step_{step}.json"
    filepath = os.path.join(checkpoint_dir, filename)

    with open(filepath, "w") as f:
        json.dump(checkpoint, f, indent=2, default=str)

    logger.info("Checkpoint saved: %s", filepath)

    # Notify bridge to trigger memory consolidation / summary capture
    try:
        requests.post(
            f"{config.bridge_url}/checkpoint",
            json={
                "world_id": config.world_id,
                "workspace_id": config.workspace_id,
                "step": step,
            },
            timeout=5,
        )
    except Exception as exc:
        logger.warning("Failed to notify bridge about checkpoint at step %d: %s", step, exc)

    return filepath


def load_checkpoint(
    filepath: str,
) -> Optional[dict]:
    """Load a checkpoint from disk.

    Returns the checkpoint dict, or None if the file doesn't exist.
    """
    if not os.path.exists(filepath):
        logger.warning("Checkpoint not found: %s", filepath)
        return None

    with open(filepath) as f:
        checkpoint = json.load(f)

    if checkpoint.get("version") != 1:
        logger.warning("Unsupported checkpoint version: %s", checkpoint.get("version"))
        return None

    logger.info(
        "Checkpoint loaded: world=%s step=%d",
        checkpoint.get("world_id"),
        checkpoint.get("step"),
    )
    return checkpoint


def list_checkpoints(
    world_id: str,
    checkpoint_dir: str = CHECKPOINT_DIR,
) -> list[dict]:
    """List all checkpoints for a world, sorted by step."""
    if not os.path.exists(checkpoint_dir):
        return []

    checkpoints = []
    prefix = f"{world_id}_step_"
    for filename in os.listdir(checkpoint_dir):
        if filename.startswith(prefix) and filename.endswith(".json"):
            filepath = os.path.join(checkpoint_dir, filename)
            try:
                with open(filepath) as f:
                    data = json.load(f)
                checkpoints.append({
                    "filepath": filepath,
                    "world_id": data.get("world_id"),
                    "step": data.get("step", 0),
                    "timestamp": data.get("timestamp", 0),
                })
            except Exception:
                continue

    return sorted(checkpoints, key=lambda c: c["step"])


def _serialize_state(state: object) -> dict:
    """Recursively serialize a state object to JSON-compatible dict."""
    if isinstance(state, dict):
        return {str(k): _serialize_state(v) for k, v in state.items()}
    if isinstance(state, (list, tuple)):
        return [_serialize_state(v) for v in state]
    if isinstance(state, (str, int, float, bool, type(None))):
        return state
    return str(state)


def simulation_config_from_checkpoint(checkpoint: dict) -> SimulationConfig:
    """Rebuild a SimulationConfig from a serialized checkpoint."""
    raw = checkpoint.get("config")
    if not isinstance(raw, dict):
        raise ValueError("Checkpoint missing config payload")

    agents = []
    for agent in raw.get("agents", []):
        if not isinstance(agent, dict):
            continue
        agents.append(
            AgentConfig(
                id=agent.get("id", ""),
                name=agent.get("name", ""),
                personality=agent.get("personality", ""),
                goal=agent.get("goal", ""),
            )
        )

    return SimulationConfig(
        world_id=raw.get("world_id", checkpoint.get("world_id", "default")),
        workspace_id=raw.get("workspace_id", "concordia-sim"),
        premise=raw.get("premise", ""),
        agents=agents,
        user_id=raw.get("user_id"),
        max_steps=raw.get("max_steps", checkpoint.get("step", 0)),
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
