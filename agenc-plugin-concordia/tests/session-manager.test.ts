import { describe, it, expect } from "vitest";
import { SessionManager, deriveSessionId } from "../src/session-manager.js";

describe("deriveSessionId", () => {
  it("is deterministic — same inputs produce same output", () => {
    const id1 = deriveSessionId("world-1", "alice", "launch-1");
    const id2 = deriveSessionId("world-1", "alice", "launch-1");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different worlds", () => {
    const id1 = deriveSessionId("world-1", "alice", "launch-1");
    const id2 = deriveSessionId("world-2", "alice", "launch-1");
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different agents", () => {
    const id1 = deriveSessionId("world-1", "alice", "launch-1");
    const id2 = deriveSessionId("world-1", "bob", "launch-1");
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different launches", () => {
    const id1 = deriveSessionId("world-1", "alice", "launch-1");
    const id2 = deriveSessionId("world-1", "alice", "launch-2");
    expect(id1).not.toBe(id2);
  });

  it("starts with concordia: prefix", () => {
    const id = deriveSessionId("world-1", "alice", "launch-1");
    expect(id.startsWith("concordia:")).toBe(true);
  });

  it("is a valid SHA256 hex hash after prefix", () => {
    const id = deriveSessionId("world-1", "alice", "launch-1");
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
    });
    expect(session.agentId).toBe("alice");
    expect(session.agentName).toBe("Alice");
    expect(session.worldId).toBe("world-1");
    expect(session.sessionId.startsWith("concordia:")).toBe(true);
    expect(session.turnCount).toBe(0);
    expect(session.lastAction).toBeNull();
  });

  it("returns existing session on second call", () => {
    const mgr = new SessionManager();
    const s1 = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
    });
    const s2 = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
    });
    expect(s1).toBe(s2);
  });

  it("get returns undefined for unknown agent", () => {
    const mgr = new SessionManager();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("findBySessionId returns matching session", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "bob",
      agentName: "Bob",
      worldId: "w1",
      workspaceId: "ws1",
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
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws" });
    mgr.getOrCreate({ agentId: "b", agentName: "B", worldId: "w", workspaceId: "ws" });
    expect(mgr.listAgentIds()).toEqual(["a", "b"]);
  });

  it("clear removes all sessions", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate({ agentId: "a", agentName: "A", worldId: "w", workspaceId: "ws" });
    expect(mgr.size).toBe(1);
    mgr.clear();
    expect(mgr.size).toBe(0);
  });

  it("resetSimulation clears sessions and rotates the launch namespace", () => {
    const mgr = new SessionManager();
    const first = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
    });
    mgr.resetSimulation();
    const second = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
    });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(mgr.size).toBe(1);
  });

  it("tracks observations buffer", () => {
    const mgr = new SessionManager();
    const session = mgr.getOrCreate({
      agentId: "alice",
      agentName: "Alice",
      worldId: "w1",
      workspaceId: "ws1",
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
    });
    session.turnCount = 5;
    session.lastAction = "went to market";
    expect(session.turnCount).toBe(5);
    expect(session.lastAction).toBe("went to market");
  });
});
