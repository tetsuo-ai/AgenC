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
from typing import Callable, Optional, Sequence

import requests

from concordia.typing.entity import Entity, ActionSpec, OutputType
from concordia.environment.engine import Engine
from concordia.environment import engine as engine_lib

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.simulation_identity import (
    SimulationIdentity,
    apply_identity_to_event,
    with_identity_payload,
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
        self._bridge_url = bridge_url.rstrip("/")
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

        self._last_acting_entity_name = next_entity.name
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

        # Notify bridge for social memory recording
        self._notify_bridge_event(event, resolved)

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

    def run_loop(
        self,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        premise: str = "",
        max_steps: int = 100,
        verbose: bool = False,
        log: bool = False,
        checkpoint_callback: Optional[Callable[[int], None]] = None,
        step_controller: object = None,
        step_callback: Optional[Callable[..., None]] = None,
        scenes: Optional[list] = None,
        start_step: int = 1,
    ) -> None:
        """Run the full simulation loop with optional scene support."""
        gm = game_masters[0]

        # Inject premise
        if premise and start_step <= 1:
            gm.observe(f"[event] {premise}")
            self._event_callback(SimulationEvent(
                type="step",
                step=0,
                timestamp=time.time(),
                content=premise,
                metadata={"phase": "premise"},
            ))

        # Scene tracking (Phase 7.2)
        scene_index = 0
        scene_round = 0
        current_scene = scenes[0] if scenes else None
        if current_scene:
            self._event_callback(SimulationEvent(
                type="scene_change",
                step=0,
                timestamp=time.time(),
                scene=getattr(current_scene, "scene_type", {}).get("name", "scene_0")
                    if isinstance(getattr(current_scene, "scene_type", None), dict)
                    else str(scene_index),
                content=f"Scene started: {scene_index}",
            ))

        for step in range(start_step, max_steps + 1):
            self._current_step = step

            if step_controller and hasattr(step_controller, "wait_for_step_permission"):
                step_controller.wait_for_step_permission()

            if self._stop_requested(step_controller, "before_step"):
                break

            if not self._validate_pre_step(gm, entities):
                logger.warning("Pre-step validation failed at step %d — skipping", step)
                self._finish_step(step, "skipped_pre_step_validation", step_callback)
                continue

            if self.terminate(gm):
                break

            if scenes and current_scene:
                scene_round += 1
                num_rounds = getattr(current_scene, "num_rounds", None) or 999
                if scene_round > num_rounds:
                    scene_index += 1
                    scene_round = 0
                    if scene_index < len(scenes):
                        current_scene = scenes[scene_index]
                        self._event_callback(SimulationEvent(
                            type="scene_change",
                            step=step,
                            timestamp=time.time(),
                            scene=str(scene_index),
                            content=f"Scene transition to scene {scene_index}",
                        ))
                    else:
                        current_scene = None

            if len(game_masters) > 1:
                gm = self.next_game_master(gm, game_masters)

            stop_during_observation = False
            for entity in entities:
                if self._stop_requested(step_controller, f"before_observation:{entity.name}"):
                    stop_during_observation = True
                    break
                self.make_observation(gm, entity)

            if stop_during_observation or self._stop_requested(step_controller, "before_next_acting"):
                break

            acting_entity, action_spec = self.next_acting(gm, entities)

            if self._stop_requested(step_controller, f"before_action:{acting_entity.name}"):
                break

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
                break

            self.resolve(gm, event_text)

            stop_before_checkpoint = self._stop_requested(
                step_controller,
                f"before_checkpoint:{acting_entity.name}",
            )
            if checkpoint_callback and not stop_before_checkpoint:
                checkpoint_callback(step)

            outcome = "resolved_stop_pending" if stop_before_checkpoint else "resolved"
            self._finish_step(step, outcome, step_callback)

            logger.info("Step %d/%d complete: %s", step, max_steps, event_text[:100])

            if stop_before_checkpoint:
                break

    def _finish_step(
        self,
        step: int,
        outcome: str,
        step_callback: Optional[Callable[..., None]],
    ) -> None:
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

    def _notify_bridge_event(self, putative: str, resolved: str) -> None:
        """Notify the AgenC bridge about a resolved event for social memory."""
        try:
            requests.post(
                f"{self._bridge_url}/event",
                json=with_identity_payload({
                    "type": "resolution",
                    "step": self._current_step,
                    "acting_agent": self._last_acting_entity_name,
                    "content": resolved or putative,
                    "world_id": self._world_id,
                    "workspace_id": self._workspace_id,
                }, self._identity),
                timeout=15,
            )
        except Exception as exc:
            logger.warning("Bridge event notification failed (step=%d): %s", self._current_step, exc)
