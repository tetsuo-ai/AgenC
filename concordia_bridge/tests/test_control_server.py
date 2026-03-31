"""Tests for StepController and control server."""

from __future__ import annotations

import json
import threading
import time
import urllib.request

import pytest

from concordia_bridge.control_server import (
    StepController,
    SimulationState,
    start_control_server,
)


class TestStepController:
    def test_starts_in_play_mode(self) -> None:
        ctrl = StepController()
        # Should not block
        ctrl.wait_for_step_permission()

    def test_pause_blocks(self) -> None:
        ctrl = StepController()
        ctrl.pause()

        blocked = True

        def try_step():
            nonlocal blocked
            ctrl.wait_for_step_permission()
            blocked = False

        thread = threading.Thread(target=try_step, daemon=True)
        thread.start()
        time.sleep(0.1)
        assert blocked  # Should still be blocked

        ctrl.play()
        thread.join(timeout=2)
        assert not blocked  # Should have unblocked

    def test_step_unblocks_once_then_reblocks(self) -> None:
        ctrl = StepController()
        ctrl.pause()

        step_count = 0

        def stepper():
            nonlocal step_count
            ctrl.wait_for_step_permission()
            step_count += 1

        # First step
        ctrl.step()
        thread = threading.Thread(target=stepper, daemon=True)
        thread.start()
        thread.join(timeout=2)
        assert step_count == 1

    def test_stop(self) -> None:
        ctrl = StepController()
        ctrl.pause()
        assert not ctrl.is_stopped
        ctrl.stop()
        assert ctrl.is_stopped


class TestSimulationState:
    def test_update_and_read(self) -> None:
        state = SimulationState()
        state.update(step=5, running=True, world_id="test")
        d = state.to_dict()
        assert d["step"] == 5
        assert d["running"] is True
        assert d["world_id"] == "test"


class TestControlServer:
    def test_status_endpoint(self) -> None:
        ctrl = StepController()
        state = SimulationState()
        state.update(step=3, max_steps=10, running=True, world_id="test-world")

        server = start_control_server(ctrl, state, port=13210)
        try:
            time.sleep(0.1)
            resp = urllib.request.urlopen("http://127.0.0.1:13210/simulation/status")
            data = json.loads(resp.read())
            assert data["step"] == 3
            assert data["max_steps"] == 10
            assert data["running"] is True
            assert data["world_id"] == "test-world"
        finally:
            server.shutdown()

    def test_play_pause_endpoints(self) -> None:
        ctrl = StepController()
        state = SimulationState()
        server = start_control_server(ctrl, state, port=13211)
        try:
            time.sleep(0.1)

            # Pause
            req = urllib.request.Request(
                "http://127.0.0.1:13211/simulation/pause", method="POST",
            )
            resp = urllib.request.urlopen(req)
            assert json.loads(resp.read())["status"] == "ok"

            status = json.loads(
                urllib.request.urlopen("http://127.0.0.1:13211/simulation/status").read(),
            )
            assert status["paused"] is True

            # Play
            req = urllib.request.Request(
                "http://127.0.0.1:13211/simulation/play", method="POST",
            )
            urllib.request.urlopen(req)

            status = json.loads(
                urllib.request.urlopen("http://127.0.0.1:13211/simulation/status").read(),
            )
            assert status["paused"] is False
        finally:
            server.shutdown()
