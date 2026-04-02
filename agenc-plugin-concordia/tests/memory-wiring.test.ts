import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  ingestObservation,
  recordObservationWorldFact,
  recordAgentAction,
  setupAgentIdentity,
  recordSocialEvent,
  storePremise,
  getAgentState,
  recordProcedure,
  retrieveProcedures,
  updateActivationScores,
  updateTemporalEdges,
  buildGraphContext,
  getSharedContext,
  promoteToSharedMemory,
  checkCollectiveEmergence,
  promoteCollectiveEmergenceFacts,
  traceMemoryRetrieval,
  logSimulationEvent,
  buildFullActContext,
  type MemoryWiringContext,
  type MemoryBackendLike,
  type IdentityManagerLike,
  type SocialMemoryLike,
  type ProceduralMemoryLike,
  type MemoryGraphLike,
  type SharedMemoryLike,
  type TraceLoggerLike,
  type DailyLogManagerLike,
  type MemoryIngestionEngineLike,
  type MemoryRetrieverLike,
} from "../src/memory-wiring.js";

function createMockBackend(): MemoryBackendLike {
  return {
    addEntry: vi.fn().mockResolvedValue({ id: "entry-1", timestamp: Date.now() }),
    getThread: vi.fn().mockResolvedValue([
      {
        id: "e1",
        content: "[observation] You see a market",
        role: "system",
        timestamp: 1000,
        metadata: { world_id: "test-world", agent_id: "alice" },
      },
      {
        id: "e2",
        content: "I will go shopping",
        role: "assistant",
        timestamp: 2000,
        metadata: { world_id: "test-world", agent_id: "alice" },
      },
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
      relationship: "acquaintance",
      interactions: [{ timestamp: 1000, summary: "Met at market" }],
      sentiment: 0.5,
    }),
    listKnownAgents: vi.fn().mockResolvedValue(["bob", "sera"]),
    addWorldFact: vi.fn().mockResolvedValue({
      id: "fact-1",
      content: "It is morning",
      observedBy: "gm",
      confirmations: 1,
      confirmedBy: ["gm"],
    }),
    confirmWorldFact: vi.fn().mockResolvedValue({
      id: "fact-1",
      content: "It is morning",
      observedBy: "gm",
      confirmations: 2,
      confirmedBy: ["gm", "alice"],
    }),
    getWorldFacts: vi.fn().mockResolvedValue([
      { content: "It is morning", observedBy: "gm", confirmations: 0 },
    ]),
    checkCollectiveEmergence: vi.fn().mockResolvedValue([
      { content: "The market opens at dawn", confirmedBy: ["alice", "bob", "sera"] },
    ]),
  };
}

function createMockProceduralMemory(): ProceduralMemoryLike {
  return {
    record: vi.fn().mockResolvedValue({}),
    retrieve: vi.fn().mockResolvedValue([
      { name: "greet_and_trade", trigger: "negotiation", steps: ["greet", "offer"], confidence: 0.8 },
    ]),
    formatForPrompt: vi.fn().mockReturnValue("[Procedure: greet_and_trade]\n1. greet\n2. offer"),
  };
}

function createMockGraph(): MemoryGraphLike {
  return {
    upsertNode: vi.fn().mockResolvedValue({
      id: "event-node-1",
      content: "Resolved event node",
      entityName: "Marcus",
      entityType: "simulation_event",
    }),
    findByEntity: vi.fn().mockResolvedValue([
      { id: "n1", content: "Marcus is a merchant", entityName: "Marcus", entityType: "person" },
    ]),
    getRelatedEntities: vi.fn().mockResolvedValue([
      { id: "n2", content: "trades iron", entityName: "iron" },
      { id: "n3", content: "from rival town", entityName: "rival town" },
    ]),
    updateEdge: vi.fn().mockResolvedValue(undefined),
    addEdge: vi.fn().mockResolvedValue({}),
  };
}

function createMockSharedMemory(): SharedMemoryLike {
  return {
    writeFact: vi.fn().mockResolvedValue({}),
    getFacts: vi.fn().mockResolvedValue([
      { content: "User prefers detailed simulations", author: "concordia:prev-sim" },
    ]),
  };
}

function createMockTraceLogger(): TraceLoggerLike {
  return {
    traceRetrieval: vi.fn(),
    traceTrustFilter: vi.fn(),
    traceIngestion: vi.fn(),
  };
}

