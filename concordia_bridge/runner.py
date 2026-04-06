"""
Simulation runner — configures and runs a Concordia simulation with AgenC agents.

Orchestrates: EventServer, ProxyEntities, GameMaster, InstrumentedEngine,
ControlServer. Provides the main entry point for running simulations.

Phase 3 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Collection, Sequence
from dataclasses import asdict
from typing import Optional

import requests
import openai
from openai import OpenAI

from concordia.associative_memory.basic_associative_memory import AssociativeMemoryBank
from concordia.language_model import language_model
from concordia.typing.entity import Entity

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig, SimulationEvent
from concordia_bridge.proxy_entity import ProxyEntityWithLogging
from concordia_bridge.event_server import EventServer
from concordia_bridge.instrumented_engine import InstrumentedSequentialEngine
from concordia_bridge.instrumented_simultaneous_engine import (
    InstrumentedSimultaneousEngine,
)
from concordia_bridge.observation_component import FreshObservationComponent
from concordia_bridge.control_server import (
    StepController,
    SimulationState,
    start_control_server,
)
from concordia_bridge.checkpoint import save_checkpoint
from concordia_bridge.simulation_identity import (
    apply_identity_to_event,
    identity_from_config,
    with_identity_payload,
)

logger = logging.getLogger(__name__)
_MAX_MULTIPLE_CHOICE_ATTEMPTS = 20

_CHOICE_PREFIX_RE = re.compile(
    r"^\s*(?:option|choice)?\s*[\(\[]?([a-zA-Z])[\)\].:\-]?\s*(.*)$",
    re.IGNORECASE,
)


def _normalize_choice_text(value: str) -> str:
    collapsed = re.sub(r"\s+", " ", value).strip()
    collapsed = collapsed.strip(" \"'`")
    collapsed = collapsed.strip("()[]{}<>")
    collapsed = re.sub(r"[.,!?;:]+$", "", collapsed)
    return collapsed.casefold()


def _match_response_index(
    answer: str,
    responses: Sequence[str],
    labels: Sequence[str] | None = None,
) -> int | None:
    try:
        return responses.index(answer)
    except ValueError:
        pass

    normalized_answer = _normalize_choice_text(answer)
    normalized_responses = [_normalize_choice_text(response) for response in responses]

    for idx, normalized_response in enumerate(normalized_responses):
        if normalized_answer == normalized_response:
            return idx

    prefix_match = _CHOICE_PREFIX_RE.match(answer)
    if prefix_match:
        choice_index = ord(prefix_match.group(1).lower()) - ord("a")
        if 0 <= choice_index < len(responses):
            trailing = _normalize_choice_text(prefix_match.group(2) or "")
            expected = normalized_responses[choice_index]
            if (
                not trailing
                or trailing == expected
                or trailing.startswith(expected)
                or expected.startswith(trailing)
                or len(expected) == 1  # single-letter keys: letter match alone is sufficient
            ):
                return choice_index

    # Colon separator pattern: "Option A: Yes" or "A: Yes"
    colon_match = re.match(
        r"^\s*(?:option\s+)?([a-zA-Z])\s*[:]\s*(.*)$", answer, re.IGNORECASE
    )
    if colon_match:
        choice_index = ord(colon_match.group(1).lower()) - ord("a")
        if 0 <= choice_index < len(responses):
            trailing = _normalize_choice_text(colon_match.group(2) or "")
            expected = normalized_responses[choice_index]
            if (
                not trailing
                or trailing == expected
                or trailing.startswith(expected)
                or expected.startswith(trailing)
            ):
                return choice_index

    contains = [
        idx
        for idx, normalized_response in enumerate(normalized_responses)
        if normalized_response
        and (
            normalized_answer == normalized_response
            or normalized_answer.startswith(normalized_response + " ")
            or normalized_answer.endswith(" " + normalized_response)
            or f" {normalized_response} " in f" {normalized_answer} "
        )
    ]
    if len(contains) == 1:
        return contains[0]

    # When responses are letter keys, try matching against the display labels
    if labels and len(labels) == len(responses):
        normalized_labels = [_normalize_choice_text(label) for label in labels]
        for idx, normalized_label in enumerate(normalized_labels):
            if normalized_label and normalized_answer == normalized_label:
                return idx

    # Semantic yes/no matching for binary choices
    if len(responses) == 2:
        _YES_WORDS = {"yes", "yeah", "yep", "affirmative", "sure", "absolutely", "correct"}
        _NO_WORDS = {"no", "nope", "negative", "nah", "never", "not"}
        answer_words = set(normalized_answer.split())
        for idx, normalized_response in enumerate(normalized_responses):
            if normalized_response in _YES_WORDS and answer_words & _YES_WORDS:
                return idx
            if normalized_response in _NO_WORDS and answer_words & _NO_WORDS:
                return idx

    return None


def _resolve_gm_api_key(config: SimulationConfig) -> str:
    """Resolve the GM API key from config or provider-specific environment."""
    if config.gm_api_key:
        return config.gm_api_key

    provider = config.gm_provider.lower()
    if provider in ("grok", "xai"):
        return os.getenv("XAI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    if provider == "openai":
        return os.getenv("OPENAI_API_KEY", "")
    return ""


class _XAiLanguageModel(language_model.LanguageModel):
    """Minimal xAI/OpenAI-compatible chat model without GPT-5-only params."""

    def __init__(
        self,
        model_name: str,
        *,
        api_key: str,
        api_base: str,
    ) -> None:
        self._model_name = model_name
        self._client = OpenAI(api_key=api_key, base_url=api_base)

    def _sample_text(
        self,
        prompt: str,
        *,
        max_tokens: int = language_model.DEFAULT_MAX_TOKENS,
        temperature: float = 1.0,
        timeout: float = language_model.DEFAULT_TIMEOUT_SECONDS,
        seed: int | None = None,
    ) -> str:
        max_attempts = 3
        last_exc: Exception | None = None
        for attempt in range(max_attempts):
            try:
                response = self._client.chat.completions.create(
                    model=self._model_name,
                    messages=[
                        {
                            "role": "system",
                            "content": "Continue the user's simulation prompt directly and do not repeat it.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                    timeout=timeout,
                    seed=seed,
                )
                break
            except openai.RateLimitError as exc:
                last_exc = exc
                backoff = 2 ** attempt  # 1s, 2s, 4s
                logger.warning(
                    "Rate limited (attempt %d/%d), retrying in %ds: %s",
                    attempt + 1, max_attempts, backoff, exc,
                )
                time.sleep(backoff)
            except openai.APIStatusError as exc:
                last_exc = exc
                if exc.status_code >= 500:
                    backoff = 2 ** attempt
                    logger.warning(
                        "Server error %d (attempt %d/%d), retrying in %ds: %s",
                        exc.status_code, attempt + 1, max_attempts, backoff, exc,
                    )
                    time.sleep(backoff)
                else:
                    raise
        else:
            raise last_exc  # type: ignore[misc]
        content = response.choices[0].message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                text = getattr(item, "text", None)
                if isinstance(text, str):
                    parts.append(text)
            return "".join(parts)
        return ""

    def sample_text(
        self,
        prompt: str,
        *,
        max_tokens: int = language_model.DEFAULT_MAX_TOKENS,
        terminators: Collection[str] = language_model.DEFAULT_TERMINATORS,
        temperature: float = 1.0,
        top_p: float = language_model.DEFAULT_TOP_P,
        top_k: int = language_model.DEFAULT_TOP_K,
        timeout: float = language_model.DEFAULT_TIMEOUT_SECONDS,
        seed: int | None = None,
    ) -> str:
        del terminators, top_p, top_k
        return self._sample_text(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout=timeout,
            seed=seed,
        )

    def sample_choice(
        self,
        prompt: str,
        responses: Sequence[str],
        *,
        seed: int | None = None,
    ) -> tuple[int, str, dict[str, float]]:
        # Concordia's interactive_document passes letter keys ['a','b'] but the
        # prompt already contains labeled options like "(a) Yes\n(b) No".
        # Extract the display labels so we can match bare answers like "No".
        labels: list[str] = []
        for idx in range(len(responses)):
            prefix = f"({chr(ord('a') + idx)}) "
            for line in prompt.splitlines():
                stripped = line.strip()
                if stripped.startswith(prefix):
                    labels.append(stripped[len(prefix):])
                    break
            else:
                labels.append(responses[idx])

        choice_prompt = (
            prompt
            + "\nRespond with the matching option only. Acceptable examples: \"Yes\", \"No\", \"(a) Yes\", \"b\", or \"option c\" when the option list is labeled.\n"
            + "Options:\n"
            + "\n".join(f"({chr(ord('a') + idx)}) {response}" for idx, response in enumerate(responses))
        )
        answer = ""
        for _ in range(_MAX_MULTIPLE_CHOICE_ATTEMPTS):
            answer = self._sample_text(
                choice_prompt,
                temperature=0.0,
                seed=seed,
            ).strip()
            idx = _match_response_index(answer, responses, labels=labels)
            if idx is None:
                continue
            return idx, responses[idx], {}

        raise language_model.InvalidResponseError(
            "Too many multiple choice attempts. Last attempt: " + answer
        )


def create_gm_model(config: SimulationConfig):
    """Create the LLM for the Game Master based on config."""
    provider = config.gm_provider.lower()

    if provider == "ollama":
        from concordia.contrib.language_models.langchain import (
            langchain_ollama_model,
        )

        return langchain_ollama_model.LangchainOllamaLanguageModel(
            model_name=config.gm_model,
        )

    if provider in ("grok", "xai"):
        api_key = _resolve_gm_api_key(config)
        api_base = config.gm_base_url or "https://api.x.ai/v1"
        if not api_key:
            raise ValueError(
                "XAI_API_KEY not found. Please provide it via the api_key "
                "parameter or set the XAI_API_KEY environment variable."
            )
        return _XAiLanguageModel(
            model_name=config.gm_model,
            api_key=api_key,
            api_base=api_base,
        )

    if provider == "openai":
        from concordia.contrib.language_models.openai import gpt_model

        kwargs = {"model_name": config.gm_model}
        api_key = _resolve_gm_api_key(config)
        if api_key:
            kwargs["api_key"] = api_key
        if config.gm_base_url:
            kwargs["api_base"] = config.gm_base_url
        return gpt_model.GptLanguageModel(**kwargs)

    raise ValueError(f"Unsupported GM provider: {provider}")


def create_embedder(config: SimulationConfig):
    """Create an embedding function for the GM's associative memory."""
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(config.embedding_model)
        return lambda text: model.encode(text)
    except ImportError:
        logger.info(
            "sentence-transformers not installed — GM memory will use "
            "lightweight deterministic fallback embeddings"
        )
        import hashlib
        import numpy as np

        def _hash_embed(text: str) -> np.ndarray:
            """Deterministic finite embedding fallback."""
            raw = bytearray()
            seed = text.encode("utf-8")
            while len(raw) < 384:
                seed = hashlib.sha512(seed).digest()
                raw.extend(seed)
            arr = np.frombuffer(raw[:384], dtype=np.uint8).astype(np.float32)
            arr = (arr - 127.5) / 127.5
            norm = np.linalg.norm(arr)
            if norm > 0:
                arr /= norm
            return arr

        return _hash_embed


