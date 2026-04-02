"""
Simulation checkpoint/resume — save and restore simulation state.

Saves: GM memory, entity logs, step counter, world config, and run identity.
AgenC agent memory persists automatically via SQLite — checkpoints
only need to capture Concordia-side state plus explicit resume metadata.

Phase 7.3 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional, Sequence

import requests

from concordia.typing.entity import EntityWithLogging

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig
from concordia_bridge.simulation_identity import (
    identity_from_config,
    with_identity_payload,
)

logger = logging.getLogger(__name__)

CHECKPOINT_DIR = os.path.expanduser("~/.agenc/concordia/checkpoints")
CHECKPOINT_VERSION = 2


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

    gm_state = {}
    if hasattr(game_master, "get_state"):
        try:
            gm_state = game_master.get_state()
        except Exception as exc:
            logger.warning("Failed to get GM state: %s", exc)

    identity = identity_from_config(config)

    checkpoint = with_identity_payload({
        "version": CHECKPOINT_VERSION,
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
    }, identity)

    filename = _checkpoint_filename(identity.simulation_id, step)
    filepath = os.path.join(checkpoint_dir, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(checkpoint, f, indent=2, default=str)

    logger.info("Checkpoint saved: %s", filepath)

    try:
        requests.post(
            f"{config.bridge_url}/checkpoint",
            json=with_identity_payload({
                "world_id": config.world_id,
                "workspace_id": config.workspace_id,
                "step": step,
            }, identity),
            timeout=5,
        )
    except Exception as exc:
        logger.warning("Failed to notify bridge about checkpoint at step %d: %s", step, exc)

    return filepath


def load_checkpoint(filepath: str) -> Optional[dict]:
    """Load a checkpoint from disk.

    Returns the migrated checkpoint dict, or None if the file doesn't exist.
    """
    if not os.path.exists(filepath):
        logger.warning("Checkpoint not found: %s", filepath)
        return None

    with open(filepath, encoding="utf-8") as f:
        checkpoint = json.load(f)

    migrated = _migrate_checkpoint(checkpoint)
    if migrated is None:
        logger.warning("Unsupported checkpoint version: %s", checkpoint.get("version"))
        return None

    logger.info(
        "Checkpoint loaded: simulation=%s world=%s step=%d",
        migrated.get("simulation_id"),
        migrated.get("world_id"),
        migrated.get("step"),
    )
    return migrated


def list_checkpoints(
    world_id: Optional[str],
    checkpoint_dir: str = CHECKPOINT_DIR,
    simulation_id: Optional[str] = None,
) -> list[dict]:
    """List checkpoints filtered by world and/or simulation, sorted by step."""
    if not os.path.exists(checkpoint_dir):
        return []

    checkpoints = []
    for filename in os.listdir(checkpoint_dir):
        if not filename.endswith(".json"):
            continue
        filepath = os.path.join(checkpoint_dir, filename)
        try:
            checkpoint = load_checkpoint(filepath)
            if checkpoint is None:
                continue
            if world_id is not None and checkpoint.get("world_id") != world_id:
                continue
            if simulation_id is not None and checkpoint.get("simulation_id") != simulation_id:
                continue
            checkpoints.append({
                "filepath": filepath,
                "simulation_id": checkpoint.get("simulation_id"),
                "lineage_id": checkpoint.get("lineage_id"),
                "parent_simulation_id": checkpoint.get("parent_simulation_id"),
                "world_id": checkpoint.get("world_id"),
                "step": checkpoint.get("step", 0),
                "timestamp": checkpoint.get("timestamp", 0),
                "version": checkpoint.get("version", 0),
            })
        except Exception:
            continue

    return sorted(checkpoints, key=lambda c: c["step"])


def _checkpoint_filename(simulation_id: str, step: int) -> str:
    safe_simulation_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", simulation_id).strip("-")
    safe_simulation_id = safe_simulation_id or "simulation"
    return f"{safe_simulation_id}_step_{step}.json"


def _migrate_checkpoint(checkpoint: dict) -> Optional[dict]:
    version = checkpoint.get("version", 1)
    if version == CHECKPOINT_VERSION:
        return checkpoint
    if version != 1:
        return None

    config = checkpoint.get("config")
    if not isinstance(config, dict):
        config = {}

    simulation_id = checkpoint.get("simulation_id") or config.get("simulation_id") or checkpoint.get("world_id") or "legacy-simulation"
    lineage_id = checkpoint.get("lineage_id") or config.get("lineage_id")
    parent_simulation_id = checkpoint.get("parent_simulation_id") or config.get("parent_simulation_id")

    migrated = dict(checkpoint)
    migrated["version"] = CHECKPOINT_VERSION
    migrated["simulation_id"] = simulation_id
    migrated["lineage_id"] = lineage_id
    migrated["parent_simulation_id"] = parent_simulation_id

    migrated_config = dict(config)
    migrated_config.setdefault("simulation_id", simulation_id)
    migrated_config.setdefault("lineage_id", lineage_id)
    migrated_config.setdefault("parent_simulation_id", parent_simulation_id)
    migrated["config"] = migrated_config
    return migrated


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
    migrated = _migrate_checkpoint(checkpoint)
    if migrated is None:
        raise ValueError("Checkpoint has unsupported version")

    raw = migrated.get("config")
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
        world_id=raw.get("world_id", migrated.get("world_id", "default")),
        workspace_id=raw.get("workspace_id", "concordia-sim"),
        premise=raw.get("premise", ""),
        agents=agents,
        simulation_id=raw.get("simulation_id", migrated.get("simulation_id", "")),
        lineage_id=raw.get("lineage_id", migrated.get("lineage_id")),
        parent_simulation_id=raw.get(
            "parent_simulation_id",
            migrated.get("parent_simulation_id"),
        ),
        user_id=raw.get("user_id"),
        max_steps=raw.get("max_steps", migrated.get("step", 0)),
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
