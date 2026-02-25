import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ProgressTracker,
  summarizeToolResult,
  type ProgressEntry,
  type ProgressTrackerConfig,
} from "./progress.js";
import type { MemoryBackend } from "../memory/types.js";
import { createMockMemoryBackend } from "../memory/test-utils.js";

// ============================================================================
// Helpers
// ============================================================================

function createTracker(
  overrides: Partial<ProgressTrackerConfig> = {},
): { tracker: ProgressTracker; backend: MemoryBackend } {
  const backend = overrides.memoryBackend ?? createMockMemoryBackend();
  const tracker = new ProgressTracker({ memoryBackend: backend, ...overrides });
  return { tracker, backend };
}

// ============================================================================
// Tests
// ============================================================================

describe("ProgressTracker", () => {
  describe("append()", () => {
    it("stores a progress entry with auto-set timestamp", async () => {
      const { tracker, backend } = createTracker();
      const now = Date.now();
      await tracker.append({
        sessionId: "s1",
        type: "task_started",
        summary: "Working on feature X",
      });

      const entries = await tracker.getRecent("s1");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("task_started");
      expect(entries[0].summary).toBe("Working on feature X");
      expect(entries[0].sessionId).toBe("s1");
      expect(entries[0].timestamp).toBeGreaterThanOrEqual(now);
      expect(backend.set).toHaveBeenCalledOnce();
    });

    it("appends multiple entries in order", async () => {
      const { tracker } = createTracker();
      await tracker.append({ sessionId: "s1", type: "task_started", summary: "A" });
      await tracker.append({ sessionId: "s1", type: "tool_result", summary: "B" });
      await tracker.append({ sessionId: "s1", type: "task_completed", summary: "C" });

      const entries = await tracker.getRecent("s1");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.summary)).toEqual(["A", "B", "C"]);
    });

    it("prunes entries beyond maxEntriesPerSession", async () => {
      const { tracker } = createTracker({ maxEntriesPerSession: 3 });
      for (let i = 0; i < 5; i++) {
        await tracker.append({
          sessionId: "s1",
          type: "tool_result",
          summary: `entry-${i}`,
        });
      }

      const entries = await tracker.getRecent("s1");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.summary)).toEqual([
        "entry-2",
        "entry-3",
        "entry-4",
      ]);
    });

    it("truncates long summaries", async () => {
      const { tracker } = createTracker();
      const longSummary = "x".repeat(300);
      await tracker.append({ sessionId: "s1", type: "decision", summary: longSummary });

      const entries = await tracker.getRecent("s1");
      expect(entries[0].summary.length).toBeLessThanOrEqual(200);
      expect(entries[0].summary).toMatch(/\.\.\.$/);
    });

    it("stores optional metadata", async () => {
      const { tracker } = createTracker();
      await tracker.append({
        sessionId: "s1",
        type: "error",
        summary: "Tool failed",
        metadata: { tool: "system.bash", exitCode: 1 },
      });

      const entries = await tracker.getRecent("s1");
      expect(entries[0].metadata).toEqual({ tool: "system.bash", exitCode: 1 });
    });

    it("serializes concurrent appends to same session", async () => {
      const { tracker } = createTracker();
      // Fire 5 appends concurrently
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          tracker.append({
            sessionId: "s1",
            type: "tool_result",
            summary: `concurrent-${i}`,
          }),
        ),
      );

      const entries = await tracker.getRecent("s1");
      expect(entries).toHaveLength(5);
    });

    it("logs error on backend failure without throwing", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const backend = createMockMemoryBackend();
      (backend.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("backend down"),
      );
      const tracker = new ProgressTracker({
        memoryBackend: backend,
        logger: logger as unknown as import("../utils/logger.js").Logger,
      });

      // Should not throw
      await tracker.append({
        sessionId: "s1",
        type: "error",
        summary: "test",
      });
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("getRecent()", () => {
    it("returns empty array for unknown session", async () => {
      const { tracker } = createTracker();
      const entries = await tracker.getRecent("unknown");
      expect(entries).toEqual([]);
    });

    it("respects limit parameter", async () => {
      const { tracker } = createTracker();
      for (let i = 0; i < 10; i++) {
        await tracker.append({ sessionId: "s1", type: "tool_result", summary: `e-${i}` });
      }

      const entries = await tracker.getRecent("s1", 3);
      expect(entries).toHaveLength(3);
      expect(entries[0].summary).toBe("e-7");
    });
  });

  describe("getSummary()", () => {
    it("returns undefined for empty session", async () => {
      const { tracker } = createTracker();
      const summary = await tracker.getSummary("empty");
      expect(summary).toBeUndefined();
    });

    it("returns grouped Markdown summary", async () => {
      const { tracker } = createTracker();
      await tracker.append({ sessionId: "s1", type: "task_started", summary: "Started A" });
      await tracker.append({ sessionId: "s1", type: "tool_result", summary: "Ran ls" });
      await tracker.append({ sessionId: "s1", type: "task_completed", summary: "Done A" });

      const summary = await tracker.getSummary("s1");
      expect(summary).toContain("## Session Progress");
      expect(summary).toContain("### task_started");
      expect(summary).toContain("### tool_result");
      expect(summary).toContain("### task_completed");
      expect(summary).toContain("Started A");
      expect(summary).toContain("Ran ls");
      expect(summary).toContain("Done A");
    });
  });

  describe("clear()", () => {
    it("removes all entries for a session", async () => {
      const { tracker, backend } = createTracker();
      await tracker.append({ sessionId: "s1", type: "decision", summary: "chose X" });
      await tracker.clear("s1");

      const entries = await tracker.getRecent("s1");
      expect(entries).toEqual([]);
      expect(backend.delete).toHaveBeenCalledWith("progress:s1");
    });
  });

  describe("retrieve() (MemoryRetriever)", () => {
    it("returns undefined for empty session", async () => {
      const { tracker } = createTracker();
      const ctx = await tracker.retrieve("hello", "empty");
      expect(ctx).toBeUndefined();
    });

    it("returns formatted last-5 entries", async () => {
      const { tracker } = createTracker();
      for (let i = 0; i < 8; i++) {
        await tracker.append({
          sessionId: "s1",
          type: "tool_result",
          summary: `step-${i}`,
        });
      }

      const ctx = await tracker.retrieve("what happened?", "s1");
      expect(ctx).toContain("## Recent Progress");
      // Should only include last 5
      expect(ctx).not.toContain("step-0");
      expect(ctx).not.toContain("step-1");
      expect(ctx).not.toContain("step-2");
      expect(ctx).toContain("step-3");
      expect(ctx).toContain("step-7");
    });

    it("includes entry type prefix", async () => {
      const { tracker } = createTracker();
      await tracker.append({ sessionId: "s1", type: "error", summary: "something broke" });

      const ctx = await tracker.retrieve("msg", "s1");
      expect(ctx).toContain("[error]");
    });
  });
});

describe("summarizeToolResult()", () => {
  it("produces a one-liner summary", () => {
    const result = summarizeToolResult(
      "system.bash",
      { command: "ls -la" },
      "file1.ts\nfile2.ts",
      42,
    );
    expect(result).toContain("system.bash");
    expect(result).toContain("ls -la");
    expect(result).toContain("42ms");
  });

  it("truncates long args and results", () => {
    const longArgs = { command: "x".repeat(200) };
    const longResult = "y".repeat(200);
    const result = summarizeToolResult("tool", longArgs, longResult, 10);
    expect(result.length).toBeLessThan(400);
  });
});
