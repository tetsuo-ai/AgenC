import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createBridgeServer } from "../src/bridge-http.js";
import { SessionManager } from "../src/session-manager.js";
import type { Server } from "node:http";

// ============================================================================
// Test HTTP server
// ============================================================================

let server: Server;
let port: number;
let sessionManager: SessionManager;
const actCalls: string[] = [];
const observeCalls: string[] = [];
const setupCalls: unknown[] = [];
const eventCalls: unknown[] = [];

beforeAll(async () => {
  sessionManager = new SessionManager();
  port = 13300 + Math.floor(Math.random() * 100);

  server = createBridgeServer({
    port,
    host: "127.0.0.1",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sessionManager,
    onAct: async (agentId, sessionId, message) => {
      actCalls.push(message);
      return `response for ${agentId}`;
    },
    onObserve: async (agentId, sessionId, observation) => {
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
        });
        sessions[agent.agent_id] = s.sessionId;
      }
      return sessions;
    },
    onEvent: async (event) => {
      eventCalls.push(event);
    },
    getAgentState: async (agentId) => {
      if (agentId === "unknown") return null;
      return {
        identity: { name: agentId },
        memoryCount: 5,
        recentMemories: [],
        relationships: [],
        worldFacts: [],
        turnCount: 1,
        lastAction: "test action",
      } as any;
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

// ============================================================================
// Tests
// ============================================================================

describe("Bridge HTTP Server", () => {
  describe("GET /health", () => {
    it("returns status ok", async () => {
      const resp = await fetch(url("/health"));
      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.status).toBe("ok");
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

  describe("POST /setup", () => {
    it("creates sessions for agents", async () => {
      const resp = await fetch(url("/setup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world_id: "test-world",
          workspace_id: "test-ws",
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
      expect(data.sessions).toBeDefined();
      expect(data.sessions.alice).toBeTruthy();
      expect(data.sessions.bob).toBeTruthy();
    });
  });

  describe("POST /act", () => {
    it("returns agent response", async () => {
      // Ensure session exists
      sessionManager.getOrCreate({
        agentId: "alice",
        agentName: "Alice",
        worldId: "test-world",
        workspaceId: "test-ws",
      });

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
      expect(resp.status).toBe(200);
      expect(data.action).toBe("response for alice");
    });
  });

  describe("POST /observe", () => {
    it("stores observation and returns ok", async () => {
      sessionManager.getOrCreate({
        agentId: "alice",
        agentName: "Alice",
        worldId: "w1",
        workspaceId: "ws1",
      });

      const resp = await fetch(url("/observe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "alice",
          agent_name: "Alice",
          world_id: "w1",
          workspace_id: "ws1",
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
  });
});
