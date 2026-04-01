"""Tests for EventServer and SimulationEvent streaming."""

from __future__ import annotations

import asyncio
import json
import time
import threading

import pytest
import websockets

from concordia_bridge.bridge_types import SimulationEvent
from concordia_bridge.event_server import EventServer


class TestSimulationEvent:
    def test_to_json_roundtrip(self) -> None:
        event = SimulationEvent(
            type="observation",
            step=5,
            timestamp=1234567890.0,
            agent_name="Alice",
            content="You see a market square.",
        )
        json_str = event.to_json()
        parsed = json.loads(json_str)
        assert parsed["type"] == "observation"
        assert parsed["step"] == 5
        assert parsed["agent_name"] == "Alice"
        assert parsed["content"] == "You see a market square."

    def test_from_json(self) -> None:
        data = '{"type": "action", "step": 3, "timestamp": 100.0, "agent_name": "Bob"}'
        event = SimulationEvent.from_json(data)
        assert event.type == "action"
        assert event.step == 3
        assert event.agent_name == "Bob"


class TestEventServer:
    def test_start_stop(self) -> None:
        server = EventServer(port=13201)
        server.start()
        assert server.client_count == 0
        server.stop()
        assert server._thread is not None
        assert not server._thread.is_alive()

    def test_broadcast_buffers_events(self) -> None:
        server = EventServer(port=13202)
        server.start()
        try:
            server.broadcast(SimulationEvent(
                type="step",
                step=1,
                timestamp=time.time(),
                content="test event",
            ))
            assert server.event_count == 1

            server.broadcast(SimulationEvent(
                type="step",
                step=2,
                timestamp=time.time(),
            ))
            assert server.event_count == 2
        finally:
            server.stop()

    def test_replay_buffer_capped(self) -> None:
        server = EventServer(port=13203, max_buffer=5)
        server.start()
        try:
            for i in range(10):
                server.broadcast(SimulationEvent(
                    type="step",
                    step=i,
                    timestamp=time.time(),
                ))
            assert server.event_count == 5
        finally:
            server.stop()

    def test_broadcast_from_non_async_thread(self) -> None:
        """Verify broadcast works from a synchronous thread (like Concordia engine)."""
        server = EventServer(port=13204)
        server.start()
        try:
            results = []

            def sync_broadcaster():
                for i in range(5):
                    server.broadcast(SimulationEvent(
                        type="step",
                        step=i,
                        timestamp=time.time(),
                    ))
                    time.sleep(0.01)
                results.append("done")

            thread = threading.Thread(target=sync_broadcaster)
            thread.start()
            thread.join(timeout=5)

            assert results == ["done"]
            assert server.event_count == 5
        finally:
            server.stop()

    def test_stop_without_clients_or_pending_events_is_clean(self) -> None:
        server = EventServer(port=13205)
        server.start()
        server.stop()
        assert server._loop is None
