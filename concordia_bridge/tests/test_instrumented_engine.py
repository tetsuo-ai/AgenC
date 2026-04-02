"""Tests for InstrumentedSequentialEngine — the core simulation loop."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch, call

import pytest

from concordia.typing.entity import ActionSpec, OutputType

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.instrumented_engine import InstrumentedSequentialEngine


# ============================================================================
# Mock entities
# ============================================================================

def make_mock_entity(name: str, action: str = "does something"):
    entity = MagicMock()
    entity.name = name
    entity.act.return_value = action
    entity.observe.return_value = None
    return entity


def make_mock_gm(
    observation: str = "You see a market.",
    next_actor: str = "Alice",
    resolution: str = "Alice does something successfully.",
    terminate: bool = False,
):
    gm = MagicMock()
    gm.name = "GameMaster"

    def gm_act(action_spec):
        if action_spec.output_type == OutputType.MAKE_OBSERVATION:
            return observation
        elif action_spec.output_type == OutputType.NEXT_ACTING:
            return next_actor
        elif action_spec.output_type == OutputType.NEXT_ACTION_SPEC:
            requested_name = "Alice"
            if isinstance(action_spec.call_to_action, str):
                marker = "should "
                start = action_spec.call_to_action.find(marker)
                end = action_spec.call_to_action.find(" respond", start)
                if start != -1 and end != -1:
                    requested_name = action_spec.call_to_action[start + len(marker):end]
            return (
                '{"call_to_action": "What would '
                f'{requested_name}'
                ' do next?", "output_type": "free", "options": [], "tag": "action"}'
            )
        elif action_spec.output_type == OutputType.RESOLVE:
            return resolution
        elif action_spec.output_type == OutputType.TERMINATE:
            return "No"
        elif action_spec.output_type == OutputType.NEXT_GAME_MASTER:
            return gm.name
        return ""

    if terminate:
        call_count = [0]
        original_act = gm_act
        def terminating_act(action_spec):
            if action_spec.output_type == OutputType.TERMINATE:
                call_count[0] += 1
                return "Yes" if call_count[0] > 2 else "No"
            return original_act(action_spec)
        gm.act.side_effect = terminating_act
    else:
        gm.act.side_effect = gm_act

    gm.observe.return_value = None
    return gm


# ============================================================================
# Tests
# ============================================================================

class TestMakeObservation:
    def test_emits_observation_event(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm(observation="You see a busy market square.")
        entity = make_mock_entity("Alice")

        engine._current_step = 3
        engine.make_observation(gm, entity)

        assert len(events) == 1
        assert events[0].type == "observation"
        assert events[0].agent_name == "Alice"
        assert events[0].content == "You see a busy market square."
        assert events[0].step == 3

    def test_entity_receives_observation(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm(observation="The sun rises.")
        entity = make_mock_entity("Bob")

        engine.make_observation(gm, entity)

        entity.observe.assert_called_once_with("The sun rises.")

    def test_empty_observation_skipped(self):
        events = []
        engine = InstrumentedSequentialEngine(event_callback=events.append)
        gm = make_mock_gm(observation="")
        entity = make_mock_entity("Alice")

        engine.make_observation(gm, entity)

        assert len(events) == 0
        entity.observe.assert_not_called()


class TestNextActing:
    def test_selects_correct_entity(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm(next_actor="Bob")
        alice = make_mock_entity("Alice")
        bob = make_mock_entity("Bob")

        entity, spec = engine.next_acting(gm, [alice, bob])

        assert entity.name == "Bob"
        assert spec.output_type == OutputType.FREE
        assert spec.tag == "action"
        assert "Bob" in spec.call_to_action
        assert gm.act.call_args_list[1].args[0].output_type == OutputType.NEXT_ACTION_SPEC

    def test_falls_back_to_first_entity(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm(next_actor="Unknown")
        alice = make_mock_entity("Alice")

        entity, spec = engine.next_acting(gm, [alice])

        assert entity.name == "Alice"
        assert spec.output_type == OutputType.FREE
        assert spec.tag == "action"
        assert "Alice" in spec.call_to_action
        assert gm.act.call_args_list[1].args[0].output_type == OutputType.NEXT_ACTION_SPEC

    def test_builds_observation_prompt_with_required_engine_contract(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm()
        entity = make_mock_entity("Alice")

        engine.make_observation(gm, entity)

        observation_spec = gm.act.call_args_list[0].args[0]
        assert observation_spec.output_type == OutputType.MAKE_OBSERVATION
        assert observation_spec.call_to_action == (
            "What is the current situation faced by Alice? "
            "What do they now observe? Only include information of which "
            "they are aware."
        )


class TestResolve:
    def test_emits_resolution_event(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        engine._current_step = 5
        engine._last_acting_entity_name = "Alice"
        gm = make_mock_gm(resolution="Alice successfully trades iron.")

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.resolve(gm, "Alice: trades iron")

        resolution_events = [e for e in events if e.type == "resolution"]
        assert len(resolution_events) == 1
        assert resolution_events[0].step == 5
        assert resolution_events[0].content == "Alice: trades iron"

    def test_gm_observes_putative_and_resolved(self):
        engine = InstrumentedSequentialEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm(resolution="Event resolved.")

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.resolve(gm, "Alice: does something")

        observe_calls = [str(c) for c in gm.observe.call_args_list]
        assert any("[putative_event]" in c for c in observe_calls)
        assert any("[event]" in c for c in observe_calls)


class TestTerminate:
    def test_returns_false_when_gm_says_no(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm(terminate=False)
        assert engine.terminate(gm) is False

    def test_returns_true_when_gm_says_yes(self):
        events = []
        engine = InstrumentedSequentialEngine(event_callback=events.append)
        gm = MagicMock()
        gm.act.return_value = "Yes"

        assert engine.terminate(gm) is True
        assert any(e.type == "terminate" for e in events)


class TestValidatePreStep:
    def test_passes_for_valid_entities(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm()
        entities = [make_mock_entity("Alice"), make_mock_entity("Bob")]

        assert engine._validate_pre_step(gm, entities) is True

    def test_fails_for_entity_missing_act(self):
        engine = InstrumentedSequentialEngine(event_callback=lambda e: None)
        gm = make_mock_gm()
        bad_entity = MagicMock(spec=[])  # No act/observe methods

        assert engine._validate_pre_step(gm, [bad_entity]) is False


class TestRunLoop:
    def test_runs_correct_number_of_steps(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        alice = make_mock_entity("Alice", action="goes to market")

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[alice],
                premise="Test premise",
                max_steps=3,
            )

        action_events = [e for e in events if e.type == "action"]
        assert len(action_events) == 3

    def test_emits_premise_event(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        gm.act.return_value = "Yes"  # Terminate immediately

        engine.run_loop(
            game_masters=[gm],
            entities=[make_mock_entity("A")],
            premise="It is morning.",
            max_steps=1,
        )

        premise_events = [e for e in events if e.metadata and e.metadata.get("phase") == "premise"]
        assert len(premise_events) == 1
        assert premise_events[0].content == "It is morning."

    def test_calls_step_callback(self):
        callback = MagicMock()
        engine = InstrumentedSequentialEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=3,
                step_callback=callback,
            )

        assert callback.call_count == 3

    def test_calls_checkpoint_callback(self):
        callback = MagicMock()
        engine = InstrumentedSequentialEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=2,
                checkpoint_callback=callback,
            )

        assert callback.call_count == 2

    def test_terminates_when_gm_says_yes(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm(terminate=True)  # Terminates after step 2

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=100,
            )

        action_events = [e for e in events if e.type == "action"]
        assert len(action_events) <= 3  # Should stop early

    def test_restore_checkpoint_state_skips_scene_restart_event(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        scene1 = type("Scene", (), {"num_rounds": 1, "scene_type": {"name": "intro"}})()
        scene2 = type("Scene", (), {"num_rounds": 2, "scene_type": {"name": "market"}})()
        engine.restore_checkpoint_state({
            "step": 5,
            "scene_cursor": {
                "scene_index": 1,
                "scene_round": 1,
                "current_scene_name": "market",
            },
            "runtime_cursor": {
                "current_step": 5,
                "start_step": 6,
                "max_steps": 8,
                "last_step_outcome": "resolved",
            },
        }, scenes=[scene1, scene2])

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=6,
                start_step=6,
                scenes=[scene1, scene2],
            )

        scene_events = [e for e in events if e.type == "scene_change"]
        assert all(event.step != 0 for event in scene_events)

    def test_get_checkpoint_state_reports_runtime_and_replay_cursor(self):
        engine = InstrumentedSequentialEngine(
            event_callback=lambda _event: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        scene = type("Scene", (), {"num_rounds": 2, "scene_type": {"name": "intro"}})()

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=1,
                scenes=[scene],
            )

        state = engine.get_checkpoint_state(max_steps=5, replay_event_count=4)
        assert state["runtime_cursor"]["current_step"] == 1
        assert state["runtime_cursor"]["engine_type"] == "sequential"
        assert state["replay_cursor"]["replay_cursor"] == 4
        assert state["scene_cursor"]["scene_index"] == 0

    def test_scene_transitions(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()

        # Mock scenes with num_rounds attribute
        scene1 = MagicMock()
        scene1.num_rounds = 2
        scene2 = MagicMock()
        scene2.num_rounds = 2

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=5,
                scenes=[scene1, scene2],
            )

        scene_events = [e for e in events if e.type == "scene_change"]
        assert len(scene_events) >= 1  # At least initial scene

    def test_step_controller_integration(self):
        engine = InstrumentedSequentialEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()

        controller = MagicMock()
        controller.wait_for_step_permission.return_value = None

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[make_mock_entity("A")],
                max_steps=3,
                step_controller=controller,
            )

        assert controller.wait_for_step_permission.call_count == 3


    def test_stopped_controller_breaks_before_observation(self):
        events = []
        engine = InstrumentedSequentialEngine(
            event_callback=events.append,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        alice = make_mock_entity("Alice", action="goes to market")

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

    def test_invalid_actions_still_advance_step_callback(self):
        callback = MagicMock()
        engine = InstrumentedSequentialEngine(
            event_callback=lambda e: None,
            bridge_url="http://localhost:1",
        )
        gm = make_mock_gm()
        hesitant = make_mock_entity("A", action="hesitates.")

        with patch("concordia_bridge.instrumented_engine.requests.post"):
            engine.run_loop(
                game_masters=[gm],
                entities=[hesitant],
                max_steps=2,
                step_callback=callback,
            )

        assert callback.call_count == 2
        assert [record.args for record in callback.call_args_list] == [
            (1, "invalid_action"),
            (2, "invalid_action"),
        ]
