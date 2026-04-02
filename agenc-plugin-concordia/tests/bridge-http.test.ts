import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createBridgeServer } from "../src/bridge-http.js";
import { SessionManager } from "../src/session-manager.js";
import type { Server } from "node:http";

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
const actRequestIds: string[] = [];
const generateRequestIds: string[] = [];
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
    control_port: 3202,
    event_port: 3201,
    last_completed_step: 3,
    last_step_outcome: "resolved",
    replay_event_count: 7,
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
    control_port: 3302,
    event_port: 3301,
    last_completed_step: 5,
    last_step_outcome: "paused",
    replay_event_count: 9,
  },
] as const;
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

beforeAll(async () => {
  sessionManager = new SessionManager();
  port = 13300 + Math.floor(Math.random() * 100);

  server = createBridgeServer({
    port,
    host: "127.0.0.1",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sessionManager,
    onAct: async (agentId, _sessionId, message, requestId) => {
      actCalls.push(message);
      actRequestIds.push(requestId);
      return `response for ${agentId}`;
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
    listSimulations: async () => simulationSummaries,
    getSimulation: async (simulationId) => simulationRecords.get(simulationId) ?? null,
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
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
});

afterAll(() => {
  server.close();
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe("Bridge HTTP Server", () => {
  describe("GET /health", () => {
    it("returns status ok", async () => {
      const resp = await fetch(url("/health"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.active_simulations).toBe(2);
      expect(typeof data.uptime_ms).toBe("number");
    });
  });

  describe("GET /metrics", () => {
    it("returns metrics counters", async () => {
      const resp = await fetch(url("/metrics"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(typeof data.act_requests).toBe("number");
      expect(typeof data.observe_requests).toBe("number");
      expect(typeof data.errors).toBe("number");
    });
  });


  describe("GET /simulations", () => {
    it("returns active and recent simulation summaries", async () => {
      const resp = await fetch(url("/simulations"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.simulations).toHaveLength(2);
      expect(data.simulations[0].simulation_id).toBe("sim-running");
      expect(data.simulations[1].simulation_id).toBe("sim-paused");
    });
  });

  describe("GET /simulations/:id", () => {
    it("returns the simulation record when present", async () => {
      const resp = await fetch(url("/simulations/sim-running"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.simulation_id).toBe("sim-running");
      expect(data.premise).toBe("Active premise");
    });

    it("returns 404 when the simulation is unknown", async () => {
      const resp = await fetch(url("/simulations/missing-sim"));
      expect(resp.status).toBe(404);
    });
  });

  describe("POST /setup", () => {
    it("creates sessions for agents and echoes simulation identity", async () => {
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.simulation_id).toBe("sim-setup");
      expect(data.lineage_id).toBe("lineage-setup");
      expect(data.sessions.alice).toBeTruthy();
      expect(data.sessions.bob).toBeTruthy();
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.pid).toBe(4242);
      expect(data.simulation_id).toBe("sim-launch");
      expect(launchCalls).toHaveLength(1);
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.step).toBe(7);
      expect(data.simulation_id).toBe("sim-checkpoint");
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
      expect(resp.status).toBe(200);
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
      expect(resp.status).toBe(200);
      expect(Array.isArray(data.agents)).toBe(true);
      expect(data.agents[0].id).toBe("alex");
      expect(generateCalls).toHaveLength(1);
      expect(generateRequestIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("POST /act", () => {
    it("returns agent response", async () => {
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
      expect(resp.status).toBe(200);
      expect(data.action).toBe("response for alice");
      expect(actRequestIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("POST /observe", () => {
    it("stores observation and returns ok", async () => {
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(observeCalls).toContain("You see a market square.");
    });
  });

  describe("POST /event", () => {
    it("accepts event notifications", async () => {
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
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
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(sessionManager.size).toBe(0);
    });
  });

  describe("GET /agent/:id/state", () => {
    it("returns agent state", async () => {
      const resp = await fetch(url("/agent/alice/state"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.identity.name).toBe("alice");
      expect(data.turnCount).toBe(1);
      expect(data.simulationId).toBe("sim-agent-state");
      expect(agentStateCalls.at(-1)).toEqual({
        agentId: "alice",
        simulationId: null,
      });
    });

    it("passes simulation_id through to agent state lookups", async () => {
      const resp = await fetch(url("/agent/alice/state?simulation_id=sim-state"));
      expect(resp.status).toBe(200);
      expect(agentStateCalls.at(-1)).toEqual({
        agentId: "alice",
        simulationId: "sim-state",
      });
    });

    it("returns 404 for unknown agent", async () => {
      const resp = await fetch(url("/agent/unknown/state"));
      expect(resp.status).toBe(404);
    });
  });

  describe("error handling", () => {
    it("returns 404 for unknown paths", async () => {
      const resp = await fetch(url("/nonexistent"));
      expect(resp.status).toBe(404);
    });

    it("returns 405 for wrong method", async () => {
      const resp = await fetch(url("/health"), { method: "PUT" });
      expect(resp.status).toBe(405);
    });

    it("rejects act requests without simulation identity", async () => {
      const resp = await fetch(url("/act"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "alice",
          agent_name: "Alice",
          world_id: "test-world",
          workspace_id: "test-ws",
          action_spec: {
            call_to_action: "What would Alice do?",
            output_type: "free",
            options: [],
            tag: "action",
          },
        }),
      });
      const data = await resp.json();
      expect(resp.status).toBe(500);
      expect(data.error).toContain("simulation_id");
    });
  });
});
