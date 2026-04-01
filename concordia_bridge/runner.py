"""
Simulation runner — configures and runs a Concordia simulation with AgenC agents.

Orchestrates: EventServer, ProxyEntities, GameMaster, InstrumentedEngine,
ControlServer. Provides the main entry point for running simulations.

Phase 3 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import requests

from concordia.associative_memory.basic_associative_memory import AssociativeMemoryBank
from concordia.typing.entity import Entity

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig, SimulationEvent
from concordia_bridge.proxy_entity import ProxyEntityWithLogging
from concordia_bridge.event_server import EventServer
from concordia_bridge.instrumented_engine import InstrumentedSequentialEngine
from concordia_bridge.control_server import (
    StepController,
    SimulationState,
    start_control_server,
)

logger = logging.getLogger(__name__)


def create_gm_model(config: SimulationConfig):
    """Create the LLM for the Game Master based on config."""
    provider = config.gm_provider.lower()

    if provider == "ollama":
        from concordia.language_model import ollama_model
        return ollama_model.OllamaLanguageModel(model_name=config.gm_model)

    if provider in ("openai", "grok", "xai"):
        from concordia.language_model import gpt_model
        kwargs = {"model_name": config.gm_model}
        if config.gm_api_key:
            kwargs["api_key"] = config.gm_api_key
        if config.gm_base_url:
            kwargs["base_url"] = config.gm_base_url
        elif provider in ("grok", "xai"):
            kwargs["base_url"] = "https://api.x.ai/v1"
        return gpt_model.GptLanguageModel(**kwargs)

    raise ValueError(f"Unsupported GM provider: {provider}")


def create_embedder(config: SimulationConfig):
    """Create an embedding function for the GM's associative memory."""
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(config.embedding_model)
        return lambda text: model.encode(text)
    except ImportError:
        logger.warning(
            "sentence-transformers not installed — GM memory will use "
            "hash-based embeddings (low quality). Install with: "
            "pip install sentence-transformers"
        )
        import hashlib
        import numpy as np

        def _hash_embed(text: str) -> np.ndarray:
            """Deterministic hash-based embedding fallback."""
            raw = hashlib.sha512(text.encode("utf-8")).digest()
            while len(raw) < 384 * 4:
                raw += hashlib.sha512(raw).digest()
            arr = np.frombuffer(raw[: 384 * 4], dtype=np.float32).copy()
            norm = np.linalg.norm(arr)
            if norm > 0:
                arr /= norm
            return arr

        return _hash_embed


def run_simulation(
    config: SimulationConfig,
    verbose: bool = False,
) -> dict:
    """Run a complete Concordia simulation with AgenC agents.

    Returns a summary dict with step count, agent count, and event count.
    """
    logger.info(
        "Starting simulation: world=%s agents=%d steps=%d",
        config.world_id,
        len(config.agents),
        config.max_steps,
    )

    # 1. Start event server
    event_server = EventServer(port=config.event_port)
    event_server.start()

    # 2. Create step controller and control server
    controller = StepController()
    sim_state = SimulationState()
    sim_state.update(
        max_steps=config.max_steps,
        world_id=config.world_id,
        agent_count=len(config.agents),
        running=True,
    )
    control_srv = start_control_server(
        controller, sim_state, port=config.control_port,
    )

    try:
        # 3. Setup agents via the bridge
        _setup_agents(config)

        # 4. Create proxy entities
        proxy_entities = [
            ProxyEntityWithLogging(
                agent_name=agent.name,
                bridge_url=config.bridge_url,
                agent_id=agent.id,
                world_id=config.world_id,
                workspace_id=config.workspace_id,
            )
            for agent in config.agents
        ]

        # 5. Create GM model and memory
        model = create_gm_model(config)
        embedder = create_embedder(config)
        gm_memory = AssociativeMemoryBank(
            sentence_embedder=embedder,
            allow_duplicates=True,
        )

        # 6. Build Game Master
        game_master = _build_game_master(config, model, gm_memory, proxy_entities)

        # 7. Create instrumented engine
        engine = InstrumentedSequentialEngine(
            event_callback=event_server.broadcast,
            bridge_url=config.bridge_url,
            world_id=config.world_id,
        )

        # 8. Run the simulation
        def step_callback(step: int) -> None:
            sim_state.update(step=step)
            event_server.broadcast(SimulationEvent(
                type="step",
                step=step,
                timestamp=time.time(),
                metadata={"phase": "step_complete"},
            ))

        engine.run_loop(
            game_masters=[game_master],
            entities=proxy_entities,
            premise=config.premise,
            max_steps=config.max_steps,
            step_controller=controller,
            step_callback=step_callback,
            scenes=config.scenes,
        )

        sim_state.update(running=False)

        summary = {
            "world_id": config.world_id,
            "steps_completed": sim_state.step,
            "max_steps": config.max_steps,
            "agent_count": len(config.agents),
            "event_count": event_server.event_count,
        }
        logger.info("Simulation complete: %s", summary)
        return summary

    finally:
        event_server.stop()
        control_srv.shutdown()


