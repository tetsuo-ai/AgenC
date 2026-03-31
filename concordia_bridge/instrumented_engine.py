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
import time
from typing import Callable, Optional, Sequence

import requests

from concordia.typing.entity import Entity, ActionSpec, OutputType
from concordia.environment.engine import Engine

from concordia_bridge.bridge_types import SimulationEvent

logger = logging.getLogger(__name__)


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
        call_to_make_observation: str = "What does {name} observe?",
        call_to_next_acting: str = "Who is next to act?",
        call_to_resolve: str = "Because of all that came before, what happens next?",
        call_to_check_termination: str = "Is the game/simulation finished?",
    ) -> None:
        self._event_callback = event_callback
        self._bridge_url = bridge_url.rstrip("/")
        self._world_id = world_id
        self._call_to_make_observation = call_to_make_observation
        self._call_to_next_acting = call_to_next_acting
        self._call_to_resolve = call_to_resolve
        self._call_to_check_termination = call_to_check_termination
        self._current_step = 0
        self._last_acting_entity_name: Optional[str] = None

    def make_observation(self, game_master: Entity, entity: Entity) -> str:
        """Generate observation for an entity and emit event."""
        observation_spec = ActionSpec(
            call_to_action=self._call_to_make_observation.format(name=entity.name),
            output_type=OutputType.MAKE_OBSERVATION,
        )
        observation = game_master.act(observation_spec)
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

        # Use default FREE action spec
        from concordia.typing.entity import DEFAULT_ACTION_SPEC
        return next_entity, DEFAULT_ACTION_SPEC

    def resolve(self, game_master: Entity, event: str) -> None:
        """Resolve an event via the GM and emit resolution event."""
        # GM observes the putative event
        game_master.observe(f"[putative_event] {event}")

        resolve_spec = ActionSpec(
            call_to_action=self._call_to_resolve,
            output_type=OutputType.RESOLVE,
        )
        resolved = game_master.act(resolve_spec)

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
        step_callback: Optional[Callable] = None,
    ) -> None:
        """Run the full simulation loop."""
        gm = game_masters[0]

        # Inject premise
        if premise:
            gm.observe(f"[event] {premise}")
            self._event_callback(SimulationEvent(
                type="step",
                step=0,
                timestamp=time.time(),
                content=premise,
                metadata={"phase": "premise"},
            ))

        for step in range(1, max_steps + 1):
            self._current_step = step

            # Optional step controller (play/pause/step)
            if step_controller and hasattr(step_controller, "wait_for_step_permission"):
                step_controller.wait_for_step_permission()

            # Check termination
            if self.terminate(gm):
                break

            # Multi-GM selection
            if len(game_masters) > 1:
                gm = self.next_game_master(gm, game_masters)

            # Generate observations for all entities
            for entity in entities:
                self.make_observation(gm, entity)

            # Determine who acts
            acting_entity, action_spec = self.next_acting(gm, entities)

            # Entity acts
            raw_action = acting_entity.act(action_spec)
            event_text = f"{acting_entity.name}: {raw_action}"

            self._event_callback(SimulationEvent(
                type="action",
                step=step,
                timestamp=time.time(),
                agent_name=acting_entity.name,
                content=raw_action,
                action_spec=action_spec.to_dict() if hasattr(action_spec, "to_dict") else None,
            ))

            # Resolve the event
            self.resolve(gm, event_text)

            # Callbacks
            if checkpoint_callback:
                checkpoint_callback(step)

            if step_callback:
                try:
                    step_callback(step)
                except Exception as exc:
                    logger.warning("step_callback error: %s", exc)

            logger.info("Step %d/%d complete: %s", step, max_steps, event_text[:100])

    def _notify_bridge_event(self, putative: str, resolved: str) -> None:
        """Notify the AgenC bridge about a resolved event for social memory."""
        try:
            requests.post(
                f"{self._bridge_url}/event",
                json={
                    "type": "resolution",
                    "step": self._current_step,
                    "acting_agent": self._last_acting_entity_name,
                    "content": resolved or putative,
                    "world_id": self._world_id,
                },
                timeout=5,
            )
        except Exception as exc:
            logger.debug("Bridge event notification failed: %s", exc)
