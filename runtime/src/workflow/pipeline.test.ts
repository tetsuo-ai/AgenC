import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PipelineExecutor,
  type Pipeline,
  type PipelineStep,
  type PipelineExecutorConfig,
} from "./pipeline.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ApprovalEngine } from "../gateway/approvals.js";
import type { ProgressTracker } from "../gateway/progress.js";
import { createMockMemoryBackend } from "../memory/test-utils.js";

// ============================================================================
// Helpers
// ============================================================================

function createMockToolHandler(
  results: Record<string, string> = {},
  errors: Record<string, Error> = {},
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return vi.fn(async (name: string) => {
    if (errors[name]) throw errors[name];
    return results[name] ?? `result-of-${name}`;
  });
}

function createPipeline(
  steps: PipelineStep[],
  id = "test-pipeline",
): Pipeline {
  return {
    id,
    steps,
    context: { results: {} },
    createdAt: Date.now(),
  };
}

function createExecutor(
  overrides: Partial<PipelineExecutorConfig> = {},
): PipelineExecutor {
  return new PipelineExecutor({
    toolHandler: createMockToolHandler(),
    memoryBackend: createMockMemoryBackend(),
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("PipelineExecutor", () => {
  describe("execute()", () => {
    it("executes all steps and returns completed", async () => {
      const handler = createMockToolHandler({
        "system.bash": "file1.ts",
        "system.http": '{"ok":true}',
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "list", tool: "system.bash", args: { command: "ls" } },
        { name: "fetch", tool: "system.http", args: { url: "http://x" } },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.totalSteps).toBe(2);
      expect(result.context.results["list"]).toBe("file1.ts");
      expect(result.context.results["fetch"]).toBe('{"ok":true}');
    });

    it("returns failed on tool error with abort policy", async () => {
      const handler = createMockToolHandler(
        {},
        { "system.bash": new Error("command not found") },
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "run", tool: "system.bash", args: { command: "bad" } },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("command not found");
      expect(result.completedSteps).toBe(0);
    });

    it("skips failed step with skip policy", async () => {
      const handler = createMockToolHandler(
        { "tool.b": "b-result" },
        { "tool.a": new Error("a failed") },
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "step-a", tool: "tool.a", args: {}, onError: "skip" },
        { name: "step-b", tool: "tool.b", args: {} },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.context.results["step-a"]).toContain("SKIPPED");
      expect(result.context.results["step-b"]).toBe("b-result");
    });

    it("retries on failure with retry policy", async () => {
      let callCount = 0;
      const handler = vi.fn(async () => {
        callCount++;
        if (callCount <= 1) throw new Error("transient");
        return "success";
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "flaky", tool: "flaky", args: {}, onError: "retry", maxRetries: 2 },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.context.results["flaky"]).toBe("success");
    });

    it("fails after exhausting retries", async () => {
      const handler = vi.fn(async () => {
        throw new Error("always fails");
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "bad", tool: "bad", args: {}, onError: "retry", maxRetries: 2 },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("failed");
      // Initial call + 2 retries = 3 total calls
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("rejects concurrent execution of same pipeline", async () => {
      let resolveFirst: (() => void) | undefined;
      const handler = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = () => resolve("done");
          }),
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "slow", tool: "slow", args: {} },
      ]);

      // Start first execution (don't await — it will block on the handler)
      const firstPromise = executor.execute(pipeline);
      // Give the event loop time to enter the handler
      await new Promise((r) => setTimeout(r, 10));

      // Second execution should fail immediately
      const second = await executor.execute(pipeline);

      expect(second.status).toBe("failed");
      expect(second.error).toContain("already running");

      // Clean up: resolve the first execution
      resolveFirst?.();
      await firstPromise;
    });

    it("halts when step requires approval and rule matches", async () => {
      const approvalEngine = {
        requiresApproval: vi.fn().mockReturnValue({ tool: "wallet.*", description: "needs approval" }),
      } as unknown as ApprovalEngine;
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, approvalEngine });
      const pipeline = createPipeline([
        { name: "safe", tool: "system.bash", args: {} },
        { name: "dangerous", tool: "wallet.sign", args: {}, requiresApproval: true },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("halted");
      expect(result.resumeFrom).toBe(1);
      expect(result.completedSteps).toBe(1);
    });

    it("continues when requiresApproval but no matching rule", async () => {
      const approvalEngine = {
        requiresApproval: vi.fn().mockReturnValue(null),
      } as unknown as ApprovalEngine;
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, approvalEngine });
      const pipeline = createPipeline([
        { name: "step", tool: "safe.tool", args: {}, requiresApproval: true },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
    });

    it("saves checkpoints during execution", async () => {
      const backend = createMockMemoryBackend();
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, memoryBackend: backend });
      const pipeline = createPipeline([
        { name: "a", tool: "tool.a", args: {} },
        { name: "b", tool: "tool.b", args: {} },
      ]);

      await executor.execute(pipeline);

      // Checkpoint set for each step (running) then deleted on completion
      expect(backend.set).toHaveBeenCalled();
      expect(backend.delete).toHaveBeenCalledWith("pipeline:test-pipeline");
    });

    it("starts from a given step index", async () => {
      const handler = createMockToolHandler({
        "tool.b": "b-result",
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline: Pipeline = {
        id: "resume-test",
        steps: [
          { name: "a", tool: "tool.a", args: {} },
          { name: "b", tool: "tool.b", args: {} },
        ],
        context: { results: { a: "already-done" } },
        createdAt: Date.now(),
      };

      const result = await executor.execute(pipeline, 1);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.context.results["a"]).toBe("already-done");
      expect(result.context.results["b"]).toBe("b-result");
    });

    it("tracks progress when progressTracker is provided", async () => {
      const progressTracker = {
        append: vi.fn(),
      } as unknown as ProgressTracker;
      const handler = createMockToolHandler();
      const executor = createExecutor({
        toolHandler: handler,
        progressTracker,
      });
      const pipeline = createPipeline([
        { name: "step1", tool: "tool", args: {} },
      ]);

      await executor.execute(pipeline);

      expect(progressTracker.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "task_completed",
          summary: expect.stringContaining("step1"),
        }),
      );
    });
  });

  describe("resume()", () => {
    it("resumes from checkpoint", async () => {
      const backend = createMockMemoryBackend();
      const handler = createMockToolHandler({ "tool.b": "resumed-b" });
      const executor = createExecutor({
        toolHandler: handler,
        memoryBackend: backend,
      });

      // Manually insert a checkpoint
      await backend.set("pipeline:p1", {
        pipelineId: "p1",
        pipeline: {
          id: "p1",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt: Date.now(),
      });

      const result = await executor.resume("p1");

      expect(result.status).toBe("completed");
      expect(result.context.results["a"]).toBe("old-a");
      expect(result.context.results["b"]).toBe("resumed-b");
    });

    it("throws WorkflowStateError when no checkpoint found", async () => {
      const executor = createExecutor();

      await expect(executor.resume("nonexistent")).rejects.toThrow(
        /No checkpoint found/,
      );
    });
  });

  describe("listActive()", () => {
    it("returns empty when no pipelines active", async () => {
      const executor = createExecutor();
      const active = await executor.listActive();
      expect(active).toEqual([]);
    });
  });

  describe("remove()", () => {
    it("removes checkpoint and clears from active set", async () => {
      const backend = createMockMemoryBackend();
      const executor = createExecutor({ memoryBackend: backend });

      // Execute a pipeline to make it active, then remove
      let resolveHandler: (() => void) | undefined;
      const slowExecutor = createExecutor({
        memoryBackend: backend,
        toolHandler: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveHandler = () => resolve("done");
            }),
        ),
      });
      const pipeline = createPipeline([
        { name: "slow", tool: "slow", args: {} },
      ], "removable");

      const execPromise = slowExecutor.execute(pipeline);
      // Let the executor start running
      await new Promise((r) => setTimeout(r, 10));
      await slowExecutor.remove("removable");
      resolveHandler?.();
      await execPromise;

      expect(backend.delete).toHaveBeenCalledWith("pipeline:removable");
    });
  });
});
