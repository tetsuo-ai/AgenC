import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ingestObservation,
  setupAgentIdentity,
  recordSocialEvent,
  storePremise,
  getAgentState,
  type MemoryWiringContext,
  type MemoryBackendLike,
  type IdentityManagerLike,
  type SocialMemoryLike,
} from "../src/memory-wiring.js";

function createMockBackend(): MemoryBackendLike {
  return {
    addEntry: vi.fn().mockResolvedValue({ id: "entry-1", timestamp: Date.now() }),
    getThread: vi.fn().mockResolvedValue([
      { id: "e1", content: "[observation] You see a market", role: "system", timestamp: 1000 },
      { id: "e2", content: "I will go shopping", role: "assistant", timestamp: 2000 },
    ]),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockIdentityManager(): IdentityManagerLike {
  const identity = {
    agentId: "alice",
    name: "Alice",
    corePersonality: "Friendly blacksmith",
    learnedTraits: ["detail-oriented"],
    beliefs: { "iron_quality": { belief: "Local iron is best", confidence: 0.7 } },
  };
  return {
    load: vi.fn().mockResolvedValue(identity),
    upsert: vi.fn().mockResolvedValue(identity),
    formatForPrompt: vi.fn().mockReturnValue("# Alice\nFriendly blacksmith"),
  };
}

function createMockSocialMemory(): SocialMemoryLike {
  return {
    recordInteraction: vi.fn().mockResolvedValue({}),
    getRelationship: vi.fn().mockResolvedValue({
      interactions: [{ timestamp: 1000, summary: "Met at market" }],
      sentiment: 0.5,
    }),
    listKnownAgents: vi.fn().mockResolvedValue(["bob", "sera"]),
    addWorldFact: vi.fn().mockResolvedValue({}),
    getWorldFacts: vi.fn().mockResolvedValue([
      { content: "It is morning", observedBy: "gm", confirmations: 0 },
    ]),
  };
}

function createContext(overrides?: Partial<MemoryWiringContext>): MemoryWiringContext {
  return {
    worldId: "test-world",
    workspaceId: "test-ws",
    memoryBackend: createMockBackend(),
    identityManager: createMockIdentityManager(),
    socialMemory: createMockSocialMemory(),
    ...overrides,
  };
}

describe("ingestObservation", () => {
  it("stores observation in memory backend with correct fields", async () => {
    const ctx = createContext();
    await ingestObservation(ctx, "alice", "session-1", "You see Marcus approaching.");

    expect(ctx.memoryBackend.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        role: "system",
        content: "[observation] You see Marcus approaching.",
        workspaceId: "test-ws",
        agentId: "alice",
        worldId: "test-world",
        channel: "concordia",
        metadata: expect.objectContaining({
          type: "concordia_observation",
          trustSource: "system",
          confidence: 0.9,
        }),
      }),
    );
  });
});

describe("setupAgentIdentity", () => {
  it("creates agent identity with personality and goal", async () => {
    const ctx = createContext();
    await setupAgentIdentity(ctx, "elena", "Elena", "Town blacksmith", "Forge a sword");

    expect(ctx.identityManager.upsert).toHaveBeenCalledWith({
      agentId: "elena",
      name: "Elena",
      corePersonality: "Town blacksmith\n\nGoal: Forge a sword",
      workspaceId: "test-ws",
    });
  });

  it("omits goal suffix when goal is empty", async () => {
    const ctx = createContext();
    await setupAgentIdentity(ctx, "bob", "Bob", "Merchant", "");

    expect(ctx.identityManager.upsert).toHaveBeenCalledWith({
      agentId: "bob",
      name: "Bob",
      corePersonality: "Merchant",
      workspaceId: "test-ws",
    });
  });
});

describe("recordSocialEvent", () => {
  it("records interaction when event mentions known agents", async () => {
    const ctx = createContext();
    await recordSocialEvent(
      ctx,
      {
        type: "resolution",
        step: 5,
        acting_agent: "alice",
        content: "Alice trades iron with bob at the smithy",
        world_id: "test-world",
      },
      ["alice", "bob", "sera"],
    );

    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledWith(
      "alice",
      "bob",
      "test-world",
      expect.objectContaining({
        summary: expect.stringContaining("Alice trades iron"),
        context: "step:5",
      }),
    );
  });

  it("does not record when no acting agent", async () => {
    const ctx = createContext();
    await recordSocialEvent(
      ctx,
      { type: "resolution", step: 1, content: "The sun rises", world_id: "w" },
      ["alice", "bob"],
    );
    expect(ctx.socialMemory.recordInteraction).not.toHaveBeenCalled();
  });

  it("records multiple interactions when event mentions multiple agents", async () => {
    const ctx = createContext();
    await recordSocialEvent(
      ctx,
      {
        type: "resolution",
        step: 3,
        acting_agent: "alice",
        content: "Alice greets bob and sera at the market",
        world_id: "test-world",
      },
      ["alice", "bob", "sera"],
    );

    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledTimes(2);
  });
});

describe("storePremise", () => {
  it("stores premise as world fact", async () => {
    const ctx = createContext();
    await storePremise(ctx, "It is morning in Thornfield.");

    expect(ctx.socialMemory.addWorldFact).toHaveBeenCalledWith(
      "test-world",
      "It is morning in Thornfield.",
      "concordia:gm",
      "world",
    );
  });
});

describe("getAgentState", () => {
  it("returns complete agent state for viewer", async () => {
    const ctx = createContext();
    const state = await getAgentState(ctx, "alice", "session-1", 5, "goes to market");

    expect(state.identity).not.toBeNull();
    expect((state.identity as Record<string, unknown>).name).toBe("Alice");
    expect(state.memoryCount).toBe(2);
    expect(state.turnCount).toBe(5);
    expect(state.lastAction).toBe("goes to market");
    expect((state.relationships as unknown[]).length).toBe(2); // bob + sera
    expect((state.worldFacts as unknown[]).length).toBe(1);
  });

  it("handles missing identity gracefully", async () => {
    const ctx = createContext({
      identityManager: {
        ...createMockIdentityManager(),
        load: vi.fn().mockResolvedValue(null),
      },
    });
    const state = await getAgentState(ctx, "unknown", "s1", 0, null);
    expect(state.identity).toBeNull();
  });
});
