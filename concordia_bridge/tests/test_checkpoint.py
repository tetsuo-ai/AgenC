"""Tests for checkpoint save/load."""

from __future__ import annotations

import json
import os
import tempfile

import pytest

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig
from concordia_bridge.checkpoint import (
    save_checkpoint,
    load_checkpoint,
    list_checkpoints,
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
        max_steps=20,
        bridge_url="http://localhost:1",  # No real bridge needed
    )


class TestCheckpoint:
    def test_save_creates_file(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice"), MockEntity("Bob")]
        filepath = save_checkpoint(
            sample_config, step=5, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        assert os.path.exists(filepath)
        assert "test-world_step_5.json" in filepath

    def test_save_contains_correct_data(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        filepath = save_checkpoint(
            sample_config, step=3, game_master=object(),
            entities=entities, checkpoint_dir=tmp_checkpoint_dir,
        )
        with open(filepath) as f:
            data = json.load(f)

        assert data["version"] == 1
        assert data["world_id"] == "test-world"
        assert data["step"] == 3
        assert "Alice" in data["entity_logs"]
        assert data["entity_logs"]["Alice"]["action"] == "test action"

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

    def test_load_returns_none_for_missing(self) -> None:
        result = load_checkpoint("/nonexistent/path.json")
        assert result is None

    def test_list_checkpoints_sorted(self, tmp_checkpoint_dir, sample_config) -> None:
        entities = [MockEntity("Alice")]
        for step in [3, 1, 5, 2]:
            save_checkpoint(
                sample_config, step=step, game_master=object(),
                entities=entities, checkpoint_dir=tmp_checkpoint_dir,
            )
        cps = list_checkpoints("test-world", tmp_checkpoint_dir)
        assert len(cps) == 4
        assert [c["step"] for c in cps] == [1, 2, 3, 5]

    def test_list_checkpoints_empty_dir(self, tmp_checkpoint_dir) -> None:
        cps = list_checkpoints("nonexistent", tmp_checkpoint_dir)
        assert cps == []
