"""
Instrumented Simultaneous engine — all agents act each step.

Unlike the Sequential engine where one agent acts per step, the
Simultaneous engine collects actions from ALL agents each step,
then resolves them together.

Phase 7.1 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Callable, Optional, Sequence, Unpack

from concordia.typing.entity import Entity, ActionSpec, OutputType

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.instrumented_engine import (
    CheckpointCallback,
    InstrumentedSequentialEngine,
    PhaseCallback,
    RunLoopOptions,
    StepCallback,
    is_invalid_agent_action,
)

logger = logging.getLogger(__name__)


class InstrumentedSimultaneousEngine(InstrumentedSequentialEngine):
    """Simultaneous engine — all agents act each step, then GM resolves."""

    def __init__(
        self,
        event_callback: Callable[[SimulationEvent], None],
        bridge_url: str = "http://localhost:3200",
        world_id: str = "default",
        max_workers: int = 8,
        **kwargs,
    ) -> None:
        super().__init__(
            event_callback=event_callback,
            bridge_url=bridge_url,
            world_id=world_id,
            **kwargs,
        )
        self._max_workers = max_workers

    def _engine_type(self) -> str:
        return "simultaneous"

    def _iter_simultaneous_steps(
        self,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        options: RunLoopOptions,
    ) -> Sequence[tuple[int, Entity]]:
        return self._iter_prepared_steps(
            game_masters,
            entities,
            options.get("premise", ""),
            options.get("max_steps", 100),
            options.get("step_controller"),
            options.get("step_callback"),
            options.get("phase_callback"),
            options.get("scenes"),
            options.get("start_step", 1),
        )

    def run_loop(
        self,
        game_masters: Sequence[Entity],
        entities: Sequence[Entity],
        **options: Unpack[RunLoopOptions],
    ) -> None:
        """Run simulation with simultaneous agent actions per step."""
        max_steps = options.get("max_steps", 100)
        checkpoint_callback = options.get("checkpoint_callback")
        step_controller = options.get("step_controller")
        step_callback = options.get("step_callback")
        phase_callback: PhaseCallback = options.get("phase_callback")

        for step, gm in self._iter_simultaneous_steps(
            game_masters,
            entities,
            options,
        ):
            self._emit_phase(phase_callback, "observing", step)
            stop_during_observation = False
            for entity in entities:
                if self._stop_requested(step_controller, f"before_observation:{entity.name}"):
                    stop_during_observation = True
                    break
                self.make_observation(gm, entity)

            if stop_during_observation or self._stop_requested(step_controller, "before_action_collection"):
                self._emit_phase(phase_callback, "stopped", step)
                break

            self._emit_phase(phase_callback, "collecting_actions", step)
            actions: dict[str, str] = {}
            action_specs = {
                entity.name: self.build_entity_action_spec_from_game_master(
                    gm,
                    entity.name,
                )
                for entity in entities
            }

            stop_during_actions = False
            executor = ThreadPoolExecutor(max_workers=self._max_workers)
            try:
                futures = {
                    executor.submit(entity.act, action_specs[entity.name]): entity
                    for entity in entities
                }
                pending = set(futures)
                while pending:
                    done, pending = wait(
                        pending,
                        timeout=0.1,
                        return_when=FIRST_COMPLETED,
                    )
                    if self._stop_requested(step_controller, "during_action_collection"):
                        stop_during_actions = True
                        self._emit_phase(phase_callback, "stopped", step)
                        for future in pending:
                            future.cancel()
                        break
                    for future in done:
                        entity = futures[future]
                        try:
                            action = future.result()
                            if is_invalid_agent_action(action):
                                logger.warning(
                                    "Dropping invalid action text for %s at step %d: %s",
                                    entity.name,
                                    step,
                                    action[:200],
                                )
                                self._event_callback(SimulationEvent(
                                    type="error",
                                    step=step,
                                    timestamp=time.time(),
                                    agent_name=entity.name,
                                    content="Dropped invalid action text before GM resolution.",
                                    metadata={"raw_action": action},
                                ))
                                continue
                            actions[entity.name] = action
                        except Exception as exc:
                            logger.warning(
                                "Agent %s act() failed: %s", entity.name, exc,
                            )
                            self._event_callback(SimulationEvent(
                                type="error",
                                step=step,
                                timestamp=time.time(),
                                agent_name=entity.name,
                                content=f"Agent action failed: {exc}",
                            ))
            finally:
                executor.shutdown(wait=not stop_during_actions, cancel_futures=stop_during_actions)

            if stop_during_actions:
                break

            ordered_actor_names = [
                entity.name for entity in entities if entity.name in actions
            ]

            for name in ordered_actor_names:
                action = actions[name]
                self._event_callback(SimulationEvent(
                    type="action",
                    step=step,
                    timestamp=time.time(),
                    agent_name=name,
                    content=action,
                ))

            if not actions:
                logger.warning("No valid agent actions at step %d; skipping GM resolution", step)
                self._finish_step(step, "no_valid_actions", step_callback)
                self._emit_phase(
                    phase_callback,
                    "step_complete",
                    step,
                    {"outcome": "no_valid_actions"},
                )
                continue

            combined = "\n".join(
                f"{name}: {actions[name]}"
                for name in ordered_actor_names
            )
            self._set_active_entity_context(
                gm,
                ordered_actor_names[0] if ordered_actor_names else None,
            )

            if self._stop_requested(step_controller, "before_resolution"):
                self._emit_phase(phase_callback, "stopped", step)
                break

            self._emit_phase(phase_callback, "resolving", step)
            self.resolve(gm, combined)

            stop_before_checkpoint = self._stop_requested(step_controller, "before_checkpoint")
            if checkpoint_callback and not stop_before_checkpoint:
                self._emit_phase(
                    phase_callback,
                    "checkpointing",
                    step,
                    {"acted_agents": len(actions)},
                )
                checkpoint_callback(step)

            outcome = "resolved_stop_pending" if stop_before_checkpoint else "resolved"
            self._finish_step(step, outcome, step_callback)
            self._emit_phase(
                phase_callback,
                "step_complete",
                step,
                {"outcome": outcome, "acted_agents": len(actions)},
            )

            logger.info(
                "Step %d/%d complete: %d agents acted",
                step, max_steps, len(actions),
            )

            if stop_before_checkpoint:
                self._emit_phase(phase_callback, "stopped", step)
                break
