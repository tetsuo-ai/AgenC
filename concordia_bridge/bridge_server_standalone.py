"""
Concordia Bridge Server — enterprise-grade standalone bridge with daemon integration.

Connects to the AgenC daemon via WebSocket for real LLM responses (Grok).
Each agent and the GM get their own daemon session. Falls back to mock
responses if the daemon is unavailable.

Endpoints:
  POST /setup           — configure world + agents, launch simulation
  POST /act             — agent action (routed through daemon LLM)
  POST /observe         — store observation in agent memory
  POST /event           — resolved event notification from engine
  POST /generate-agents — LLM-powered agent generation
  POST /reset           — clear all state
  GET  /health          — bridge health status
  GET  /metrics         — request counters
  GET  /agent/:id/state — agent identity, memory, relationships

Usage: python concordia_bridge/bridge_server_standalone.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import signal
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional

import websockets.sync.client

from concordia_bridge.bridge_types import SimulationEvent, SimulationConfig, AgentConfig
from concordia_bridge.event_server import EventServer
from concordia_bridge.control_server import StepController, SimulationState, start_control_server

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
)
logger = logging.getLogger("concordia.bridge")


# ============================================================================
# Daemon WebSocket Client
# ============================================================================

class DaemonClient:
    """Connects to the AgenC daemon via WebSocket for real LLM responses.

    Each agent gets its own WebSocket connection and session. The client
    blocks until the daemon responds (synchronous bridge for Concordia's
    synchronous engine).
    """

    def __init__(self, daemon_url: str = "ws://127.0.0.1:3100"):
        self.daemon_url = daemon_url
        self._connections: dict[str, websockets.sync.client.ClientConnection] = {}
        self._sessions: dict[str, str] = {}  # agent_id -> session_id
        self._agent_locks: dict[str, threading.Lock] = {}  # per-agent lock for thread safety
        self.available = False
        self._lock = threading.Lock()  # global lock for connection/session maps

    def start(self):
        """Test daemon connectivity."""
        try:
            ws = websockets.sync.client.connect(self.daemon_url, open_timeout=5)
            ws.send(json.dumps({"type": "ping", "id": "health"}))
            resp = json.loads(ws.recv(timeout=5))
            ws.close()
            self.available = resp.get("type") == "pong"
            if self.available:
                logger.info("Daemon connected at %s", self.daemon_url)
            else:
                logger.warning("Daemon responded but unexpected: %s", resp)
        except Exception as exc:
            self.available = False
            logger.warning("Daemon unavailable at %s: %s — using mock fallback", self.daemon_url, exc)

    def stop(self):
        with self._lock:
            for ws in self._connections.values():
                try:
                    ws.close()
                except Exception:
                    pass
            self._connections.clear()
            self._sessions.clear()

    def _get_connection(self, agent_id: str) -> websockets.sync.client.ClientConnection:
        """Get or create a WebSocket connection for an agent."""
        with self._lock:
            ws = self._connections.get(agent_id)
            if ws is not None:
                try:
                    ws.ping()
                    return ws
                except Exception:
                    self._connections.pop(agent_id, None)
                    self._sessions.pop(agent_id, None)

            ws = websockets.sync.client.connect(self.daemon_url, open_timeout=10)
            self._connections[agent_id] = ws

            # Create a new session
            ws.send(json.dumps({
                "type": "chat.new",
                "payload": {"workspaceRoot": "/tmp/concordia"},
                "id": f"new-{agent_id}",
            }))

            # Read responses until we get chat.session
            session_id = None
            for _ in range(10):
                try:
                    msg = json.loads(ws.recv(timeout=10))
                    if msg.get("type") == "chat.session":
                        session_id = msg.get("payload", {}).get("sessionId")
                        break
                except Exception:
                    break

            if session_id:
                self._sessions[agent_id] = session_id
                logger.info("Session created for %s: %s", agent_id, session_id[:20])
            else:
                logger.warning("Failed to get session for %s", agent_id)

            return ws

    def _get_agent_lock(self, agent_id: str) -> threading.Lock:
        with self._lock:
            if agent_id not in self._agent_locks:
                self._agent_locks[agent_id] = threading.Lock()
            return self._agent_locks[agent_id]

    def send_message(self, agent_id: str, content: str, timeout: float = 120.0) -> str:
        """Send a message and block until the daemon responds. Thread-safe per agent."""
        if not self.available:
            return ""

        agent_lock = self._get_agent_lock(agent_id)
        if not agent_lock.acquire(timeout=timeout):
            logger.warning("Agent %s lock timeout — another request is in progress", agent_id)
            return ""

        try:
            ws = self._get_connection(agent_id)
            ws.send(json.dumps({
                "type": "chat.message",
                "payload": {"content": content},
                "id": f"act-{agent_id}-{int(time.time())}",
            }))

            # Wait for chat.message response with sender=agent
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    raw = ws.recv(timeout=min(5, deadline - time.time()))
                    msg = json.loads(raw)
                    if msg.get("type") == "chat.message":
                        payload = msg.get("payload", {})
                        if payload.get("sender") == "agent":
                            return payload.get("content", "")
                except TimeoutError:
                    continue
                except Exception as exc:
                    logger.warning("Error reading daemon response for %s: %s", agent_id, exc)
                    break

            logger.warning("Daemon response timeout for %s after %.0fs", agent_id, timeout)
            return ""
        except Exception as exc:
            logger.error("Daemon send failed for %s: %s", agent_id, exc)
            # Mark connection as dead
            with self._lock:
                self._connections.pop(agent_id, None)
                self._sessions.pop(agent_id, None)
            return ""
        finally:
            agent_lock.release()


# ============================================================================
# Mock GM (fallback when daemon unavailable)
# ============================================================================

class MockGM:
    """Fallback GM with canned responses when daemon is unavailable."""

    def __init__(self, agents: list[str], premise: str):
        self._agents = agents
        self._history: list[str] = []
        self._step = 0
        self._turn_idx = 0
        self.name = "GameMaster"
        self._templates = [
            "The scene is active. Characters go about their tasks.",
            "Tension builds as interactions between participants continue.",
            "Something shifts in the atmosphere. New developments emerge.",
            "The consequences of earlier actions begin to show.",
            "A quiet moment before the next significant event.",
            "Activity intensifies as the situation evolves.",
            "Earlier interactions have created new dynamics.",
            "The pace of events quickens noticeably.",
        ]

    def act(self, action_spec) -> str:
        from concordia.typing.entity import OutputType
        if action_spec.output_type == OutputType.TERMINATE:
            return "No"
        if action_spec.output_type == OutputType.NEXT_ACTING:
            agent = self._agents[self._turn_idx % len(self._agents)]
            self._turn_idx += 1
            return agent
        if action_spec.output_type == OutputType.MAKE_OBSERVATION:
            return self._templates[self._step % len(self._templates)]
        if action_spec.output_type == OutputType.RESOLVE:
            last = self._history[-1] if self._history else ""
            event = last.replace("[putative_event] ", "")
            return f"The action takes effect: {event}"
        if action_spec.output_type == OutputType.NEXT_GAME_MASTER:
            return self.name
        return ""

    def observe(self, observation: str):
        self._history.append(observation)
        if "[event]" in observation:
            self._step += 1


# ============================================================================
# Daemon-powered GM
# ============================================================================

class DaemonGM:
    """GM that uses the AgenC daemon (Grok) for real LLM responses."""

    def __init__(self, daemon: DaemonClient, agents: list[str], premise: str):
        self._daemon = daemon
        self._agents = agents
        self._premise = premise
        self._history: list[str] = []
        self._turn_idx = 0
        self.name = "GameMaster"

    def act(self, action_spec) -> str:
        from concordia.typing.entity import OutputType

        if action_spec.output_type == OutputType.TERMINATE:
            return "No"

        if action_spec.output_type == OutputType.NEXT_GAME_MASTER:
            return self.name

        if action_spec.output_type == OutputType.NEXT_ACTING:
            # Round-robin for reliability (LLM choice is unreliable for this)
            agent = self._agents[self._turn_idx % len(self._agents)]
            self._turn_idx += 1
            return agent

        # For MAKE_OBSERVATION and RESOLVE, use the daemon LLM
        context = "\n".join(self._history[-10:])
        prompt = f"[Simulation GM]\nPremise: {self._premise}\n\nRecent events:\n{context}\n\n{action_spec.call_to_action}\n\nRespond concisely (1-3 sentences)."

        response = self._daemon.send_message("gamemaster", prompt, timeout=60)

        # Rate limit protection — small delay between GM LLM calls
        time.sleep(1)

        if not response:
            # Fallback to simple response
            if action_spec.output_type == OutputType.MAKE_OBSERVATION:
                return "The scene continues to unfold."
            return "The action proceeds as described."

        return response.strip()

    def observe(self, observation: str):
        self._history.append(observation)
        if len(self._history) > 50:
            self._history = self._history[-50:]


# ============================================================================
# Global state
# ============================================================================

AGENTS: dict[str, dict] = {}
OBSERVATIONS: dict[str, list[str]] = {}
TURNS: dict[str, int] = {}
LAST_ACTIONS: dict[str, str] = {}
RELATIONSHIPS: dict[str, dict[str, dict]] = {}  # agent_id -> {other_id -> {count, sentiment}}
WORLD_FACTS: list[dict] = []

event_server: Optional[EventServer] = None
controller: Optional[StepController] = None
sim_state: Optional[SimulationState] = None
daemon_client: Optional[DaemonClient] = None
sim_thread: Optional[threading.Thread] = None
_start_time = time.time()


# ============================================================================
# Simulation runner
# ============================================================================

def run_simulation_thread(config: SimulationConfig):
    global sim_state, controller

    logger.info("Simulation starting: %s (%d agents, %d steps)",
                config.world_id, len(config.agents), config.max_steps)

    from concordia_bridge.proxy_entity import ProxyEntityWithLogging
    from concordia_bridge.instrumented_engine import InstrumentedSequentialEngine

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

    agent_names = [a.name for a in config.agents]

    # Use daemon-powered GM if available, otherwise mock
    if daemon_client and daemon_client.available:
        gm = DaemonGM(daemon_client, agent_names, config.premise)
        logger.info("Using DaemonGM (Grok-powered)")
    else:
        gm = MockGM(agent_names, config.premise)
        logger.info("Using MockGM (daemon unavailable)")

    def on_event(ev: SimulationEvent):
        if event_server:
            event_server.broadcast(ev)

    engine = InstrumentedSequentialEngine(
        event_callback=on_event,
        bridge_url=config.bridge_url,
        world_id=config.world_id,
    )

    sim_state.update(running=True, paused=False)

    def step_callback(step):
        sim_state.update(step=step)
        on_event(SimulationEvent(
            type="step",
            step=step,
            timestamp=time.time(),
            metadata={"phase": "step_complete"},
        ))
        time.sleep(2)  # Pace for viewing

    try:
        engine.run_loop(
            game_masters=[gm],
            entities=proxy_entities,
            premise=config.premise,
            max_steps=config.max_steps,
            step_controller=controller,
            step_callback=step_callback,
        )
    except Exception as exc:
        logger.error("Simulation error: %s", exc, exc_info=True)
    finally:
        sim_state.update(running=False)
        on_event(SimulationEvent(
            type="terminate",
            step=sim_state.step,
            timestamp=time.time(),
            content="Simulation complete",
        ))
        logger.info("Simulation finished at step %d", sim_state.step)


# ============================================================================
# Bridge HTTP handler
# ============================================================================

class BridgeHandler(BaseHTTPRequestHandler):

    def do_POST(self):
        global sim_thread, controller, sim_state
        body = self._read_json()

        if self.path == "/setup":
            self._handle_setup(body)
        elif self.path == "/act":
            self._handle_act(body)
        elif self.path == "/observe":
            self._handle_observe(body)
        elif self.path == "/event":
            self._handle_event(body)
        elif self.path == "/generate-agents":
            self._handle_generate_agents(body)
        elif self.path == "/reset":
            AGENTS.clear(); OBSERVATIONS.clear(); TURNS.clear()
            LAST_ACTIONS.clear(); RELATIONSHIPS.clear(); WORLD_FACTS.clear()
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def _handle_setup(self, body: dict):
        global sim_thread, controller, sim_state

        AGENTS.clear(); OBSERVATIONS.clear(); TURNS.clear()
        LAST_ACTIONS.clear(); RELATIONSHIPS.clear(); WORLD_FACTS.clear()

        for agent in body.get("agents", []):
            aid = agent["agent_id"]
            AGENTS[aid] = agent
            OBSERVATIONS[aid] = []
            TURNS[aid] = 0

        sessions = {a["agent_id"]: f"session:{a['agent_id']}" for a in body.get("agents", [])}

        # Read ALL config from request
        max_steps = body.get("max_steps", body.get("maxSteps", 20))

        config = SimulationConfig(
            world_id=body.get("world_id", "default"),
            workspace_id=body.get("workspace_id", "concordia-sim"),
            premise=body.get("premise", ""),
            agents=[
                AgentConfig(
                    id=a["agent_id"],
                    name=a["agent_name"],
                    personality=a.get("personality", ""),
                    goal=a.get("goal", ""),
                )
                for a in body.get("agents", [])
            ],
            max_steps=max_steps,
            gm_model=body.get("gm_model", "grok-3-mini"),
            gm_provider=body.get("gm_provider", "ollama"),
            bridge_url="http://127.0.0.1:3200",
        )

        # Store premise as world fact
        WORLD_FACTS.append({
            "content": config.premise,
            "observedBy": "GM",
            "confirmations": 0,
            "timestamp": time.time(),
        })

        sim_state.update(
            max_steps=config.max_steps,
            world_id=config.world_id,
            agent_count=len(config.agents),
            step=0,
            running=True,
            paused=False,
        )
        controller.play()

        sim_thread = threading.Thread(target=run_simulation_thread, args=(config,), daemon=True)
        sim_thread.start()

        logger.info("Setup + launched: %d agents, %d steps, world=%s",
                     len(AGENTS), max_steps, config.world_id)
        self._respond(200, {"status": "ok", "sessions": sessions})

    def _handle_act(self, body: dict):
        aid = body.get("agent_id", "")
        name = body.get("agent_name", "")
        spec = body.get("action_spec", {})
        TURNS[aid] = TURNS.get(aid, 0) + 1
        turn = TURNS[aid]

        action = ""

        # Try daemon first
        if daemon_client and daemon_client.available:
            call_to_action = spec.get("call_to_action", "What would you do?")
            output_type = spec.get("output_type", "free")
            options = spec.get("options", [])

            if output_type == "choice" and options:
                prompt = f"{call_to_action}\n\nChoose EXACTLY one:\n" + "\n".join(f"- {o}" for o in options) + "\n\nRespond with only the chosen option."
            else:
                prompt = f"{call_to_action}\n\nRespond concisely with your action (1-2 sentences). Do not include your name."

            action = daemon_client.send_message(aid, prompt, timeout=60)
            time.sleep(0.5)  # Rate limit protection between agent LLM calls

        # Fallback to canned response
        if not action:
            canned = [
                "considers the situation carefully",
                "takes a deliberate step forward",
                "observes the surroundings",
                "works on their primary task",
                "approaches someone nearby",
                "speaks up about what they've noticed",
                "pauses to reflect",
                "takes action toward their goal",
            ]
            action = canned[(turn - 1) % len(canned)]

        # Post-process: strip name prefix
        for prefix in [f"{name}: ", f"{name}:", f"{name} — ", f"{name} - "]:
            if action.startswith(prefix):
                action = action[len(prefix):].strip()
                break

        # For choice type, fuzzy match
        if spec.get("output_type") == "choice" and spec.get("options"):
            options = spec["options"]
            lower = action.lower().strip()
            matched = None
            for o in options:
                if o.lower() == lower or o.lower() in lower or lower in o.lower():
                    matched = o
                    break
            if matched:
                action = matched
            else:
                action = options[0]

        LAST_ACTIONS[aid] = action
        self._respond(200, {"action": action})

    def _handle_observe(self, body: dict):
        aid = body.get("agent_id", "")
        obs = body.get("observation", "")
        OBSERVATIONS.setdefault(aid, []).append(obs)
        self._respond(200, {"status": "ok"})

    def _handle_event(self, body: dict):
        # Parse resolved events for relationships and world facts
        content = body.get("content", "")
        acting = body.get("acting_agent", "")
        step = body.get("step", 0)

        if acting and content:
            # Check if other agents are mentioned
            for aid in AGENTS:
                if aid != acting and (aid.lower() in content.lower() or
                    AGENTS[aid].get("agent_name", "").lower() in content.lower()):
                    # Record relationship
                    if acting not in RELATIONSHIPS:
                        RELATIONSHIPS[acting] = {}
                    if aid not in RELATIONSHIPS[acting]:
                        RELATIONSHIPS[acting][aid] = {"count": 0, "sentiment": 0.0}
                    RELATIONSHIPS[acting][aid]["count"] += 1

            # Store as world fact if it's a resolution
            if body.get("type") == "resolution":
                WORLD_FACTS.append({
                    "content": content[:200],
                    "observedBy": acting or "GM",
                    "confirmations": 0,
                    "timestamp": time.time(),
                })
                # Keep only last 20 world facts
                if len(WORLD_FACTS) > 20:
                    WORLD_FACTS[:] = WORLD_FACTS[-20:]

        if event_server:
            event_server.broadcast(SimulationEvent(
                type=body.get("type", "event"),
                step=step,
                agent_name=acting,
                content=content,
            ))

        self._respond(200, {"status": "ok"})

    def _handle_generate_agents(self, body: dict):
        count = body.get("count", 3)
        premise = body.get("premise", "")
        world_id = body.get("worldId", "generated")

        if not daemon_client or not daemon_client.available:
            # Fallback: generate simple agents without LLM
            agents = []
            names = ["Alex", "Jordan", "Sam", "Riley", "Morgan", "Casey", "Quinn", "Avery", "Taylor", "Drew"]
            for i in range(min(count, 10)):
                name = names[i % len(names)]
                agents.append({
                    "id": name.lower(),
                    "name": name,
                    "personality": f"{name} is a participant in this scenario with their own unique perspective and motivations.",
                    "goal": f"Navigate the situation and achieve a meaningful outcome.",
                })
            self._respond(200, {"agents": agents})
            return

        prompt = f"""Generate exactly {count} diverse characters for this simulation scenario.

