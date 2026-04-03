"""Tests for checkpoint save/load."""

from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig
from concordia_bridge.checkpoint import (
    CHECKPOINT_VERSION,
    save_checkpoint,
    load_checkpoint,
    list_checkpoints,
    simulation_config_from_checkpoint,
)


class MockEntity:
    def __init__(self, name: str):
        self._name = name
        self._last_log = {"action": "test action"}

    @property
    def name(self):
        return self._name

    def get_last_log(self):
        return self._last_log

    def get_state(self):
        return {"turn_count": 3, "last_log": self._last_log}


@pytest.fixture
def tmp_checkpoint_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.fixture
def sample_config():
    return SimulationConfig(
        world_id="test-world",
        workspace_id="test-ws",
        premise="Test premise",
        agents=[
            AgentConfig(id="a1", name="Alice", personality="Helpful"),
            AgentConfig(id="a2", name="Bob", personality="Curious"),
        ],
        simulation_id="sim-123",
        lineage_id="lineage-123",
        parent_simulation_id=None,
        max_steps=20,
        bridge_url="http://localhost:1",
    )


class TestCheckpoint:
    def test_save_creates_file(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice"), MockEntity("Bob")]
        filepath = save_checkpoint(
            sample_config, step=5, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        assert os.path.exists(filepath)
        assert "sim-123_step_5.json" in filepath

    def test_save_contains_correct_data(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        filepath = save_checkpoint(
            sample_config, step=3, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        with open(filepath, encoding="utf-8") as f:
            data = json.load(f)

        assert data["version"] == CHECKPOINT_VERSION
        assert data["world_id"] == "test-world"
        assert data["simulation_id"] == "sim-123"
        assert data["lineage_id"] == "lineage-123"
        assert data["step"] == 3
        assert "Alice" in data["entity_logs"]
        assert data["entity_logs"]["Alice"]["action"] == "test action"
        assert data["entity_states"]["Alice"]["turn_count"] == 3

    def test_save_persists_bridge_enriched_manifest(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]

        class _Response:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self):
                return None

            def json(self):
                return self._payload

        def _fake_post(*_args, **kwargs):
            manifest = dict(kwargs["json"]["checkpoint_manifest"])
            manifest["restored_sessions"] = [{
                "agent_id": "a1",
                "agent_name": "Alice",
                "session_id": "session-a1",
                "simulation_id": "sim-123",
                "turn_count": 3,
                "last_action": "Inspect the square",
            }]
            manifest["memory_namespace_refs"] = {
                "effective_storage_key": "world:test-world::lineage:lineage-123",
            }
            return _Response({"checkpoint_manifest": manifest})

        with patch("concordia_bridge.checkpoint.requests.post", side_effect=_fake_post):
            filepath = save_checkpoint(
                sample_config,
                step=6,
                game_master=object(),
                entities=entities,
                checkpoint_dir=tmp_checkpoint_dir,
                scene_cursor={
                    "scene_index": 1,
                    "scene_round": 2,
                    "current_scene_name": "market",
                },
                runtime_cursor={
                    "current_step": 6,
                    "start_step": 7,
                    "max_steps": 20,
                    "last_step_outcome": "resolved",
                    "engine_type": "simultaneous",
                },
                replay_cursor={
                    "replay_cursor": 15,
                    "replay_event_count": 15,
                    "last_event_id": "15",
                },
            )

        loaded = load_checkpoint(filepath)
        assert loaded is not None
        assert loaded["scene_cursor"]["scene_index"] == 1
        assert loaded["runtime_cursor"]["start_step"] == 7
        assert loaded["replay_cursor"]["replay_cursor"] == 15
        assert loaded["restored_sessions"][0]["session_id"] == "session-a1"
        assert loaded["memory_namespace_refs"]["effective_storage_key"] == "world:test-world::lineage:lineage-123"

    def test_load_returns_checkpoint(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        filepath = save_checkpoint(
            sample_config, step=7, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        loaded = load_checkpoint(filepath)
        assert loaded is not None
        assert loaded["step"] == 7
        assert loaded["world_id"] == "test-world"
        assert loaded["simulation_id"] == "sim-123"

    def test_load_returns_none_for_missing(self) -> None:
        result = load_checkpoint("/nonexistent/path.json")
        assert result is None

    def test_load_migrates_legacy_world_scoped_checkpoint(self, tmp_checkpoint_dir) -> None:
        legacy_path = os.path.join(tmp_checkpoint_dir, "legacy.json")
        with open(legacy_path, "w", encoding="utf-8") as f:
            json.dump({
                "version": 1,
                "world_id": "legacy-world",
                "step": 2,
                "config": {
                    "world_id": "legacy-world",
                    "workspace_id": "legacy-ws",
                    "premise": "Legacy premise",
                    "agents": [],
                },
            }, f)

        loaded = load_checkpoint(legacy_path)
        assert loaded is not None
        assert loaded["version"] == CHECKPOINT_VERSION
        assert loaded["simulation_id"] == "legacy-world"
        assert loaded["config"]["simulation_id"] == "legacy-world"

    def test_list_checkpoints_sorted_and_filterable_by_simulation(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        for step in [3, 1, 5, 2]:
            save_checkpoint(
                sample_config, step=step, game_master=object(),
                entities=entities, checkpoint_dir=tmp_checkpoint_dir,
            )

        other_config = SimulationConfig(
            world_id="test-world",
            workspace_id="test-ws",
            premise="Other premise",
            agents=[AgentConfig(id="b1", name="Bea", personality="Brave")],
            simulation_id="sim-999",
            max_steps=10,
            bridge_url="http://localhost:1",
        )
        save_checkpoint(
            other_config, step=4, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )

        cps = list_checkpoints("test-world", tmp_checkpoint_dir, simulation_id="sim-123")
        assert len(cps) == 4
        assert [c["step"] for c in cps] == [1, 2, 3, 5]
        assert {c["simulation_id"] for c in cps} == {"sim-123"}

    def test_list_checkpoints_empty_dir(self, tmp_checkpoint_dir) -> None:
        cps = list_checkpoints("nonexistent", tmp_checkpoint_dir)
        assert cps == []

    def test_list_checkpoints_filters_by_lineage_in_nested_layout(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        save_checkpoint(
            sample_config, step=1, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )

        other_lineage = SimulationConfig(
            world_id="test-world",
            workspace_id="test-ws",
            premise="Other premise",
            agents=[AgentConfig(id="a1", name="Alice", personality="Helpful")],
            simulation_id="sim-777",
            lineage_id="lineage-777",
            max_steps=5,
            bridge_url="http://localhost:1",
        )
        save_checkpoint(
            other_lineage, step=2, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )

        cps = list_checkpoints("test-world", tmp_checkpoint_dir, lineage_id="lineage-123")
        assert len(cps) == 1
        assert cps[0]["simulation_id"] == "sim-123"

    def test_simulation_config_from_checkpoint_discards_old_ports(self, tmp_checkpoint_dir, sample_config) -> None:
        portful_config = SimulationConfig(
            **{**sample_config.__dict__, "event_port": 4101, "control_port": 4102}
        )
        entities = [MockEntity("Alice")]
        filepath = save_checkpoint(
            portful_config, step=4, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        checkpoint = load_checkpoint(filepath)
        assert checkpoint is not None

        config = simulation_config_from_checkpoint(checkpoint)
        assert config.event_port == 3201
        assert config.control_port == 3202

    def test_simulation_config_from_checkpoint(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        filepath = save_checkpoint(
            sample_config, step=4, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        checkpoint = load_checkpoint(filepath)
        assert checkpoint is not None

        config = simulation_config_from_checkpoint(checkpoint)
        assert config.world_id == "test-world"
        assert config.workspace_id == "test-ws"
        assert config.simulation_id == "sim-123"
        assert config.lineage_id == "lineage-123"
        assert len(config.agents) == 2