function createMockDailyLogManager(): DailyLogManagerLike {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockIngestionEngine(): MemoryIngestionEngineLike {
  return {
    ingestTurn: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRetriever(): MemoryRetrieverLike {
  return {
    retrieve: vi.fn().mockResolvedValue("<memory>Relevant fact</memory>"),
    retrieveDetailed: vi.fn().mockResolvedValue({
      content: "<memory>Relevant fact</memory>",
      estimatedTokens: 24,
      entries: [
        {
          entry: { id: "entry-7", role: "assistant" },
          role: "semantic",
        },
      ],
    }),
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

  it("indexes observations through the semantic ingestion engine when available", async () => {
    const ingestionEngine = createMockIngestionEngine();
    const ctx = createContext({ ingestionEngine });

    await ingestObservation(ctx, "alice", "session-1", "You see Marcus approaching.");

    expect(ingestionEngine.ingestTurn).toHaveBeenCalledWith(
      "session-1",
      "You see Marcus approaching.",
      "[Observation recorded for future simulation turns.]",
      expect.objectContaining({
        workspaceId: "test-ws",
        agentId: "alice",
        worldId: "test-world",
      }),
    );
  });
});

describe("recordObservationWorldFact", () => {
  it("stores a private world fact for a first observation", async () => {
    const ctx = createContext();

    await recordObservationWorldFact(
      ctx,
      "alice",
      "//09:15 AM//A red sell order flashes across the board.",
    );

    expect(ctx.socialMemory.addWorldFact).toHaveBeenCalledWith(
      "test-world",
      "A red sell order flashes across the board.",
      "alice",
      "private",
    );
    expect(ctx.memoryBackend.set).toHaveBeenCalled();
  });

  it("confirms an existing fact when another agent independently observes it", async () => {
    const backend = createMockBackend();
    const factFingerprint = createHash("sha256")
      .update("a red sell order flashes across the board")
      .digest("hex");
    (backend.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [factFingerprint]: {
        factId: "fact-1",
        canonicalContent: "A red sell order flashes across the board.",
        confirmedBy: ["alice"],
      },
    });
    const ctx = createContext({ memoryBackend: backend });

    await recordObservationWorldFact(
      ctx,
      "bob",
      "//09:30 AM//A red sell order flashes across the board.",
    );

    expect(ctx.socialMemory.confirmWorldFact).toHaveBeenCalledWith(
      "fact-1",
      "test-world",
      "bob",
    );
  });
});

describe("recordAgentAction", () => {
  it("stores agent actions in world-scoped memory with action metadata", async () => {
    const ctx = createContext();

    await recordAgentAction(ctx, "alice", "session-1", "places a bid for 10 contracts");

    expect(ctx.memoryBackend.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        role: "assistant",
        content: "places a bid for 10 contracts",
        workspaceId: "test-ws",
        agentId: "alice",
        worldId: "test-world",
        channel: "concordia",
        metadata: expect.objectContaining({
          type: "concordia_action",
          concordia_tag: "action",
          trustSource: "agent",
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
        content: "Alice trades iron with Bob at the smithy",
        world_id: "test-world",
      },
      [
        { agentId: "alice", agentName: "Alice" },
        { agentId: "bob", agentName: "Bob" },
        { agentId: "sera", agentName: "Sera" },
      ],
    );

    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledWith(
      "alice",
      "bob",
      "test-world",
      expect.objectContaining({
        summary: expect.stringContaining("Alice trades iron"),
        context: "step:5:resolution",
      }),
    );
    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledWith(
      "bob",
      "alice",
      "test-world",
      expect.objectContaining({
        summary: expect.stringContaining("Alice trades iron"),
        context: "step:5:resolution",
      }),
    );
  });

  it("does not record when no acting agent", async () => {
    const ctx = createContext();
    await recordSocialEvent(
      ctx,
      { type: "resolution", step: 1, content: "The sun rises", world_id: "w" },
      [
        { agentId: "alice", agentName: "Alice" },
        { agentId: "bob", agentName: "Bob" },
      ],
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
        content: "Alice greets Bob and Sera at the market",
        world_id: "test-world",
      },
      [
        { agentId: "alice", agentName: "Alice" },
        { agentId: "bob", agentName: "Bob" },
        { agentId: "sera", agentName: "Sera" },
      ],
    );

    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledTimes(4);
  });

  it("records pairwise interactions for simultaneous events without a single actor", async () => {
    const ctx = createContext();
    await recordSocialEvent(
      ctx,
      {
        type: "resolution",
        step: 4,
        content: "Alice and Bob shout over Sera as the market turns chaotic.",
        world_id: "test-world",
      },
      [
        { agentId: "alice", agentName: "Alice" },
        { agentId: "bob", agentName: "Bob" },
        { agentId: "sera", agentName: "Sera" },
      ],
    );

    expect(ctx.socialMemory.recordInteraction).toHaveBeenCalledTimes(6);
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
    expect((state.relationships as Array<Record<string, unknown>>)[0]?.relationship).toBe("acquaintance");
    expect((state.recentMemories as Array<Record<string, unknown>>)[0]?.metadata).toBeDefined();
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

// === Task 5.4: Procedural memory ===

describe("recordProcedure", () => {
  it("records a procedure when proceduralMemory is available", async () => {
    const proc = createMockProceduralMemory();
    const ctx = createContext({ proceduralMemory: proc });
    await recordProcedure(ctx, "alice", "negotiation with merchant", ["greet", "offer", "close"]);
    expect(proc.record).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "negotiation with merchant",
      steps: ["greet", "offer", "close"],
      workspaceId: "test-ws",
    }));
  });

  it("is a no-op when proceduralMemory is absent", async () => {
    const ctx = createContext();
    await recordProcedure(ctx, "alice", "test", ["step1"]); // Should not throw
  });
});

describe("retrieveProcedures", () => {
  it("returns formatted procedures", async () => {
    const ctx = createContext({ proceduralMemory: createMockProceduralMemory() });
    const result = await retrieveProcedures(ctx, "negotiation");
    expect(result).toContain("greet_and_trade");
  });

  it("returns empty when no procedural memory", async () => {
    const ctx = createContext();
    const result = await retrieveProcedures(ctx, "test");
    expect(result).toBe("");
  });
});

describe("buildFullActContext", () => {
  it("includes semantic retrieval context and updates activation scores", async () => {
    const retriever = createMockRetriever();
    const traceLogger = createMockTraceLogger();
    const ctx = createContext({
      proceduralMemory: createMockProceduralMemory(),
      retriever,
      traceLogger,
      memoryBackend: {
        ...createMockBackend(),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await buildFullActContext(
      ctx,
      "alice",
      "session-1",
      "Negotiate with Marcus about iron prices",
    );

    expect(result).toContain("Relevant fact");
    expect(ctx.memoryBackend.set).toHaveBeenCalledWith(
      "test-ws:activation:entry-7",
      expect.objectContaining({ accessCount: 1 }),
    );
    expect(traceLogger.traceRetrieval).toHaveBeenCalled();
  });
});

// === Task 10.2: Activation scoring ===

describe("updateActivationScores", () => {
  it("stores activation counts in KV", async () => {
    const ctx = createContext();
    await updateActivationScores(ctx, "s1", ["entry-1", "entry-2"]);
    expect(ctx.memoryBackend.set).toHaveBeenCalledTimes(2);
    expect(ctx.memoryBackend.set).toHaveBeenCalledWith(
      "test-ws:activation:entry-1",
      expect.objectContaining({ accessCount: 1 }),
    );
  });

  it("increments existing counts", async () => {
    const backend = createMockBackend();
    (backend.get as ReturnType<typeof vi.fn>).mockResolvedValue({ accessCount: 5, lastAccessTime: 1000 });
    const ctx = createContext({ memoryBackend: backend });
    await updateActivationScores(ctx, "s1", ["entry-1"]);
    expect(backend.set).toHaveBeenCalledWith(
      "test-ws:activation:entry-1",
      expect.objectContaining({ accessCount: 6 }),
    );
  });
});

// === Task 10.4: BFS graph traversal ===

describe("buildGraphContext", () => {
  it("returns graph context for entity mentions", async () => {
    const ctx = createContext({ graph: createMockGraph() });
    const result = await buildGraphContext(ctx, "What does Marcus think?", "alice");
    expect(result).toContain("Knowledge about Marcus");
    expect(result).toContain("trades iron");
  });

  it("returns empty when no graph", async () => {
    const ctx = createContext();
    const result = await buildGraphContext(ctx, "test", "alice");
    expect(result).toBe("");
  });
});

describe("updateTemporalEdges", () => {
  it("creates graph updates for simultaneous events without a single acting agent", async () => {
    const graph = createMockGraph();
    const ctx = createContext({ graph });

    await updateTemporalEdges(
      ctx,
      undefined,
      "Alice and Bob discover the assay report was false and gold reserves are lower than claimed.",
    );

    expect(graph.upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "simulation_event",
        content: "Alice and Bob discover the assay report was false and gold reserves are lower than claimed.",
      }),
    );
    expect(graph.addEdge).toHaveBeenCalled();
  });
});

// === Task 10.5: Shared memory ===

describe("getSharedContext", () => {
  it("returns shared facts", async () => {
    const ctx = createContext({ sharedMemory: createMockSharedMemory() });
    const result = await getSharedContext(ctx, "user-1");
    expect(result).toContain("Shared Knowledge");
    expect(result).toContain("detailed simulations");
  });

  it("returns empty when no shared memory or user scope is unavailable", async () => {
    const ctx = createContext({ sharedMemory: createMockSharedMemory() });
    const result = await getSharedContext(ctx);
    expect(result).toBe("");
  });
});

describe("promoteToSharedMemory", () => {
  it("writes fact to shared memory", async () => {
    const shared = createMockSharedMemory();
    const ctx = createContext({ sharedMemory: shared });
    await promoteToSharedMemory(ctx, "User enjoys medieval sims", "user-1");
    expect(shared.writeFact).toHaveBeenCalledWith(expect.objectContaining({
      scope: "user",
      content: "User enjoys medieval sims",
      userId: "user-1",
    }));
  });
});

// === Task 10.6: Collective emergence ===

describe("checkCollectiveEmergence", () => {
  it("returns promoted facts", async () => {
    const ctx = createContext();
    const result = await checkCollectiveEmergence(ctx, 3);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("The market opens at dawn");
    expect(result[0].confirmedBy).toContain("alice");
  });
});

describe("promoteCollectiveEmergenceFacts", () => {
  it("promotes newly emerged facts into world-visible social memory", async () => {
    const backend = createMockBackend();
    (backend.get as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ctx = createContext({ memoryBackend: backend });

    const promoted = await promoteCollectiveEmergenceFacts(ctx, 5, 3);

    expect(promoted).toHaveLength(1);
    expect(ctx.socialMemory.addWorldFact).toHaveBeenCalledWith(
      "test-world",
      "The market opens at dawn",
      "concordia:collective-emergence",
      "world",
    );
  });
});

// === Task 10.13: Trace logging ===

describe("traceMemoryRetrieval", () => {
  it("calls trace logger when available", () => {
    const logger = createMockTraceLogger();
    const ctx = createContext({ traceLogger: logger });
    traceMemoryRetrieval(ctx, {
      sessionId: "s1",
      query: "test",
      candidateCount: 10,
      selectedCount: 3,
      estimatedTokens: 200,
      roles: { semantic: 3 },
      durationMs: 50,
    });
    expect(logger.traceRetrieval).toHaveBeenCalledOnce();
  });

  it("is a no-op when no trace logger", () => {
    const ctx = createContext();
    // Should not throw
    traceMemoryRetrieval(ctx, {
      sessionId: "s1",
      query: "test",
      candidateCount: 0,
      selectedCount: 0,
      estimatedTokens: 0,
      roles: {},
      durationMs: 0,
    });
  });
});

// === Task 10.14: Daily log manager ===

describe("logSimulationEvent", () => {
  it("appends to daily log when available", async () => {
    const logMgr = createMockDailyLogManager();
    const ctx = createContext({ dailyLogManager: logMgr });
    await logSimulationEvent(ctx, "s1", {
      step: 5,
      actingAgent: "alice",
      content: "Alice trades iron",
      type: "resolution",
    });
    expect(logMgr.append).toHaveBeenCalledWith("s1", expect.objectContaining({
      step: 5,
      actingAgent: "alice",
      content: "Alice trades iron",
    }));
  });

  it("is a no-op when no daily log manager", async () => {
    const ctx = createContext();
    await logSimulationEvent(ctx, "s1", { step: 1, content: "test", type: "step" });
  });
});

// === Task 5.5: Full act context builder ===

describe("buildFullActContext", () => {
  it("combines identity + procedural + graph + shared memory", async () => {
    const ctx = createContext({
      proceduralMemory: createMockProceduralMemory(),
      graph: createMockGraph(),
      sharedMemory: createMockSharedMemory(),
    });
    const result = await buildFullActContext(ctx, "alice", "s1", "What does Marcus think?", "user-1");
    expect(result).toContain("Alice"); // identity
    expect(result).toContain("Current Relationships");
    expect(result).toContain("Visible World Facts");
    expect(result).toContain("greet_and_trade"); // procedural
    expect(result).toContain("Knowledge about Marcus"); // graph
    expect(result).toContain("Shared Knowledge"); // shared
  });

  it("works with minimal context (no optional providers)", async () => {
    const ctx = createContext();
    const result = await buildFullActContext(ctx, "alice", "s1", "test");
    expect(result).toContain("Alice"); // identity always included
    expect(result).toContain("Visible World Facts");
  });
});
