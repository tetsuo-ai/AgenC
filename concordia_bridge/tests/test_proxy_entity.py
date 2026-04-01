"""Tests for ProxyEntity and ProxyEntityWithLogging."""

from __future__ import annotations

import json
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import time

import pytest

from concordia.typing.entity import ActionSpec, OutputType, DEFAULT_ACTION_SPEC

from concordia_bridge.proxy_entity import (
    ProxyEntity,
    ProxyEntityActError,
    ProxyEntityWithLogging,
)


# ============================================================================
# Mock bridge server
# ============================================================================

class MockBridgeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that simulates the AgenC bridge server."""

    # Class-level state for test control
    act_response: dict = {"action": "goes to the market"}
    observe_called: list = []
    act_called: list = []
    delay_seconds: float = 0.0
    error_code: int = 0

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

        if self.error_code:
            self.send_response(self.error_code)
            self.end_headers()
            self.wfile.write(b'{"error": "test error"}')
            return

        if self.delay_seconds > 0:
            time.sleep(self.delay_seconds)

        if self.path == "/act":
            MockBridgeHandler.act_called.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(self.act_response).encode())
        elif self.path == "/observe":
            MockBridgeHandler.observe_called.append(body)
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress HTTP server logs during tests


@pytest.fixture
def mock_bridge():
    """Start a mock bridge server on a random port."""
    MockBridgeHandler.act_response = {"action": "goes to the market"}
    MockBridgeHandler.observe_called = []
    MockBridgeHandler.act_called = []
    MockBridgeHandler.delay_seconds = 0.0
    MockBridgeHandler.error_code = 0

    server = HTTPServer(("127.0.0.1", 0), MockBridgeHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


# ============================================================================
# ProxyEntity Tests
# ============================================================================

class TestProxyEntity:
    def test_name_property(self, mock_bridge: str) -> None:
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        assert entity.name == "Alice"

    def test_agent_id_derived_from_name(self) -> None:
        entity = ProxyEntity(agent_name="Dr. Alice Smith")
        assert entity.agent_id == "dr.-alice-smith"

    def test_agent_id_explicit(self) -> None:
        entity = ProxyEntity(agent_name="Alice", agent_id="alice-1")
        assert entity.agent_id == "alice-1"

    def test_act_free_sends_correct_json(self, mock_bridge: str) -> None:
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url=mock_bridge,
            agent_id="alice",
            world_id="world-1",
            workspace_id="ws-1",
        )

        action_spec = ActionSpec(
            call_to_action="What would Alice do next?",
            output_type=OutputType.FREE,
            tag="action",
        )
        result = entity.act(action_spec)

        assert result == "goes to the market"
        assert len(MockBridgeHandler.act_called) == 1

        body = MockBridgeHandler.act_called[0]
        assert body["agent_id"] == "alice"
        assert body["agent_name"] == "Alice"
        assert body["world_id"] == "world-1"
        assert body["workspace_id"] == "ws-1"
        assert body["action_spec"]["output_type"] == "free"
        assert body["action_spec"]["call_to_action"] == "What would Alice do next?"
        assert body["action_spec"]["tag"] == "action"
        assert body["turn_count"] == 1

    def test_act_choice_sends_options(self, mock_bridge: str) -> None:
        MockBridgeHandler.act_response = {"action": "Accept"}
        entity = ProxyEntity(agent_name="Bob", bridge_url=mock_bridge)

        action_spec = ActionSpec(
            call_to_action="Does Bob accept the deal?",
            output_type=OutputType.CHOICE,
            options=("Accept", "Reject", "Counter-offer"),
            tag="action",
        )
        result = entity.act(action_spec)

        assert result == "Accept"
        body = MockBridgeHandler.act_called[0]
        assert body["action_spec"]["output_type"] == "choice"
        assert body["action_spec"]["options"] == ["Accept", "Reject", "Counter-offer"]

    def test_act_float_sends_correctly(self, mock_bridge: str) -> None:
        MockBridgeHandler.act_response = {"action": "0.75"}
        entity = ProxyEntity(agent_name="Sam", bridge_url=mock_bridge)

        action_spec = ActionSpec(
            call_to_action="How confident is Sam?",
            output_type=OutputType.FLOAT,
        )
        result = entity.act(action_spec)
        assert result == "0.75"

    def test_act_default_action_spec(self, mock_bridge: str) -> None:
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        result = entity.act()
        assert result == "goes to the market"

    def test_observe_sends_observation(self, mock_bridge: str) -> None:
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url=mock_bridge,
            agent_id="alice",
            world_id="world-1",
        )
        entity.observe("You see Marcus approaching the smithy.")

        assert len(MockBridgeHandler.observe_called) == 1
        body = MockBridgeHandler.observe_called[0]
        assert body["agent_id"] == "alice"
        assert body["agent_name"] == "Alice"
        assert body["world_id"] == "world-1"
        assert body["observation"] == "You see Marcus approaching the smithy."

    def test_observe_empty_string_skipped(self, mock_bridge: str) -> None:
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        entity.observe("")
        entity.observe("   ")
        assert len(MockBridgeHandler.observe_called) == 0

    def test_observe_fire_safe_on_error(self, mock_bridge: str) -> None:
        MockBridgeHandler.error_code = 500
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        # Should NOT raise
        entity.observe("This will fail but not crash")
        assert len(MockBridgeHandler.observe_called) == 0

    def test_act_timeout_raises(self, mock_bridge: str) -> None:
        MockBridgeHandler.delay_seconds = 5.0
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url=mock_bridge,
            timeout_seconds=0.5,
        )
        with pytest.raises(ProxyEntityActError):
            entity.act()

    def test_act_http_error_raises(self, mock_bridge: str) -> None:
        MockBridgeHandler.error_code = 500
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        with pytest.raises(ProxyEntityActError):
            entity.act()

    def test_act_connection_error_raises(self) -> None:
        entity = ProxyEntity(
            agent_name="Alice",
            bridge_url="http://127.0.0.1:1",  # Nothing listening
            timeout_seconds=1.0,
        )
        with pytest.raises(ProxyEntityActError):
            entity.act()

    def test_turn_count_increments(self, mock_bridge: str) -> None:
        entity = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge)
        assert entity.turn_count == 0
        entity.act()
        assert entity.turn_count == 1
        entity.act()
        assert entity.turn_count == 2

    def test_multiple_agents_independent(self, mock_bridge: str) -> None:
        alice = ProxyEntity(agent_name="Alice", bridge_url=mock_bridge, agent_id="alice")
        bob = ProxyEntity(agent_name="Bob", bridge_url=mock_bridge, agent_id="bob")

        alice.act()
        bob.act()

        assert len(MockBridgeHandler.act_called) == 2
        assert MockBridgeHandler.act_called[0]["agent_id"] == "alice"
        assert MockBridgeHandler.act_called[1]["agent_id"] == "bob"


# ============================================================================
# ProxyEntityWithLogging Tests
# ============================================================================

class TestProxyEntityWithLogging:
    def test_get_last_log_contains_action(self, mock_bridge: str) -> None:
        entity = ProxyEntityWithLogging(
            agent_name="Alice",
            bridge_url=mock_bridge,
            agent_id="alice",
        )
        entity.act()

        log = entity.get_last_log()
        assert log["action"] == "goes to the market"
        assert log["agent_id"] == "alice"
        assert log["agent_name"] == "Alice"
        assert log["turn_count"] == 1
        assert "elapsed_ms" in log
        assert isinstance(log["elapsed_ms"], float)

    def test_get_last_log_contains_action_spec(self, mock_bridge: str) -> None:
        entity = ProxyEntityWithLogging(agent_name="Alice", bridge_url=mock_bridge)
        action_spec = ActionSpec(
            call_to_action="Test prompt",
            output_type=OutputType.FREE,
            tag="action",
        )
        entity.act(action_spec)

        log = entity.get_last_log()
        assert log["action_spec"]["call_to_action"] == "Test prompt"
        assert log["action_spec"]["output_type"] == "free"

    def test_get_last_log_empty_before_act(self) -> None:
        entity = ProxyEntityWithLogging(agent_name="Alice")
        assert entity.get_last_log() == {}

    def test_get_last_log_updates_each_turn(self, mock_bridge: str) -> None:
        entity = ProxyEntityWithLogging(agent_name="Alice", bridge_url=mock_bridge)
        entity.act()
        assert entity.get_last_log()["turn_count"] == 1

        MockBridgeHandler.act_response = {"action": "crafts a sword"}
        entity.act()
        assert entity.get_last_log()["turn_count"] == 2
        assert entity.get_last_log()["action"] == "crafts a sword"

    def test_logging_entity_is_concordia_compatible(self, mock_bridge: str) -> None:
        """Verify the entity passes Concordia's EntityWithLogging contract."""
        entity = ProxyEntityWithLogging(agent_name="Alice", bridge_url=mock_bridge)
        # Must have name property
        assert entity.name == "Alice"
        # Must have act() method
        result = entity.act()
        assert isinstance(result, str)
        # Must have observe() method
        entity.observe("test observation")
        # Must have get_last_log() method
        log = entity.get_last_log()
        assert isinstance(log, dict)