Premise: {premise}

Respond with ONLY a JSON array (no other text, no markdown). Each element must have:
- "id": lowercase identifier with hyphens (e.g. "elena-santos")
- "name": full display name
- "personality": 2-3 sentences describing background, traits, quirks, and how they interact with others
- "goal": what this character specifically wants to achieve in this scenario

Make the characters diverse in personality, background, and motivation. Create potential for interesting conflicts and alliances between them."""

        response = daemon_client.send_message("agent-generator", prompt, timeout=60)

        if not response:
            self._respond(500, {"error": "Failed to generate agents — daemon did not respond"})
            return

        # Parse JSON from response (handle markdown code blocks)
        json_str = response.strip()
        if "```" in json_str:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", json_str)
            if match:
                json_str = match.group(1).strip()

        try:
            agents = json.loads(json_str)
            if not isinstance(agents, list):
                raise ValueError("Expected JSON array")
            # Validate structure
            for a in agents:
                if not all(k in a for k in ("id", "name", "personality", "goal")):
                    raise ValueError(f"Agent missing required fields: {a}")
            self._respond(200, {"agents": agents})
        except (json.JSONDecodeError, ValueError) as exc:
            logger.error("Failed to parse generated agents: %s\nResponse: %s", exc, response[:500])
            self._respond(500, {"error": f"Failed to parse agent generation response: {exc}"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {
                "status": "ok",
                "daemon_available": daemon_client.available if daemon_client else False,
                "active_sessions": len(AGENTS),
                "uptime_ms": int((time.time() - _start_time) * 1000),
            })
        elif self.path == "/metrics":
            self._respond(200, {
                "act_requests": sum(TURNS.values()),
                "observe_requests": sum(len(v) for v in OBSERVATIONS.values()),
                "active_sessions": len(AGENTS),
                "daemon_available": daemon_client.available if daemon_client else False,
            })
        elif self.path.startswith("/agent/") and self.path.endswith("/state"):
            aid = self.path.split("/")[2]
            agent = AGENTS.get(aid)
            if agent:
                # Build relationships for this agent
                rels = []
                for other_id, data in RELATIONSHIPS.get(aid, {}).items():
                    rels.append({
                        "otherAgentId": other_id,
                        "relationship": "acquaintance",
                        "sentiment": data.get("sentiment", 0.0),
                        "interactionCount": data.get("count", 0),
                    })

                self._respond(200, {
                    "identity": {
                        "name": agent.get("agent_name", aid),
                        "personality": agent.get("personality", ""),
                        "learnedTraits": [],
                        "beliefs": {},
                    },
                    "memoryCount": len(OBSERVATIONS.get(aid, [])),
                    "recentMemories": [
                        {"content": obs[:200], "role": "system", "timestamp": int(time.time() * 1000)}
                        for obs in (OBSERVATIONS.get(aid, [])[-5:])
                    ],
                    "relationships": rels,
                    "worldFacts": WORLD_FACTS[-5:],
                    "turnCount": TURNS.get(aid, 0),
                    "lastAction": LAST_ACTIONS.get(aid),
                })
            else:
                self._respond(404, {"error": f"Agent {aid} not found"})
        else:
            self._respond(404, {"error": "not found"})

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length > 0 else {}

    def _respond(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *args):
        pass


# ============================================================================
# Main
# ============================================================================

def main():
    global event_server, controller, sim_state, daemon_client, _start_time

    _start_time = time.time()

    print("=" * 55)
    print("  AgenC Concordia Bridge Server")
    print("=" * 55)
    print()

    # Connect to daemon
    daemon_client = DaemonClient("ws://127.0.0.1:3100")
    daemon_client.start()
    print(f"[1/4] Daemon: {'CONNECTED (Grok-powered)' if daemon_client.available else 'UNAVAILABLE (mock fallback)'}")

    # Start event server
    event_server = EventServer(port=3201)
    event_server.start()
    print("[2/4] Event server on ws://0.0.0.0:3201")

    # Start control server
    controller = StepController()
    sim_state = SimulationState()
    control_srv = start_control_server(controller, sim_state, port=3202)
    print("[3/4] Control server on http://0.0.0.0:3202")

    # Start bridge HTTP server (threaded for concurrent requests)
    bridge = ThreadingHTTPServer(("0.0.0.0", 3200), BridgeHandler)
    bridge_thread = threading.Thread(target=bridge.serve_forever, daemon=True)
    bridge_thread.start()
    print("[4/4] Bridge server on http://0.0.0.0:3200")

    print()
    print("Ready. Open AgenC web UI → click SIM → configure → Launch.")
    print("Press Ctrl+C to stop.")

    try:
        signal.pause()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        bridge.shutdown()
        daemon_client.stop()
        event_server.stop()
        control_srv.shutdown()


if __name__ == "__main__":
    main()
