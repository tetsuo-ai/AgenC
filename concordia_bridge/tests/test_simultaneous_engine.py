"""Tests for InstrumentedSimultaneousEngine — parallel agent actions."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from concordia.typing.entity import OutputType

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.instrumented_simultaneous_engine import InstrumentedSimultaneousEngine


def make_mock_entity(name: str, action: str = "does something", delay: float = 0):
    entity = MagicMock()
    entity.name = name
    if delay > 0:
        def slow_act(spec=None):
            time.sleep(delay)
            return action
        entity.act.side_effect = slow_act
    else:
        entity.act.return_value = action
    entity.observe.return_value = None
    return entity


def make_mock_gm(terminate_after: int = 999):
    gm = MagicMock()
    gm.name = "GM"
    call_count = [0]

    def gm_act(action_spec):
        if action_spec.output_type == OutputType.TERMINATE:
            call_count[0] += 1
            return "Yes" if call_count[0] > terminate_after else "No"
        if action_spec.output_type == OutputType.MAKE_OBSERVATION:
            return "You observe the world."
        if action_spec.output_type == OutputType.NEXT_ACTION_SPEC:
            name = "someone"
            prompt = getattr(action_spec, "call_to_action", "")
            marker = "In what action spec format should "
            if prompt.startswith(marker):
              name = prompt.removeprefix(marker).split(" respond?", 1)[0]
            return (
                '{"call_to_action": "What would '
                f'{name}'
                ' do next?", "output_type": "free", "options": [], "tag": "action"}'
            )
        if action_spec.output_type == OutputType.RESOLVE:
            return "Events resolved."
        return "No"

    gm.act.side_effect = gm_act
    gm.observe.return_value = None
    return gm


class TestSimultaneousEngine:
    def test_all_agents_act_per_step(self):
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        alice = make_mock_entity("Alice", "goes to market")
        bob = make_mock_entity("Bob", "stays home")
        gm = make_mock_gm()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[alice, bob],
                max_steps=2,
            )

        action_events = [e for e in events if e.type == "action"]
        # 2 steps × 2 agents = 4 action events
        assert len(action_events) == 4

        step_1_agents = {e.agent_name for e in action_events if e.step == 1}
        assert step_1_agents == {"Alice", "Bob"}

    def test_agents_act_concurrently(self):
        """Verify agents act in parallel, not sequentially."""
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
            max_workers=4,
        )
        # Each agent takes 0.2s — if sequential, 3 agents = 0.6s
        # If parallel, should be ~0.2s
        agents = [make_mock_entity(f"Agent{i}", f"action{i}", delay=0.2) for i in range(3)]
        gm = make_mock_gm()

        start = time.time()
        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=agents,
                max_steps=1,
            )
        elapsed = time.time() - start

        # Should be much less than 0.6s (sequential would be 0.6+)
        assert elapsed < 0.5, f"Agents seem sequential: {elapsed:.2f}s"

    def test_exception_in_one_agent_doesnt_crash_others(self):
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )

        good = make_mock_entity("Good", "does fine")
        bad = make_mock_entity("Bad")
        bad.act.side_effect = RuntimeError("Agent crashed")

        gm = make_mock_gm()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[good, bad],
                max_steps=1,
            )

        action_events = [e for e in events if e.type == "action"]
        error_events = [e for e in events if e.type == "error"]
        assert len(action_events) == 1
        assert action_events[0].agent_name == "Good"
        assert len(error_events) == 1
        assert error_events[0].agent_name == "Bad"

    def test_terminates_correctly(self):
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm(terminate_after=2)

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=100,
            )

        action_events = [e for e in events if e.type == "action"]
        assert len(action_events) <= 3

    def test_accepts_scene_configs(self):
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        scene1 = type("Scene", (), {"num_rounds": 1, "scene_type": {"name": "intro"}})()
        scene2 = type("Scene", (), {"num_rounds": 1, "scene_type": {"name": "market"}})()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=2,
                scenes=[scene1, scene2],
            )

        scene_events = [e for e in events if e.type == "scene_change"]
        assert len(scene_events) == 2
        assert scene_events[0].scene == "intro"
        assert scene_events[1].scene == "market"
        assert scene_events[1].step == 2


    def test_stopped_controller_breaks_before_observation(self):
        events = []
        engine = InstrumentedSimultaneousEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        alice = make_mock_entity("Alice", "goes to market")

        class StopAfterWaitController:
            def __init__(self) -> None:
                self.wait_calls = 0

            def wait_for_step_permission(self) -> None:
                self.wait_calls += 1

            @property
            def is_stopped(self) -> bool:
                return True

        controller = StopAfterWaitController()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[alice],
                max_steps=3,
                step_controller=controller,
            )

        assert controller.wait_calls == 1
        assert gm.act.call_count == 0
        alice.observe.assert_not_called()
        assert not [
            event for event in events
            if event.type in {"observation", "action", "resolution"}
        ]

    def test_no_valid_actions_still_advance_step_callback(self):
        callback = MagicMock()
        engine = InstrumentedSimultaneousEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        hesitant_agents = [
            make_mock_entity("Alice", "hesitates."),
            make_mock_entity("Bob", "hesitates."),
        ]

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=hesitant_agents,
                max_steps=2,
                step_callback=callback,
            )

        assert callback.call_count == 2
        assert [call.args for call in callback.call_args_list] == [
            (1, "no_valid_actions"),
            (2, "no_valid_actions"),
        ]
