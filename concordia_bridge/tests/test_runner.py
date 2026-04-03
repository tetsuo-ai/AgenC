"""Tests for the simulation runner."""

from __future__ import annotations

import builtins
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

from concordia_bridge.bridge_types import (
    AgentConfig,
    SimulationConfig,
    SimulationEvent,
    build_simulation_config,
)
from concordia_bridge.observation_component import FreshObservationComponent
from concordia_bridge.runner import (
    _post_bridge_event,
    _configure_observation_override,
    _resolve_gm_api_key,
    create_embedder,
)


class TestSimulationConfig:
    def test_config_creation(self) -> None:
        config = SimulationConfig(
            world_id="test-world",
            workspace_id="test-ws",
            premise="Test premise",
            agents=[
                AgentConfig(id="a1", name="Agent One", personality="Helpful"),
                AgentConfig(id="a2", name="Agent Two", personality="Curious"),
            ],
            max_steps=10,
        )
        assert config.world_id == "test-world"
        assert len(config.agents) == 2
        assert config.agents[0].name == "Agent One"
        assert config.max_steps == 10

    def test_config_defaults(self) -> None:
        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
        )
        assert config.max_steps == 50
        assert config.gm_model == "grok-3-mini"
        assert config.gm_provider == "ollama"
        assert config.engine_type == "simultaneous"
        assert config.bridge_url == "http://localhost:3200"
        assert config.event_port == 3201
        assert config.control_port == 3202
        assert config.simultaneous_max_workers == 8
        assert config.proxy_action_timeout_seconds == 120.0
        assert config.proxy_action_max_retries == 2
        assert config.proxy_retry_delay_seconds == 2.0
        assert config.reflection_interval == 5
        assert config.consolidation_interval == 20

    def test_agent_config_defaults(self) -> None:
        agent = AgentConfig(id="test", name="Test", personality="Nice")
        assert agent.goal == ""

    def test_build_simulation_config_applies_runtime_budget_overrides(self) -> None:
        config = build_simulation_config(
            {
                "world_id": "world-budget",
                "workspace_id": "ws-budget",
                "premise": "budget premise",
                "simultaneous_max_workers": 3,
                "proxy_action_timeout_seconds": 15.0,
                "proxy_action_max_retries": 1,
                "proxy_retry_delay_seconds": 0.5,
            },
            [],
        )
        assert config.simultaneous_max_workers == 3
        assert config.proxy_action_timeout_seconds == 15.0
        assert config.proxy_action_max_retries == 1
        assert config.proxy_retry_delay_seconds == 0.5


class TestRunnerApiKeyResolution:
    def test_prefers_explicit_config_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("XAI_API_KEY", "env-xai")
        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
            gm_provider="grok",
            gm_api_key="config-key",
        )
        assert _resolve_gm_api_key(config) == "config-key"

    def test_grok_uses_xai_api_key_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("XAI_API_KEY", "env-xai")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
            gm_provider="grok",
        )
        assert _resolve_gm_api_key(config) == "env-xai"

    def test_grok_falls_back_to_openai_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("XAI_API_KEY", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "env-openai")
        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
            gm_provider="grok",
        )
        assert _resolve_gm_api_key(config) == "env-openai"


class TestEmbeddingFallback:
    def test_hash_fallback_embeddings_are_finite_and_normalized(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        original_import = builtins.__import__

        def _import(name, *args, **kwargs):
            if name == "sentence_transformers":
                raise ImportError("not installed")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", _import)

        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
        )
        embedder = create_embedder(config)
        vector = embedder("alice observes the crowded market square")

        assert isinstance(vector, np.ndarray)
        assert vector.shape == (384,)
        assert np.isfinite(vector).all()
        assert pytest.approx(float(np.linalg.norm(vector)), rel=1e-6) == 1.0

    def test_openai_uses_openai_env_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "env-openai")
        config = SimulationConfig(
            world_id="w",
            workspace_id="ws",
            premise="p",
            agents=[],
            gm_provider="openai",
        )
        assert _resolve_gm_api_key(config) == "env-openai"


class TestExampleConfigs:
    def test_medieval_town_imports(self) -> None:
        from concordia_bridge.examples.medieval_town import config
        assert config.world_id == "medieval-town-001"
        assert len(config.agents) == 3
        assert config.agents[0].name == "Elena"
        assert config.agents[1].name == "Marcus"
        assert config.agents[2].name == "Sera"
        assert config.max_steps == 30

    def test_trading_floor_imports(self) -> None:
        from concordia_bridge.examples.trading_floor import config
        assert config.world_id == "trading-floor-001"
        assert len(config.agents) == 4
        assert config.agents[0].name == "Alex"
        assert config.max_steps == 40

    def test_research_lab_imports(self) -> None:
        from concordia_bridge.examples.research_lab import config
        assert config.world_id == "research-lab-001"
        assert len(config.agents) == 3
        assert config.agents[0].name == "Dr. Chen"
        assert config.max_steps == 35

    def test_all_agents_have_goals(self) -> None:
        from concordia_bridge.examples.medieval_town import config as mc
        from concordia_bridge.examples.trading_floor import config as tc
        from concordia_bridge.examples.research_lab import config as rc

        for config in [mc, tc, rc]:
            for agent in config.agents:
                assert agent.goal, f"{agent.name} in {config.world_id} has no goal"

    def test_all_agents_have_unique_ids(self) -> None:
        from concordia_bridge.examples.medieval_town import config as mc
        from concordia_bridge.examples.trading_floor import config as tc
        from concordia_bridge.examples.research_lab import config as rc

        for config in [mc, tc, rc]:
            ids = [a.id for a in config.agents]
            assert len(ids) == len(set(ids)), f"Duplicate IDs in {config.world_id}"


class TestObservationOverride:
    def test_injects_custom_make_observation_component(self) -> None:
        prefab = SimpleNamespace(params={"extra_components": {}})
        players = [
            SimpleNamespace(name="Elena"),
            SimpleNamespace(name="Marcus"),
        ]

        _configure_observation_override(
            prefab=prefab,
            model=object(),
            players=players,
        )

        component = prefab.params["extra_components"]["__make_observation__"]
        assert isinstance(component, FreshObservationComponent)

    def test_noop_when_prefab_has_no_extra_components_slot(self) -> None:
        prefab = SimpleNamespace(params={"name": "conversation rules"})
        players = [SimpleNamespace(name="Elena")]

        _configure_observation_override(
            prefab=prefab,
            model=object(),
            players=players,
        )

        assert prefab.params == {"name": "conversation rules"}


class TestBridgeEventPosting:
    def test_posts_runner_events_to_bridge(self) -> None:
        config = SimulationConfig(
            world_id="test-world",
            workspace_id="test-ws",
            premise="Test premise",
            agents=[],
            simulation_id="sim-bridge",
            bridge_url="http://127.0.0.1:3200",
        )

        with patch("concordia_bridge.runner.requests.post") as mock_post:
            _post_bridge_event(
                config,
                SimulationEvent(
                    type="step",
                    step=4,
                    simulation_id="sim-bridge",
                    world_id="test-world",
                    workspace_id="test-ws",
                    timestamp=123.0,
                ),
            )

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert kwargs["json"]["simulation_id"] == "sim-bridge"
        assert kwargs["json"]["type"] == "step"
