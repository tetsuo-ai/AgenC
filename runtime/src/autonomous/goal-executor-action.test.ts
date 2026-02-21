import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGoalExecutorAction } from "./goal-executor-action.js";
import { GoalManager, type ManagedGoal } from "./goal-manager.js";
import type { HeartbeatContext } from "../gateway/heartbeat.js";

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
  };
}

function makeMockDesktopExecutor(result = {
  goalId: "test-goal-id",
  success: true,
  status: "completed" as const,
  steps: [],
  summary: "Goal completed successfully",
  durationMs: 1500,
}) {
  return {
    get isRunning() { return false; },
    cancel: vi.fn(),
    executeGoal: vi.fn().mockResolvedValue(result),
  };
}

function makeContext(): HeartbeatContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sendToChannels: vi.fn(),
  } as unknown as HeartbeatContext;
}

// ============================================================================
// Tests
// ============================================================================

describe("createGoalExecutorAction", () => {
  let memory: ReturnType<typeof makeMockMemory>;
  let goalManager: GoalManager;

  beforeEach(() => {
    memory = makeMockMemory();
    goalManager = new GoalManager({ memory: memory as any });
  });

  // --------------------------------------------------------------------------
  // Basic properties
  // --------------------------------------------------------------------------

  it("creates action with correct name", () => {
    const action = createGoalExecutorAction({
      goalManager,
      desktopExecutor: makeMockDesktopExecutor() as any,
      memory: memory as any,
    });

    expect(action.name).toBe("desktop-goal-executor");
    expect(action.enabled).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  describe("execution", () => {
    it("dequeues and executes highest priority goal", async () => {
      await goalManager.addGoal({
        title: "Low priority",
        description: "Click on the low priority button",
        priority: "low",
        source: "meta-planner",
        maxAttempts: 2,
      });
      await goalManager.addGoal({
        title: "High priority",
        description: "Click on the critical error dialog",
        priority: "critical",
        source: "awareness",
        maxAttempts: 2,
      });

      const executor = makeMockDesktopExecutor();
      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: executor as any,
        memory: memory as any,
      });

      const result = await action.execute(makeContext());

      expect(executor.executeGoal).toHaveBeenCalledWith(
        "Click on the critical error dialog",
        "meta-planner",
      );
      expect(result.hasOutput).toBe(true);
      expect(result.output).toContain("completed");
    });

    it("marks goal completed on success", async () => {
      const goal = await goalManager.addGoal({
        title: "Click button",
        description: "Click the dismiss button",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 2,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: makeMockDesktopExecutor() as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      const active = await goalManager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await goalManager.getHistory();
      expect(history.find((g) => g.id === goal.id)?.status).toBe("completed");
    });

    it("marks goal failed on failure", async () => {
      const goal = await goalManager.addGoal({
        title: "Click button",
        description: "Click the dismiss button",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 1,
      });

      const failExecutor = makeMockDesktopExecutor({
        goalId: "x",
        success: false,
        status: "failed",
        steps: [],
        summary: "Could not find button",
        durationMs: 1000,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: failExecutor as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      const history = await goalManager.getHistory();
      expect(history.find((g) => g.id === goal.id)?.status).toBe("failed");
    });
  });

  // --------------------------------------------------------------------------
  // Skip conditions
  // --------------------------------------------------------------------------

  describe("skip conditions", () => {
    it("skips if executor is running", async () => {
      await goalManager.addGoal({
        title: "Click",
        description: "Click the button",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 2,
      });

      const busyExecutor = {
        get isRunning() { return true; },
        cancel: vi.fn(),
        executeGoal: vi.fn(),
      };

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: busyExecutor as any,
        memory: memory as any,
      });

      const result = await action.execute(makeContext());
      expect(result.hasOutput).toBe(false);
      expect(result.quiet).toBe(true);
      expect(busyExecutor.executeGoal).not.toHaveBeenCalled();
    });

    it("skips if no goals available", async () => {
      const executor = makeMockDesktopExecutor();
      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: executor as any,
        memory: memory as any,
      });

      const result = await action.execute(makeContext());
      expect(result.hasOutput).toBe(false);
      expect(executor.executeGoal).not.toHaveBeenCalled();
    });

    it("skips non-desktop goals when desktopOnly=true", async () => {
      await goalManager.addGoal({
        title: "Research Solana",
        description: "Study the latest Solana developments",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 2,
      });

      const executor = makeMockDesktopExecutor();
      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: executor as any,
        memory: memory as any,
        desktopOnly: true,
      });

      const result = await action.execute(makeContext());
      expect(result.hasOutput).toBe(false);
      expect(executor.executeGoal).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Retry
  // --------------------------------------------------------------------------

  describe("retry logic", () => {
    it("failed goal with remaining attempts stays in queue", async () => {
      const goal = await goalManager.addGoal({
        title: "Click retry",
        description: "Click the dismiss button on error",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 2,
      });

      const failExecutor = makeMockDesktopExecutor({
        goalId: "x",
        success: false,
        status: "failed",
        steps: [],
        summary: "Transient failure",
        durationMs: 100,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: failExecutor as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      // Goal should still be in active list (reset to pending for retry)
      const active = await goalManager.getActiveGoals();
      const retried = active.find((g) => g.id === goal.id);
      expect(retried?.status).toBe("pending");
      expect(retried?.attempts).toBe(1);
    });

    it("exhausted goal moves to history", async () => {
      const goal = await goalManager.addGoal({
        title: "Click final",
        description: "Click the close button",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 1,
      });

      const failExecutor = makeMockDesktopExecutor({
        goalId: "x",
        success: false,
        status: "failed",
        steps: [],
        summary: "Fatal failure",
        durationMs: 100,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: failExecutor as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      const active = await goalManager.getActiveGoals();
      expect(active.find((g) => g.id === goal.id)).toBeUndefined();

      const history = await goalManager.getHistory();
      expect(history.find((g) => g.id === goal.id)?.status).toBe("failed");
    });
  });

  // --------------------------------------------------------------------------
  // Feedback / self-learning
  // --------------------------------------------------------------------------

  describe("feedback", () => {
    it("stores result in memory for self-learning", async () => {
      await goalManager.addGoal({
        title: "Click test",
        description: "Click the download button",
        priority: "medium",
        source: "awareness",
        maxAttempts: 2,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: makeMockDesktopExecutor() as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      expect(memory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "goal-executor:results",
          role: "assistant",
          metadata: expect.objectContaining({
            type: "goal-execution-result",
            success: true,
            goalSource: "awareness",
          }),
        }),
      );
    });

    it("includes goal metadata in feedback entry", async () => {
      await goalManager.addGoal({
        title: "Priority test",
        description: "Navigate to the settings page",
        priority: "critical",
        source: "meta-planner",
        maxAttempts: 2,
      });

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: makeMockDesktopExecutor() as any,
        memory: memory as any,
      });

      await action.execute(makeContext());

      expect(memory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            goalTitle: "Priority test",
            goalPriority: "critical",
            goalSource: "meta-planner",
          }),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("marks goal failed on unexpected executor error", async () => {
      const goal = await goalManager.addGoal({
        title: "Error test",
        description: "Open the browser",
        priority: "medium",
        source: "meta-planner",
        maxAttempts: 1,
      });

      const throwingExecutor = {
        get isRunning() { return false; },
        cancel: vi.fn(),
        executeGoal: vi.fn().mockRejectedValue(new Error("Executor crashed")),
      };

      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: throwingExecutor as any,
        memory: memory as any,
      });

      const result = await action.execute(makeContext());
      expect(result.hasOutput).toBe(true);
      expect(result.output).toContain("Executor crashed");

      const history = await goalManager.getHistory();
      expect(history.find((g) => g.id === goal.id)?.status).toBe("failed");
    });
  });

  // --------------------------------------------------------------------------
  // Source mapping
  // --------------------------------------------------------------------------

  describe("source mapping", () => {
    it("maps user source to 'user' for DesktopExecutor", async () => {
      await goalManager.addGoal({
        title: "User goal",
        description: "Click the search button",
        priority: "medium",
        source: "user",
        maxAttempts: 2,
      });

      const executor = makeMockDesktopExecutor();
      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: executor as any,
        memory: memory as any,
      });

      await action.execute(makeContext());
      expect(executor.executeGoal).toHaveBeenCalledWith(
        expect.any(String),
        "user",
      );
    });

    it("maps awareness source to 'meta-planner' for DesktopExecutor", async () => {
      await goalManager.addGoal({
        title: "Awareness goal",
        description: "Dismiss the error dialog",
        priority: "high",
        source: "awareness",
        maxAttempts: 2,
      });

      const executor = makeMockDesktopExecutor();
      const action = createGoalExecutorAction({
        goalManager,
        desktopExecutor: executor as any,
        memory: memory as any,
      });

      await action.execute(makeContext());
      expect(executor.executeGoal).toHaveBeenCalledWith(
        expect.any(String),
        "meta-planner",
      );
    });
  });
});
