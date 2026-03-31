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

from concordia_bridge.bridge_types import SimulationConfig

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
    for entity in entities:
        try:
            entity_logs[entity.name] = entity.get_last_log()
        except Exception:
            entity_logs[entity.name] = {}

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
        "step": step,
        "max_steps": config.max_steps,
        "timestamp": time.time(),
        "config": asdict(config),
        "entity_logs": entity_logs,
        "gm_state": _serialize_state(gm_state),
        "agent_ids": [a.id for a in config.agents],
    }

    filename = f"{config.world_id}_step_{step}.json"
    filepath = os.path.join(checkpoint_dir, filename)

    with open(filepath, "w") as f:
        json.dump(checkpoint, f, indent=2, default=str)

    logger.info("Checkpoint saved: %s", filepath)

    # Notify bridge to trigger memory consolidation
    try:
        requests.post(
            f"{config.bridge_url}/event",
            json={
                "type": "checkpoint",
                "step": step,
                "content": f"Checkpoint saved at step {step}",
                "world_id": config.world_id,
            },
            timeout=5,
        )
    except Exception:
        pass

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