def _setup_agents(config: SimulationConfig) -> None:
    """Call the bridge /setup endpoint to configure all agents."""
    try:
        response = requests.post(
            f"{config.bridge_url}/setup",
            json={
                "world_id": config.world_id,
                "workspace_id": config.workspace_id,
                "agents": [
                    {
                        "agent_id": agent.id,
                        "agent_name": agent.name,
                        "personality": agent.personality,
                        "goal": agent.goal,
                    }
                    for agent in config.agents
                ],
                "premise": config.premise,
            },
            timeout=30,
        )
        response.raise_for_status()
        logger.info("Agent setup complete: %s", response.json())
    except Exception as exc:
        logger.warning("Agent setup via bridge failed: %s", exc)


def _build_game_master(
    config: SimulationConfig,
    model,
    memory_bank: AssociativeMemoryBank,
    players: list[Entity],
) -> Entity:
    """Build the Game Master entity using Concordia prefabs (Phase 7.5).

    Supports prefab selection via config.gm_prefab:
    - "generic" (default): full event resolution with chain of thought
    - "dialogic": pure conversation, no physical actions
    - "situated": location tracking
    - Other values: fall back to generic, then to _FallbackGameMaster
    """
    prefab_name = config.gm_prefab or "generic"
    gm_kwargs = dict(
        model=model,
        memory=memory_bank,
        players=players,
        update_thought_chain=[],
        player_observes_event=False,
    )

    try:
        if prefab_name == "generic":
            from concordia.prefabs.game_master import generic as gm_mod
            return gm_mod.GenericGameMaster(**gm_kwargs)
        elif prefab_name == "dialogic":
            try:
                from concordia.prefabs.game_master import dialogic as gm_mod
                return gm_mod.DialogicGameMaster(**gm_kwargs)
            except (ImportError, AttributeError):
                logger.warning("Dialogic GM prefab not available — falling back to generic")
                from concordia.prefabs.game_master import generic as gm_mod
                return gm_mod.GenericGameMaster(**gm_kwargs)
        elif prefab_name == "situated":
            try:
                from concordia.prefabs.game_master import situated as gm_mod
                return gm_mod.SituatedGameMaster(**gm_kwargs)
            except (ImportError, AttributeError):
                logger.warning("Situated GM prefab not available — falling back to generic")
                from concordia.prefabs.game_master import generic as gm_mod
                return gm_mod.GenericGameMaster(**gm_kwargs)
        else:
            logger.warning("Unknown GM prefab '%s' — falling back to generic", prefab_name)
            from concordia.prefabs.game_master import generic as gm_mod
            return gm_mod.GenericGameMaster(**gm_kwargs)
    except (ImportError, TypeError) as exc:
        logger.warning(
            "Failed to build GM via prefab (%s) — using fallback", exc,
        )
        return _FallbackGameMaster(model, memory_bank, config.gm_instructions)


class _FallbackGameMaster:
    """Minimal GM implementation when Concordia prefabs aren't compatible."""

    def __init__(self, model, memory, instructions: str) -> None:
        self._model = model
        self._memory = memory
        self._instructions = instructions
        self._name = "GameMaster"
        self._observations: list[str] = []

    @property
    def name(self) -> str:
        return self._name

    def act(self, action_spec) -> str:
        from concordia.typing.entity import OutputType

        if action_spec.output_type == OutputType.SKIP_THIS_STEP:
            return ""

        prompt_parts = [self._instructions] + self._observations[-10:]
        prompt = "\n".join(prompt_parts) + "\n" + action_spec.call_to_action

        if action_spec.output_type in (
            OutputType.CHOICE,
            OutputType.NEXT_ACTING,
            OutputType.TERMINATE,
            OutputType.NEXT_GAME_MASTER,
        ):
            try:
                idx, text, _ = self._model.sample_choice(prompt, list(action_spec.options))
                return text
            except Exception as exc:
                logger.warning("sample_choice failed: %s — returning first option", exc)
                return list(action_spec.options)[0] if action_spec.options else ""
        else:
            return self._model.sample_text(prompt, max_tokens=500)

    def observe(self, observation: str) -> None:
        self._observations.append(observation)
        self._memory.add(observation)
        if len(self._observations) > 50:
            self._observations = self._observations[-50:]
