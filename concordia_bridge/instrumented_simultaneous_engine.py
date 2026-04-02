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
from typing import Callable, Optional, Sequence

import requests

from concordia.typing.entity import Entity, ActionSpec, OutputType

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.instrumented_engine import (
    InstrumentedSequentialEngine,
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
        """Run simulation with simultaneous agent actions per step."""
        gm = game_masters[0]

        if premise and start_step <= 1:
            gm.observe(f"[event] {premise}")
            self._event_callback(SimulationEvent(
                type="step",
                step=0,
                timestamp=time.time(),
                content=premise,
                metadata={"phase": "premise"},
            ))

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

            if stop_during_observation or self._stop_requested(step_controller, "before_action_collection"):
                break

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

            for name, action in actions.items():
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
                continue

            combined = "\n".join(f"{name}: {action}" for name, action in actions.items())
            self._last_acting_entity_name = None

            if self._stop_requested(step_controller, "before_resolution"):
                break

            self.resolve(gm, combined)

            stop_before_checkpoint = self._stop_requested(step_controller, "before_checkpoint")
            if checkpoint_callback and not stop_before_checkpoint:
                checkpoint_callback(step)

            outcome = "resolved_stop_pending" if stop_before_checkpoint else "resolved"
            self._finish_step(step, outcome, step_callback)

            logger.info(
                "Step %d/%d complete: %d agents acted",
                step, max_steps, len(actions),
            )

            if stop_before_checkpoint:
                break
