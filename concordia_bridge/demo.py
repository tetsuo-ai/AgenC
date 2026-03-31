"""
Standalone Concordia demo — runs a simulation you can watch.

Starts a mock bridge (simple HTTP server that returns canned LLM responses),
an event WebSocket server, and runs the medieval town simulation.

No AgenC daemon required — this is a self-contained demo.

Usage:
    python concordia_bridge/demo.py
    # Or via the script:
    ./scripts/run-concordia-demo.sh
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

from concordia_bridge.bridge_types import SimulationConfig, AgentConfig, SimulationEvent
from concordia_bridge.event_server import EventServer
from concordia_bridge.proxy_entity import ProxyEntityWithLogging
from concordia_bridge.instrumented_engine import InstrumentedSequentialEngine
from concordia_bridge.control_server import StepController, SimulationState, start_control_server

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
)
logger = logging.getLogger("concordia.demo")

# ============================================================================
# Mock bridge — returns personality-driven responses without a real LLM
# ============================================================================

AGENT_PERSONALITIES = {}
AGENT_OBSERVATIONS = {}
AGENT_TURN = {}


class MockBridgeHandler(BaseHTTPRequestHandler):
    """Simple bridge that generates responses based on agent personality."""

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

        if self.path == "/setup":
            for agent in body.get("agents", []):
                AGENT_PERSONALITIES[agent["agent_id"]] = agent.get("personality", "")
                AGENT_OBSERVATIONS[agent["agent_id"]] = []
                AGENT_TURN[agent["agent_id"]] = 0
            sessions = {a["agent_id"]: f"session:{a['agent_id']}" for a in body.get("agents", [])}
            self._respond(200, {"status": "ok", "sessions": sessions})

        elif self.path == "/act":
            agent_id = body.get("agent_id", "unknown")
            agent_name = body.get("agent_name", "Unknown")
            spec = body.get("action_spec", {})
            output_type = spec.get("output_type", "free")
            options = spec.get("options", [])
            AGENT_TURN[agent_id] = AGENT_TURN.get(agent_id, 0) + 1
            turn = AGENT_TURN[agent_id]

            if output_type == "choice" and options:
                # Pick based on personality
                action = options[turn % len(options)]
            else:
                action = self._generate_action(agent_id, agent_name, turn)

            self._respond(200, {"action": action})

        elif self.path == "/observe":
            agent_id = body.get("agent_id", "unknown")
            obs = body.get("observation", "")
            if agent_id not in AGENT_OBSERVATIONS:
                AGENT_OBSERVATIONS[agent_id] = []
            AGENT_OBSERVATIONS[agent_id].append(obs)
            self._respond(200, {"status": "ok"})

        elif self.path == "/event":
            self._respond(200, {"status": "ok"})

        elif self.path == "/health":
            self._respond(200, {"status": "ok", "active_sessions": len(AGENT_PERSONALITIES)})

        else:
            self._respond(404, {"error": "not found"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def _generate_action(self, agent_id: str, agent_name: str, turn: int) -> str:
        """Generate a simple action based on personality and turn number."""
        personality = AGENT_PERSONALITIES.get(agent_id, "")
        recent_obs = AGENT_OBSERVATIONS.get(agent_id, [])[-3:]

        # Simple personality-driven responses
        actions = {
            "elena": [
                "examines the iron ore quality at the smithy",
                "begins heating the forge for the day's work",
                "inspects the sword commission from the guard captain",
                "hammers a blade on the anvil with practiced precision",
                "discusses iron prices with a customer",
                "notices the traveling merchant eyeing her iron stock",
                "tests the edge of a newly forged blade",
                "organizes raw materials in the workshop",
            ],
            "marcus": [
                "surveys the market square and notes the town layout",
                "approaches the smithy with a friendly smile",
                "inquires about the quality of local iron",
                "offers to buy iron at a competitive price",
                "casually asks about the town guard's equipment",
                "examines the town's defensive walls during a walk",
                "makes notes in a small journal when no one is watching",
                "engages a local in conversation about town politics",
            ],
            "sera": [
                "opens the healing house and prepares remedies",
                "checks on patients from yesterday",
                "gathers herbs from the garden",
                "observes the new merchant from a distance",
                "notices the merchant asking unusual questions",
                "confides her suspicions to a trusted townsperson",
                "treats a minor injury for a market vendor",
                "reviews her notes on the merchant's behavior",
            ],
        }

        agent_actions = actions.get(agent_id, [
            f"looks around thoughtfully",
            f"considers the situation carefully",
            f"takes a deliberate action",
        ])

        return agent_actions[(turn - 1) % len(agent_actions)]

    def _respond(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # Suppress HTTP logs


# ============================================================================
# Mock GM (in-process, no real LLM needed)
# ============================================================================

class MockGameMaster:
    """Simple GM that generates observations and resolves events."""

    def __init__(self, agents: list[str], premise: str):
        self._agents = agents
        self._premise = premise
        self._observations: list[str] = []
        self._step = 0
        self._turn_order_idx = 0
        self.name = "GameMaster"

    def act(self, action_spec) -> str:
        from concordia.typing.entity import OutputType

        if action_spec.output_type == OutputType.TERMINATE:
            return "No"

        if action_spec.output_type == OutputType.NEXT_ACTING:
            agent = self._agents[self._turn_order_idx % len(self._agents)]
            self._turn_order_idx += 1
            return agent

        if action_spec.output_type == OutputType.MAKE_OBSERVATION:
            # Generate observation based on recent events
            target = action_spec.call_to_action.split("{name}")[-1] if "{name}" in action_spec.call_to_action else ""
            return self._generate_observation()

        if action_spec.output_type == OutputType.RESOLVE:
            return self._resolve_event()

        if action_spec.output_type == OutputType.NEXT_GAME_MASTER:
            return self.name

        return ""

    def observe(self, observation: str):
        self._observations.append(observation)
        if "[event]" in observation:
            self._step += 1

    def _generate_observation(self) -> str:
        """Generate context-aware observations."""
        observations = [
            "The morning sun casts long shadows across the market square. Merchants set up stalls while townspeople begin their daily routines.",
            "The smithy's forge glows orange, sending waves of heat into the cool morning air. The sound of hammering echoes through the square.",
            "A traveling merchant's cart is parked near the market entrance, laden with exotic goods. He seems particularly interested in the smithy.",
            "The healing house is quiet but busy. The healer tends to her herb garden, occasionally glancing toward the market.",
            "Townspeople gather in small groups, exchanging gossip about the new merchant and his unusual interest in town affairs.",
            "The guard captain passes through the square, reminding everyone of the upcoming inspection of town defenses.",
            "Smoke rises from the smithy as the blacksmith works on a special commission. The quality of her work draws admiring glances.",
            "The merchant examines goods at various stalls, but his eyes keep drifting back to the smithy and the iron stockpile.",
        ]
        return observations[self._step % len(observations)]

    def _resolve_event(self) -> str:
        """Resolve the latest event."""
        if self._observations:
            last = self._observations[-1]
            if "[putative_event]" in last:
                event = last.replace("[putative_event] ", "")
                return f"The event unfolds as described: {event}"
        return "The moment passes without incident."


# ============================================================================
# Main demo
# ============================================================================

def run_demo():
    print("=" * 60)
    print("  AgenC x Concordia — Medieval Town Demo")
    print("=" * 60)
    print()

    # Config
    config = SimulationConfig(
        world_id="demo-medieval-town",
        workspace_id="concordia-demo",
        premise=(
            "It is morning in the medieval town of Thornfield. "
            "The market square is bustling with activity. "
            "Three residents begin their day: Elena the blacksmith, "
            "Marcus the traveling merchant, and Sera the healer."
        ),
        agents=[
            AgentConfig(
                id="elena", name="Elena",
                personality="Town blacksmith. Practical, strong-willed, values honest work.",
                goal="Complete the sword commission for the guard captain.",
            ),
            AgentConfig(
                id="marcus", name="Marcus",
                personality="Traveling merchant. Charming, opportunistic. Secretly a spy.",
                goal="Buy iron cheaply and gather intelligence on town defenses.",
            ),
            AgentConfig(
                id="sera", name="Sera",
                personality="Town healer. Compassionate, perceptive, strong moral compass.",
                goal="Keep the town healthy. Suspects the merchant is not what he seems.",
            ),
        ],
        max_steps=12,
        bridge_url="http://127.0.0.1:3200",
        event_port=3201,
        control_port=3202,
    )

    # 1. Start mock bridge
    print("[1/4] Starting mock bridge on port 3200...")
    bridge_server = HTTPServer(("127.0.0.1", 3200), MockBridgeHandler)
    bridge_thread = threading.Thread(target=bridge_server.serve_forever, daemon=True)
    bridge_thread.start()

    # 2. Start event server
    print("[2/4] Starting event server on port 3201...")
    print("       Connect a WebSocket client to ws://localhost:3201 to watch live!")
    event_server = EventServer(port=3201)
    event_server.start()

    # 3. Start control server
    print("[3/4] Starting control server on port 3202...")
    controller = StepController()
    sim_state = SimulationState()
    sim_state.update(
        max_steps=config.max_steps,
        world_id=config.world_id,
        agent_count=len(config.agents),
        running=True,
    )
    control_srv = start_control_server(controller, sim_state, port=3202)

    # 4. Setup agents via bridge
    import requests
    requests.post(f"{config.bridge_url}/setup", json={
        "world_id": config.world_id,
        "workspace_id": config.workspace_id,
        "agents": [
            {"agent_id": a.id, "agent_name": a.name, "personality": a.personality, "goal": a.goal}
            for a in config.agents
        ],
        "premise": config.premise,
    })

    # Create proxy entities
    proxy_entities = [
        ProxyEntityWithLogging(
            agent_name=a.name,
            bridge_url=config.bridge_url,
            agent_id=a.id,
            world_id=config.world_id,
            workspace_id=config.workspace_id,
        )
        for a in config.agents
    ]

    # Create mock GM
    gm = MockGameMaster(
        agents=[a.name for a in config.agents],
        premise=config.premise,
    )

    # Create engine
    def event_callback(event: SimulationEvent):
        event_server.broadcast(event)
        # Print to console for local viewing
        if event.type == "observation":
            print(f"  [OBS] GM → {event.agent_name}: {event.content}")
        elif event.type == "action":
            print(f"  [ACT] {event.agent_name}: {event.content}")
        elif event.type == "resolution":
            print(f"  [RES] {event.resolved_event or event.content}")
        elif event.type == "scene_change":
            print(f"  [SCENE] {event.content}")
        elif event.type == "terminate":
            print(f"  [END] {event.content}")

    engine = InstrumentedSequentialEngine(
        event_callback=event_callback,
        bridge_url=config.bridge_url,
        world_id=config.world_id,
    )

    print(f"[4/4] Running simulation: {config.world_id}")
    print(f"       Agents: {', '.join(a.name for a in config.agents)}")
    print(f"       Steps: {config.max_steps}")
    print()
    print("-" * 60)
    print()

    try:
        def step_callback(step):
            sim_state.update(step=step)
            print(f"\n--- Step {step}/{config.max_steps} ---\n")

        engine.run_loop(
            game_masters=[gm],
            entities=proxy_entities,
            premise=config.premise,
            max_steps=config.max_steps,
            step_callback=step_callback,
        )

        print()
        print("-" * 60)
        print()
        print(f"Simulation complete! {config.max_steps} steps, {len(config.agents)} agents.")
        print(f"Events broadcast: {event_server.event_count}")
        print()

        # Show agent logs
        for entity in proxy_entities:
            log = entity.get_last_log()
            if log:
                print(f"  {entity.name} (last action): {log.get('action', 'N/A')}")
                print(f"    Turns: {entity.turn_count}, Last latency: {log.get('elapsed_ms', 0):.0f}ms")

    except KeyboardInterrupt:
        print("\nSimulation interrupted.")
    finally:
        sim_state.update(running=False)
        event_server.stop()
        bridge_server.shutdown()
        control_srv.shutdown()


if __name__ == "__main__":
    run_demo()
