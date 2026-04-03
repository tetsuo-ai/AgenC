import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createBridgeServer } from "../src/bridge-http.js";
import {
  COMPAT_SHIM_LEGACY_AGENT_STATE,
  COMPAT_SHIM_LEGACY_LAUNCH,
  COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
  COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
  CONCORDIA_HEADER_COMPATIBILITY_SHIM,
  CONCORDIA_HEADER_DEPRECATED,
  CONCORDIA_HEADER_MIGRATION_STATUS,
  CONCORDIA_HEADER_REQUEST_SCHEMA,
} from "../src/migration-compatibility.js";
import { ConcordiaAdmissionError } from "../src/operations.js";
import { SessionManager } from "../src/session-manager.js";
import type { Server } from "node:http";
import {
  createSampleSimulationWorldState,
  createSampleWorldProjection,
} from "./helpers/world-projection-fixture.js";

const HOST = "127.0.0.1";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const TEST_PORT_OFFSET = HTTP_OK;

let server: Server;
let port: number;
let sessionManager: SessionManager;
const actCalls: string[] = [];
const observeCalls: string[] = [];
const setupCalls: unknown[] = [];
const eventCalls: unknown[] = [];
const launchCalls: unknown[] = [];
const generateCalls: unknown[] = [];
const checkpointCalls: unknown[] = [];
const resumeCalls: unknown[] = [];
const agentStateCalls: Array<{ agentId: string; simulationId: string | null | undefined }> = [];
const simulationStatusCalls: string[] = [];
const worldProjectionCalls: Array<{ simulationId: string; agentId: string }> = [];
const worldStateCalls: string[] = [];
const actResultCalls: Array<{ action: string; narration: string | null; intent: unknown }> = [];
const controlCalls: Array<{ simulationId: string; command: string }> = [];
const simulationEventCalls: Array<{ simulationId: string; cursor: string | null | undefined }> = [];
const streamSubscribers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
const actRequestIds: string[] = [];
const generateRequestIds: string[] = [];
const operationalMetrics = {
  max_concurrent_simulations: 4,
  max_historical_simulations: 12,
  archived_simulation_retention_ms: 21_600_000,
  replay_buffer_limit: 1000,
  archived_replay_event_limit: HTTP_OK,
  runner_startup_timeout_ms: 30_000,
  runner_shutdown_timeout_ms: 2_000,
  step_stuck_timeout_ms: 300_000,
  act_timeout_ms: 120_000,
  generate_agents_timeout_ms: 60_000,
  simultaneous_max_workers: 8,
  proxy_action_timeout_seconds: 120,
  proxy_action_max_retries: 2,
  proxy_retry_delay_seconds: 2,
  active_simulations: 1,
  historical_simulations: 1,
  stuck_simulations: 0,
  pending_action_count: 0,
  replay_buffer_events: 2,
  reserved_port_count: 4,
  configured_thread_budget: 8,
  checkpoint_volume: 1,
  launch_requests: 0,
  rejected_launches: 0,
} as const;

const sampleWorldProjection = createSampleWorldProjection();
const simulationWorldState = createSampleSimulationWorldState();

const simulationSummaries = [
  {
    simulation_id: "sim-running",
    world_id: "world-alpha",
    workspace_id: "ws-alpha",
    lineage_id: null,
    parent_simulation_id: null,
    status: "running",
    reason: null,
    error: null,
    created_at: 1,
    updated_at: 2,
    started_at: 2,
    ended_at: null,
    agent_ids: ["alice"],
    current_alias: true,
    pid: 1111,
    last_completed_step: 3,
    last_step_outcome: "resolved",
    replay_event_count: 7,
    checkpoint: null,
  },
  {
    simulation_id: "sim-paused",
    world_id: "world-beta",
    workspace_id: "ws-beta",
    lineage_id: "lineage-beta",
    parent_simulation_id: "sim-older",
    status: "paused",
    reason: null,
    error: null,
    created_at: 3,
    updated_at: 4,
    started_at: 4,
    ended_at: null,
    agent_ids: ["bob"],
    current_alias: false,
    pid: 2222,
    last_completed_step: 5,
    last_step_outcome: "paused",
    replay_event_count: 9,
    checkpoint: null,
  },
] as const;

