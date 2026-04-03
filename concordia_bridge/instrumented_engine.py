"""
Instrumented Concordia engine — emits real-time simulation events.

Wraps Concordia's Sequential engine to broadcast observation, action,
resolution, and termination events to the EventServer for live viewer streaming.

Also notifies the AgenC bridge about resolved events so it can record
social memory interactions.

Phase 2 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence, TypedDict

import requests

from concordia.components.game_master import next_acting as next_acting_components
from concordia.typing.entity import Entity, ActionSpec, OutputType
from concordia.environment.engine import Engine
from concordia.environment import engine as engine_lib

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.simulation_identity import (
    SimulationIdentity,
    apply_identity_to_event,
)

logger = logging.getLogger(__name__)

_DEFAULT_CALL_TO_NEXT_ACTION_SPEC = (
    "In what action spec format should {name} respond? Respond in "
    " one of the provided formats and use no additional words."
)


_PROMPT_ECHO_RE = re.compile(
    r"(?:with one short plain-text description of your immediate next action|"
    r"do not include your name|"
    r"what would [^.?!]+ do next\??|"
    r"give one specific, concrete action)",
    re.IGNORECASE,
)
_TURN_CONTROL_RE = re.compile(
    r"\*?\*?[A-Za-z0-9 _'-]+(?:'s)? turn is complete\.\*?\*?"
    r"|It is now \*?\*?[A-Za-z0-9 _'-]+(?:'s)? turn to act\*?\*?\.?"
    r"|What does [A-Za-z0-9 _'-]+ do\?"
    r"|\[/?(?:observation|putative_event|event)\]"
    r"|\*\[[^\]]+\]\*",
    re.IGNORECASE,
)
_MARKDOWN_EMPHASIS_RE = re.compile(r"\*\*([^*]+)\*\*")


def is_invalid_agent_action(action: str) -> bool:
    normalized = action.strip()
    if not normalized:
        return True
    lowered = normalized.lower()
    return (
        bool(_PROMPT_ECHO_RE.search(normalized))
        or lowered.endswith("hesitates.")
        or "hesitates and does nothing" in lowered
    )


def sanitize_story_text(text: str) -> str:
    cleaned = _TURN_CONTROL_RE.sub("", text)
    cleaned = _MARKDOWN_EMPHASIS_RE.sub(r"\1", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([.,!?;:])", r"\1", cleaned)
    return cleaned.strip()


@dataclass
class _SceneState:
    index: int = 0
    round: int = 0
    current: object | None = None
    introduced_index: int = -1
    emitted_round_events: set[str] = field(default_factory=set)


CheckpointCallback = Optional[Callable[[int], None]]
StepCallback = Optional[Callable[..., None]]
PhaseCallback = Optional[Callable[[str, int, Optional[dict]], None]]
LoopStepDisposition = str


class RunLoopOptions(TypedDict, total=False):
    premise: str
    max_steps: int
    verbose: bool
    log: bool
    checkpoint_callback: CheckpointCallback
    step_controller: object
    step_callback: StepCallback
    phase_callback: PhaseCallback
    scenes: Optional[list]
    start_step: int


class InstrumentedSequentialEngine(Engine):
    """Sequential simulation engine with event hooks for real-time streaming.

    Overrides the base Engine methods to emit SimulationEvents at each
    phase of the simulation loop. Also posts resolved events to the
    AgenC bridge for social memory recording.
    """

    def __init__(
        self,
        event_callback: Callable[[SimulationEvent], None],
        bridge_url: str = "http://localhost:3200",
        world_id: str = "default",
        simulation_id: str = "",
        workspace_id: str = "",
        lineage_id: Optional[str] = None,
        parent_simulation_id: Optional[str] = None,
        call_to_make_observation: str = (
            "What is the current situation faced by {name}? "
            "What do they now observe? Only include information of which "
            "they are aware."
        ),
        call_to_next_acting: str = "Who is next to act?",
        call_to_next_action_spec: str = _DEFAULT_CALL_TO_NEXT_ACTION_SPEC,
        call_to_resolve: str = (
            "Describe only the concrete world outcome caused by the putative event. "
            "Do not mention turn order, whose turn is next, prompts, instructions, "
            "or simulation control text."
        ),
        call_to_check_termination: str = "Is the game/simulation finished?",
    ) -> None:
        self._raw_event_callback = event_callback
        del bridge_url
        self._world_id = world_id
        self._identity = SimulationIdentity(
            simulation_id=simulation_id,
            lineage_id=lineage_id,
            parent_simulation_id=parent_simulation_id,
        )
        self._workspace_id = workspace_id
        self._event_callback = lambda event: self._raw_event_callback(self._decorate_event(event))
        self._call_to_make_observation = call_to_make_observation
        self._call_to_next_acting = call_to_next_acting
        self._call_to_next_action_spec = call_to_next_action_spec
        self._call_to_resolve = call_to_resolve
        self._call_to_check_termination = call_to_check_termination
        self._current_step = 0
        self._last_acting_entity_name: Optional[str] = None
        self._last_step_outcome: Optional[str] = None
        self._scene_state: Optional[_SceneState] = None
        self._premise_emitted = False

    def _emit_premise(
        self,
        game_master: Entity,
        premise: str,
        start_step: int,
    ) -> None:
        if not premise:
            return
        if start_step > 1 or self._premise_emitted:
            self._premise_emitted = True
            return
        game_master.observe(f"[event] {premise}")
        self._premise_emitted = True
        self._event_callback(SimulationEvent(
            type="step",
            step=0,
            timestamp=time.time(),
            content=premise,
            metadata={"phase": "premise"},
        ))

    def _scene_value(
        self,
        scene: object | None,
        key: str,
    ) -> object | None:
        if scene is None:
            return None
        if isinstance(scene, dict):
            return scene.get(key)
        return getattr(scene, key, None)

    def _scene_name(self, scene: object, fallback_index: int) -> str:
        direct_name = self._scene_value(scene, "name")
        if isinstance(direct_name, str) and direct_name:
            return direct_name
        scene_type = self._scene_value(scene, "scene_type")
        if isinstance(scene_type, dict):
            name = scene_type.get("name")
            if isinstance(name, str) and name:
                return name
        return str(fallback_index)

    def _scene_id(self, scene: object | None, fallback_index: int) -> str:
        value = self._scene_value(scene, "scene_id")
        if isinstance(value, str) and value:
            return value
        return f"scene-{fallback_index + 1}"

    def _scene_zone_id(self, scene: object | None, fallback_index: int) -> str:
        value = self._scene_value(scene, "zone_id")
        if isinstance(value, str) and value:
            return value
        return self._scene_id(scene, fallback_index)

    def _scene_location_id(self, scene: object | None, fallback_index: int) -> str:
        value = self._scene_value(scene, "location_id")
        if isinstance(value, str) and value:
            return value
        return f"{self._scene_zone_id(scene, fallback_index)}:center"

    def _scene_time_of_day(self, scene: object | None) -> str | None:
        value = self._scene_value(scene, "time_of_day")
        return value if isinstance(value, str) and value else None

    def _scene_day_index(self, scene: object | None) -> int | None:
        value = self._scene_value(scene, "day_index")
        if isinstance(value, int):
            return value
        return None

    def _scene_description(self, scene: object | None) -> str | None:
        value = self._scene_value(scene, "description")
        return value if isinstance(value, str) and value else None

    def _scene_gm_instructions(self, scene: object | None) -> str | None:
        value = self._scene_value(scene, "gm_instructions")
        return value if isinstance(value, str) and value else None

    def _scene_world_events(self, scene: object | None) -> list[object]:
        value = self._scene_value(scene, "world_events")
        return list(value) if isinstance(value, list) else []

    def _world_event_trigger_round(self, raw_event: object) -> int:
        if isinstance(raw_event, dict):
            value = raw_event.get("trigger_round")
        else:
            value = getattr(raw_event, "trigger_round", None)
        return value if isinstance(value, int) and value > 0 else 1

    def _world_event_summary(self, raw_event: object) -> str | None:
        if isinstance(raw_event, dict):
            value = raw_event.get("summary")
        else:
            value = getattr(raw_event, "summary", None)
        return value if isinstance(value, str) and value else None

    def _world_event_observation(self, raw_event: object) -> str | None:
        if isinstance(raw_event, dict):
            value = raw_event.get("observation")
        else:
            value = getattr(raw_event, "observation", None)
        return value if isinstance(value, str) and value else None

    def _world_event_id(
        self,
        raw_event: object,
        scene: object | None,
        scene_index: int,
        event_index: int,
    ) -> str:
        if isinstance(raw_event, dict):
            value = raw_event.get("event_id")
        else:
            value = getattr(raw_event, "event_id", None)
        if isinstance(value, str) and value:
            return value
        scene_id = self._scene_id(scene, scene_index)
        return f"{scene_id}-event-{event_index + 1}"

    def _world_event_metadata(self, raw_event: object) -> dict:
        if isinstance(raw_event, dict):
            value = raw_event.get("metadata")
        else:
            value = getattr(raw_event, "metadata", None)
        return dict(value) if isinstance(value, dict) else {}

    def _scene_metadata(
        self,
        scene: object | None,
        scene_index: int,
    ) -> dict[str, object]:
        return {
            "scene_id": self._scene_id(scene, scene_index),
            "scene_name": self._scene_name(scene, scene_index),
            "zone_id": self._scene_zone_id(scene, scene_index),
            "location_id": self._scene_location_id(scene, scene_index),
            "time_of_day": self._scene_time_of_day(scene),
            "day_index": self._scene_day_index(scene),
        }

    def _scene_intro_text(
        self,
        scene: object | None,
        scene_index: int,
    ) -> str | None:
        if scene is None:
            return None
        scene_name = self._scene_name(scene, scene_index)
        description = self._scene_description(scene)
        parts = [f"Scene {scene_name} begins."]
        if description:
            parts.append(description)
        time_of_day = self._scene_time_of_day(scene)
        if time_of_day:
            parts.append(f"It is currently {time_of_day}.")
        return " ".join(part.strip() for part in parts if part and part.strip())

    def _emit_scene_intro(
        self,
        game_master: Entity,
        step: int,
        scene: object | None,
        scene_index: int,
        scene_state: _SceneState,
    ) -> None:
        if scene is None or scene_state.introduced_index == scene_index:
            return
        intro = self._scene_intro_text(scene, scene_index)
        if intro:
            game_master.observe(f"[event] {intro}")
        gm_instructions = self._scene_gm_instructions(scene)
        if gm_instructions:
            game_master.observe(f"[event] GM guidance: {gm_instructions}")
        self._event_callback(SimulationEvent(
            type="scene_change",
            step=step,
            timestamp=time.time(),
            scene=self._scene_name(scene, scene_index),
            content=intro or f"Scene started: {scene_index}",
            metadata=self._scene_metadata(scene, scene_index),
        ))
        scene_state.introduced_index = scene_index

    def _emit_scene_round_events(
        self,
        game_master: Entity,
        step: int,
        scene_state: _SceneState,
    ) -> None:
        if scene_state.current is None:
            return
        for event_index, raw_event in enumerate(self._scene_world_events(scene_state.current)):
            trigger_round = self._world_event_trigger_round(raw_event)
            if trigger_round != scene_state.round:
                continue
            event_key = f"{scene_state.index}:{scene_state.round}:{event_index}"
            if event_key in scene_state.emitted_round_events:
                continue
            summary = self._world_event_summary(raw_event)
            if not summary:
                continue
            observation = self._world_event_observation(raw_event) or summary
            game_master.observe(f"[event] {observation}")
            metadata = {
                **self._scene_metadata(scene_state.current, scene_state.index),
                **self._world_event_metadata(raw_event),
                "trigger_round": trigger_round,
                "world_event_id": self._world_event_id(
                    raw_event,
                    scene_state.current,
                    scene_state.index,
                    event_index,
                ),
            }
            self._event_callback(SimulationEvent(
                type="world_event",
                step=step,
                timestamp=time.time(),
                scene=self._scene_name(scene_state.current, scene_state.index),
                content=summary,
                metadata=metadata,
            ))
            scene_state.emitted_round_events.add(event_key)

    def _initialize_scene_state(
        self,
        scenes: Optional[Sequence[object]],
    ) -> _SceneState:
        if self._scene_state is not None:
            state = _SceneState(
                index=self._scene_state.index,
                round=self._scene_state.round,
                introduced_index=self._scene_state.introduced_index,
                emitted_round_events=set(self._scene_state.emitted_round_events),
            )
            if scenes and 0 <= state.index < len(scenes):
                state.current = scenes[state.index]
            else:
                state.current = self._scene_state.current
            self._scene_state = state
            return state

        current_scene = scenes[0] if scenes else None
        state = _SceneState(current=current_scene)
        self._scene_state = state
        return state

    def _advance_scene_state(
        self,
        step: int,
        scenes: Optional[Sequence[object]],
        state: _SceneState,
    ) -> bool:
        self._scene_state = state
        if not scenes or state.current is None:
            return False

        state.round += 1
        num_rounds = self._scene_value(state.current, "num_rounds")
        if not isinstance(num_rounds, int) or num_rounds <= 0:
            num_rounds = 999
        if state.round <= num_rounds:
            self._scene_state = state
            return False

        state.index += 1
        state.round = 0
        state.emitted_round_events.clear()
        if state.index < len(scenes):
            state.current = scenes[state.index]
            state.introduced_index = -1
            self._scene_state = state
            return True

        state.current = None
        self._scene_state = state
        return False

    def _engine_type(self) -> str:
        return "sequential"

    def restore_checkpoint_state(
        self,
        checkpoint: dict,
        scenes: Optional[Sequence[object]] = None,
    ) -> None:
        runtime_cursor = checkpoint.get("runtime_cursor") if isinstance(checkpoint.get("runtime_cursor"), dict) else {}
        scene_cursor = checkpoint.get("scene_cursor") if isinstance(checkpoint.get("scene_cursor"), dict) else {}
        self._current_step = int(runtime_cursor.get("current_step", checkpoint.get("step", 0)) or 0)
        self._last_acting_entity_name = runtime_cursor.get("last_acting_agent")
        self._last_step_outcome = runtime_cursor.get("last_step_outcome")
        self._premise_emitted = self._current_step > 0
        if scene_cursor:
            scene_index = int(scene_cursor.get("scene_index", 0) or 0)
            current_scene = None
            if scenes and 0 <= scene_index < len(scenes):
                current_scene = scenes[scene_index]
            self._scene_state = _SceneState(
                index=scene_index,
                round=int(scene_cursor.get("scene_round", 0) or 0),
                current=current_scene,
            )

    def get_checkpoint_state(
        self,
        *,
        max_steps: int,
        replay_event_count: int,
    ) -> dict[str, object]:
        scene_cursor = None
        if self._scene_state is not None:
            scene_cursor = {
                "scene_index": self._scene_state.index,
                "scene_round": self._scene_state.round,
                "current_scene_name": self._scene_name(self._scene_state.current, self._scene_state.index)
                if self._scene_state.current is not None
                else None,
            }
        return {
            "scene_cursor": scene_cursor,
            "runtime_cursor": {
                "current_step": self._current_step,
                "start_step": self._current_step + 1,
                "max_steps": max_steps,
                "last_acting_agent": self._last_acting_entity_name,
                "last_step_outcome": self._last_step_outcome,
                "engine_type": self._engine_type(),
            },
            "replay_cursor": {
                "replay_cursor": replay_event_count,
                "replay_event_count": replay_event_count,
                "last_event_id": str(replay_event_count) if replay_event_count > 0 else None,
            },
        }

    def _emit_phase(
        self,
        phase_callback: PhaseCallback,
        phase: str,
        step: int,
        metadata: Optional[dict] = None,
    ) -> None:
        if not phase_callback:
            return
        try:
            phase_callback(phase, step, metadata)
        except Exception as exc:
            logger.debug("Failed to emit phase %s: %s", phase, exc)

    def build_entity_action_spec(self, entity: Entity) -> ActionSpec:
        """Build an explicit, per-entity action prompt for the next move."""
        return ActionSpec(
            call_to_action=(
                f"What would {entity.name} do next? "
                f"Give one specific, concrete action that {entity.name} personally takes right now."
            ),
            output_type=OutputType.FREE,
            tag="action",
        )

    def build_entity_action_spec_from_game_master(
        self,
        game_master: Entity,
        entity_name: str,
    ) -> ActionSpec:
        """Ask the GM for the exact action spec the active entity should use."""
        action_spec_request = ActionSpec(
            call_to_action=self._call_to_next_action_spec.format(name=entity_name),
            output_type=OutputType.NEXT_ACTION_SPEC,
        )
        raw_action_spec = game_master.act(action_spec_request)
        try:
            return engine_lib.action_spec_parser(raw_action_spec)
        except Exception as exc:
            logger.warning(
                "Failed to parse NEXT_ACTION_SPEC for %s: %s — falling back to generic action spec",
                entity_name,
                exc,
            )
            fallback_entity = type("FallbackEntity", (), {"name": entity_name})()
            return self.build_entity_action_spec(fallback_entity)

    def _set_active_entity_context(
        self,
        game_master: Entity,
        entity_name: str | None,
    ) -> None:
        """Mirror the active actor into the GM's NextActing component when available."""
        self._last_acting_entity_name = entity_name
        get_component = getattr(game_master, "get_component", None)
        if not callable(get_component):
            return
        try:
            next_acting_component = game_master.get_component(
                next_acting_components.DEFAULT_NEXT_ACTING_COMPONENT_KEY,
                type_=next_acting_components.NextActing,
            )
        except Exception:
            return

        set_state = getattr(next_acting_component, "set_state", None)
        if not callable(set_state):
            return

        get_state = getattr(next_acting_component, "get_state", None)
        try:
            state = dict(get_state() or {}) if callable(get_state) else {}
            state["currently_active_player"] = entity_name
            set_state(state)
        except Exception as exc:
            logger.debug(
                "Unable to sync GM active entity context for %s: %s",
                self._world_id,
                exc,
            )

    def make_observation(self, game_master: Entity, entity: Entity) -> str:
        """Generate observation for an entity and emit event."""
        observation_spec = ActionSpec(
            call_to_action=self._call_to_make_observation.format(name=entity.name),
            output_type=OutputType.MAKE_OBSERVATION,
        )
        observation = sanitize_story_text(game_master.act(observation_spec))
        if observation:
            entity.observe(observation)
            self._event_callback(SimulationEvent(
                type="observation",
                step=self._current_step,
                timestamp=time.time(),
                agent_name=entity.name,
                content=observation,
            ))
        return observation

    def next_acting(
        self, game_master: Entity, entities: Sequence[Entity],
    ) -> tuple[Entity, ActionSpec]:
        """Determine which entity acts next."""
        entity_names = tuple(e.name for e in entities)
        next_spec = ActionSpec(
            call_to_action=self._call_to_next_acting,
            output_type=OutputType.NEXT_ACTING,
            options=entity_names,
        )
        next_name = game_master.act(next_spec)
        # Find the matching entity
        next_entity = entities[0]  # Fallback to first
        for entity in entities:
            if entity.name == next_name:
                next_entity = entity
                break

        self._set_active_entity_context(game_master, next_entity.name)
        return (
            next_entity,
            self.build_entity_action_spec_from_game_master(
                game_master,
                next_entity.name,
            ),
        )

    def resolve(self, game_master: Entity, event: str) -> None:
        """Resolve an event via the GM and emit resolution event."""
        # GM observes the putative event
        game_master.observe(f"[putative_event] {event}")

        resolve_spec = ActionSpec(
            call_to_action=self._call_to_resolve,
            output_type=OutputType.RESOLVE,
        )
        resolved = sanitize_story_text(game_master.act(resolve_spec))
        if not resolved:
            resolved = sanitize_story_text(event)

        # GM observes the resolved event
        game_master.observe(f"[event] {resolved}")

        self._event_callback(SimulationEvent(
            type="resolution",
            step=self._current_step,
            timestamp=time.time(),
            agent_name=self._last_acting_entity_name,
            content=event,
            resolved_event=resolved,
        ))

    def terminate(self, game_master: Entity) -> bool:
        """Check if the simulation should end."""
        terminate_spec = ActionSpec(
            call_to_action=self._call_to_check_termination,
            output_type=OutputType.TERMINATE,
            options=("Yes", "No"),
        )
        result = game_master.act(terminate_spec)
        should_terminate = result.strip().lower() in ("yes", "y", "true")
        if should_terminate:
            self._event_callback(SimulationEvent(
                type="terminate",
                step=self._current_step,
                timestamp=time.time(),
                content="Simulation terminated by GM",
            ))
        return should_terminate

    def next_game_master(
        self, game_master: Entity, game_masters: Sequence[Entity],
    ) -> Entity:
        """Select the next game master (for multi-GM simulations)."""
        if len(game_masters) <= 1:
            return game_master
        gm_names = tuple(gm.name for gm in game_masters)
        spec = ActionSpec(
            call_to_action="Which game master should run the next step?",
            output_type=OutputType.NEXT_GAME_MASTER,
            options=gm_names,
        )
        selected_name = game_master.act(spec)
        for gm in game_masters:
            if gm.name == selected_name:
                return gm
        return game_master

    def _initialize_run_loop(
        self,
        game_masters: Sequence[Entity],
        premise: str,
        scenes: Optional[list],
        start_step: int,
    ) -> tuple[Entity, _SceneState]:
        gm = game_masters[0]
        self._emit_premise(gm, premise, start_step)
        scene_state = self._initialize_scene_state(scenes)
        if start_step <= 1 and scene_state.current is not None:
            self._emit_scene_intro(
                gm,
                0,
                scene_state.current,
                scene_state.index,
                scene_state,
            )
        return gm, scene_state

    def _prepare_loop_step(
        self,
        step: int,
        gm: Entity,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        step_controller: object,
        scenes: Optional[list],
        scene_state: _SceneState,
        step_callback: StepCallback,
        phase_callback: PhaseCallback,
    ) -> tuple[LoopStepDisposition, Entity]:
        self._current_step = step
        self._emit_phase(phase_callback, "waiting_for_permission", step)

        if step_controller and hasattr(step_controller, "wait_for_step_permission"):
            step_controller.wait_for_step_permission()

        if self._stop_requested(step_controller, "before_step"):
            self._emit_phase(phase_callback, "stopped", step)
            return "break", gm

        if not self._validate_pre_step(gm, entities):
            logger.warning("Pre-step validation failed at step %d — skipping", step)
            self._finish_step(step, "skipped_pre_step_validation", step_callback)
            self._emit_phase(
                phase_callback,
                "step_complete",
                step,
                {"outcome": "skipped_pre_step_validation"},
            )
            return "continue", gm

        if self.terminate(gm):
            self._emit_phase(phase_callback, "stopped", step, {"reason": "terminated"})
            return "break", gm

        scene_changed = self._advance_scene_state(step, scenes, scene_state)
        if scene_changed and scene_state.current is not None:
            self._emit_scene_intro(
                gm,
                step,
                scene_state.current,
                scene_state.index,
                scene_state,
            )

        self._emit_scene_round_events(gm, step, scene_state)

        if len(game_masters) > 1:
            gm = self.next_game_master(gm, game_masters)

        return "proceed", gm

    def _iter_prepared_steps(
        self,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        premise: str,
        max_steps: int,
        step_controller: object,
        step_callback: StepCallback,
        phase_callback: PhaseCallback,
        scenes: Optional[list],
        start_step: int,
    ) -> Iterator[tuple[int, Entity]]:
        gm, scene_state = self._initialize_run_loop(
            game_masters,
            premise,
            scenes,
            start_step,
        )

        for step in range(start_step, max_steps + 1):
            disposition, gm = self._prepare_loop_step(
                step,
                gm,
                game_masters,
                entities,
                step_controller,
                scenes,
                scene_state,
                step_callback,
                phase_callback,
            )
            if disposition == "break":
                break
            if disposition == "continue":
                continue
            yield step, gm

    def run_loop(
        self,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        premise: str = "",
        max_steps: int = 100,
        verbose: bool = False,
        log: bool = False,
        checkpoint_callback: CheckpointCallback = None,
        step_controller: object = None,
        step_callback: StepCallback = None,
        phase_callback: PhaseCallback = None,
        scenes: Optional[list] = None,
        start_step: int = 1,
    ) -> None:
        """Run the full simulation loop with optional scene support."""
        for step, gm in self._iter_prepared_steps(
            game_masters,
            entities,
            premise,
            max_steps,
            step_controller,
            step_callback,
            phase_callback,
            scenes,
            start_step,
        ):
            self._emit_phase(phase_callback, "observing", step)
            stop_during_observation = False
            for entity in entities:
                if self._stop_requested(step_controller, f"before_observation:{entity.name}"):
                    stop_during_observation = True
                    break
                self.make_observation(gm, entity)

            if stop_during_observation or self._stop_requested(step_controller, "before_next_acting"):
                break

            self._emit_phase(phase_callback, "choosing_actor", step)
            acting_entity, action_spec = self.next_acting(gm, entities)

            if self._stop_requested(step_controller, f"before_action:{acting_entity.name}"):
                self._emit_phase(phase_callback, "stopped", step)
                break

            self._emit_phase(
                phase_callback,
                "acting",
                step,
                {"agent_name": acting_entity.name},
            )
            try:
                raw_action = acting_entity.act(action_spec)
            except Exception as exc:
                logger.warning("Agent %s act() failed: %s", acting_entity.name, exc)
                self._event_callback(SimulationEvent(
                    type="error",
                    step=step,
                    timestamp=time.time(),
                    agent_name=acting_entity.name,
                    content=f"Agent action failed: {exc}",
                ))
                self._finish_step(step, "agent_action_failed", step_callback)
                continue

            if is_invalid_agent_action(raw_action):
                logger.warning(
                    "Dropping invalid action text for %s at step %d: %s",
                    acting_entity.name,
                    step,
                    raw_action[:200],
                )
                self._event_callback(SimulationEvent(
                    type="error",
                    step=step,
                    timestamp=time.time(),
                    agent_name=acting_entity.name,
                    content="Dropped invalid action text before GM resolution.",
                    metadata={"raw_action": raw_action},
                ))
                self._finish_step(step, "invalid_action", step_callback)
                continue

            event_text = f"{acting_entity.name}: {raw_action}"

            self._event_callback(SimulationEvent(
                type="action",
                step=step,
                timestamp=time.time(),
                agent_name=acting_entity.name,
                content=raw_action,
                action_spec=action_spec.to_dict() if hasattr(action_spec, "to_dict") else None,
            ))

            if self._stop_requested(step_controller, f"before_resolution:{acting_entity.name}"):
                self._emit_phase(phase_callback, "stopped", step)
                break

            self._emit_phase(
                phase_callback,
                "resolving",
                step,
                {"agent_name": acting_entity.name},
            )
            self.resolve(gm, event_text)

            stop_before_checkpoint = self._stop_requested(
                step_controller,
                f"before_checkpoint:{acting_entity.name}",
            )
            if checkpoint_callback and not stop_before_checkpoint:
                self._emit_phase(
                    phase_callback,
                    "checkpointing",
                    step,
                    {"agent_name": acting_entity.name},
                )
                checkpoint_callback(step)

            outcome = "resolved_stop_pending" if stop_before_checkpoint else "resolved"
            self._finish_step(step, outcome, step_callback)
            self._emit_phase(
                phase_callback,
                "step_complete",
                step,
                {"outcome": outcome, "agent_name": acting_entity.name},
            )

            logger.info("Step %d/%d complete: %s", step, max_steps, event_text[:100])

            if stop_before_checkpoint:
                break

    def _finish_step(
        self,
        step: int,
        outcome: str,
        step_callback: Optional[Callable[..., None]],
    ) -> None:
        self._current_step = step
        self._last_step_outcome = outcome
        logger.info(
            "Step %d outcome=%s world=%s",
            step,
            outcome,
            self._world_id,
        )
        if not step_callback:
            return
        try:
            step_callback(step, outcome)
        except TypeError:
            step_callback(step)
        except Exception as exc:
            logger.warning("step_callback error: %s", exc)

    def _stop_requested(self, step_controller: object, phase: str) -> bool:
        stopped = False
        if step_controller is not None:
            value = getattr(step_controller, "is_stopped", False)
            if callable(value):
                try:
                    value = value()
                except TypeError:
                    pass
            stopped = value is True
        if stopped:
            logger.info(
                "Stopping sequential engine world=%s step=%d phase=%s",
                self._world_id,
                self._current_step,
                phase,
            )
        return stopped

    def _decorate_event(self, event: SimulationEvent) -> SimulationEvent:
        return apply_identity_to_event(
            event,
            self._identity,
            world_id=self._world_id,
            workspace_id=self._workspace_id,
        )

    def _validate_pre_step(self, gm: Entity, entities: Sequence[Entity]) -> bool:
        """Pre-step validation: check GM and entity health (Phase 8.5)."""
        try:
            # Verify GM is responsive
            if not hasattr(gm, "act"):
                logger.error("GM missing act() method")
                return False
            # Verify entities have required interface
            for entity in entities:
                if not hasattr(entity, "act") or not hasattr(entity, "observe"):
                    logger.error("Entity %s missing required methods", getattr(entity, "name", "?"))
                    return False
            return True
        except Exception as exc:
            logger.warning("Pre-step validation error: %s", exc)
            return False
