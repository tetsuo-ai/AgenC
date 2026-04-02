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
from concurrent.futures import ThreadPoolExecutor, as_completed
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
        step_callback: Optional[Callable] = None,
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

        for step in range(start_step, max_steps + 1):
            self._current_step = step

            if step_controller and hasattr(step_controller, "wait_for_step_permission"):
                step_controller.wait_for_step_permission()

            if self.terminate(gm):
                break

            if len(game_masters) > 1:
                gm = self.next_game_master(gm, game_masters)

            # Generate observations for all entities
            for entity in entities:
                self.make_observation(gm, entity)

            # ALL agents act simultaneously
            actions: dict[str, str] = {}
            with ThreadPoolExecutor(max_workers=self._max_workers) as pool:
                futures = {
                    pool.submit(entity.act, self.build_entity_action_spec(entity)): entity
                    for entity in entities
                }
                for future in as_completed(futures):
                    entity = futures[future]
                    try:
                        action = future.result(timeout=120)
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

            # Emit action events
            for name, action in actions.items():
                self._event_callback(SimulationEvent(
                    type="action",
                    step=step,
                    timestamp=time.time(),
                    agent_name=name,
                    content=action,
                ))

            # Combine all actions into one event for GM resolution
            if not actions:
                logger.warning("No valid agent actions at step %d; skipping GM resolution", step)
                continue

            combined = "\n".join(f"{name}: {action}" for name, action in actions.items())
            self._last_acting_entity_name = None  # Multiple actors
            self.resolve(gm, combined)

            if checkpoint_callback:
                checkpoint_callback(step)
            if step_callback:
                try:
                    step_callback(step)
                except Exception as exc:
                    logger.warning("step_callback error: %s", exc)

            logger.info(
                "Step %d/%d complete: %d agents acted",
                step, max_steps, len(actions),
            )
