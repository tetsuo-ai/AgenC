"""
HTTP control server for simulation play/pause/step/stop.

Runs in a background thread alongside the simulation. Exposes simple
HTTP endpoints that the React viewer calls to control simulation flow.

Phase 3 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

logger = logging.getLogger(__name__)


class SimulationState:
    """Thread-safe simulation state tracker."""

    def __init__(self) -> None:
        self.step = 0
        self.max_steps = 0
        self.running = False
        self.paused = False
        self.world_id = ""
        self.agent_count = 0
        self._lock = threading.Lock()

    def update(self, **kwargs: object) -> None:
        with self._lock:
            for key, value in kwargs.items():
                if hasattr(self, key):
                    setattr(self, key, value)

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "step": self.step,
                "max_steps": self.max_steps,
                "running": self.running,
                "paused": self.paused,
                "world_id": self.world_id,
                "agent_count": self.agent_count,
            }


class StepController:
    """Thread-safe play/pause/step controller.

    The simulation engine calls wait_for_step_permission() before each step.
    The controller blocks until play/step/stop is signaled.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._mode: str = "play"  # "play", "pause", "step", "stop"
        self._lock = threading.Lock()
        self._event.set()  # Start in play mode

    def play(self) -> None:
        with self._lock:
            self._mode = "play"
            self._event.set()

    def pause(self) -> None:
        with self._lock:
            self._mode = "pause"
            self._event.clear()

    def step(self) -> None:
        with self._lock:
            self._mode = "step"
            self._event.set()

    def stop(self) -> None:
        with self._lock:
            self._mode = "stop"
            self._event.set()

    @property
    def is_stopped(self) -> bool:
        with self._lock:
            return self._mode == "stop"

    def wait_for_step_permission(self) -> None:
        """Block until the controller permits the next step."""
        self._event.wait()
        with self._lock:
            if self._mode == "step":
                # After one step, go back to paused
                self._mode = "pause"
                self._event.clear()


def _make_handler_class(
    controller: StepController,
    sim_state: SimulationState,
) -> type:
    """Create a request handler class with access to controller and state."""

    class ControlHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path == "/simulation/play":
                controller.play()
                sim_state.update(paused=False)
                self._send_ok()
            elif self.path == "/simulation/pause":
                controller.pause()
                sim_state.update(paused=True)
                self._send_ok()
            elif self.path == "/simulation/step":
                controller.step()
                self._send_ok()
            elif self.path == "/simulation/stop":
                controller.stop()
                sim_state.update(running=False)
                self._send_ok()
            else:
                self._send_json(404, {"error": "Not found"})

        def do_GET(self) -> None:
            if self.path == "/simulation/status":
                self._send_json(200, sim_state.to_dict())
            else:
                self._send_json(404, {"error": "Not found"})

        def _send_ok(self) -> None:
            self._send_json(200, {"status": "ok"})

        def _send_json(self, status: int, data: dict) -> None:
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass  # Suppress default HTTP logs

    return ControlHandler


def start_control_server(
    controller: StepController,
    sim_state: SimulationState,
    port: int = 3202,
    host: str = "127.0.0.1",
) -> HTTPServer:
    """Start the control HTTP server in a background thread."""
    handler_class = _make_handler_class(controller, sim_state)
    server = HTTPServer((host, port), handler_class)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("Control server started on %s:%d", host, port)
    return server
