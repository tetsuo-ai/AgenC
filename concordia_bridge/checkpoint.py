"""
Simulation checkpoint/resume — save and restore simulation state.

Saves: GM memory, entity logs, scene/runtime cursors, replay cursor,
world refs, and lineage metadata. AgenC agent memory persists automatically
via SQLite, so checkpoints only need to capture Concordia-side state plus
explicit resume metadata.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional, Sequence

import requests

from concordia.typing.entity import EntityWithLogging

from concordia_bridge.bridge_types import (
    AgentConfig,
    SimulationConfig,
    build_simulation_config,
)
from concordia_bridge.simulation_identity import (
    identity_from_config,
    with_identity_payload,
)

logger = logging.getLogger(__name__)

CHECKPOINT_DIR = os.path.expanduser("~/.agenc/concordia/checkpoints")
CHECKPOINT_SCHEMA_VERSION = 3
CHECKPOINT_VERSION = CHECKPOINT_SCHEMA_VERSION


def save_checkpoint(
    config: SimulationConfig,
    step: int,
    game_master: object,
    entities: Sequence[EntityWithLogging],
    checkpoint_dir: str = CHECKPOINT_DIR,
    *,
    scene_cursor: Optional[dict[str, Any]] = None,
    runtime_cursor: Optional[dict[str, Any]] = None,
    replay_cursor: Optional[dict[str, Any]] = None,
    world_state_refs: Optional[dict[str, Any]] = None,
    memory_namespace_refs: Optional[dict[str, Any]] = None,
    subsystem_state: Optional[dict[str, Any]] = None,
    restored_sessions: Optional[list[dict[str, Any]]] = None,
) -> str:
    """Save a simulation checkpoint to disk and return the file path."""
    identity = identity_from_config(config)

    entity_logs: dict[str, Any] = {}
    entity_states: dict[str, Any] = {}
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

    gm_state: dict[str, Any] = {}
    if hasattr(game_master, "get_state"):
        try:
            gm_state = _serialize_state(game_master.get_state())
        except Exception as exc:
            logger.warning("Failed to get GM state: %s", exc)

    checkpoint_path = _checkpoint_path(
        checkpoint_dir,
        workspace_id=config.workspace_id,
        world_id=config.world_id,
        lineage_id=identity.lineage_id,
        simulation_id=identity.simulation_id,
        step=step,
    )
    checkpoint_id = f"{identity.simulation_id}:step:{step}"

    base_manifest = _normalize_checkpoint_manifest(
        with_identity_payload(
            {
                "version": CHECKPOINT_VERSION,
                "schema_version": CHECKPOINT_SCHEMA_VERSION,
                "checkpoint_id": checkpoint_id,
                "checkpoint_path": str(checkpoint_path),
                "world_id": config.world_id,
                "workspace_id": config.workspace_id,
                "user_id": config.user_id,
                "step": step,
                "max_steps": config.max_steps,
                "timestamp": time.time(),
                "config": asdict(config),
                "restored_sessions": restored_sessions or [],
                "scene_cursor": scene_cursor,
                "runtime_cursor": runtime_cursor,
                "replay_cursor": replay_cursor,
                "world_state_refs": world_state_refs,
                "memory_namespace_refs": memory_namespace_refs or {},
                "subsystem_state": subsystem_state,
                "entity_logs": entity_logs,
                "entity_states": entity_states,
                "gm_state": gm_state,
                "agent_ids": [a.id for a in config.agents],
            },
            identity,
        ),
        fallback_path=str(checkpoint_path),
    )

    final_manifest = _enrich_checkpoint_manifest(config, base_manifest)
    final_path = Path(final_manifest["checkpoint_path"])
    _atomic_write_json(final_path, final_manifest)

    logger.info("Checkpoint saved: %s", final_path)
    return str(final_path)


def load_checkpoint(filepath: str) -> Optional[dict[str, Any]]:
    """Load a checkpoint from disk.

    Returns the migrated checkpoint dict, or None if the file does not exist.
    """
    path = Path(filepath)
    if not path.exists():
        logger.warning("Checkpoint not found: %s", filepath)
        return None

    with path.open(encoding="utf-8") as f:
        checkpoint = json.load(f)

    migrated = _migrate_checkpoint(checkpoint, fallback_path=str(path))
    if migrated is None:
        logger.warning(
            "Unsupported checkpoint version: %s",
            checkpoint.get("schema_version", checkpoint.get("version")),
        )
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
    lineage_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """List checkpoints filtered by world/simulation/lineage, sorted by step."""
    root = Path(checkpoint_dir)
    if not root.exists():
        return []

    checkpoints: list[dict[str, Any]] = []
    for path in root.rglob("*.json"):
        try:
            checkpoint = load_checkpoint(str(path))
        except Exception:
            checkpoint = None
        if checkpoint is None:
            continue
        if world_id is not None and checkpoint.get("world_id") != world_id:
            continue
        if simulation_id is not None and checkpoint.get("simulation_id") != simulation_id:
            continue
        if lineage_id is not None and checkpoint.get("lineage_id") != lineage_id:
            continue
        checkpoints.append(
            {
                "filepath": str(path),
                "checkpoint_id": checkpoint.get("checkpoint_id"),
                "simulation_id": checkpoint.get("simulation_id"),
                "lineage_id": checkpoint.get("lineage_id"),
                "parent_simulation_id": checkpoint.get("parent_simulation_id"),
                "world_id": checkpoint.get("world_id"),
                "workspace_id": checkpoint.get("workspace_id"),
                "step": checkpoint.get("step", 0),
                "timestamp": checkpoint.get("timestamp", 0),
                "schema_version": checkpoint.get("schema_version", checkpoint.get("version", 0)),
            }
        )

    return sorted(
        checkpoints,
        key=lambda checkpoint: (
            checkpoint.get("step", 0),
            checkpoint.get("timestamp", 0),
            checkpoint.get("filepath", ""),
        ),
    )


def simulation_config_from_checkpoint(checkpoint: dict[str, Any]) -> SimulationConfig:
    """Rebuild a SimulationConfig from a serialized checkpoint."""
    migrated = _migrate_checkpoint(checkpoint)
    if migrated is None:
        raise ValueError("Checkpoint has unsupported version")

    raw = migrated.get("config")
    if not isinstance(raw, dict):
        raise ValueError("Checkpoint missing config payload")

    sanitized = dict(raw)
    sanitized.pop("event_port", None)
    sanitized.pop("control_port", None)

    agents = []
    for agent in sanitized.get("agents", []):
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

    return build_simulation_config(
        sanitized,
        agents,
        default_world_id=migrated.get("world_id", "default"),
        default_workspace_id=migrated.get("workspace_id", "concordia-sim"),
        default_simulation_id=migrated.get("simulation_id", ""),
        default_lineage_id=migrated.get("lineage_id"),
        default_parent_simulation_id=migrated.get("parent_simulation_id"),
        default_max_steps=migrated.get("max_steps", migrated.get("step", 0)),
    )


def _enrich_checkpoint_manifest(
    config: SimulationConfig,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    request_payload = with_identity_payload(
        {
            "world_id": manifest["world_id"],
            "workspace_id": manifest["workspace_id"],
            "simulation_id": manifest["simulation_id"],
            "lineage_id": manifest.get("lineage_id"),
            "parent_simulation_id": manifest.get("parent_simulation_id"),
            "step": manifest["step"],
            "checkpoint_id": manifest["checkpoint_id"],
            "checkpoint_path": manifest["checkpoint_path"],
            "checkpoint_manifest": manifest,
        },
        identity_from_config(config),
    )
    try:
        response = requests.post(
            f"{config.bridge_url}/checkpoint",
            json=request_payload,
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
        enriched = payload.get("checkpoint_manifest")
        if isinstance(enriched, dict):
            return _normalize_checkpoint_manifest(enriched, fallback_path=manifest["checkpoint_path"])
    except Exception as exc:
        logger.warning(
            "Failed to enrich checkpoint manifest for simulation %s at step %d: %s",
            config.simulation_id,
            manifest.get("step", 0),
            exc,
        )
    return manifest


def _migrate_checkpoint(
    checkpoint: dict[str, Any],
    *,
    fallback_path: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(checkpoint, dict):
        return None

    version = checkpoint.get("schema_version", checkpoint.get("version", 1))
    try:
        version = int(version)
    except Exception:
        return None
    if version not in {1, 2, 3}:
        return None

    return _normalize_checkpoint_manifest(checkpoint, fallback_path=fallback_path)


def _normalize_checkpoint_manifest(
    checkpoint: dict[str, Any],
    *,
    fallback_path: Optional[str] = None,
) -> dict[str, Any]:
    raw_config = checkpoint.get("config") if isinstance(checkpoint.get("config"), dict) else {}
    config = dict(raw_config)
    step = _as_int(checkpoint.get("step"), 0)
    world_id = _as_str(checkpoint.get("world_id")) or _as_str(config.get("world_id")) or "default"
    workspace_id = (
        _as_str(checkpoint.get("workspace_id"))
        or _as_str(config.get("workspace_id"))
        or "concordia-sim"
    )
    simulation_id = (
        _as_str(checkpoint.get("simulation_id"))
        or _as_str(config.get("simulation_id"))
        or world_id
        or "legacy-simulation"
    )
    lineage_id = _as_optional_str(checkpoint.get("lineage_id")) or _as_optional_str(config.get("lineage_id"))
    parent_simulation_id = (
        _as_optional_str(checkpoint.get("parent_simulation_id"))
        or _as_optional_str(config.get("parent_simulation_id"))
    )
    max_steps = _as_int(checkpoint.get("max_steps"), _as_int(config.get("max_steps"), step))
    checkpoint_id = _as_str(checkpoint.get("checkpoint_id")) or f"{simulation_id}:step:{step}"
    checkpoint_path = _as_str(checkpoint.get("checkpoint_path")) or fallback_path
    if not checkpoint_path:
        checkpoint_path = str(
            _checkpoint_path(
                CHECKPOINT_DIR,
                workspace_id=workspace_id,
                world_id=world_id,
                lineage_id=lineage_id,
                simulation_id=simulation_id,
                step=step,
            )
        )

    entity_states = _as_dict(checkpoint.get("entity_states"))
    gm_state = _serialize_state(_as_dict(checkpoint.get("gm_state")))
    replay_cursor = _normalize_replay_cursor(checkpoint.get("replay_cursor"), step)
    runtime_cursor = _normalize_runtime_cursor(
        checkpoint.get("runtime_cursor"),
        step=step,
        max_steps=max_steps,
        engine_type=_as_optional_str(config.get("engine_type")),
    )
    scene_cursor = _normalize_scene_cursor(checkpoint.get("scene_cursor"))
    subsystem_state = _normalize_subsystem_state(checkpoint.get("subsystem_state"))
    world_state_refs = _normalize_world_state_refs(
        checkpoint.get("world_state_refs"),
        entity_state_keys=list(entity_states.keys()),
        has_gm_state=bool(gm_state),
    )

    config.setdefault("world_id", world_id)
    config.setdefault("workspace_id", workspace_id)
    config.setdefault("simulation_id", simulation_id)
    config.setdefault("lineage_id", lineage_id)
    config.setdefault("parent_simulation_id", parent_simulation_id)
    config.setdefault("max_steps", max_steps)

    manifest = {
        "version": CHECKPOINT_VERSION,
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "checkpoint_id": checkpoint_id,
        "checkpoint_path": checkpoint_path,
        "world_id": world_id,
        "workspace_id": workspace_id,
        "simulation_id": simulation_id,
        "lineage_id": lineage_id,
        "parent_simulation_id": parent_simulation_id,
        "step": step,
        "timestamp": checkpoint.get("timestamp", time.time()),
        "user_id": _as_optional_str(checkpoint.get("user_id")) or _as_optional_str(config.get("user_id")),
        "max_steps": max_steps,
        "config": dict(config),
        "restored_sessions": _normalize_restored_sessions(checkpoint.get("restored_sessions")),
        "scene_cursor": scene_cursor,
        "runtime_cursor": runtime_cursor,
        "replay_cursor": replay_cursor,
        "world_state_refs": world_state_refs,
        "memory_namespace_refs": _as_dict(checkpoint.get("memory_namespace_refs")),
        "subsystem_state": subsystem_state,
        "entity_logs": _as_dict(checkpoint.get("entity_logs")),
        "entity_states": entity_states,
        "gm_state": gm_state,
        "agent_ids": _normalize_agent_ids(checkpoint.get("agent_ids")),
    }
    return manifest


def _normalize_restored_sessions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    sessions: list[dict[str, Any]] = []
    for entry in value:
        if isinstance(entry, dict):
            sessions.append(dict(entry))
    return sessions


def _normalize_agent_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, str) and entry]


def _normalize_scene_cursor(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        return None
    return {
        "scene_index": _as_int(value.get("scene_index"), 0),
        "scene_round": _as_int(value.get("scene_round"), 0),
        "current_scene_name": _as_optional_str(value.get("current_scene_name")),
    }


def _normalize_runtime_cursor(
    value: Any,
    *,
    step: int,
    max_steps: int,
    engine_type: Optional[str],
) -> dict[str, Any]:
    record = value if isinstance(value, dict) else {}
    current_step = _as_int(record.get("current_step"), step)
    return {
        "current_step": current_step,
        "start_step": _as_int(record.get("start_step"), current_step + 1),
        "max_steps": _as_int(record.get("max_steps"), max_steps),
        "last_acting_agent": _as_optional_str(record.get("last_acting_agent")),
        "last_step_outcome": _as_optional_str(record.get("last_step_outcome")),
        "engine_type": _as_optional_str(record.get("engine_type")) or engine_type,
    }


def _normalize_replay_cursor(value: Any, step: int) -> dict[str, Any]:
    record = value if isinstance(value, dict) else {}
    replay_cursor = _as_int(record.get("replay_cursor"), 0)
    replay_event_count = _as_int(record.get("replay_event_count"), replay_cursor)
    return {
        "replay_cursor": replay_cursor,
        "replay_event_count": replay_event_count,
        "last_event_id": _as_optional_str(record.get("last_event_id"))
        or (str(replay_cursor) if replay_cursor > 0 else None),
        # Explicit Phase 5 rule: resumed runs get a new simulationId and a fresh
        # live replay stream. This cursor describes the source checkpoint only.
        "resume_behavior": "fork_new_stream",
        "source_step": step,
    }


def _normalize_world_state_refs(
    value: Any,
    *,
    entity_state_keys: list[str],
    has_gm_state: bool,
) -> dict[str, Any]:
    record = value if isinstance(value, dict) else {}
    keys = record.get("entity_state_keys")
    if not isinstance(keys, list):
        keys = list(entity_state_keys)
    return {
        "source": "inline_checkpoint",
        "gm_state_key": _as_optional_str(record.get("gm_state_key")) or ("gm_state" if has_gm_state else None),
        "entity_state_keys": [entry for entry in keys if isinstance(entry, str) and entry],
        "authoritative_snapshot_ref": _as_optional_str(record.get("authoritative_snapshot_ref")),
    }


def _normalize_subsystem_state(value: Any) -> dict[str, list[str]]:
    record = value if isinstance(value, dict) else {}
    resumed = record.get("resumed") if isinstance(record.get("resumed"), list) else None
    reset = record.get("reset") if isinstance(record.get("reset"), list) else None
    return {
        "resumed": [entry for entry in (resumed or _default_subsystem_state()["resumed"]) if isinstance(entry, str)],
        "reset": [entry for entry in (reset or _default_subsystem_state()["reset"]) if isinstance(entry, str)],
    }


def _default_subsystem_state() -> dict[str, list[str]]:
    return {
        "resumed": [
            "gm_state",
            "entity_states",
            "scene_cursor",
            "runtime_cursor",
            "replay_cursor",
            "session_mappings",
            "world_state_refs",
            "memory_namespaces",
        ],
        "reset": [
            "control_port",
            "event_port",
            "pending_responses",
            "live_subscribers",
            "runner_process",
        ],
    }


def _checkpoint_path(
    checkpoint_dir: str,
    *,
    workspace_id: str,
    world_id: str,
    lineage_id: Optional[str],
    simulation_id: str,
    step: int,
) -> Path:
    root = Path(checkpoint_dir)
    lineage_segment = lineage_id or simulation_id
    return (
        root
        / _safe_segment(workspace_id)
        / _safe_segment(world_id)
        / _safe_segment(lineage_segment)
        / _safe_segment(simulation_id)
        / _checkpoint_filename(simulation_id, step)
    )


def _checkpoint_filename(simulation_id: str, step: int) -> str:
    return f"{_safe_segment(simulation_id)}_step_{step}.json"


def _safe_segment(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-")
    return sanitized or "checkpoint"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2, default=str)
        handle.flush()
        os.fsync(handle.fileno())
        temp_name = handle.name
    os.replace(temp_name, path)


def _serialize_state(state: object) -> Any:
    if isinstance(state, dict):
        return {str(k): _serialize_state(v) for k, v in state.items()}
    if isinstance(state, (list, tuple)):
        return [_serialize_state(v) for v in state]
    if isinstance(state, (str, int, float, bool, type(None))):
        return state
    return str(state)


def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _as_int(value: Any, default: int) -> int:
    try:
        if value is None:
            raise ValueError()
        return int(value)
    except Exception:
        return default


def _as_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _as_optional_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None