const simulationStatuses = new Map([
  [
    "sim-running",
    {
      simulation_id: "sim-running",
      world_id: "world-alpha",
      workspace_id: "ws-alpha",
      status: "running",
      reason: null,
      error: null,
      step: 3,
      max_steps: 12,
      running: true,
      paused: false,
      agent_count: 1,
      started_at: 2,
      ended_at: null,
      updated_at: 5,
      last_step_outcome: "resolved",
      terminal_reason: null,
      checkpoint: null,
    },
  ],
  [
    "sim-paused",
    {
      simulation_id: "sim-paused",
      world_id: "world-beta",
      workspace_id: "ws-beta",
      status: "paused",
      reason: null,
      error: null,
      step: 5,
      max_steps: 20,
      running: true,
      paused: true,
      agent_count: 1,
      started_at: 4,
      ended_at: null,
      updated_at: 6,
      last_step_outcome: "paused",
      terminal_reason: null,
      checkpoint: null,
    },
  ],
]);

const simulationEvents = new Map([
  [
    "sim-running",
    [
      {
        event_id: "1",
        type: "observation",
        step: 1,
        simulation_id: "sim-running",
        world_id: "world-alpha",
        workspace_id: "ws-alpha",
        agent_name: "alice",
        content: "Alice sees the forge.",
        timestamp: 1,
      },
      {
        event_id: "2",
        type: "resolution",
        step: 2,
        simulation_id: "sim-running",
        world_id: "world-alpha",
        workspace_id: "ws-alpha",
        agent_name: "alice",
        content: "Alice bargains with the smith.",
        resolved_event: "Alice secures a better price.",
        timestamp: 2,
      },
    ],
  ],
]);

const simulationRecords = new Map([
  [
    "sim-running",
    {
      ...simulationSummaries[0],
      agents: [
        { agent_id: "alice", agent_name: "Alice", personality: "Helpful", goal: "Win" },
      ],
      premise: "Active premise",
      max_steps: 12,
      gm_model: "grok-4",
      gm_provider: "grok",
    },
  ],
]);

function registerSimulationRecord(
  simulationId: string,
  overrides: Record<string, unknown> = {},
): void {
  simulationRecords.set(simulationId, {
    ...simulationRecords.get("sim-running"),
    simulation_id: simulationId,
    world_id: overrides.world_id ?? `world-${simulationId}`,
    workspace_id: overrides.workspace_id ?? `ws-${simulationId}`,
    lineage_id: overrides.lineage_id ?? null,
    parent_simulation_id: overrides.parent_simulation_id ?? null,
    status: overrides.status ?? "running",
    reason: overrides.reason ?? null,
    error: overrides.error ?? null,
    created_at: overrides.created_at ?? Date.now(),
    updated_at: overrides.updated_at ?? Date.now(),
    started_at: overrides.started_at ?? Date.now(),
    ended_at: overrides.ended_at ?? null,
    agent_ids: overrides.agent_ids ?? ["alice"],
    current_alias: overrides.current_alias ?? false,
    pid: overrides.pid ?? 1234,
    last_completed_step: overrides.last_completed_step ?? 0,
    last_step_outcome: overrides.last_step_outcome ?? null,
    replay_event_count: overrides.replay_event_count ?? 0,
    checkpoint: overrides.checkpoint ?? null,
    agents: overrides.agents ?? [
      { agent_id: "alice", agent_name: "Alice", personality: "Helpful", goal: "Win" },
    ],
    premise: overrides.premise ?? "Test premise",
    max_steps: overrides.max_steps ?? 12,
    gm_model: overrides.gm_model ?? "grok-4",
    gm_provider: overrides.gm_provider ?? "grok",
  });
}

