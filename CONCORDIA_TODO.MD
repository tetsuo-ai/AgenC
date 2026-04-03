# AgenC x Concordia — Generative Agent Simulation Bridge

> **Goal**: Enable AgenC agents (with persistent memory, identity, beliefs, social
> memory, knowledge graphs, and Grok-4.20) to participate in Concordia-style
> generative social simulations — with a live web viewer for watching agent
> interactions in real-time.
>
> **Architecture**: Python Concordia engine drives the simulation loop. AgenC
> agents participate as Concordia `Entity` implementations via an HTTP bridge.
> A WebSocket event stream powers a React-based live simulation viewer.
>
> **Plugin architecture**: The bridge is implemented as an AgenC `ChannelAdapter`
> plugin via `@tetsuo-ai/plugin-kit`. The daemon loads it like any other channel
> (Telegram, Discord, WebChat). The Concordia GM sends observations via the
> plugin's `on_message` callback, and agent responses are delivered via `send()`.
> This gives us daemon lifecycle management, health checks, config validation,
> and seamless integration with the existing tool/memory/identity stack.
>
> **Why hybrid, not pure TypeScript port**: Concordia's GM prefabs, event
> resolution chain-of-thought, scene management, and turn-taking engine are
> ~8,000 lines of well-tested Python. Porting would take weeks and diverge
> from upstream. The bridge approach lets us use Concordia's simulation engine
> as-is while AgenC agents bring persistent memory, identity, and Grok.

> **Status update (2026-04-03)**: The live simulation stack is now run-scoped around `simulationId`, bridge-owned replay/control APIs, and simulation-scoped memory namespaces. Any section below that treats `world_id` or `workspace_id` as the primary runtime isolation boundary should be read as historical design context, not current behavior. The active execution plan is [TODO.MD](./TODO.MD).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Concordia Engine (Python)                          │
│                                                     │
│  GameMaster (Entity)                                │
│    ├── MakeObservation (per-agent observations)     │
│    ├── NextActing (turn selection)                  │
│    ├── EventResolution (chain-of-thought)           │
│    │     ├── AccountForAgencyOfOthers               │
│    │     ├── maybe_inject_narrative_push             │
│    │     └── result_to_who_what_where               │
│    └── SceneTracker (scene transitions)             │
│                                                     │
│  ProxyEntity (per agent)                            │
│    └── HTTP POST to AgenC bridge server             │
│                                                     │
│  SimulationEventStream                              │
│    └── WebSocket push to viewer                     │
└───────────┬─────────────────────────┬───────────────┘
            │ POST /act               │ POST /observe
            │ POST /observe           │ WS events
            ▼                         ▼
┌─────────────────────────┐  ┌────────────────────────┐
│  AgenC Bridge Server    │  │  Simulation Viewer     │
│  (TypeScript, Express)  │  │  (React + WebSocket)   │
│                         │  │                        │
│  /act endpoint          │  │  Agent cards           │
│    → create session     │  │  Event timeline        │
│    → inject observation │  │  Memory inspector      │
│    → send message       │  │  Knowledge graph viz   │
│    → return response    │  │  Belief tracker        │
│                         │  │  World state panel     │
│  /observe endpoint      │  │  Scene indicator       │
│    → ingest into memory │  │                        │
│                         │  └────────────────────────┘
│  AgenC Daemon (port     │
│  3100) via WebSocket    │
│    → chat.new           │
│    → chat.message       │
│    → agent identity     │
│    → social memory      │
│    → memory ingestion   │
└─────────────────────────┘
```

---

## Phase 0: Python Concordia Entity Proxy

**Goal**: A Python `Entity` subclass that proxies `act()`/`observe()` calls
over HTTP to the AgenC bridge server.

**File**: `concordia_bridge/proxy_entity.py`

### Task 0.1: Install Concordia and verify it runs

```bash
pip install gdm-concordia
```

Run the built-in tutorial to verify installation works:
```python
from concordia.language_model import gpt_model  # or ollama, etc.
# Run a simple 2-agent simulation to confirm the engine works
```

**Acceptance**: Concordia runs a basic 5-step simulation locally with any LLM.

### Task 0.2: Implement `ProxyEntity(Entity)`

Create `concordia_bridge/proxy_entity.py`:

```python
import requests
from concordia.typing.entity import Entity, ActionSpec

class ProxyEntity(Entity):
    """Concordia Entity that proxies act/observe to an AgenC bridge server."""

    def __init__(
        self,
        agent_name: str,
        bridge_url: str,        # e.g. "http://localhost:3200"
        agent_id: str,          # AgenC agent ID
        world_id: str,          # AgenC world ID for memory isolation
        workspace_id: str,      # AgenC workspace ID
        timeout_seconds: float = 120.0,
    ):
        self._name = agent_name
        self._bridge_url = bridge_url.rstrip("/")
        self._agent_id = agent_id
        self._world_id = world_id
        self._workspace_id = workspace_id
        self._timeout = timeout_seconds

    @functools.cached_property
    def name(self) -> str:
        return self._name

    def act(self, action_spec: ActionSpec = DEFAULT_ACTION_SPEC) -> str:
        """Send action_spec to AgenC bridge, return the agent's action string."""
        response = requests.post(
            f"{self._bridge_url}/act",
            json={
                "agent_id": self._agent_id,
                "agent_name": self._name,
                "world_id": self._world_id,
                "workspace_id": self._workspace_id,
                "action_spec": action_spec.to_dict(),
            },
            timeout=self._timeout,
        )
        response.raise_for_status()
        return response.json()["action"]

    def observe(self, observation: str) -> None:
        """Send observation to AgenC bridge for memory ingestion."""
        requests.post(
            f"{self._bridge_url}/observe",
            json={
                "agent_id": self._agent_id,
                "agent_name": self._name,
                "world_id": self._world_id,
                "workspace_id": self._workspace_id,
                "observation": observation,
            },
            timeout=self._timeout,
        )
```

**Key details**:
- Concordia's `ActionSpec.to_dict()` returns:
  ```json
  {
    "call_to_action": "What would Alice do next?...",
    "output_type": "free",
    "options": [],
    "tag": "action"
  }
  ```
- `output_type` values for player agents: `"free"`, `"choice"`, `"float"`
- For `"choice"` type, `options` is a non-empty list of strings the agent must pick from
- The `{name}` placeholder in `call_to_action` is substituted by Concordia before calling `act()`
- The bridge must return `{"action": "string"}` — the raw action text (NOT prefixed with agent name; Concordia adds the prefix itself)

**Acceptance**: `ProxyEntity` can be instantiated and its `act()`/`observe()` methods make HTTP calls.

### Task 0.3: Implement `ProxyEntityWithLogging`

Concordia's engine often expects `EntityWithLogging` which adds `get_last_log()`.

```python
from concordia.typing.entity import EntityWithLogging

class ProxyEntityWithLogging(ProxyEntity, EntityWithLogging):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._last_log = {}

    def act(self, action_spec=DEFAULT_ACTION_SPEC) -> str:
        result = super().act(action_spec)
        self._last_log = {
            "action_spec": action_spec.to_dict(),
            "action": result,
            "agent_id": self._agent_id,
        }
        return result

    def get_last_log(self) -> dict:
        return self._last_log
```

### Task 0.4: Write tests for ProxyEntity

Test with a mock HTTP server (use `responses` or `httpretty` library):
- `act()` with `FREE` output type sends correct JSON, returns action string
- `act()` with `CHOICE` output type sends options array, returns one of the options
- `observe()` sends observation string, returns 200
- Timeout handling (bridge takes too long)
- HTTP error handling (bridge returns 500)

**Acceptance**: All proxy entity tests pass.

---

## Phase 1: AgenC Bridge — Plugin-Kit Channel Adapter + HTTP Server

**Goal**: A `ChannelAdapter` plugin that the daemon loads as a channel, PLUS
a lightweight HTTP server that receives Concordia proxy calls and routes them
through the plugin's `on_message` pipeline.

**Plugin package**: `agenc-plugin-concordia/` (new package in workspace)
**Bridge server**: `agenc-core/runtime/src/bridges/concordia/bridge-server.ts`

### Task 1.0: Create the plugin-kit ChannelAdapter

Create `agenc-plugin-concordia/src/adapter.ts`:

```typescript
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelAdapterManifest,
  ChannelConfigValidationResult,
} from "@tetsuo-ai/plugin-kit";

export interface ConcordiaChannelConfig {
  bridge_port: number;       // HTTP server port (default: 3200)
  event_port: number;        // WebSocket event server port (default: 3201)
  world_id?: string;         // Default world ID
  workspace_id?: string;     // Default workspace ID
  encryption_key?: string;   // Optional at-rest encryption key
}

export const manifest: ChannelAdapterManifest = {
  schema_version: 1,
  plugin_id: "ai.tetsuo.channel.concordia",
  channel_name: "concordia",
  plugin_type: "channel_adapter",
  version: "0.1.0",
  display_name: "Concordia Simulation Bridge",
  description: "Bridges Google DeepMind Concordia generative simulations to AgenC agents",
  plugin_api_version: "1.0.0",
  host_api_version: "1.0.0",
};

export function validateConfig(config: unknown): ChannelConfigValidationResult {
  const errors: string[] = [];
  const c = config as Partial<ConcordiaChannelConfig>;
  if (c.bridge_port !== undefined && (typeof c.bridge_port !== "number" || c.bridge_port < 1)) {
    errors.push("bridge_port must be a positive integer");
  }
  return { valid: errors.length === 0, errors };
}

export function createChannelAdapter(): ChannelAdapter<ConcordiaChannelConfig> {
  return new ConcordiaChannelAdapter();
}