def run_simulation(
    config: SimulationConfig,
    verbose: bool = False,
    checkpoint: Optional[dict] = None,
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

    identity = identity_from_config(config)

    def emit_event(event: SimulationEvent) -> None:
        event_server.broadcast(event)
        _post_bridge_event(config, event)

    # 1. Start event server
    event_server = EventServer(port=config.event_port)
    event_server.start()

    # 2. Create step controller and control server
    controller = StepController()
    sim_state = SimulationState()
    checkpoint_runtime_cursor = (
        checkpoint.get("runtime_cursor")
        if checkpoint and isinstance(checkpoint.get("runtime_cursor"), dict)
        else {}
    )
    initial_step = (
        max(int(checkpoint_runtime_cursor.get("current_step", checkpoint.get("step", 0))), 0)
        if checkpoint
        else 0
    )
    sim_state.update(
        max_steps=config.max_steps,
        world_id=config.world_id,
        simulation_id=config.simulation_id,
        agent_count=len(config.agents),
        running=True,
        step=initial_step,
        execution_phase="launching",
        last_step_outcome=(
            checkpoint_runtime_cursor.get("last_step_outcome") if checkpoint else None
        ),
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
                simulation_id=identity.simulation_id,
                lineage_id=identity.lineage_id,
                parent_simulation_id=identity.parent_simulation_id,
                timeout_seconds=config.proxy_action_timeout_seconds,
                max_retries=config.proxy_action_max_retries,
                retry_delay_seconds=config.proxy_retry_delay_seconds,
                stop_event=controller.stop_event,
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

        if checkpoint:
            _restore_checkpoint_state(checkpoint, game_master, proxy_entities)

        # 7. Create instrumented engine
        if config.engine_type == "simultaneous":
            engine = InstrumentedSimultaneousEngine(
                event_callback=emit_event,
                bridge_url=config.bridge_url,
                world_id=config.world_id,
                max_workers=config.simultaneous_max_workers,
                simulation_id=identity.simulation_id,
                workspace_id=config.workspace_id,
                lineage_id=identity.lineage_id,
                parent_simulation_id=identity.parent_simulation_id,
            )
        else:
            engine = InstrumentedSequentialEngine(
                event_callback=emit_event,
                bridge_url=config.bridge_url,
                world_id=config.world_id,
                simulation_id=identity.simulation_id,
                workspace_id=config.workspace_id,
                lineage_id=identity.lineage_id,
                parent_simulation_id=identity.parent_simulation_id,
            )

        if checkpoint:
            engine.restore_checkpoint_state(checkpoint, scenes=config.scenes)

        # 8. Run the simulation
        def step_callback(step: int, outcome: str = "resolved") -> None:
            sim_state.update(
                step=step,
                running=not controller.is_stopped,
                last_step_outcome=outcome,
            )
            emit_event(apply_identity_to_event(
                SimulationEvent(
                    type="step",
                    step=step,
                    timestamp=time.time(),
                    world_id=config.world_id,
                    workspace_id=config.workspace_id,
                    metadata={
                        "phase": "step_complete",
                        "outcome": outcome,
                    },
                ),
                identity,
                world_id=config.world_id,
                workspace_id=config.workspace_id,
            ))

        def phase_callback(
            phase: str,
            step: int,
            metadata: Optional[dict] = None,
        ) -> None:
            del metadata
            sim_state.update(
                step=max(sim_state.step, step),
                running=not controller.is_stopped,
                execution_phase=phase,
            )

        def checkpoint_callback(step: int) -> None:
            checkpoint_state = engine.get_checkpoint_state(
                max_steps=config.max_steps,
                replay_event_count=event_server.event_count,
            )
            save_checkpoint(
                config=config,
                step=step,
                game_master=game_master,
                entities=proxy_entities,
                scene_cursor=checkpoint_state.get("scene_cursor"),
                runtime_cursor=checkpoint_state.get("runtime_cursor"),
                replay_cursor=checkpoint_state.get("replay_cursor"),
            )

        try:
            engine.run_loop(
                game_masters=[game_master],
                entities=proxy_entities,
                premise=config.premise,
                max_steps=config.max_steps,
                start_step=(_checkpoint_start_step(checkpoint) if checkpoint else 1),
                step_controller=controller,
                step_callback=step_callback,
                phase_callback=phase_callback,
                checkpoint_callback=checkpoint_callback,
                scenes=config.scenes,
            )
        except Exception as exc:
            sim_state.update(
                running=False,
                paused=False,
                execution_phase="stopped",
                terminal_reason=f"error:{type(exc).__name__}",
                last_step_outcome="failed",
            )
            logger.exception("Simulation run failed")
            raise

        sim_state.update(
            running=False,
            paused=False,
            execution_phase="stopped",
            terminal_reason="stopped" if controller.is_stopped else "completed",
        )

        summary = {
            "world_id": config.world_id,
            "simulation_id": config.simulation_id,
            "steps_completed": sim_state.step,
            "max_steps": config.max_steps,
            "agent_count": len(config.agents),
            "event_count": event_server.event_count,
        }
        logger.info("Simulation complete: %s", summary)
        return summary

    finally:
        controller.stop()
        event_server.stop()
        control_srv.shutdown()
        control_srv.server_close()


def _setup_agents(config: SimulationConfig) -> None:
    """Call the bridge /setup endpoint to configure all agents."""
    try:
        response = requests.post(
            f"{config.bridge_url}/setup",
            json=with_identity_payload({
                "world_id": config.world_id,
                "workspace_id": config.workspace_id,
                "user_id": config.user_id,
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
            }, identity_from_config(config)),
            timeout=30,
        )
        response.raise_for_status()
        logger.info("Agent setup complete: %s", response.json())
    except Exception as exc:
        logger.warning("Agent setup via bridge failed: %s", exc)


def _post_bridge_event(config: SimulationConfig, event: SimulationEvent) -> None:
    """Send a simulation event to the bridge replay/control layer."""
    try:
        requests.post(
            f"{config.bridge_url}/event",
            json=asdict(event),
            timeout=10,
        )
    except Exception as exc:
        logger.warning(
            "Bridge event notification failed (simulation=%s step=%s type=%s): %s",
            config.simulation_id,
            event.step,
            event.type,
            exc,
        )


def _checkpoint_start_step(checkpoint: dict) -> int:
    runtime_cursor = checkpoint.get("runtime_cursor")
    if isinstance(runtime_cursor, dict):
        return max(int(runtime_cursor.get("start_step", checkpoint.get("step", 0) + 1) or 1), 1)
    return max(int(checkpoint.get("step", 0)), 0) + 1


def _restore_checkpoint_state(
    checkpoint: dict,
    game_master: Entity,
    proxy_entities: Sequence[ProxyEntityWithLogging],
) -> None:
    """Restore GM and proxy entity state from a checkpoint payload."""
    gm_state = checkpoint.get("gm_state")
    if gm_state and hasattr(game_master, "set_state"):
        try:
            game_master.set_state(gm_state)
        except Exception as exc:
            logger.warning("Failed to restore game master state: %s", exc)

    entity_states = checkpoint.get("entity_states", {})
    if not isinstance(entity_states, dict):
        entity_states = {}

    for entity in proxy_entities:
        state = entity_states.get(entity.name)
        if not isinstance(state, dict):
            continue
        try:
            entity.set_state(state)
        except Exception as exc:
            logger.warning("Failed to restore state for %s: %s", entity.name, exc)


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

    def _build_prefab(prefab_module, description: str) -> Entity:
        prefab_cls = getattr(prefab_module, "GameMaster", None)
        if prefab_cls is None:
            raise AttributeError(f"{prefab_module.__name__} has no GameMaster prefab")

        prefab = prefab_cls(
            description=description,
            entities=players,
        )
        _configure_observation_override(prefab, model, players)
        if not hasattr(prefab, "build"):
            raise TypeError(f"{prefab_module.__name__}.GameMaster is not buildable")
        return prefab.build(model=model, memory_bank=memory_bank)

    try:
        if prefab_name == "generic":
            from concordia.prefabs.game_master import generic as gm_mod
            return _build_prefab(gm_mod, "A general purpose game master.")
        elif prefab_name == "dialogic":
            try:
                from concordia.prefabs.game_master import dialogic as gm_mod
                return _build_prefab(
                    gm_mod,
                    "A game master specialized for handling conversation.",
                )
            except (ImportError, AttributeError):
                logger.warning("Dialogic GM prefab not available — falling back to generic")
                from concordia.prefabs.game_master import generic as gm_mod
                return _build_prefab(gm_mod, "A general purpose game master.")
        elif prefab_name == "situated":
            try:
                from concordia.prefabs.game_master import situated as gm_mod
                return _build_prefab(
                    gm_mod,
                    "A general game master for games set in a specific location.",
                )
            except (ImportError, AttributeError):
                logger.warning("Situated GM prefab not available — falling back to generic")
                from concordia.prefabs.game_master import generic as gm_mod
                return _build_prefab(gm_mod, "A general purpose game master.")
        else:
            logger.warning("Unknown GM prefab '%s' — falling back to generic", prefab_name)
            from concordia.prefabs.game_master import generic as gm_mod
            return _build_prefab(gm_mod, "A general purpose game master.")
    except (ImportError, TypeError, AttributeError) as exc:
        logger.warning(
            "Failed to build GM via prefab (%s) — using fallback", exc,
        )
        return _FallbackGameMaster(model, memory_bank, config.gm_instructions)


def _configure_observation_override(
    prefab: object,
    model,
    players: Sequence[Entity],
) -> None:
    """Inject the custom observation component into prefabs that support it."""
    params = getattr(prefab, "params", None)
    if params is None:
        return

    try:
        params_dict = dict(params)
    except TypeError:
        return

    if "extra_components" not in params_dict:
        return

    from concordia.components import game_master as gm_components

    component_key = (
        gm_components.make_observation.DEFAULT_MAKE_OBSERVATION_COMPONENT_KEY
    )
    extra_components = dict(params_dict.get("extra_components", {}))
    extra_components[component_key] = FreshObservationComponent(
        model=model,
        player_names=[entity.name for entity in players],
        components=[
            "instructions",
            "player_characters",
            "relevant_memories",
            "display_events",
        ],
        reformat_observations_in_specified_style=(
            "The format to use when describing the "
            'current situation to a player is: "//date or time//situation description".'
        ),
    )
    params_dict["extra_components"] = extra_components
    setattr(prefab, "params", params_dict)


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
