import { describe, it, expect, vi } from "vitest";
import {
  runPeriodicTasks,
  postSimulationCleanup,
  buildTrustMetadata,
  TRUST_SOURCE_GM,
  TRUST_SOURCE_AGENT,
  TRUST_SOURCE_USER,
  TRUST_SOURCE_EXTERNAL,
} from "../src/memory-lifecycle.js";
import type { MemoryWiringContext } from "../src/memory-wiring.js";
import { deriveSessionId } from "../src/session-manager.js";

function createMockContext(
  overrides?: Partial<MemoryWiringContext>,
): MemoryWiringContext {
  return {
    worldId: "test-world",
    workspaceId: "test-ws",
    memoryBackend: {
      addEntry: vi.fn().mockResolvedValue({ id: "e1", timestamp: Date.now() }),
      getThread: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
    },
    identityManager: {
      load: vi.fn().mockResolvedValue({
        agentId: "alice",
        name: "Alice",
        corePersonality: "Helpful",
        learnedTraits: ["kind"],
        beliefs: { coding: { belief: "Python is great", confidence: 0.8 } },
      }),
      upsert: vi.fn().mockResolvedValue({}),
      formatForPrompt: vi.fn().mockReturnValue(""),
    },
    socialMemory: {
      recordInteraction: vi.fn().mockResolvedValue({}),
      getRelationship: vi.fn().mockResolvedValue(null),
      listKnownAgents: vi.fn().mockResolvedValue([]),
      addWorldFact: vi.fn().mockResolvedValue({}),
      getWorldFacts: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe("runPeriodicTasks", () => {
  it("runs reflection at configured interval", async () => {
    const ctx = createMockContext();
    await runPeriodicTasks(ctx, 5, ["alice", "bob"], { reflectionInterval: 5 });
    // Should have stored reflection markers for both agents
    expect(ctx.memoryBackend.set).toHaveBeenCalledTimes(2);
  });

  it("skips reflection when not at interval", async () => {
    const ctx = createMockContext();
    await runPeriodicTasks(ctx, 3, ["alice"], { reflectionInterval: 5 });
    expect(ctx.memoryBackend.set).not.toHaveBeenCalled();
  });

  it("runs consolidation at configured interval", async () => {
    const ctx = createMockContext();
    await runPeriodicTasks(ctx, 20, ["alice"], {
      reflectionInterval: 100,
      consolidationInterval: 20,
      retentionInterval: 100,
    });
    expect(ctx.memoryBackend.set).toHaveBeenCalledWith(
      expect.stringContaining("consolidation"),
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("runs retention at configured interval", async () => {
    const ctx = createMockContext();
    await runPeriodicTasks(ctx, 20, ["alice"], {
      reflectionInterval: 100,
      consolidationInterval: 100,
      retentionInterval: 20,
    });
    expect(ctx.memoryBackend.set).toHaveBeenCalledWith(
      expect.stringContaining("retention"),
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("handles errors without throwing", async () => {
    const ctx = createMockContext();
    (ctx.identityManager.load as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("identity load failed"),
    );
    // Should not throw
    await runPeriodicTasks(ctx, 5, ["alice"], { reflectionInterval: 5 });
  });

  it("prefers runtime lifecycle hooks when available", async () => {
    const ctx = createMockContext({
      lifecycle: {
      reflectAgent: vi.fn().mockResolvedValue(true),
      consolidate: vi.fn().mockResolvedValue({
        processed: 5,
        consolidated: 2,
        skippedDuplicates: 0,
        durationMs: 10,
      }),
      retain: vi.fn().mockResolvedValue({
        expiredDeleted: 0,
        logsDeleted: 0,
      }),
      },
    });

    await runPeriodicTasks(ctx, 20, ["alice"], {
      reflectionInterval: 5,
      consolidationInterval: 20,
      retentionInterval: 20,
    });

    expect(ctx.lifecycle.reflectAgent).toHaveBeenCalledWith({
      agentId: "alice",
      sessionId: deriveSessionId("test-world", "alice"),
      workspaceId: "test-ws",
    });
    expect(ctx.lifecycle.consolidate).toHaveBeenCalledWith({
      workspaceId: "test-ws",
    });
    expect(ctx.lifecycle.retain).toHaveBeenCalled();
  });
});

describe("postSimulationCleanup", () => {
  it("runs consolidation, retention, and reflection", async () => {
    const ctx = createMockContext();
    const summary = await postSimulationCleanup(ctx, ["alice", "bob"]);
    expect(summary.worldId).toBe("test-world");
    expect(summary.agentCount).toBe(2);
    // Should have called set for consolidation + retention + 2 reflections
    expect(ctx.memoryBackend.set).toHaveBeenCalledTimes(4);
  });
});

describe("buildTrustMetadata", () => {
  it("builds correct metadata for system source", () => {
    const meta = buildTrustMetadata("system", 0.9);
    expect(meta.trustSource).toBe("system");
    expect(meta.confidence).toBe(0.9);
  });

  it("clamps confidence to [0, 1]", () => {
    expect(buildTrustMetadata("agent", 1.5).confidence).toBe(1);
    expect(buildTrustMetadata("agent", -0.5).confidence).toBe(0);
  });

  it("merges extra fields", () => {
    const meta = buildTrustMetadata("user", 0.8, { concordia_tag: "action" });
    expect(meta.concordia_tag).toBe("action");
  });
});

describe("trust source constants", () => {
  it("has correct values", () => {
    expect(TRUST_SOURCE_GM).toBe("system");
    expect(TRUST_SOURCE_AGENT).toBe("agent");
    expect(TRUST_SOURCE_USER).toBe("user");
    expect(TRUST_SOURCE_EXTERNAL).toBe("external");
  });
});