beforeAll(async () => {
  sessionManager = new SessionManager();
  port = 13300 + Math.floor(Math.random() * 100);

  server = createBridgeServer({
    port,
    host: HOST,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sessionManager,
    onAct: async (agentId, _sessionId, message, requestId) => {
      actCalls.push(message);
      actRequestIds.push(requestId);
      return JSON.stringify({
        action: `response for ${agentId}`,
        narration: `${agentId} advances through the forge.`,
        intent: {
          summary: `response for ${agentId}`,
          mode: "action",
          destination: {
            location_id: "forge",
            scene_id: "scene-forge",
            zone_id: "zone-market",
            label: "Forge",
          },
          target_agent_ids: [],
          target_object_ids: ["anvil"],
          task: { title: "Inspect the forge", status: "active", note: null },
          inventory_add: [],
          inventory_remove: [],
          world_object_updates: [],
          relationship_updates: [],
          notes: [],
        },
      });
    },
    onActResult: async ({ action, narration, intent }) => {
      actResultCalls.push({ action, narration, intent });
    },
    onObserve: async (_agentId, _sessionId, observation) => {
      observeCalls.push(observation);
    },
    onSetup: async (request) => {
      setupCalls.push(request);
      const sessions: Record<string, string> = {};
      for (const agent of request.agents) {
        const s = sessionManager.getOrCreate({
          agentId: agent.agent_id,
          agentName: agent.agent_name,
          worldId: request.world_id,
          workspaceId: request.workspace_id,
          simulationId: request.simulation_id,
          lineageId: request.lineage_id,
          parentSimulationId: request.parent_simulation_id,
        });
        sessions[agent.agent_id] = s.sessionId;
      }
      return sessions;
    },
    onLaunch: async (request) => {
      launchCalls.push(request);
      return {
        pid: 4242,
        world_id: request.world_id,
        simulation_id: request.simulation_id ?? "generated-sim",
      };
    },
    onCheckpoint: async (request) => {
      checkpointCalls.push(request);
      return {
        world_id: request.world_id,
        simulation_id: request.simulation_id,
        step: request.step,
        sessions: [],
        checkpoint_manifest: {
          simulation_id: request.simulation_id,
          world_id: request.world_id,
          workspace_id: request.workspace_id,
          step: request.step,
          checkpoint_id: `${request.simulation_id}:step:${request.step}`,
          checkpoint_path: `/tmp/checkpoints/${request.simulation_id}_step_${request.step}.json`,
        },
        checkpoint: {
          checkpoint_id: `${request.simulation_id}:step:${request.step}`,
          checkpoint_path: `/tmp/checkpoints/${request.simulation_id}_step_${request.step}.json`,
          schema_version: 3,
          world_id: request.world_id,
          workspace_id: request.workspace_id,
          simulation_id: request.simulation_id,
          lineage_id: request.lineage_id ?? null,
          parent_simulation_id: request.parent_simulation_id ?? null,
          step: request.step,
          timestamp: 1,
          max_steps: request.max_steps ?? request.step,
          scene_cursor: null,
          runtime_cursor: {
            current_step: request.step,
            start_step: request.step + 1,
            max_steps: request.max_steps ?? request.step,
          },
          replay_cursor: {
            replay_cursor: 0,
            replay_event_count: 0,
          },
          world_state_refs: {
            source: "inline_checkpoint",
            entity_state_keys: [],
          },
          subsystem_state: {
            resumed: ["gm_state"],
            reset: ["control_port"],
          },
        },
      };
    },
    onResume: async (request) => {
      resumeCalls.push(request);
      return {
        world_id: "test-world",
        simulation_id: request.simulation_id ?? "resumed-sim",
        resumed_from_step: 5,
        sessions: {},
      };
    },
    onGenerateAgents: async (request, requestId) => {
      generateCalls.push(request);
      generateRequestIds.push(requestId);
      return {
        agents: [
          {
            id: "alex",
            name: "Alex",
            personality: "Careful and analytical.",
            goal: "Understand the situation.",
          },
        ],
      };
    },
    onEvent: async (event) => {
      eventCalls.push(event);
    },
    getCurrentSimulationId: async () => "sim-running",
    listSimulations: async () => simulationSummaries,
    getSimulation: async (simulationId) => simulationRecords.get(simulationId) ?? null,
    getSimulationStatus: async (simulationId) => {
      simulationStatusCalls.push(simulationId);
      return simulationStatuses.get(simulationId) ?? null;
    },
    controlSimulation: async (simulationId, command) => {
      controlCalls.push({ simulationId, command });
      return simulationStatuses.get(simulationId) ?? null;
    },
    listSimulationEvents: async (simulationId, cursor) => {
      simulationEventCalls.push({ simulationId, cursor });
      const events = simulationEvents.get(simulationId);
      if (!events) return null;
      const filtered = cursor
        ? events.filter((event) => Number(event.event_id) > Number(cursor))
        : events;
      return {
        simulation_id: simulationId,
        events: filtered,
        next_cursor: filtered.at(-1)?.event_id ?? cursor ?? null,
      };
    },
    getOperationalMetrics: async () => operationalMetrics,
    openSimulationEventStream: async (simulationId, cursor, subscriber) => {
      const events = simulationEvents.get(simulationId);
      if (!events) return null;
      const subscribers = streamSubscribers.get(simulationId) ?? new Set();
      subscribers.add(subscriber as (event: Record<string, unknown>) => void);
      streamSubscribers.set(simulationId, subscribers);
      const filtered = cursor
        ? events.filter((event) => Number(event.event_id) > Number(cursor))
        : events;
      return {
        history: filtered,
        unsubscribe: () => {
          subscribers.delete(subscriber as (event: Record<string, unknown>) => void);
        },
      };
    },
    getAgentState: async (agentId, simulationId) => {
      agentStateCalls.push({ agentId, simulationId });
      if (agentId === "unknown") return null;
      return {
        simulationId: "sim-agent-state",
        identity: { name: agentId },
        memoryCount: 5,
        recentMemories: [],
        relationships: [],
        worldFacts: [],
        turnCount: 1,
        lastAction: "test action",
      } as const;
    },
    getWorldProjection: async (simulationId, agentId) => {
      worldProjectionCalls.push({ simulationId, agentId });
      return {
        ...sampleWorldProjection,
        simulation_id: simulationId,
        agent_id: agentId,
      };
    },
    getSimulationWorldState: async (simulationId) => {
      worldStateCalls.push(simulationId);
      if (simulationId !== "sim-running") {
        return null;
      }
      return simulationWorldState;
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(port, HOST, () => resolve());
  });
});

afterAll(() => {
  server.close();
});

function url(path: string): string {
  return `http://${HOST}:${port}${path}`;
}

describe("Bridge HTTP Server", () => {
  describe("GET /health", () => {
    it("returns status ok", async () => {
      const resp = await fetch(url("/health"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(data.active_simulations).toBe(2);
      expect(typeof data.uptime_ms).toBe("number");
    });
  });

  describe("GET /metrics", () => {
    it("returns metrics counters", async () => {
      const resp = await fetch(url("/metrics"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(resp.headers.get(CONCORDIA_HEADER_REQUEST_SCHEMA)).toBe("2");
      expect(resp.headers.get(CONCORDIA_HEADER_MIGRATION_STATUS)).toBe("/migration/status");
      expect(typeof data.act_requests).toBe("number");
      expect(typeof data.observe_requests).toBe("number");
      expect(typeof data.errors).toBe("number");
    });
  });

  describe("GET /migration/status", () => {
    it("returns migration compatibility and rollback metadata", async () => {
      const resp = await fetch(url("/migration/status"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.request_response_schema.current_version).toBe(2);
      expect(data.compatibility_shims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ shim_id: COMPAT_SHIM_LEGACY_LAUNCH }),
          expect.objectContaining({ shim_id: COMPAT_SHIM_LEGACY_SIMULATION_STATUS }),
        ]),
      );
      expect(data.rollback_points).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rollback_id: "checkpoint-manifest-v3" }),
        ]),
      );
    });
  });

  describe("GET /simulations", () => {
    it("returns active and recent simulation summaries", async () => {
      const resp = await fetch(url("/simulations"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.simulations).toHaveLength(2);
      expect(data.simulations[0].simulation_id).toBe("sim-running");
      expect(data.simulations[1].simulation_id).toBe("sim-paused");
    });
  });

  describe("GET /simulations/:id", () => {
    it("returns the simulation record when present", async () => {
      const resp = await fetch(url("/simulations/sim-running"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.simulation_id).toBe("sim-running");
      expect(data.premise).toBe("Active premise");
    });

    it("returns not found when the simulation is unknown", async () => {
      const resp = await fetch(url("/simulations/missing-sim"));
      expect(resp.status).toBe(HTTP_NOT_FOUND);
    });
  });

  describe("GET /simulations/:id/status", () => {
    it("returns the simulation lifecycle status", async () => {
      const resp = await fetch(url("/simulations/sim-running/status"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.simulation_id).toBe("sim-running");
      expect(data.status).toBe("running");
      expect(simulationStatusCalls.at(-1)).toBe("sim-running");
    });
  });

  describe("GET /simulations/:id/world-state", () => {
    it("returns the authoritative world-state snapshot", async () => {
      const resp = await fetch(url("/simulations/sim-running/world-state"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.simulation_id).toBe("sim-running");
      expect(data.snapshot_ref).toBe("sim-running:world:2:10");
      expect(worldStateCalls.at(-1)).toBe("sim-running");
    });
  });

  describe("GET /simulation/status", () => {
    it("uses the current simulation alias", async () => {
      const resp = await fetch(url("/simulation/status"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(resp.headers.get(CONCORDIA_HEADER_COMPATIBILITY_SHIM)).toBe(
        COMPAT_SHIM_LEGACY_SIMULATION_STATUS,
      );
      expect(resp.headers.get(CONCORDIA_HEADER_DEPRECATED)).toBe("true");
      expect(data.simulation_id).toBe("sim-running");
    });
  });

  describe("GET /simulations/:id/events", () => {
    it("returns replay events and cursor state", async () => {
      const resp = await fetch(url("/simulations/sim-running/events"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.events).toHaveLength(2);
      expect(data.next_cursor).toBe("2");
      expect(simulationEventCalls.at(-1)).toEqual({
        simulationId: "sim-running",
        cursor: null,
      });
    });

    it("passes through replay cursors", async () => {
      const resp = await fetch(url("/simulations/sim-running/events?cursor=1"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.events).toHaveLength(1);
      expect(data.events[0].event_id).toBe("2");
      expect(simulationEventCalls.at(-1)).toEqual({
        simulationId: "sim-running",
        cursor: "1",
      });
    });
  });

  describe("GET /simulations/:id/events/stream", () => {
    it("streams replay history from the bridge-owned event feed", async () => {
      const controller = new AbortController();
      const resp = await fetch(url("/simulations/sim-running/events/stream"), {
        signal: controller.signal,
      });
      expect(resp.status).toBe(HTTP_OK);
      const reader = resp.body?.getReader();
      expect(reader).toBeTruthy();
      const firstChunk = await reader!.read();
      const text = new TextDecoder().decode(firstChunk.value);
      controller.abort();
      expect(text).toContain("id: 1");
      expect(text).toContain('"simulation_id":"sim-running"');
    });
  });

  describe("POST /setup", () => {
    it("creates sessions for agents and echoes simulation identity", async () => {
      registerSimulationRecord("sim-setup", {
        world_id: "test-world",
        workspace_id: "test-ws",
        agent_ids: ["alice", "bob"],
        agents: [
          { agent_id: "alice", agent_name: "Alice", personality: "Helpful", goal: "Win" },
          { agent_id: "bob", agent_name: "Bob", personality: "Curious", goal: "Learn" },
        ],
        premise: "Test premise",
      });

      const resp = await fetch(url("/setup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-setup",
          lineage_id: "lineage-setup",
          parent_simulation_id: null,
          agents: [
            { agent_id: "alice", agent_name: "Alice", personality: "Helpful", goal: "Win" },
            { agent_id: "bob", agent_name: "Bob", personality: "Curious" },
          ],
          premise: "Test premise",
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(data.simulation_id).toBe("sim-setup");
      expect(data.lineage_id).toBe("lineage-setup");
      expect(data.sessions.alice).toBeTruthy();
      expect(data.sessions.bob).toBeTruthy();
    });

    it("rejects setup for unknown simulations", async () => {
      const setupCount = setupCalls.length;
      const resp = await fetch(url("/setup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-missing-setup",
          agents: [
            { agent_id: "ghost", agent_name: "Ghost", personality: "Fleeting" },
          ],
          premise: "Ghost premise",
        }),
      });

      expect(resp.status).toBe(HTTP_NOT_FOUND);
      expect(setupCalls).toHaveLength(setupCount);
      expect(sessionManager.getAllForSimulation("sim-missing-setup", "test-ws")).toEqual([]);
    });
  });

  describe("POST /launch", () => {
    it("delegates simulation launch", async () => {
      const resp = await fetch(url("/launch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world_id: "launch-world",
          workspace_id: "test-ws",
          simulation_id: "sim-launch",
          agents: [
            { agent_id: "alice", agent_name: "Alice", personality: "Helpful", goal: "Win" },
          ],
          premise: "Test launch premise",
          max_steps: 10,
          gm_model: "grok-4",
          gm_provider: "grok",
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(resp.headers.get(CONCORDIA_HEADER_COMPATIBILITY_SHIM)).toBe(
        COMPAT_SHIM_LEGACY_LAUNCH,
      );
      expect(resp.headers.get(CONCORDIA_HEADER_DEPRECATED)).toBe("true");
      expect(data.status).toBe("ok");
      expect(data.pid).toBe(4242);
      expect(data.simulation_id).toBe("sim-launch");
      expect(launchCalls).toHaveLength(1);
    });
  });

  describe("POST /simulations/:id/play", () => {
    it("routes lifecycle commands through the bridge", async () => {
      const resp = await fetch(url("/simulations/sim-running/play"), {
        method: "POST",
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(data.simulation.simulation_id).toBe("sim-running");
      expect(controlCalls.at(-1)).toEqual({
        simulationId: "sim-running",
        command: "play",
      });
    });
  });

  describe("POST /simulation/pause", () => {
    it("routes legacy lifecycle commands via the current simulation alias", async () => {
      const resp = await fetch(url("/simulation/pause"), {
        method: "POST",
      });
      expect(resp.status).toBe(HTTP_OK);
      expect(resp.headers.get(CONCORDIA_HEADER_COMPATIBILITY_SHIM)).toBe(
        COMPAT_SHIM_LEGACY_SIMULATION_CONTROL,
      );
      expect(resp.headers.get(CONCORDIA_HEADER_DEPRECATED)).toBe("true");
      expect(controlCalls.at(-1)).toEqual({
        simulationId: "sim-running",
        command: "pause",
      });
    });
  });

  describe("POST /checkpoint", () => {
    it("delegates checkpoint generation", async () => {
      const resp = await fetch(url("/checkpoint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world_id: "checkpoint-world",
          workspace_id: "test-ws",
          simulation_id: "sim-checkpoint",
          lineage_id: "lineage-checkpoint",
          step: 7,
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(data.step).toBe(7);
      expect(data.simulation_id).toBe("sim-checkpoint");
      expect(data.checkpoint_manifest.checkpoint_id).toBe("sim-checkpoint:step:7");
      expect(data.checkpoint.checkpoint_id).toBe("sim-checkpoint:step:7");
      expect(checkpointCalls).toHaveLength(1);
    });
  });

  describe("POST /resume", () => {
    it("delegates resume handling", async () => {
      const resp = await fetch(url("/resume"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulation_id: "sim-resumed",
          checkpoint: {
            world_id: "test-world",
            simulation_id: "sim-original",
            step: 5,
            config: {
              world_id: "test-world",
              workspace_id: "test-ws",
              simulation_id: "sim-original",
              premise: "Resume premise",
              agents: [],
            },
          },
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(data.resumed_from_step).toBe(5);
      expect(data.simulation_id).toBe("sim-resumed");
      expect(resumeCalls).toHaveLength(1);
    });
  });

  describe("POST /generate-agents", () => {
    it("returns generated agents", async () => {
      const resp = await fetch(url("/generate-agents"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: 3,
          premise: "A tense market opening.",
          worldId: "generated-market",
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(Array.isArray(data.agents)).toBe(true);
      expect(data.agents[0].id).toBe("alex");
      expect(generateCalls).toHaveLength(1);
      expect(generateRequestIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("POST /act", () => {
    it("returns structured agent responses and records world projection usage", async () => {
      registerSimulationRecord("sim-act", {
        world_id: "test-world",
        workspace_id: "test-ws",
      });
      sessionManager.getOrCreate({
        agentId: "alice",
        agentName: "Alice",
        worldId: "test-world",
        workspaceId: "test-ws",
        simulationId: "sim-act",
      });

      const resp = await fetch(url("/act"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "alice",
          agent_name: "Alice",
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-act",
          action_spec: {
            call_to_action: "What would Alice do?",
            output_type: "free",
            options: [],
            tag: "action",
          },
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.action).toBe("response for alice");
      expect(data.narration).toBe("alice advances through the forge.");
      expect(data.intent.mode).toBe("action");
      expect(actCalls.at(-1)).toContain("[World Projection]");
      expect(worldProjectionCalls.at(-1)).toEqual({ simulationId: "sim-act", agentId: "alice" });
      expect(actResultCalls.at(-1)).toEqual({
        action: "response for alice",
        narration: "alice advances through the forge.",
        intent: expect.objectContaining({ mode: "action" }),
      });
      expect(actRequestIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("rejects act requests for unknown simulations", async () => {
      const resp = await fetch(url("/act"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "ghost",
          agent_name: "Ghost",
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-missing-act",
          action_spec: {
            call_to_action: "What would Ghost do?",
            output_type: "free",
            options: [],
            tag: "action",
          },
        }),
      });

      expect(resp.status).toBe(HTTP_NOT_FOUND);
      expect(sessionManager.getAllForSimulation("sim-missing-act", "test-ws")).toEqual([]);
    });
  });

  describe("POST /observe", () => {
    it("stores observation and returns ok", async () => {
      registerSimulationRecord("sim-observe", {
        world_id: "w1",
        workspace_id: "ws1",
      });
      sessionManager.getOrCreate({
        agentId: "alice",
        agentName: "Alice",
        worldId: "w1",
        workspaceId: "ws1",
        simulationId: "sim-observe",
      });

      const resp = await fetch(url("/observe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "alice",
          agent_name: "Alice",
          world_id: "w1",
          workspace_id: "ws1",
          simulation_id: "sim-observe",
          observation: "You see a market square.",
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(observeCalls).toContain("You see a market square.");
    });

    it("rejects observations for unknown simulations", async () => {
      const resp = await fetch(url("/observe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "ghost",
          agent_name: "Ghost",
          world_id: "w1",
          workspace_id: "ws1",
          simulation_id: "sim-missing-observe",
          observation: "You see an abandoned square.",
        }),
      });

      expect(resp.status).toBe(HTTP_NOT_FOUND);
      expect(sessionManager.getAllForSimulation("sim-missing-observe", "ws1")).toEqual([]);
    });
  });

  describe("POST /event", () => {
    it("accepts event notifications", async () => {
      registerSimulationRecord("sim-event", {
        world_id: "test-world",
        workspace_id: "test-ws",
      });
      const resp = await fetch(url("/event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "resolution",
          step: 5,
          acting_agent: "alice",
          content: "Alice trades iron.",
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-event",
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
    });

    it("rejects events for unknown simulations", async () => {
      const eventCount = eventCalls.length;
      const resp = await fetch(url("/event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "resolution",
          step: 1,
          acting_agent: "ghost",
          content: "Ghost resolves nothing.",
          world_id: "test-world",
          workspace_id: "test-ws",
          simulation_id: "sim-missing-event",
        }),
      });

      expect(resp.status).toBe(HTTP_NOT_FOUND);
      expect(eventCalls).toHaveLength(eventCount);
    });
  });

  describe("POST /reset", () => {
    it("clears sessions", async () => {
      sessionManager.getOrCreate({
        agentId: "temp",
        agentName: "Temp",
        worldId: "w",
        workspaceId: "ws",
        simulationId: "sim-reset",
      });
      expect(sessionManager.size).toBeGreaterThan(0);

      const resp = await fetch(url("/reset"), { method: "POST" });
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(data.status).toBe("ok");
      expect(sessionManager.size).toBe(0);
    });
  });

  describe("GET /agent/:id/state", () => {
    it("returns agent state", async () => {
      const resp = await fetch(url("/agent/alice/state"));
      const data = await resp.json();
      expect(resp.status).toBe(HTTP_OK);
      expect(resp.headers.get(CONCORDIA_HEADER_COMPATIBILITY_SHIM)).toBe(
        COMPAT_SHIM_LEGACY_AGENT_STATE,
      );
      expect(resp.headers.get(CONCORDIA_HEADER_DEPRECATED)).toBe("true");
      expect(data.identity.name).toBe("alice");
      expect(data.turnCount).toBe(1);
      expect(data.simulationId).toBe("sim-agent-state");
      expect(agentStateCalls.at(-1)).toEqual({
        agentId: "alice",
        simulationId: "sim-running",
      });
    });

    it("passes simulation_id through to agent state lookups", async () => {
      const resp = await fetch(url("/agent/alice/state?simulation_id=sim-state"));
      expect(resp.status).toBe(HTTP_OK);
      expect(agentStateCalls.at(-1)).toEqual({
        agentId: "alice",
        simulationId: "sim-state",
      });
    });

    it("returns not found for unknown agent", async () => {
      const resp = await fetch(url("/agent/unknown/state"));
      expect(resp.status).toBe(HTTP_NOT_FOUND);
    });
  });

  describe("GET /simulations/:id/agents/:agentId/state", () => {
    it("uses simulation-scoped agent state endpoints", async () => {
      const resp = await fetch(url("/simulations/sim-running/agents/alice/state"));
      expect(resp.status).toBe(HTTP_OK);
      expect(agentStateCalls.at(-1)).toEqual({
        agentId: "alice",
        simulationId: "sim-running",
      });
    });
  });

it("includes operational metrics in the metrics payload", async () => {
  const response = await fetch(url("/metrics"));
  expect(response.status).toBe(HTTP_OK);

  const payload = await response.json();
  expect(payload).toEqual(expect.objectContaining({
    operations: expect.objectContaining({
      max_concurrent_simulations: 4,
      reserved_port_count: 4,
      configured_thread_budget: 8,
    }),
  }));
});

it("returns 503 when admission control rejects a launch", async () => {
  const localSessionManager = new SessionManager();
  const localPort = port + TEST_PORT_OFFSET;
  const localServer = createBridgeServer({
    port: localPort,
    host: HOST,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sessionManager: localSessionManager,
    onAct: async () => "ok",
    onObserve: async () => undefined,
    onSetup: async () => ({}),
    onEvent: async () => undefined,
    onLaunch: async () => {
      throw new ConcordiaAdmissionError(1, 1);
    },
  });

  await new Promise<void>((resolve) => {
    localServer.listen(localPort, HOST, () => resolve());
  });

  try {
    const response = await fetch(`http://${HOST}:${localPort}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        world_id: "world-capacity",
        workspace_id: "ws-capacity",
        agents: [],
        premise: "capacity test",
      }),
    });

    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    const payload = await response.json();
    expect(payload).toEqual(expect.objectContaining({
      code: "concordia_capacity_exhausted",
      active: 1,
      limit: 1,
    }));
  } finally {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  }
});

});
