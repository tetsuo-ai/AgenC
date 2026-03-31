"""Tests for the simulation runner."""

from __future__ import annotations

import pytest

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig


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
        assert config.engine_type == "sequential"
        assert config.bridge_url == "http://localhost:3200"
        assert config.event_port == 3201
        assert config.control_port == 3202
        assert config.reflection_interval == 5
        assert config.consolidation_interval == 20

    def test_agent_config_defaults(self) -> None:
        agent = AgentConfig(id="test", name="Test", personality="Nice")
        assert agent.goal == ""


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