class ConcordiaChannelAdapter implements ChannelAdapter<ConcordiaChannelConfig> {
  readonly name = "concordia";
  private context!: ChannelAdapterContext<ConcordiaChannelConfig>;
  private bridgeServer: import("http").Server | null = null;
  private pendingActRequests = new Map<string, {
    resolve: (action: string) => void;
    timeout: NodeJS.Timeout;
  }>();
  private sessions = new Map<string, string>(); // agent_id -> session_id
  private healthy = false;

  async initialize(context: ChannelAdapterContext<ConcordiaChannelConfig>): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    const port = this.context.config.bridge_port ?? 3200;
    // Create HTTP server with /act, /observe, /setup, /event, /health endpoints
    // (implementation in Task 1.1)
    this.healthy = true;
    this.context.logger.info?.(`Concordia bridge listening on port ${port}`);
  }

  async stop(): Promise<void> {
    this.healthy = false;
    if (this.bridgeServer) {
      this.bridgeServer.close();
      this.bridgeServer = null;
    }
    // Clear pending requests
    for (const [, pending] of this.pendingActRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingActRequests.clear();
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    // Agent response comes back through here.
    // Route it to the pending /act request for the matching session.
    const agentId = this.findAgentBySession(message.session_id);
    if (!agentId) return;
    const pending = this.pendingActRequests.get(agentId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(message.content);
      this.pendingActRequests.delete(agentId);
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private findAgentBySession(sessionId: string): string | undefined {
    for (const [agentId, sid] of this.sessions) {
      if (sid === sessionId) return agentId;
    }
    return undefined;
  }
}

export default { manifest, validateConfig, createChannelAdapter };
```

**How the flow works with the plugin-kit**:

1. Python ProxyEntity POSTs `/act` to the bridge HTTP server (port 3200)
2. The bridge creates a `ChannelInboundMessage` and calls `this.context.on_message()`
3. The daemon routes this through the standard pipeline: ChatExecutor → LLM → tools
4. The daemon calls `adapter.send(outboundMessage)` with the agent's response
5. `send()` resolves the pending `/act` Promise, which returns the response to Python

This means the agent gets the FULL daemon pipeline: system prompt, identity injection,
memory retrieval, tool calling, trust scoring — all without custom wiring. The plugin
is just a channel like any other.

### Task 1.1: Create the bridge HTTP server inside the adapter

The bridge HTTP server runs inside the `ConcordiaChannelAdapter.start()` method:

```typescript
const { createServer } = await import("node:http");

this.bridgeServer = createServer(async (req, res) => {
  // Parse JSON body
  // Route by path:
  //   POST /act     → handleAct(req, res)
  //   POST /observe → handleObserve(req, res)
  //   POST /setup   → handleSetup(req, res)
  //   POST /event   → handleEvent(req, res)
  //   GET  /health  → handleHealth(req, res)
  //   GET  /agent/:id/state → handleAgentState(req, res)
  //   GET  /metrics  → handleMetrics(req, res)
});

this.bridgeServer.listen(port, "127.0.0.1");
```

**Dependencies**: Only `node:http` — no Express, no external deps. The plugin-kit
contract requires zero external dependencies beyond the kit itself.

### Task 1.2: Implement the `/act` endpoint

When the bridge receives `POST /act`:

```typescript
interface ActRequest {
  agent_id: string;
  agent_name: string;
  world_id: string;
  workspace_id: string;
  action_spec: {
    call_to_action: string;
    output_type: "free" | "choice" | "float";
    options: string[];
    tag: string | null;
  };
}

interface ActResponse {
  action: string;
}
```

**Step-by-step logic**:

1. **Ensure session exists**: If no session for this `agent_id`, create one:
   - Connect to daemon WebSocket at `ws://localhost:{daemonPort}`
   - Send `{ type: "chat.new", payload: { workspaceRoot: workspace_id } }`
   - Wait for `chat.session` response containing `sessionId`
   - Store `agent_id -> sessionId` mapping

2. **Build the user message from the ActionSpec**:
   - For `output_type: "free"`:
     ```
     [Simulation Context]
     {call_to_action}

     Respond with ONLY your action. Do not include your name prefix.
     Do not include quotation marks around your response.
     ```
   - For `output_type: "choice"`:
     ```
     [Simulation Context]
     {call_to_action}

     You MUST respond with EXACTLY one of these options (copy it verbatim):
     {options.map((o, i) => `${i + 1}. ${o}`).join('\n')}

     Respond with ONLY the chosen option text. Nothing else.
     ```
   - For `output_type: "float"`:
     ```
     [Simulation Context]
     {call_to_action}

     Respond with ONLY a single number. Nothing else.
     ```

3. **Send via plugin callback**: Create a `ChannelInboundMessage` and call `this.context.on_message()`:
   ```typescript
   const sessionId = this.sessions.get(request.agent_id)
     ?? this.deriveSessionId(request.agent_id, request.world_id);
   
   const inbound: ChannelInboundMessage = {
     id: crypto.randomUUID(),
     channel: "concordia",
     sender_id: request.agent_id,
     sender_name: request.agent_name,
     session_id: sessionId,
     scope: "dm",
     content: message,
     timestamp: Date.now(),
     metadata: {
       concordia_action_spec: request.action_spec,
       world_id: request.world_id,
       workspace_id: request.workspace_id,
     },
   };

   // Create a promise that resolves when send() is called back
   const actionPromise = new Promise<string>((resolve) => {
     const timeout = setTimeout(() => {
       this.pendingActRequests.delete(request.agent_id);
       resolve(`${request.agent_name} hesitates and does nothing.`);
     }, 120_000);
     this.pendingActRequests.set(request.agent_id, { resolve, timeout });
   });

   await this.context.on_message(inbound);
   ```

4. **Wait for response**: The daemon processes the message through its full pipeline
   (system prompt, identity injection, memory retrieval, tools, LLM call). When done,
   it calls `adapter.send(outbound)` which resolves the `actionPromise`.

5. **Post-process the response**:
   - Strip the agent name prefix if the agent included it (e.g., `"Alice: goes to store"` -> `"goes to store"`)
   - For `choice` type: find the closest matching option from the options list. If the agent's response doesn't exactly match any option, use fuzzy string matching (Levenshtein or substring) to pick the best match. If no match at all, pick the first option as fallback.
   - For `float` type: parse the number. If parsing fails, return `0.0`.
   - Trim whitespace and quotes.

6. **Return**: `{ "action": processedAction }`

**Critical**: The `/act` endpoint is **synchronous from Concordia's perspective**. The Python `requests.post()` blocks until the bridge returns. The bridge must wait for the full agent response (including any tool calls) before returning. Set a generous timeout (120s default).

### Task 1.3: Implement the `/observe` endpoint

When the bridge receives `POST /observe`:

```typescript
interface ObserveRequest {
  agent_id: string;
  agent_name: string;
  world_id: string;
  workspace_id: string;
  observation: string;
}
```

**Step-by-step logic**:

1. **Ensure session exists** (same as `/act`).

2. **Ingest the observation into memory** using BOTH approaches — they serve different purposes:

   **Step 2a**: Store in session history (so it appears in the agent's context window on the next `/act` call):
   ```typescript
   await memoryBackend.addEntry({
     sessionId,
     role: "system",
     content: `[observation] ${observation}`,
     workspaceId: request.workspace_id,
     agentId: request.agent_id,
     worldId: request.world_id,
     channel: "concordia",
     metadata: {
       type: "concordia_observation",
       provenance: "concordia:gm_observation",
       concordia_tag: "observation",
     },
   });
   ```

   **Step 2b**: Also ingest into the semantic memory pipeline (so it gets embedded, entity-extracted, and graph-updated for long-term retrieval):
   ```typescript
   await ingestionEngine.ingestTurn(
     sessionId,
     observation,           // as "user message"
     "[observation noted]", // minimal agent response
     {
       workspaceId: request.workspace_id,
       agentId: request.agent_id,
       worldId: request.world_id,
       channel: "concordia",
     },
   );
   ```

   Step 2a ensures the observation is in the immediate context. Step 2b ensures it's embedded, entity-extracted, and available for semantic retrieval in future turns and future simulations.

3. **Return**: `200 OK` with empty body.

**Key detail**: Concordia calls `observe()` BEFORE `act()` each turn. The observation provides the agent's view of the world state. It MUST be available in the agent's context when `act()` is called next.

### Task 1.4: Implement session lifecycle management

The bridge must manage:

- **Session creation**: One AgenC daemon session per agent per simulation run. Session IDs should be deterministic based on `{world_id}:{agent_id}` so sessions can be resumed.

- **Agent identity setup**: On first `/act` or `/observe` for an agent, create the agent identity:
  ```typescript
  const identityManager = new AgentIdentityManager({ memoryBackend });
  await identityManager.upsert({
    agentId: request.agent_id,
    name: request.agent_name,
    corePersonality: "", // Will be set from Concordia agent config
    workspaceId: request.workspace_id,
  });
  ```

- **Social memory recording**: After each resolved event from the GM, record inter-agent interactions:
  ```typescript
  // If the event involves agent A acting toward agent B:
  await socialMemory.recordInteraction(
    agentA_id, agentB_id, world_id,
    { timestamp: Date.now(), summary: resolvedEventText },
  );
  ```

- **Cleanup endpoint**: `POST /reset` — clears all sessions for a world:
  ```typescript
  // Delete all sessions for the world
  // Reset agent identities (optional — may want to preserve across runs)
  ```

### Task 1.5: Implement the `/setup` endpoint

Before a simulation starts, the Python side calls `/setup` to configure all agents:

```typescript
interface SetupRequest {
  world_id: string;
  workspace_id: string;
  agents: Array<{
    agent_id: string;
    agent_name: string;
    personality: string;   // Core personality / instructions
    goal?: string;         // Agent goal
  }>;
  premise: string;         // Simulation premise
}
```

This endpoint:
1. Creates a fresh world context (per-world SQLite DB via `resolveWorldDbPath`)
2. Creates agent identities for each agent
3. Creates daemon sessions for each agent
4. Stores the premise in shared world state via `SocialMemoryManager.addWorldFact()`
5. Returns `{ "status": "ok", "sessions": { agent_id: sessionId } }`

### Task 1.6: Implement `/agent/{id}/state` endpoint

The viewer (Phase 4) needs agent state for the AgentCard component:

```typescript
interface AgentStateResponse {
  identity: AgentIdentity | null;
  memoryCount: number;
  recentMemories: Array<{
    content: string;
    role: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }>;
  relationships: Array<{
    otherAgentId: string;
    relationship: string;
    sentiment: number;
    interactionCount: number;
  }>;
  worldFacts: Array<{
    content: string;
    observedBy: string;
    confirmations: number;
  }>;
  turnCount: number;
  lastAction: string | null;
}
```

Implementation:
1. Load agent identity via `AgentIdentityManager.load(agentId, workspaceId)`
2. Query recent memory entries from the agent's session (`memoryBackend.getThread()`)
3. List known agents via `SocialMemoryManager.listKnownAgents()` and get each relationship
4. Get world facts via `SocialMemoryManager.getWorldFacts(worldId)`

### Task 1.7: Write tests for the bridge server

- Mock the AgenC daemon WebSocket
- Test `/act` with FREE action spec — correct message sent to daemon, response parsed
- Test `/act` with CHOICE action spec — options constraint enforced
- Test `/observe` — observation stored in memory
- Test `/setup` — agent identities created
- Test session reuse — second `/act` call reuses existing session
- Test timeout handling — agent takes too long

**Acceptance**: Bridge server handles all Concordia proxy calls correctly.

---

## Phase 2: Simulation Event Stream

**Goal**: Real-time event streaming from the Concordia engine to the web viewer.

**File**: `concordia_bridge/event_stream.py`

### Task 2.1: Implement SimulationEventStream

Concordia's engine accepts a `step_callback` function called after each simulation step. We use this to emit events.

```python
import json
import asyncio
import websockets
from dataclasses import dataclass, asdict
from typing import Optional
from concordia.environment.engine import StepData

@dataclass
class SimulationEvent:
    type: str               # "step", "observation", "action", "resolution", "scene_change", "terminate"
    step: int
    timestamp: float
    agent_name: Optional[str] = None
    content: Optional[str] = None
    action_spec: Optional[dict] = None
    resolved_event: Optional[str] = None
    scene: Optional[str] = None
    metadata: Optional[dict] = None
```

### Task 2.2: Hook into the Concordia engine loop

The bridge needs to intercept events at multiple points in the engine loop. Concordia's `step_callback` only fires after each complete step. For finer-grained streaming, we wrap the engine methods:

Create `concordia_bridge/instrumented_engine.py`:

```python
from concordia.environment.engines.sequential import Sequential

class InstrumentedSequentialEngine(Sequential):
    """Sequential engine with event hooks for real-time streaming."""

    def __init__(self, event_callback, **kwargs):
        super().__init__(**kwargs)
        self._event_callback = event_callback

    # Override make_observation to emit observation events
    def make_observation(self, game_master, entity):
        observation = super().make_observation(game_master, entity)
        self._event_callback(SimulationEvent(
            type="observation",
            step=self._current_step,
            timestamp=time.time(),
            agent_name=entity.name,
            content=observation,
        ))
        return observation

    # Override resolve to emit resolution events
    def resolve(self, game_master, event):
        super().resolve(game_master, event)
        self._event_callback(SimulationEvent(
            type="resolution",
            step=self._current_step,
            timestamp=time.time(),
            content=event,
        ))
```

**Important**: The `Sequential` engine methods (`make_observation`, `next_acting`, `resolve`, `terminate`) are defined in the base `Engine` class. They work by calling `game_master.act()` with specific `OutputType` values. If subclassing is difficult, use the `step_callback` parameter plus a custom GM component that logs events to the stream.

### Task 2.3: WebSocket event server

Create `concordia_bridge/event_server.py`:

A simple WebSocket server (Python `websockets` library) that:
- Listens on port 3201
- Accepts viewer connections
- Broadcasts `SimulationEvent` JSON to all connected viewers
- Maintains a replay buffer (last 1000 events) for late-joining viewers

```python
class EventServer:
    def __init__(self, port: int = 3201):
        self.port = port
        self.clients: set[websockets.WebSocketServerProtocol] = set()
        self.replay_buffer: list[dict] = []
        self.max_buffer = 1000

    async def handler(self, websocket):
        self.clients.add(websocket)
        # Send replay buffer to late joiners
        for event in self.replay_buffer:
            await websocket.send(json.dumps(event))
        try:
            async for message in websocket:
                pass  # Viewer is read-only
        finally:
            self.clients.discard(websocket)

    def broadcast(self, event: SimulationEvent):
        data = json.dumps(asdict(event))
        self.replay_buffer.append(asdict(event))
        if len(self.replay_buffer) > self.max_buffer:
            self.replay_buffer = self.replay_buffer[-self.max_buffer:]
        for client in self.clients:
            asyncio.ensure_future(client.send(data))

    async def start(self):
        await websockets.serve(self.handler, "localhost", self.port)
```

### Task 2.4: Wire event stream into the bridge server

The AgenC bridge server (TypeScript) also emits events when it processes `/act` and `/observe` calls. These events include AgenC-specific data that Concordia doesn't know about:

- Agent's internal reasoning (from ChatExecutor tool calls, memory retrieval)
- Memory entries retrieved for this turn
- Beliefs consulted
- Knowledge graph entities referenced
- Trust scores on retrieved memories

Add a WebSocket client in the bridge server that connects to the event server (port 3201) and pushes these enriched events.

**Acceptance**: Events from both Concordia (Python) and AgenC (TypeScript) are merged into a single real-time stream.

---

## Phase 3: Simulation Runner

**Goal**: A Python script that configures and runs a complete Concordia
simulation with AgenC proxy agents.

**File**: `concordia_bridge/runner.py`

### Task 3.1: Implement the simulation runner

```python
def run_simulation(
    config: SimulationConfig,
    bridge_url: str = "http://localhost:3200",
    event_server_port: int = 3201,
    llm_model: str = "grok-3-mini",  # For GM only; agents use Grok via AgenC
):
    """Run a Concordia simulation with AgenC agents."""

    # 1. Start the event server
    event_server = EventServer(port=event_server_port)

    # 2. Create the GM's LLM (runs locally in Python, NOT through AgenC)
    #    The GM needs its own LLM for observation generation, turn selection,
    #    and event resolution. Use Ollama, OpenAI, or xAI directly.
    from concordia.language_model import ollama_model
    model = ollama_model.OllamaLanguageModel(model_name=llm_model)

    # 3. Create the GM's embedding function
    #    Used for GM's associative memory retrieval.
    from sentence_transformers import SentenceTransformer
    st_model = SentenceTransformer('all-MiniLM-L6-v2')
    embedder = lambda text: st_model.encode(text)

    # 4. Setup agents via the bridge
    setup_response = requests.post(f"{bridge_url}/setup", json={
        "world_id": config.world_id,
        "workspace_id": config.workspace_id,
        "agents": [
            {
                "agent_id": agent.id,
                "agent_name": agent.name,
                "personality": agent.personality,
                "goal": agent.goal,
            }
            for agent in config.agents
        ],
        "premise": config.premise,
    })
    setup_response.raise_for_status()

    # 5. Create ProxyEntity instances for each agent
    proxy_entities = [
        ProxyEntityWithLogging(
            agent_name=agent.name,
            bridge_url=bridge_url,
            agent_id=agent.id,
            world_id=config.world_id,
            workspace_id=config.workspace_id,
        )
        for agent in config.agents
    ]

    # 6. Create the Game Master (runs locally in Python)
    #    The GM uses Concordia's built-in components + the local LLM.
    gm_memory_bank = AssociativeMemoryBank(
        sentence_embedder=embedder,
        allow_duplicates=True,
    )

    from concordia.prefabs.game_master import generic as gm_generic
    gm_config = gm_generic.Config(
        model=model,
        memory_bank=gm_memory_bank,
        players=proxy_entities,
        instructions=config.gm_instructions or "You are the game master...",
    )
    game_master = gm_config.build()

    # 7. Create the instrumented engine
    engine = InstrumentedSequentialEngine(
        event_callback=event_server.broadcast,
    )

    # 8. Run the simulation
    engine.run_loop(
        game_masters=[game_master],
        entities=proxy_entities,
        premise=config.premise,
        max_steps=config.max_steps,
        step_callback=lambda step_data: event_server.broadcast(
            SimulationEvent(
                type="step",
                step=step_data.step,
                timestamp=time.time(),
                agent_name=step_data.acting_entity,
                content=step_data.action,
                metadata={"entity_logs": step_data.entity_logs},
            )
        ),
    )
```

### Task 3.2: Define SimulationConfig

```python
@dataclass
class AgentConfig:
    id: str              # AgenC agent ID (e.g., "alice")
    name: str            # Display name (e.g., "Alice")
    personality: str     # Core personality for AgenC AgentIdentityManager
    goal: str = ""       # Optional goal

@dataclass
class SimulationConfig:
    world_id: str        # Unique simulation world ID
    workspace_id: str    # AgenC workspace ID
    premise: str         # Opening premise narration
    agents: list[AgentConfig]
    max_steps: int = 50
    gm_instructions: str = ""  # Custom GM instructions
    gm_model: str = "grok-3-mini"  # LLM for the GM
    scenes: list[SceneSpec] | None = None  # Optional scene structure
```

### Task 3.3: Create example simulation configs

Create `concordia_bridge/examples/`:

**`medieval_town.py`** — 3 agents in a medieval town:
```python
config = SimulationConfig(
    world_id="medieval-town-001",
    workspace_id="concordia-sim",
    premise=(
        "It is morning in the medieval town of Thornfield. "
        "The market square is bustling with activity. "
        "Three residents begin their day."
    ),
    agents=[
        AgentConfig(
            id="elena",
            name="Elena",
            personality="Elena is the town blacksmith. She is practical, "
                "strong-willed, and values honest work. She distrusts "
                "merchants but respects fellow craftspeople.",
            goal="Complete a special sword commission for the town guard captain.",
        ),
        AgentConfig(
            id="marcus",
            name="Marcus",
            personality="Marcus is a traveling merchant. He is charming, "
                "opportunistic, and always looking for a good deal. "
                "He has a secret: he is actually a spy for a rival town.",
            goal="Buy rare iron from Elena at below market price while "
                "gathering intelligence about the town's defenses.",
        ),
        AgentConfig(
            id="sera",
            name="Sera",
            personality="Sera is the town healer. She is compassionate, "
                "perceptive, and notices things others miss. She has "
                "a strong moral compass.",
            goal="Treat the sick and keep the town healthy. She suspects "
                "the new merchant is not what he seems.",
        ),
    ],
    max_steps=30,
    gm_instructions=(
        "You are the game master for a medieval town simulation. "
        "The town of Thornfield has a market, a smithy, a healing house, "
        "and a town hall. Generate vivid, specific observations. "
        "Resolve actions realistically — check if actions are physically "
        "plausible and respect other agents' autonomy."
    ),
)
```

**`trading_floor.py`** — 4 agents in a negotiation scenario.

**`research_lab.py`** — 3 AI researcher agents collaborating/competing.

### Task 3.4: Add simulation control (play/pause/step)

Use Concordia's built-in `StepController`:

```python
from concordia.environment.step_controller import StepController

controller = StepController()

# Expose control via HTTP endpoints:
# POST /simulation/play   -> controller.play()
# POST /simulation/pause  -> controller.pause()
# POST /simulation/step   -> controller.step()
# POST /simulation/stop   -> controller.stop()
# GET  /simulation/status -> { "running": bool, "step": int, "paused": bool }
```

Wire the `step_controller` into `engine.run_loop(step_controller=controller)`.

**Acceptance**: Simulation can be started, paused, stepped, and stopped from the viewer.

---

## Phase 4: Live Simulation Viewer

**Goal**: A React web app that connects to the event WebSocket and renders
the simulation in real-time.

**File**: `agenc-core/web/src/components/simulation/`

### Task 4.1: SimulationViewer component

The main viewer layout:

```
┌────────────────────────────────────────────────────────┐
│  Simulation: Medieval Town  [Play] [Pause] [Step]      │
│  Step 12/30  |  Scene: Market Square                   │
├──────────────────────┬─────────────────────────────────┤
│  Agent Cards         │  Event Timeline                 │
│                      │                                 │
│  ┌──────────────┐    │  12:01 GM → Elena: "You see     │
│  │ Elena        │    │    Marcus approaching your      │
│  │ Blacksmith   │    │    smithy with a large purse."  │
│  │              │    │                                 │
│  │ Beliefs: 3   │    │  12:01 Elena: "I greet Marcus   │
│  │ Memory: 47   │    │    cautiously and ask what      │
│  │ Trust: 0.82  │    │    brings him to Thornfield."   │
│  │              │    │                                 │
│  │ [Expand]     │    │  12:02 GM resolves: Elena and   │
│  └──────────────┘    │    Marcus begin a conversation  │
│                      │    at the smithy entrance.      │
│  ┌──────────────┐    │                                 │
│  │ Marcus       │    │  12:02 GM → Marcus: "Elena      │
│  │ Merchant     │    │    seems wary but willing to    │
│  │ ...          │    │    talk. You notice quality      │
│  └──────────────┘    │    iron ingots inside."         │
│                      │                                 │
│  ┌──────────────┐    │  12:03 Marcus: "I compliment    │
│  │ Sera         │    │    her work and casually ask    │
│  │ Healer       │    │    about her iron supply."      │
│  │ ...          │    │                                 │
│  └──────────────┘    │                                 │
├──────────────────────┴─────────────────────────────────┤
│  World State: 3 facts | Relationships: Elena↔Marcus,   │
│  Elena↔Sera | Knowledge Graph: 12 nodes, 8 edges      │
└────────────────────────────────────────────────────────┘
```

### Task 4.2: AgentCard component

Each agent card shows:
- Name + role (from personality)
- Current belief count and top belief
- Memory entry count
- Trust score (average trust of recent memories)
- Last action taken
- Expandable detail view with:
  - Full personality text
  - All beliefs with confidence scores
  - Learned traits
  - Communication style
  - Recent memory entries (last 10)
  - Relationship summary (who they've interacted with)

Data source: Poll the bridge server for agent state:
```
GET /agent/{agent_id}/state
→ {
    identity: AgentIdentity,
    memoryCount: number,
    recentMemories: MemoryEntry[],
    relationships: SocialMemoryEntry[],
    worldFacts: WorldStateFact[],
  }
```

### Task 4.3: EventTimeline component

A scrolling timeline of simulation events:
- Each event is a card with:
  - Timestamp
  - Event type (observation, action, resolution) with color coding
  - Agent name (for agent events)
  - Content text
  - Expandable metadata (memory retrieval scores, tool calls, etc.)
- Auto-scrolls to latest event
- Filter by event type or agent name

Data source: WebSocket connection to event server (port 3201).

### Task 4.4: WorldStatePanel component

Shows:
- World facts (from `SocialMemoryManager.getWorldFacts()`)
- Agent relationships (from `SocialMemoryManager.getRelationship()`)
- Knowledge graph summary (node/edge counts, key entities)
- Scene indicator (current scene name, rounds remaining)

### Task 4.5: SimulationControls component

- Play/Pause/Step buttons that POST to `/simulation/play|pause|step`
- Speed slider (affects polling interval for non-WebSocket data)
- Step counter: current step / max steps
- Scene indicator

### Task 4.6: Connect viewer to WebSocket event stream

```typescript
// Connect to Python event server
const ws = new WebSocket("ws://localhost:3201");
ws.onmessage = (event) => {
  const simEvent: SimulationEvent = JSON.parse(event.data);
  dispatch({ type: "ADD_EVENT", event: simEvent });
};
```

State management: Use React `useReducer` for the event timeline and agent states.

**Acceptance**: Viewer renders agent cards, scrolling event timeline, and world state in real-time as the simulation runs.

---

## Phase 5: Memory Integration (AgenC ↔ Concordia)

**Goal**: Ensure AgenC's full memory stack is active during simulation —
entity extraction, knowledge graph, consolidation, trust scoring, beliefs.

### Task 5.1: Wire entity extraction on observations

When an agent receives an observation via `/observe`, the bridge should:
1. Ingest the observation via `MemoryIngestionEngine`
2. Entity extraction runs automatically (if LLM entity extractor is wired)
3. Extracted entities are added to the agent's knowledge graph
4. Graph nodes track which world/simulation they came from

### Task 5.2: Wire belief formation after significant interactions

After every N turns (configurable, default 5), trigger reflection:
```typescript
import { runReflection } from "../memory/reflection.js";

// After every 5 act() calls for an agent:
if (turnCount % 5 === 0) {
  await runReflection({
    agentId,
    workspaceId,
    llmProvider,
    identityManager,
    memoryBackend,
    vectorStore,
  });
}
```

This updates the agent's beliefs and learned traits based on recent simulation experience.

### Task 5.3: Wire social memory on inter-agent events

When the GM resolves an event involving multiple agents:
```typescript
// Parse the resolved event to identify interacting agents
// Record the interaction in social memory
await socialMemory.recordInteraction(
  actingAgentId,
  targetAgentId,
  worldId,
  {
    timestamp: Date.now(),
    summary: resolvedEventText,
    context: currentSceneName,
  },
);
```

### Task 5.4: Wire procedural memory for repeated action patterns

If an agent uses the same strategy successfully multiple times (e.g., "offer a trade then compliment"), record it as a procedural memory:
```typescript
await proceduralMemory.record({
  name: "negotiation_opening",
  trigger: "negotiation with merchant",
  steps: ["greet warmly", "compliment their goods", "propose trade"],
  workspaceId,
});
```

### Task 5.5: Inject AgenC memory context into the /act prompt

When building the user message for `/act`, prepend retrieved memory context:

```typescript
// Retrieve relevant memories for this action context
const memoryContext = await retriever.retrieve(
  actionSpec.call_to_action,
  sessionId,
);

// Retrieve agent identity
const identity = await identityManager.load(agentId, workspaceId);
const identityContext = identity
  ? identityManager.formatForPrompt(identity)
  : "";

// Retrieve relevant procedural memories
const procedures = await proceduralMemory.retrieve(
  actionSpec.call_to_action,
  workspaceId,
);
const proceduralContext = procedures.length > 0
  ? proceduralMemory.formatForPrompt(procedures)
  : "";

// Build the full prompt
const fullMessage = [
  identityContext,
  proceduralContext,
  memoryContext,
  "",
  actionSpec.call_to_action,
].filter(Boolean).join("\n\n");
```

This means the agent's response is informed by:
- Its persistent personality and beliefs
- Relevant memories from this and past simulations
- Known procedures for similar situations
- The current observation context

### Task 5.6: Run consolidation between simulation sessions

After a simulation ends, run memory consolidation:
```typescript
import { runConsolidation, runRetention } from "../memory/consolidation.js";

await runConsolidation({ vectorStore, embeddingProvider, workspaceId });
await runRetention({ memoryBackend, workspaceId });
```

This compresses episodic memories into semantic facts, so the next simulation starts with distilled knowledge rather than raw observation logs.

**Acceptance**: Agents in simulation 2 remember and reference facts from simulation 1.

---

## Phase 6: CLI and Packaging

**Goal**: Easy-to-use CLI for running simulations.

### Task 6.1: Create the CLI entry point

`concordia_bridge/cli.py`:

```bash
# Start the bridge server
agenc-concordia bridge --port 3200 --daemon-port 3100

# Run a simulation from a config file
agenc-concordia run --config examples/medieval_town.py --steps 30

# Run with live viewer
agenc-concordia run --config examples/medieval_town.py --viewer

# List available example configs
agenc-concordia examples

# Resume a paused simulation
agenc-concordia resume --world-id medieval-town-001
```

### Task 6.2: Create the Python package

`concordia_bridge/pyproject.toml`:
```toml
[project]
name = "agenc-concordia"
version = "0.1.0"
dependencies = [
    "gdm-concordia>=0.2.0",
    "requests>=2.28",
    "websockets>=12.0",
]

[project.scripts]
agenc-concordia = "concordia_bridge.cli:main"
```

### Task 6.3: Create the bridge startup script

A single script that starts everything:
```bash
#!/bin/bash
# start-simulation.sh

# 1. Ensure AgenC daemon is running (plugin auto-starts the bridge HTTP server)
agenc-runtime start || true

# 2. Verify bridge is healthy
curl -s http://localhost:3200/health | jq .

# 3. Run the simulation with viewer
agenc-concordia run --config $1 --viewer --bridge-url http://localhost:3200

# 4. No bridge cleanup needed — daemon manages the plugin lifecycle
```

**Note**: The bridge server is managed by the daemon as a channel plugin. There is
NO separate bridge process to start/stop. The daemon's `start()` calls
`adapter.start()` which spins up the HTTP server on port 3200. When the daemon
stops, `adapter.stop()` cleans up automatically.

**Acceptance**: `./start-simulation.sh examples/medieval_town.py` launches the full stack.

---

## Phase 7: Advanced Concordia Features

**Goal**: Support the full Concordia feature set beyond basic sequential turns.

### Task 7.1: Simultaneous engine support

Concordia's `Simultaneous` engine collects actions from ALL agents each step
(not one-at-a-time). The bridge must handle concurrent `/act` calls:

```python
from concordia.environment.engines.simultaneous import Simultaneous
```

Bridge changes:
- The bridge must accept parallel `/act` requests for different agents in the same step
- Use a request queue per world to prevent race conditions on shared state
- Return all agent actions before the GM resolves

Add `engine_type` to `SimulationConfig`:
```python
engine_type: str = "sequential"  # "sequential" | "simultaneous" | "async"
```

### Task 7.2: Scene support

Scenes structure simulations into phases. Implement full scene wiring:

```python
from concordia.typing.scene import SceneTypeSpec, SceneSpec

# Example: a trading simulation with negotiation + decision phases
negotiation_scene = SceneTypeSpec(
    name="negotiation",
    action_spec=ActionSpec(
        call_to_action="What does {name} say in the negotiation?",
        output_type=OutputType.FREE,
        tag="speech",
    ),
)

decision_scene = SceneTypeSpec(
    name="decision",
    action_spec=ActionSpec(
        call_to_action="Does {name} accept or reject the deal?",
        output_type=OutputType.CHOICE,
        options=["Accept", "Reject", "Counter-offer"],
        tag="action",
    ),
)

scenes = [
    SceneSpec(scene_type=negotiation_scene, participants=["Alice", "Bob"], num_rounds=5),
    SceneSpec(scene_type=decision_scene, participants=["Alice", "Bob"], num_rounds=1),
]
```

Add to `SimulationConfig.scenes` and wire into the runner.

### Task 7.3: Checkpoint and resume

Concordia supports `get_state()`/`set_state()` at entity and memory bank level.
The bridge must support saving/loading simulation state:

```python
# Save checkpoint
checkpoint = {
    "game_master": game_master.get_state(),
    "entities": {e.name: e.get_last_log() for e in proxy_entities},
    "step": current_step,
    "world_id": config.world_id,
}
with open(f"checkpoints/{config.world_id}_step_{current_step}.json", "w") as f:
    json.dump(checkpoint, f)
```

AgenC side: Agent memory persists automatically (SQLite). The bridge needs a
`POST /checkpoint` endpoint that triggers memory consolidation and returns
a serializable agent state summary.

Resume: `POST /resume` with checkpoint data re-initializes sessions and
injects the checkpoint state.

Add to CLI: `agenc-concordia resume --world-id <id> --checkpoint <path>`

### Task 7.4: Multiple GM support

Concordia supports multiple GMs that hand off to each other via
`next_game_master()`. This enables simulations where different rule sets
apply to different scenes (e.g., a combat GM vs. a dialogue GM).

The runner should accept a list of GM configs:
```python
gm_configs: list[GMConfig] = [
    GMConfig(name="dialogue_gm", prefab="dialogic", instructions="..."),
    GMConfig(name="action_gm", prefab="generic", instructions="..."),
]
```

### Task 7.5: GM prefab selection

Concordia ships multiple GM prefabs. The runner should support:
- `generic` — default, event resolution with chain of thought
- `dialogic` — pure conversation, no physical actions
- `situated` — location tracking (who is where)
- `situated_in_time_and_place` — time + location tracking
- `game_theoretic_and_dramaturgic` — payoff matrices
- `marketplace` — buying/selling mechanics
- `psychology_experiment` — structured experimental protocol

Add `gm_prefab` to `SimulationConfig`:
```python
gm_prefab: str = "generic"  # One of the above
```

### Task 7.6: ActionSpec tag handling

Concordia's `ActionSpec.tag` field (e.g., `"action"`, `"speech"`) is used
for memory tagging. The bridge must:
1. Pass the tag to AgenC in the observation metadata
2. Store it in memory entries as `metadata.concordia_tag`
3. Use it for retrieval filtering (e.g., retrieve only `[speech]` entries)

### Task 7.7: GM LLM provider configuration

The GM currently hardcodes Ollama. Support all Concordia LLM adapters:

```python
# Concordia ships adapters for:
# - concordia.language_model.gpt_model (OpenAI-compatible, works with xAI)
# - concordia.language_model.ollama_model
# - concordia.language_model.google_aistudio_model
# - concordia.language_model.mistral_model
# - concordia.language_model.together_model

# For Grok via xAI (OpenAI-compatible):
from concordia.language_model import gpt_model
gm_model = gpt_model.GptLanguageModel(
    model_name="grok-3-mini",
    api_key=os.environ["XAI_API_KEY"],
    base_url="https://api.x.ai/v1",
)
```

Add `gm_provider` and `gm_api_key` to `SimulationConfig`.

---

## Phase 8: Robustness and Error Handling

**Goal**: Handle failures gracefully so simulations don't crash.

### Task 8.1: Bridge health check endpoint

`GET /health` returns:
```json
{
  "status": "ok",
  "daemon_connected": true,
  "active_sessions": 3,
  "world_id": "medieval-town-001",
  "uptime_ms": 45000
}
```

### Task 8.2: Agent timeout recovery

If an agent's `/act` call times out (bridge doesn't respond within 120s):
1. The ProxyEntity catches the timeout
2. Returns a fallback action: `"{name} hesitates and does nothing."`
3. Emits a warning event to the event stream
4. The simulation continues

### Task 8.3: Daemon disconnect recovery

If the AgenC daemon disconnects mid-simulation:
1. The bridge detects WebSocket close
2. Attempts reconnection with exponential backoff (1s, 2s, 4s, ... 30s cap)
3. Queues incoming `/observe` calls during reconnection
4. Retries the current `/act` call once reconnected
5. If reconnection fails after 60s, returns fallback action

### Task 8.4: Bridge crash recovery

If the bridge server crashes:
1. The ProxyEntity catches the `requests.ConnectionError`
2. The simulation pauses (via StepController)
3. Emits a `"bridge_disconnected"` event
4. The viewer shows a reconnection banner
5. When the bridge restarts, it reads agent sessions from the daemon (sessions persist in SQLite) and resumes

### Task 8.5: Simulation state validation

Before each step, validate:
- All agent sessions are still active in the daemon
- Memory backend is healthy
- No agent has exceeded memory limits
- World state is consistent

---

## Phase 9: Complete Example Configs

**Goal**: Provide fully specified example simulations.

### Task 9.1: `trading_floor.py`

```python
config = SimulationConfig(
    world_id="trading-floor-001",
    workspace_id="concordia-sim",
    premise=(
        "Four traders gather at the commodities exchange. "
        "Gold prices have been volatile. Each trader has different "
        "information and different risk tolerance."
    ),
    agents=[
        AgentConfig(
            id="alex",
            name="Alex",
            personality="Alex is a conservative institutional trader. "
                "Risk-averse, data-driven, manages a pension fund. "
                "Never bets more than 5% of portfolio on a single trade.",
            goal="Protect the pension fund while achieving 8% annual returns.",
        ),
        AgentConfig(
            id="jordan",
            name="Jordan",
            personality="Jordan is an aggressive day trader. "
                "Thrives on volatility, trusts gut instinct over analysis. "
                "Has inside information that a major gold mine just collapsed.",
            goal="Profit from the gold mine collapse before it becomes public.",
        ),
        AgentConfig(
            id="sam",
            name="Sam",
            personality="Sam is a quantitative analyst. "
                "Builds models, speaks in probabilities, socially awkward. "
                "Has noticed unusual trading patterns suggesting insider activity.",
            goal="Identify and report suspicious trading activity to compliance.",
        ),
        AgentConfig(
            id="riley",
            name="Riley",
            personality="Riley is a newly licensed broker on their first day. "
                "Eager to impress, nervous, easily influenced by authority. "
                "Has no insider information.",
            goal="Make a good impression and complete a successful trade.",
        ),
    ],
    max_steps=40,
    gm_instructions=(
        "You are the game master for a trading floor simulation. "
        "The exchange has a central trading pit, private offices, "
        "and a compliance monitoring room. Gold is currently at $2,100/oz. "
        "Enforce realistic trading mechanics. Insider trading is illegal "
        "but enforcement requires evidence."
    ),
)
```

### Task 9.2: `research_lab.py`

```python
config = SimulationConfig(
    world_id="research-lab-001",
    workspace_id="concordia-sim",
    premise=(
        "Three AI researchers share a lab at a prestigious university. "
        "A major conference deadline is in two weeks. "
        "They have overlapping research interests but limited compute budget."
    ),
    agents=[
        AgentConfig(
            id="dr-chen",
            name="Dr. Chen",
            personality="Dr. Chen is a senior researcher specializing in "
                "reinforcement learning. Methodical, published 50+ papers, "
                "mentors junior researchers. Secretly worried about being "
                "scooped by a rival lab.",
            goal="Submit a breakthrough RL paper to the conference.",
        ),
        AgentConfig(
            id="kai",
            name="Kai",
            personality="Kai is a second-year PhD student working on "
                "multi-agent systems. Brilliant but disorganized. "
                "Has preliminary results that could complement Dr. Chen's work.",
            goal="Get a first-author publication to secure funding.",
        ),
        AgentConfig(
            id="priya",
            name="Priya",
            personality="Priya is a visiting researcher from industry. "
                "Pragmatic, focused on applications, has access to proprietary "
                "datasets. Evaluating whether to return to industry or stay in academia.",
            goal="Produce results that justify extending the industry partnership.",
        ),
    ],
    max_steps=35,
    gm_instructions=(
        "You are the game master for an academic research lab simulation. "
        "The lab has shared compute (4 GPUs), a whiteboard room, and offices. "
        "Compute allocation requires lab manager approval. "
        "Researchers can collaborate, compete, or work independently. "
        "Track paper progress realistically."
    ),
)
```

---

## TypeScript Plugin Package Structure

```
agenc-plugin-concordia/
├── package.json               # @tetsuo-ai/plugin-concordia
├── tsup.config.ts
├── src/
│   ├── index.ts               # Re-exports manifest, validateConfig, createChannelAdapter
│   ├── adapter.ts             # ConcordiaChannelAdapter (ChannelAdapter impl)
│   ├── bridge-http.ts         # HTTP server (/act, /observe, /setup, /event, /health)
│   ├── session-manager.ts     # Agent→session mapping, identity setup
│   ├── memory-wiring.ts       # Memory ingestion, social memory, graph, trust
│   ├── prompt-builder.ts      # Build /act prompts with identity+memory+graph context
│   ├── response-processor.ts  # Strip name prefix, fuzzy choice matching, float parse
│   └── types.ts               # Shared request/response interfaces
└── tests/
    ├── adapter.test.ts
    ├── bridge-http.test.ts
    ├── prompt-builder.test.ts
    └── response-processor.test.ts
```

## Python Package Structure

```
concordia_bridge/
├── __init__.py
├── proxy_entity.py          # ProxyEntity, ProxyEntityWithLogging
├── bridge_types.py          # Shared dataclasses (SimulationEvent, configs)
├── event_stream.py          # SimulationEvent dataclass
├── event_server.py          # WebSocket event server
├── instrumented_engine.py   # InstrumentedSequentialEngine
├── runner.py                # run_simulation() main entry
├── cli.py                   # CLI entry point
├── control_server.py        # HTTP server for play/pause/step/status
├── pyproject.toml
├── tests/
│   ├── __init__.py
│   ├── test_proxy_entity.py
│   ├── test_event_stream.py
│   ├── test_runner.py
│   └── test_control.py
└── examples/
    ├── __init__.py
    ├── medieval_town.py
    ├── trading_floor.py
    └── research_lab.py
```

---

## Observation → Context Flow (Critical Path)

This is the exact sequence of how an observation reaches the agent's
next action — the most important data flow to get right:

1. **GM generates observation** (Python, in-process):
   `game_master.act(ActionSpec(output_type=MAKE_OBSERVATION))` → `"You see Marcus approaching..."`

2. **Concordia calls `entity.observe(observation)`** on the ProxyEntity

3. **ProxyEntity POSTs to bridge** `/observe`:
   `{"agent_id": "elena", "observation": "You see Marcus approaching..."}`

4. **Bridge ingests into AgenC memory**:
   - Stores as memory entry with `role: "system"`, `metadata.type: "concordia_observation"`
   - Entity extraction runs → adds "Marcus" node to knowledge graph
   - Embedding generated → stored in vector store

5. **Engine calls `entity.act(action_spec)`** next

6. **ProxyEntity POSTs to bridge** `/act`:
   `{"agent_id": "elena", "action_spec": {"call_to_action": "What would Elena do?", ...}}`

7. **Bridge builds prompt** for the AgenC agent:
   - Loads agent identity (personality, beliefs, traits)
   - Retrieves relevant memories (including the observation just stored)
   - Retrieves procedural memories
   - Retrieves knowledge graph context
   - Appends the `call_to_action` text
   - Sends as `chat.message` to daemon session

8. **AgenC agent processes** via ChatExecutor:
   - System prompt includes identity
   - Memory retriever injects relevant context
   - Grok-4.20 generates the action

9. **Bridge returns** the action string to the ProxyEntity

10. **Concordia receives** the action and passes it to the GM for resolution

**Critical timing**: Steps 2-4 must complete BEFORE step 5 starts.
The sequential engine guarantees this — `observe()` is called synchronously
before `act()` in each step.

---

## Implementation Order

1. **Phase 0** (Python proxy entity) — 1-2 hours
2. **Phase 1** (TypeScript bridge server) — 4-6 hours
3. **Phase 3** (simulation runner + examples) — 2-3 hours
4. **Phase 2** (event streaming) — 2-3 hours
5. **Phase 5** (memory integration) — 3-4 hours
6. **Phase 4** (React viewer) — 4-6 hours
7. **Phase 6** (CLI + packaging) — 1-2 hours
8. **Phase 7** (advanced features) — 3-4 hours
9. **Phase 8** (robustness) — 2-3 hours
10. **Phase 9** (example configs) — 1 hour

**Total estimated implementation**: ~28 hours of focused work.

---

## Testing Strategy

### Unit Tests
- ProxyEntity serialization/deserialization
- Bridge server `/act` response processing (name stripping, choice matching)
- Bridge server `/observe` memory ingestion
- Event stream broadcasting
- Simulation config parsing

### Integration Tests
- Full round-trip: Concordia GM → ProxyEntity → Bridge → AgenC daemon → response
- Multi-agent session isolation (agent A's memory not visible to agent B)
- Observation → memory → retrieval loop
- Belief formation across turns
- Social memory recording and retrieval

### End-to-End Test
- Run a 10-step simulation with 2 agents
- Verify: events stream to viewer
- Verify: agents reference past observations in their actions
- Verify: beliefs form after reflection
- Verify: memories persist after simulation ends
- Run simulation 2 with same agents — verify they remember simulation 1

---

## Key Constraints and Edge Cases

1. **Concordia `act()` is blocking**: The Python thread blocks until the bridge returns. The bridge must handle AgenC's async tool-calling loop and return only when the full response is ready.

2. **GM runs in Python, agents run in TypeScript**: The GM does NOT go through the bridge. It runs Concordia's built-in components with a local LLM. Only player agents are proxied.

3. **Embedding model mismatch**: The GM uses a Python embedding model for its associative memory. AgenC agents use their own embedding provider. These don't need to match — they're separate memory systems.

4. **Turn ordering**: Concordia's sequential engine is strictly turn-based. Only one agent acts per step. The bridge must handle this cleanly — no concurrent `/act` calls for the same simulation.

5. **Action validation**: For `CHOICE` output type, the agent MUST return exactly one of the provided options. The bridge must enforce this with fuzzy matching as a fallback.

6. **Long simulations**: For 100+ step simulations, memory will grow. Consolidation should run periodically (every 20 steps) to keep retrieval fast.

7. **GM observation quality**: The GM generates per-agent observations. These are the ONLY input the agent sees (no god's-eye view). The observation must be specific enough for the agent to make meaningful decisions.

8. **Agent name prefixing**: Concordia expects `act()` to return just the action text. It then prefixes with `"AgentName: "`. The bridge must strip any name prefix the AgenC agent adds.

9. **Rate limiting**: Each simulation step involves multiple LLM calls (GM observation per agent + GM turn selection + agent action + GM resolution). Budget accordingly — a 30-step simulation with 3 agents uses ~180+ LLM calls.

10. **World state consistency**: All agents in a simulation share the same `worldId` for social memory. World facts are visible to all agents. Private agent memories use `agentId` scoping.

---

## Errata and Clarifications

These are critical implementation details that span multiple phases.

## Phase 10: Full Memory System Integration

**Goal**: Wire EVERY AgenC memory capability into the Concordia bridge so
simulations leverage the complete memory stack — not just basic ingestion.

> **Reference**: The AgenC memory system (TODO.MD) implements 10 phases with
> 79 tasks across persistent vectors, scoping, entity extraction, knowledge
> graphs, consolidation, agent identity, social memory, procedural memory,
> shared memory, trust scoring, encryption, and observability. ALL of these
> must be active during Concordia simulations.

### Task 10.1: Trust scoring on Concordia-sourced entries

Every memory entry gets a trust score (R29 defense against memory poisoning).
Concordia entries must be tagged with the correct `TrustSource`:

```typescript
import { type TrustSource } from "../memory/trust-scoring.js";

// GM observations are system-generated → highest trust
const gmObservationTrust: TrustSource = "system";

// Other agent actions observed → agent-level trust
const agentActionTrust: TrustSource = "agent";

// User-configured premises → user-level trust
const premiseTrust: TrustSource = "user";

// External world facts from shared memory → external trust
const sharedFactTrust: TrustSource = "external";
```

When storing observations in Task 1.3, include trust metadata:
```typescript
metadata: {
  type: "concordia_observation",
  provenance: "concordia:gm_observation",
  trustSource: "system",   // GM observations are trusted
  confidence: 0.9,
}
```

When storing agent actions (after GM resolution in E3):
```typescript
metadata: {
  type: "concordia_resolved_event",
  provenance: "concordia:event_resolution",
  trustSource: "agent",    // Agent-generated actions
  confidence: 0.7,
}
```

The retriever's trust-aware filtering (DEFAULT_TRUST_THRESHOLD = 0.3) will
automatically downrank low-trust entries during retrieval.

### Task 10.2: Activation scoring during simulation turns

After each `/act` call, the bridge must update activation scores on
retrieved memory entries. The ACT-R activation formula rewards frequently
accessed memories:

```typescript
import { computeActivationBoost } from "../memory/retriever.js";

// After retrieval returns entries for the /act prompt, update their access counts:
for (const entry of retrievedEntries) {
  const meta = entry.metadata ?? {};
  const accessCount = (typeof meta.accessCount === "number" ? meta.accessCount : 0) + 1;
  await memoryBackend.addEntry({
    ...entry,
    metadata: {
      ...meta,
      accessCount,
      lastAccessTime: Date.now(),
    },
  });
}
```

This ensures memories that are repeatedly relevant during a simulation get
higher activation scores and are more likely to surface in future turns.

### Task 10.3: Temporal edges on knowledge graph facts

When the GM resolves events that change world state, the knowledge graph
must update temporal edges:

```typescript
import { MemoryGraph } from "../memory/graph.js";

// Example: Marcus is revealed as a spy (previously known as "merchant")
// 1. Find the old edge
const oldEdges = await graph.findByEntity("Marcus", workspaceId);
const merchantEdge = oldEdges.find(e => e.content.includes("merchant"));

// 2. Set validUntil on old edge
if (merchantEdge) {
  await graph.updateEdge(merchantEdge.id, { validUntil: Date.now() });
}

// 3. Create new edge with validFrom
await graph.addEdge({
  sourceId: marcusNodeId,
  targetId: spyRoleNodeId,
  type: "has_role",
  validFrom: Date.now(),
  // validUntil: undefined = still active
});
```

Wire this into the `/event` endpoint (E3) — when a resolved event
contradicts existing knowledge graph facts, update temporal edges.

### Task 10.4: BFS graph traversal for enriched agent context

When building the `/act` prompt (Task 5.5), use BFS graph traversal to
pull related entities:

```typescript
// In the /act prompt builder:
const entities = extractEntityMentions(actionSpec.call_to_action);
let graphContext = "";

for (const entityName of entities) {
  const nodes = await graph.findByEntity(entityName, workspaceId);
  if (nodes.length > 0) {
    const related = await graph.getRelatedEntities(nodes[0].id, 2); // depth=2
    graphContext += `\n[Knowledge about ${entityName}]: `;
    graphContext += related.map(n => n.content).join("; ");
  }
}

// Inject into prompt before call_to_action
const fullMessage = [
  identityContext,
  proceduralContext,
  memoryContext,
  graphContext,  // NEW: knowledge graph context
  "",
  actionSpec.call_to_action,
].filter(Boolean).join("\n\n");
```

### Task 10.5: Shared memory layer for cross-simulation knowledge

User preferences and organizational knowledge should persist across
different simulation scenarios via the shared memory layer:

```typescript
import { SharedMemoryBackend } from "../memory/shared-memory.js";

const sharedMemory = new SharedMemoryBackend({ memoryBackend: sharedDb });

// After simulation ends, promote user-level preferences to shared memory:
await sharedMemory.writeFact({
  scope: "user",
  content: "User enjoys medieval simulation scenarios",
  author: "concordia:post_simulation",
  userId: userId,
});

// Before simulation starts, inject shared facts into agent context:
const sharedFacts = await sharedMemory.getFacts("user", userId);
// Inject as low-priority context in the /act prompt
```

### Task 10.6: Collective knowledge emergence during simulation

When 3+ agents in a simulation independently confirm a fact, promote it
to world knowledge via `checkCollectiveEmergence()`:

```typescript
// Run periodically during simulation (every 5 steps):
if (currentStep % 5 === 0) {
  const promoted = await socialMemory.checkCollectiveEmergence(worldId, 3);
  for (const fact of promoted) {
    // Emit event so viewer shows the emergence
    emitEvent({
      type: "collective_emergence",
      step: currentStep,
      content: fact.content,
      confirmedBy: fact.confirmedBy,
    });
  }
}
```

### Task 10.7: Workspace vs World scoping clarification

For Concordia simulations, the scoping hierarchy is:

```
workspace_id = "concordia-sim"          (the Concordia bridge workspace)
  └── world_id = "medieval-town-001"    (one simulation instance)
        ├── agent_id = "elena"          (per-agent isolation)
        ├── agent_id = "marcus"
        └── agent_id = "sera"
```

- **workspaceId**: Always `"concordia-sim"` (or configurable). Groups all
  Concordia simulations together. Shared across all simulations.
- **worldId**: Unique per simulation instance. Maps to a per-world SQLite DB
  via `resolveWorldDbPath(worldId)`. Full DB-level isolation between simulations.
- **agentId**: Per-agent within a world. Memory entries tagged so agent A
  can't see agent B's private memories.
- **channel**: Always `"concordia"` for bridge-ingested entries.

All bridge endpoints must pass these four fields consistently.

### Task 10.8: Persistent vector store for simulation memory

Concordia's built-in `AssociativeMemoryBank` uses an in-memory pandas
DataFrame — vectors die when the simulation ends. AgenC's `SqliteVectorBackend`
persists vectors to SQLite. The bridge must use SqliteVectorBackend:

```typescript
import { SqliteVectorBackend } from "../memory/sqlite/vector-backend.js";

const vectorStore = new SqliteVectorBackend({
  dbPath: resolveWorldDbPath(worldId), // Per-world DB
  dimension: embeddingProvider.dimension,
});
```

This means:
- Vectors survive daemon restarts
- Vectors survive simulation restarts
- Semantic search works identically before/after restart
- `getDurability()` returns `{ level: "sync" }` not `{ level: "none" }`

### Task 10.9: Entry size limits, content sanitization, and SQL safety

Concordia GM observations can be long (multi-paragraph narration).
Enforce AgenC's security limits:

```typescript
const MAX_CONTENT_BYTES = 102_400; // 100KB
const MAX_METADATA_BYTES = 10_240; // 10KB

// In /observe endpoint, before storing:
if (observation.length > MAX_CONTENT_BYTES) {
  observation = observation.slice(0, MAX_CONTENT_BYTES - 3) + "...";
  logger.warn("Observation truncated to 100KB size limit");
}

// Sanitize XML-like tags to prevent prompt injection (Security H-5):
import { attrEscape } from "../memory/retriever.js"; // or inline
const sanitized = observation.replace(/</g, "&lt;").replace(/>/g, "&gt;");
```

SQL LIKE wildcard escaping is already enforced in `SqliteBackend.escapeLikePrefix()`
for `listSessions()` and `listKeys()` calls. No additional work needed for the bridge
— the backend handles it. But verify that agent names used as session prefixes don't
contain `%` or `_` characters (sanitize in `/setup`).

### Task 10.10: Memory encryption for sensitive simulations

If Concordia simulations contain sensitive content (psychology experiments,
private scenarios), enable at-rest encryption:

```typescript
import { createAES256GCMProvider } from "../memory/encryption.js";

// In bridge setup, if encryption key is configured:
const encryption = config.encryptionKey
  ? { key: config.encryptionKey }
  : undefined;

const memoryBackend = new SqliteBackend({
  dbPath,
  encryption,  // Encrypts both content AND metadata
});
```

For key rotation across simulation runs, use versioned encryption:
```typescript
import { createVersionedAES256GCMProvider } from "../memory/encryption.js";

const provider = createVersionedAES256GCMProvider({
  keys: { 1: oldKey, 2: newKey },
  currentVersion: 2,
});
```

### Task 10.11: Memory export after simulation

After a simulation completes, export the agents' memories for analysis
or transfer:

```typescript
import { exportMemory } from "../memory/export-import.js";

// In the /simulation/stop or post-simulation hook:
for (const agent of agents) {
  const data = await exportMemory({
    memoryBackend,
    workspaceId: "concordia-sim",
  });
  // Save to disk or return via API
  writeFileSync(
    `exports/${worldId}_${agent.id}_memory.json`,
    JSON.stringify(data, null, 2),
  );
}
```

Add CLI command: `agenc-concordia export --world-id <id> --agent <id>`

### Task 10.12: Retention policy for long simulations

Simulations with 100+ steps generate hundreds of observations. Run
retention periodically to prevent memory bloat:

```typescript
import { runRetention, runSqliteVacuum } from "../memory/consolidation.js";

// Every 20 steps during simulation:
if (currentStep % 20 === 0) {
  await runRetention({ memoryBackend, workspaceId });
}

// After simulation ends:
await runSqliteVacuum(memoryBackend);
```

### Task 10.13: Memory trace logging for simulation debugging

Wire the `MemoryTraceLogger` into the bridge for full observability:

```typescript
import { MemoryTraceLogger } from "../memory/trace-logger.js";

const traceLogger = new MemoryTraceLogger(logger, true);

// After each /act retrieval:
traceLogger.traceRetrieval({
  sessionId,
  query: actionSpec.call_to_action,
  candidateCount: candidates.length,
  selectedCount: selected.length,
  estimatedTokens: tokenCount,
  roles: { working: 2, semantic: 5, knowledge: 3 },
  workspaceId,
  durationMs,
});

// After each trust filter decision:
traceLogger.traceTrustFilter({
  entryId: entry.id,
  trustScore: score,
  threshold: 0.3,
  excluded: score < 0.3,
  source: inferTrustSource(entry.metadata, entry.role),
});
```

These traces appear in the daemon logs with `memory.*` prefix and can be
filtered in the simulation viewer.

### Task 10.14: Daily log manager for simulation transcripts

Wire the `DailyLogManager` to create structured transcripts:

```typescript
import { DailyLogManager } from "../memory/structured.js";

const logManager = new DailyLogManager(memoryBackend);

// After each resolved event:
await logManager.append(sessionId, {
  timestamp: Date.now(),
  type: "simulation_event",
  step: currentStep,
  actingAgent: agentName,
  content: resolvedEvent,
});
```

Daily logs provide a structured transcript of the simulation that can be
queried, exported, and analyzed separately from semantic memory.

---

### E0: Daemon config for loading the Concordia plugin

The plugin is loaded by the daemon via the channel config in `~/.agenc/config.json`:

```json
{
  "channels": {
    "concordia": {
      "enabled": true,
      "module": "@tetsuo-ai/plugin-concordia",
      "config": {
        "bridge_port": 3200,
        "event_port": 3201,
        "world_id": "default",
        "workspace_id": "concordia-sim"
      }
    }
  }
}
```

The runtime's `channel-loader.ts` will:
1. `import("@tetsuo-ai/plugin-concordia")`
2. Call `certifyChannelAdapterModule()` to validate manifest + exports
3. Wrap in `HostedChannelPlugin`
4. Register in `PluginCatalog`
5. Call `adapter.initialize(context)` with the config + `on_message` callback
6. Call `adapter.start()` — starts the bridge HTTP server

The plugin appears in `/status` alongside Telegram, Discord, etc.

### E1: ProxyEntity missing imports

The ProxyEntity code in Task 0.2 requires these imports at the top:
```python
import functools
import requests
from concordia.typing.entity import Entity, ActionSpec, DEFAULT_ACTION_SPEC
```

Also add error handling in `observe()`:
```python
def observe(self, observation: str) -> None:
    try:
        resp = requests.post(..., timeout=self._timeout)
        resp.raise_for_status()
    except requests.RequestException:
        pass  # Observations are fire-safe — never block the engine
```

### E2: How the bridge obtains AgenC runtime instances

Because the bridge is a plugin-kit `ChannelAdapter` loaded by the daemon, it runs
**inside the daemon process**. It has direct access to runtime modules via imports:

```typescript
// In adapter.ts or memory-wiring.ts:
import { SqliteBackend } from "@tetsuo-ai/runtime/memory/sqlite/backend";
import { MemoryIngestionEngine } from "@tetsuo-ai/runtime/memory/ingestion";
import { AgentIdentityManager } from "@tetsuo-ai/runtime/memory/agent-identity";
import { SocialMemoryManager } from "@tetsuo-ai/runtime/memory/social-memory";
import { SemanticMemoryRetriever } from "@tetsuo-ai/runtime/memory/retriever";
import { resolveWorldDbPath } from "@tetsuo-ai/runtime/memory/world-db-resolver";

// Per-world backend:
const dbPath = resolveWorldDbPath(worldId);
const memoryBackend = new SqliteBackend({ dbPath });
const ingestionEngine = new MemoryIngestionEngine({ ... });
const identityManager = new AgentIdentityManager({ memoryBackend });
const socialMemory = new SocialMemoryManager({ memoryBackend });
```

The bridge does NOT use WebSocket to communicate with the daemon. It uses the
plugin-kit `on_message` callback for LLM requests and direct imports for
memory operations. This eliminates bridge↔daemon network overhead entirely.

**Note**: If the plugin-kit contract restricts imports from `@tetsuo-ai/runtime`
(to keep the public ABI clean), the alternative is to pass memory instances via
the adapter config or a `ChannelAdapterContext` extension. The daemon already has
the memory backend, ingestion engine, etc. — it can inject them into the plugin
context at activation time.

### E3: Resolved events must flow from Python to the bridge

The bridge needs to know what the GM resolved so it can record social memory. Add a `POST /event` endpoint on the bridge:

```typescript
interface EventNotification {
  type: "resolution" | "observation" | "scene_change";
  step: number;
  acting_agent?: string;
  target_agents?: string[];  // Other agents mentioned in the event
  content: string;
  world_id: string;
}
```

The Python InstrumentedEngine calls this after each resolution:
```python
def resolve(self, game_master, event):
    super().resolve(game_master, event)
    # Notify the bridge about the resolved event
    requests.post(f"{self._bridge_url}/event", json={
        "type": "resolution",
        "step": self._current_step,
        "acting_agent": self._last_acting_entity_name,
        "content": event,
        "world_id": self._world_id,
    }, timeout=5)
```

The bridge parses the event content to identify target agents (using agent name matching against the known agent list) and records social memory interactions.

### E4: Control server implementation

`concordia_bridge/control_server.py` runs alongside the simulation in a separate thread:

```python
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import json

class ControlHandler(BaseHTTPRequestHandler):
    controller = None  # Set at startup
    sim_state = {"step": 0, "running": False, "paused": False}

    def do_POST(self):
        if self.path == "/simulation/play":
            self.controller.play()
            self.sim_state["paused"] = False
        elif self.path == "/simulation/pause":
            self.controller.pause()
            self.sim_state["paused"] = True
        elif self.path == "/simulation/step":
            self.controller.step()
        elif self.path == "/simulation/stop":
            self.controller.stop()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_GET(self):
        if self.path == "/simulation/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(self.sim_state).encode())

def start_control_server(controller, port=3202):
    ControlHandler.controller = controller
    server = HTTPServer(("localhost", port), ControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
```

### E5: EventServer async/sync bridge

`EventServer.broadcast()` is called from synchronous Concordia engine code but uses `asyncio.ensure_future`. Fix by using a thread-safe queue:

```python
import queue
import threading

class EventServer:
    def __init__(self, port=3201):
        self._queue = queue.Queue()
        self._loop = None
        # ... rest of init

    def broadcast(self, event: SimulationEvent):
        """Thread-safe broadcast — can be called from any thread."""
        data = json.dumps(asdict(event))
        self.replay_buffer.append(asdict(event))
        if len(self.replay_buffer) > self.max_buffer:
            self.replay_buffer = self.replay_buffer[-self.max_buffer:]
        self._queue.put(data)

    async def _drain_queue(self):
        """Run in the asyncio event loop to send queued messages."""
        while True:
            try:
                data = self._queue.get_nowait()
                for client in list(self.clients):
                    try:
                        await client.send(data)
                    except websockets.exceptions.ConnectionClosed:
                        self.clients.discard(client)
            except queue.Empty:
                await asyncio.sleep(0.05)
```

### E6: Speech vs action ActionSpecs

Concordia has two default action specs:
- `DEFAULT_ACTION_SPEC` — "What would {name} do next?" (tag: `"action"`)
- `DEFAULT_SPEECH_ACTION_SPEC` — "What is {name} likely to say next?" (tag: `"speech"`)

The bridge must handle both. For speech actions, the prompt should be:
```
[Simulation Context]
{call_to_action}

Respond in character as {agent_name}. Use natural dialogue.
Do not include your name prefix or quotation marks.
```

### E7: Viewer routing

Add a route in the web app's router:
```typescript
// web/src/App.tsx or equivalent
<Route path="/simulation" element={<SimulationViewer />} />
<Route path="/simulation/:worldId" element={<SimulationViewer />} />
```

The simulation viewer page loads at `http://localhost:5173/simulation/medieval-town-001`.

### E8: Bridge metrics and logging

The bridge server should log:
- Request count and latency per endpoint (`/act`, `/observe`, `/event`, `/setup`)
- Agent response times (time from sending `chat.message` to receiving response)
- Memory operation counts (entries stored, entities extracted)
- Error counts by category (timeout, daemon disconnect, parse failure)

Use the existing `MemoryTraceLogger` for memory operations and a simple counter map for HTTP metrics:
```typescript
const metrics = {
  actRequests: 0,
  observeRequests: 0,
  actLatencyMs: [] as number[],
  errors: 0,
};
```

Expose via `GET /metrics` for the viewer's diagnostics panel.

### E9: Port assignments summary

| Service | Default Port | Configurable |
|---------|-------------|-------------|
| AgenC Daemon | 3100 | `gateway.port` in config |
| Concordia Bridge Server | 3200 | `--port` CLI arg |
| Event WebSocket Server | 3201 | `--event-port` CLI arg |
| Control HTTP Server | 3202 | `--control-port` CLI arg |
| Web Viewer (dev) | 5173 | Vite default |
