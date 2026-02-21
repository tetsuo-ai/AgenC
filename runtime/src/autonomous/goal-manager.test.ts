import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalManager, type ManagedGoal } from "./goal-manager.js";

// ============================================================================
// Mock memory backend
// ============================================================================

function makeMockMemory() {
  const store = new Map<string, unknown>();
  return {
    name: "mock-memory",
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return store.get(key) as T | undefined;
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    has: vi.fn(async (key: string) => store.has(key)),
    listKeys: vi.fn(async () => [...store.keys()]),
    addEntry: vi.fn().mockResolvedValue(undefined),
    getThread: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    deleteThread: vi.fn().mockResolvedValue(0),
    listSessions: vi.fn().mockResolvedValue([]),
    getDurability: vi.fn().mockReturnValue({ durable: false }),
    flush: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(async () => store.clear()),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    _store: store,
  };
}

function makeGoal(overrides: Partial<Omit<ManagedGoal, "id" | "createdAt" | "updatedAt" | "attempts" | "status">> = {}) {
  return {
    title: overrides.title ?? "Test goal",
    description: overrides.description ?? "Test goal description",
    priority: overrides.priority ?? ("medium" as const),
    source: overrides.source ?? ("meta-planner" as const),
    maxAttempts: overrides.maxAttempts ?? 2,
    rationale: overrides.rationale,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("GoalManager", () => {
  let memory: ReturnType<typeof makeMockMemory>;
  let manager: GoalManager;

  beforeEach(() => {
    memory = makeMockMemory();
    manager = new GoalManager({ memory: memory as any });
  });

  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  describe("construction", () => {
    it("applies default config values", () => {
      const m = new GoalManager({ memory: memory as any });
      expect(m).toBeDefined();
    });

    it("accepts custom config", () => {
      const m = new GoalManager({
        memory: memory as any,
        maxActiveGoals: 5,
        maxHistoryGoals: 20,
        deduplicationWindowMs: 60_000,
      });
      expect(m).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // addGoal
  // --------------------------------------------------------------------------

  describe("addGoal", () => {
    it("creates goal with correct fields", async () => {
      const goal = await manager.addGoal(makeGoal({ title: "My goal" }));

      expect(goal.id).toBeTruthy();
      expect(goal.title).toBe("My goal");
      expect(goal.status).toBe("pending");
      expect(goal.attempts).toBe(0);
      expect(goal.createdAt).toBeGreaterThan(0);
      expect(goal.updatedAt).toBe(goal.createdAt);
    });

    it("generates unique IDs", async () => {
      const g1 = await manager.addGoal(makeGoal());
      const g2 = await manager.addGoal(makeGoal());
      expect(g1.id).not.toBe(g2.id);
    });

    it("respects maxActiveGoals by dropping lowest priority", async () => {
      const m = new GoalManager({
        memory: memory as any,
        maxActiveGoals: 2,
      });

      await m.addGoal(makeGoal({ title: "Low", priority: "low" }));
      await m.addGoal(makeGoal({ title: "High", priority: "high" }));
      // This should drop the "low" priority goal to make room
      await m.addGoal(makeGoal({ title: "Critical", priority: "critical" }));

      const active = await m.getActiveGoals();
      expect(active.length).toBe(2);
      const titles = active.map((g) => g.title);
      expect(titles).toContain("High");
      expect(titles).toContain("Critical");
    });
  });

  // --------------------------------------------------------------------------
  // getNextGoal
  // --------------------------------------------------------------------------

  describe("getNextGoal", () => {
    it("returns highest priority goal", async () => {
      await manager.addGoal(makeGoal({ title: "Low", priority: "low" }));
      await manager.addGoal(makeGoal({ title: "Critical", priority: "critical" }));
      await manager.addGoal(makeGoal({ title: "High", priority: "high" }));

      const next = await manager.getNextGoal();
      expect(next?.title).toBe("Critical");
    });

    it("returns FIFO within same priority", async () => {
      const g1 = await manager.addGoal(
        makeGoal({ title: "First", priority: "high" }),
      );
      await manager.addGoal(
        makeGoal({ title: "Second", priority: "high" }),
      );

      const next = await manager.getNextGoal();
      expect(next?.id).toBe(g1.id);
    });

    it("skips executing goals", async () => {
      const g1 = await manager.addGoal(
        makeGoal({ title: "Executing", priority: "critical" }),
      );
      await manager.markExecuting(g1.id);
      await manager.addGoal(
        makeGoal({ title: "Pending", priority: "low" }),
      );

      const next = await manager.getNextGoal();
      expect(next?.title).toBe("Pending");
    });

    it("returns undefined when no pending goals", async () => {
      const next = await manager.getNextGoal();
      expect(next).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // markExecuting / markCompleted / markFailed
  // --------------------------------------------------------------------------

  describe("status transitions", () => {
    it("markExecuting sets status and increments attempts", async () => {
      const goal = await manager.addGoal(makeGoal());
      await manager.markExecuting(goal.id);

      const active = await manager.getActiveGoals();
      const updated = active.find((g) => g.id === goal.id)!;
      expect(updated.status).toBe("executing");
      expect(updated.attempts).toBe(1);
    });

    it("markCompleted moves goal to history", async () => {
      const goal = await manager.addGoal(makeGoal());
      await manager.markExecuting(goal.id);
      await manager.markCompleted(goal.id, {
        success: true,
        summary: "Done",
        durationMs: 1000,
      });

      const active = await manager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await manager.getHistory();
      const completed = history.find((g) => g.id === goal.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.result?.success).toBe(true);
    });

    it("markFailed moves exhausted goal to history", async () => {
      const goal = await manager.addGoal(makeGoal({ maxAttempts: 1 }));
      await manager.markExecuting(goal.id);
      await manager.markFailed(goal.id, {
        success: false,
        summary: "Error",
        durationMs: 500,
      });

      const active = await manager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await manager.getHistory();
      const failed = history.find((g) => g.id === goal.id);
      expect(failed?.status).toBe("failed");
    });

    it("ignores markExecuting for non-existent goal", async () => {
      await expect(manager.markExecuting("nonexistent")).resolves.not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Retry
  // --------------------------------------------------------------------------

  describe("retry logic", () => {
    it("resets failed goal to pending when attempts < maxAttempts", async () => {
      const goal = await manager.addGoal(makeGoal({ maxAttempts: 2 }));
      await manager.markExecuting(goal.id);
      await manager.markFailed(goal.id, {
        success: false,
        summary: "Transient error",
        durationMs: 100,
      });

      const active = await manager.getActiveGoals();
      const retried = active.find((g) => g.id === goal.id);
      expect(retried?.status).toBe("pending");
      expect(retried?.attempts).toBe(1);
    });

    it("exhausted attempts stays failed in history", async () => {
      const goal = await manager.addGoal(makeGoal({ maxAttempts: 1 }));
      await manager.markExecuting(goal.id); // attempts = 1, maxAttempts = 1
      await manager.markFailed(goal.id, {
        success: false,
        summary: "Fatal error",
        durationMs: 200,
      });

      const active = await manager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await manager.getHistory();
      expect(history.find((g) => g.id === goal.id)?.status).toBe("failed");
    });
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  describe("deduplication", () => {
    it("detects exact match as duplicate", () => {
      const existing: ManagedGoal[] = [
        {
          id: "1",
          title: "Test",
          description: "Open the browser and search for results",
          priority: "medium",
          status: "pending",
          source: "meta-planner",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          maxAttempts: 2,
        },
      ];

      expect(
        manager.isDuplicate("Open the browser and search for results", existing),
      ).toBe(true);
    });

    it("detects fuzzy match as duplicate (>80% overlap)", () => {
      const existing: ManagedGoal[] = [
        {
          id: "1",
          title: "Test",
          description: "Open the browser and search for important results",
          priority: "medium",
          status: "pending",
          source: "meta-planner",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          maxAttempts: 2,
        },
      ];

      // Very similar
      expect(
        manager.isDuplicate("Open the browser and search for results", existing),
      ).toBe(true);
    });

    it("allows different enough descriptions", () => {
      const existing: ManagedGoal[] = [
        {
          id: "1",
          title: "Test",
          description: "Open the browser and search for results",
          priority: "medium",
          status: "pending",
          source: "meta-planner",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          maxAttempts: 2,
        },
      ];

      expect(
        manager.isDuplicate("Dismiss the error dialog and restart the app", existing),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // History
  // --------------------------------------------------------------------------

  describe("history", () => {
    it("caps history at maxHistoryGoals", async () => {
      const m = new GoalManager({
        memory: memory as any,
        maxHistoryGoals: 2,
      });

      for (let i = 0; i < 3; i++) {
        const g = await m.addGoal(makeGoal({ title: `Goal ${i}` }));
        await m.cancelGoal(g.id);
      }

      const history = await m.getHistory();
      expect(history.length).toBe(2);
    });

    it("orders by updatedAt desc", async () => {
      const g1 = await manager.addGoal(makeGoal({ title: "First" }));
      const g2 = await manager.addGoal(makeGoal({ title: "Second" }));

      await manager.cancelGoal(g1.id);
      // Small delay to ensure different updatedAt
      await new Promise((r) => setTimeout(r, 5));
      await manager.cancelGoal(g2.id);

      const history = await manager.getHistory();
      expect(history[0]!.title).toBe("Second");
      expect(history[1]!.title).toBe("First");
    });
  });

  // --------------------------------------------------------------------------
  // cancelGoal
  // --------------------------------------------------------------------------

  describe("cancelGoal", () => {
    it("moves goal to history with cancelled status", async () => {
      const goal = await manager.addGoal(makeGoal());
      await manager.cancelGoal(goal.id);

      const active = await manager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await manager.getHistory();
      const cancelled = history.find((g) => g.id === goal.id);
      expect(cancelled?.status).toBe("cancelled");
    });
  });
});
