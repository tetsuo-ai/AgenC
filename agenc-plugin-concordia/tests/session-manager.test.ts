import { describe, it, expect } from "vitest";
import { SessionManager, deriveSessionId } from "../src/session-manager.js";

describe("deriveSessionId", () => {
  it("is deterministic — same inputs produce same output", () => {
    const id1 = deriveSessionId("sim-1", "alice");
    const id2 = deriveSessionId("sim-1", "alice");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different simulations", () => {
    const id1 = deriveSessionId("sim-1", "alice");
    const id2 = deriveSessionId("sim-2", "alice");
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different agents", () => {
    const id1 = deriveSessionId("sim-1", "alice");
    const id2 = deriveSessionId("sim-1", "bob");
    expect(id1).not.toBe(id2);
  });

  it("starts with concordia: prefix", () => {
    const id = deriveSessionId("sim-1", "alice");
    expect(id.startsWith("concordia:")).toBe(true);
  });

  it("is a valid SHA256 hex hash after prefix", () => {
    const id = deriveSessionId("sim-1", "alice");
    const hash = id.slice("concordia:".length);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("SessionManager", () => {
  it("creates a new session on first call", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "world-1",
      workspaceId: "ws-1",
      simulationId: "sim-1",
      lineageId: "lineage-1",
      parentSimulationId: null,
    });
    expect(session.agentId).toBe("alice");
    expect(session.agentName).toBe("Alice");
    expect(session.worldId).toBe("world-1");
    expect(session.simulationId).toBe("sim-1");
    expect(session.lineageId).toBe("lineage-1");
    expect(session.sessionId.startsWith("concordia:")).toBe(true);
    expect(session.turnCount).toBe(0);
    expect(session.lastAction).toBeNull();
  });

  it("returns existing session on second call for the same workspace/simulation/agent", () => {
    const mgr = new SessionManager();
    const s1 = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    const s2 = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    expect(s1).toBe(s2);
  });

  it("creates separate sessions for the same agent across concurrent runs of the same world", () => {
    const mgr = new SessionManager();
    const firstRun = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    const secondRun = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-2",
    });
    expect(firstRun).not.toBe(secondRun);
    expect(firstRun.sessionId).not.toBe(secondRun.sessionId);
  });

  it("findForSimulation returns the matching session", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });

    expect(
      mgr.findForSimulation({
        agentId: "alice",
        simulationId: "sim-1",
        workspaceId: "ws1",
      }),
    ).toBe(session);
  });

  it("findForSimulation returns undefined when the lookup is ambiguous", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w2",
      workspaceId: "ws2",
      simulationId: "sim-2",
    });

    expect(mgr.findForSimulation({ agentId: "alice" })).toBeUndefined();
  });

  it("findBySessionId returns matching session", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "bob",
      agentName: "Bob",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    const found = mgr.findBySessionId(session.sessionId);
    expect(found).toBe(session);
  });

  it("findBySessionId returns undefined for unknown", () => {
    const mgr = new SessionManager();
    expect(mgr.findBySessionId("nonexistent")).toBeUndefined();
  });

  it("listAgentIds returns all agent IDs", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws", simulationId: "sim-1" });
    mgr.getOrCreate({ agentId: "b", agentName: "B", worldId: "w", workspaceId: "ws", simulationId: "sim-2" });
    expect(mgr.listAgentIds()).toEqual(["a", "b"]);
  });

  it("getForWorld can disambiguate by simulationId", () => {
    const mgr = new SessionManager();
    const simOne = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-2",
    });

    const found = mgr.getForWorld({
      agentId: "alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });

    expect(found).toBe(simOne);
  });

  it("getAllForWorld can be filtered to a single simulation", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws", simulationId: "sim-1" });
    mgr.getOrCreate({ agentId: "b", agentName: "B", worldId: "w", workspaceId: "ws", simulationId: "sim-2" });

    const sessions = mgr.getAllForWorld("w", "ws", "sim-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].simulationId).toBe("sim-1");
  });


  it("getAllForSimulation returns only sessions for the requested run", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws", simulationId: "sim-1" });
    mgr.getOrCreate({ agentId: "b", agentName: "B", worldId: "w", workspaceId: "ws", simulationId: "sim-2" });

    const sessions = mgr.getAllForSimulation("sim-2", "ws");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe("b");
  });

  it("clearSimulation removes only the targeted run", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws", simulationId: "sim-1" });
    mgr.getOrCreate({ agentId: "b", agentName: "B", worldId: "w", workspaceId: "ws", simulationId: "sim-2" });

    mgr.clearSimulation("sim-1", "ws");

    expect(mgr.getAllForSimulation("sim-1", "ws")).toHaveLength(0);
    expect(mgr.getAllForSimulation("sim-2", "ws")).toHaveLength(1);
  });

  it("clear removes all sessions", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws", simulationId: "sim-1" });
    expect(mgr.size).toBe(1);
    mgr.clear();
    expect(mgr.size).toBe(0);
  });

  it("resetSimulation clears sessions without changing deterministic derivation", () => {
    const mgr = new SessionManager();
    const first = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    mgr.resetSimulation();
    const second = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    expect(first.sessionId).toBe(second.sessionId);
    expect(mgr.size).toBe(1);
  });

  it("tracks observations buffer", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    session.observations.push("obs1");
    session.observations.push("obs2");
    expect(session.observations).toEqual(["obs1", "obs2"]);
  });

  it("tracks turn count and last action", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
      simulationId: "sim-1",
    });
    session.turnCount = 5;
    session.lastAction = "went to market";
    expect(session.turnCount).toBe(5);
    expect(session.lastAction).toBe("went to market");
  });
});
