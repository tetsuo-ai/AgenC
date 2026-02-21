import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAwarenessGoalBridge,
  DEFAULT_AWARENESS_PATTERNS,
} from "./awareness-goal-bridge.js";
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
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("createAwarenessGoalBridge", () => {
  let memory: ReturnType<typeof makeMockMemory>;
  let goalManager: GoalManager;
  let bridge: (text: string) => Promise<ManagedGoal | null>;

  beforeEach(() => {
    memory = makeMockMemory();
    goalManager = new GoalManager({ memory: memory as any });
    bridge = createAwarenessGoalBridge({ goalManager });
  });

  // --------------------------------------------------------------------------
  // Pattern matching
  // --------------------------------------------------------------------------

  describe("pattern matching", () => {
    it("creates goal for error dialog", async () => {
      const goal = await bridge("Desktop alert: error dialog detected on screen");
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe("Dismiss error dialog");
      expect(goal!.priority).toBe("high");
      expect(goal!.source).toBe("awareness");
    });

    it("creates goal for ANR / not responding", async () => {
      const goal = await bridge("Desktop alert: application not responding");
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe("Handle unresponsive application");
      expect(goal!.priority).toBe("critical");
    });

    it("creates goal for crash report", async () => {
      const goal = await bridge("Desktop alert: crash report for Safari");
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe("Handle application crash");
      expect(goal!.priority).toBe("high");
    });

    it("creates goal for update notification", async () => {
      const goal = await bridge("Desktop alert: software update available");
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe("Acknowledge update notification");
      expect(goal!.priority).toBe("low");
    });
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  describe("deduplication", () => {
    it("skips duplicate goal", async () => {
      const goal1 = await bridge("Desktop alert: error dialog appeared");
      expect(goal1).not.toBeNull();

      const goal2 = await bridge("Desktop alert: error dialog shown");
      // Same pattern and very similar description from the same template
      expect(goal2).toBeNull();
    });

    it("allows different enough patterns", async () => {
      const goal1 = await bridge("Desktop alert: error dialog on screen");
      expect(goal1).not.toBeNull();

      const goal2 = await bridge("Desktop alert: application not responding");
      expect(goal2).not.toBeNull();
      expect(goal2!.title).toBe("Handle unresponsive application");
    });
  });

  // --------------------------------------------------------------------------
  // No match
  // --------------------------------------------------------------------------

  describe("no match", () => {
    it("returns null for normal activity", async () => {
      const result = await bridge("Normal desktop activity. Everything looks fine.");
      expect(result).toBeNull();
    });

    it("returns null for unknown pattern", async () => {
      const result = await bridge("The cat sat on the mat");
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Custom patterns
  // --------------------------------------------------------------------------

  describe("custom patterns", () => {
    it("uses custom patterns when provided", async () => {
      const customBridge = createAwarenessGoalBridge({
        goalManager,
        patterns: [
          {
            pattern: /battery\s+low/i,
            titleTemplate: "Battery warning",
            descriptionTemplate: "Plug in the charger — battery is low",
            priority: "medium",
          },
        ],
      });

      const goal = await customBridge("Desktop alert: battery low warning");
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe("Battery warning");
    });

    it("custom patterns override defaults", async () => {
      const customBridge = createAwarenessGoalBridge({
        goalManager,
        patterns: [
          {
            pattern: /battery\s+low/i,
            titleTemplate: "Battery warning",
            descriptionTemplate: "Plug in the charger",
            priority: "medium",
          },
        ],
      });

      // Default error dialog pattern should not trigger
      const result = await customBridge("Desktop alert: error dialog on screen");
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Required keywords
  // --------------------------------------------------------------------------

  describe("required keywords", () => {
    it("skips when required keywords are missing", async () => {
      const customBridge = createAwarenessGoalBridge({
        goalManager,
        patterns: [
          {
            pattern: /error/i,
            titleTemplate: "Handle error",
            descriptionTemplate: "Handle the error",
            priority: "high",
            requiredKeywords: ["critical", "fatal"],
          },
        ],
      });

      const result = await customBridge("There was an error on screen");
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Default patterns exist
  // --------------------------------------------------------------------------

  it("exports default patterns", () => {
    expect(DEFAULT_AWARENESS_PATTERNS.length).toBeGreaterThan(0);
  });
});
