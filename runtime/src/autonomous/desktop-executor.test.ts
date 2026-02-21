import { describe, it, expect, vi, beforeEach } from "vitest";
import { DesktopExecutor } from "./desktop-executor.js";
import type {
  DesktopExecutorConfig,
  DesktopExecutorResult,
} from "./desktop-executor.js";

// ============================================================================
// Mock factories
// ============================================================================

function makeMockChatExecutor(response = "I clicked the button") {
  return {
    execute: vi.fn().mockResolvedValue({
      content: response,
      provider: "mock",
      usedFallback: false,
      toolCalls: [
        {
          name: "mcp.peekaboo.click",
          args: { x: 100, y: 200 },
          result: "clicked",
          isError: false,
          durationMs: 50,
        },
      ],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 200,
    }),
  };
}

function makeMockScreenshotTool(
  result = { content: "screenshot data", isError: false },
) {
  return {
    name: "mcp.peekaboo.takeScreenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object" as const, properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  };
}

function makeMockLLM(
  verification = '{"success":true,"confidence":0.9,"description":"Action succeeded"}',
) {
  return {
    name: "mock-llm",
    chat: vi.fn().mockResolvedValue({ content: verification }),
    chatStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function makeMockMemory() {
  return {
    name: "mock-memory",
    addEntry: vi.fn().mockResolvedValue(undefined),
    getThread: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockApprovalEngine(requiresApproval = false) {
  const engine = {
    requiresApproval: vi.fn().mockReturnValue(
      requiresApproval
        ? { tool: "mcp.peekaboo.click", description: "Desktop mouse click" }
        : null,
    ),
    createRequest: vi.fn().mockReturnValue({
      id: "approval-1",
      toolName: "mcp.peekaboo.click",
      args: {},
      sessionId: "test",
      message: "Approval required",
      createdAt: Date.now(),
      rule: { tool: "mcp.peekaboo.click" },
    }),
    requestApproval: vi.fn().mockResolvedValue({
      requestId: "approval-1",
      disposition: "yes",
    }),
    isToolElevated: vi.fn().mockReturnValue(false),
  };
  return engine;
}

function makeMockCommunicator() {
  return {
    broadcast: vi.fn().mockResolvedValue(undefined),
    sendTo: vi.fn().mockResolvedValue(undefined),
    getActiveChannels: vi.fn().mockReturnValue(["telegram"]),
  };
}

function makeConfig(
  overrides: Partial<DesktopExecutorConfig> = {},
): DesktopExecutorConfig {
  return {
    chatExecutor: makeMockChatExecutor() as any,
    toolHandler: vi.fn().mockResolvedValue("tool result"),
    screenshotTool: makeMockScreenshotTool(),
    llm: makeMockLLM() as any,
    memory: makeMockMemory() as any,
    ...overrides,
  };
}

// Make ChatExecutor return a plan with one step
function makePlanningChatExecutor() {
  return {
    execute: vi
      .fn()
      // First call: planning — return a plan
      .mockResolvedValueOnce({
        content: '[{"action":"click","description":"Click the save button"}]',
        provider: "mock",
        usedFallback: false,
        toolCalls: [],
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        durationMs: 200,
      })
      // Subsequent calls: execution
      .mockResolvedValue({
        content: "I clicked the save button",
        provider: "mock",
        usedFallback: false,
        toolCalls: [
          {
            name: "mcp.peekaboo.click",
            args: { x: 500, y: 300 },
            result: "clicked",
            isError: false,
            durationMs: 50,
          },
        ],
        tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
        durationMs: 150,
      }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("DesktopExecutor", () => {
  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  describe("construction", () => {
    it("creates executor with valid config", () => {
      const executor = new DesktopExecutor(makeConfig());
      expect(executor).toBeDefined();
      expect(executor.isRunning).toBe(false);
    });

    it("applies default values", () => {
      const executor = new DesktopExecutor(makeConfig());
      // Defaults are internal — we just verify it doesn't throw
      expect(executor.isRunning).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Planning
  // --------------------------------------------------------------------------

  describe("planning", () => {
    it("generates plan from screenshot + goal", async () => {
      const chatExecutor = makePlanningChatExecutor();
      const screenshotTool = makeMockScreenshotTool();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          screenshotTool,
        }),
      );

      const result = await executor.executeGoal("Save the file", "user");

      // Screenshot captured for planning
      expect(screenshotTool.execute).toHaveBeenCalled();
      // ChatExecutor called for planning (first call)
      expect(chatExecutor.execute).toHaveBeenCalled();
      // Plan step recorded
      expect(result.steps[0].type).toBe("plan");
    });

    it("includes screenshot context in plan prompt", async () => {
      const chatExecutor = makePlanningChatExecutor();
      const screenshotTool = makeMockScreenshotTool({
        content: "desktop with editor open",
        isError: false,
      });

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          screenshotTool,
        }),
      );

      await executor.executeGoal("Save the file", "user");

      const planCall = chatExecutor.execute.mock.calls[0][0];
      expect(planCall.message.content).toContain("desktop with editor open");
    });

    it("stores plan in memory", async () => {
      const memory = makeMockMemory();
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          memory: memory as any,
        }),
      );

      await executor.executeGoal("Save the file", "user");

      expect(memory.addEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "desktop-executor",
          content: expect.stringContaining("Save the file"),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  describe("execution", () => {
    it("executes steps sequentially", async () => {
      const chatExecutor = {
        execute: vi
          .fn()
          // Plan: 2 steps
          .mockResolvedValueOnce({
            content:
              '[{"action":"click","description":"Step 1"},{"action":"type","description":"Step 2"}]',
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          // Act step 1
          .mockResolvedValueOnce({
            content: "Done step 1",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          })
          // Act step 2
          .mockResolvedValueOnce({
            content: "Done step 2",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          }),
      };

      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      const result = await executor.executeGoal("Do two things", "user");

      // plan + (act + verify) * 2 = 5 steps
      expect(result.steps.length).toBe(5);
      expect(result.steps[0].type).toBe("plan");
      expect(result.steps[1].type).toBe("act");
      expect(result.steps[2].type).toBe("verify");
      expect(result.steps[3].type).toBe("act");
      expect(result.steps[4].type).toBe("verify");
    });

    it("records tool calls from ChatExecutor", async () => {
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      const result = await executor.executeGoal("Click something", "user");

      // The act step should have tool calls
      const actStep = result.steps.find((s) => s.type === "act");
      expect(actStep).toBeDefined();
      expect(actStep!.toolCalls.length).toBeGreaterThan(0);
      expect(actStep!.toolCalls[0].name).toBe("mcp.peekaboo.click");
    });

    it("respects maxSteps limit", async () => {
      // Plan with many steps
      const manySteps = Array.from({ length: 25 }, (_, i) => ({
        action: "click",
        description: `Step ${i + 1}`,
      }));

      const chatExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            content: JSON.stringify(manySteps),
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          .mockResolvedValue({
            content: "Done",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          }),
      };

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          maxSteps: 3,
        }),
      );

      const result = await executor.executeGoal("Many steps", "user");

      expect(result.status).toBe("failed");
    });

    it("records step durations", async () => {
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      const result = await executor.executeGoal("Quick task", "user");

      for (const step of result.steps) {
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("returns completed status when plan is empty", async () => {
      const chatExecutor = {
        execute: vi.fn().mockResolvedValueOnce({
          content: "[]",
          provider: "mock",
          usedFallback: false,
          toolCalls: [],
          tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          durationMs: 200,
        }),
      };

      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      const result = await executor.executeGoal("Already done", "user");

      expect(result.success).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("already achieved");
    });
  });

  // --------------------------------------------------------------------------
  // Verification
  // --------------------------------------------------------------------------

  describe("verification", () => {
    it("detects successful verification", async () => {
      const llm = makeMockLLM(
        '{"success":true,"confidence":0.95,"description":"Button was clicked"}',
      );
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          llm: llm as any,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      const verifyStep = result.steps.find((s) => s.type === "verify");
      expect(verifyStep).toBeDefined();
      expect(verifyStep!.verification!.success).toBe(true);
      expect(verifyStep!.verification!.confidence).toBe(0.95);
      expect(result.status).toBe("completed");
    });

    it("retries on verification failure", async () => {
      const llm = makeMockLLM(
        '{"success":false,"confidence":0.8,"description":"Button not found"}',
      );

      // Plan with 4 steps so verification failure accumulates
      const chatExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '[{"action":"click","description":"S1"},{"action":"click","description":"S2"},{"action":"click","description":"S3"},{"action":"click","description":"S4"}]',
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          .mockResolvedValue({
            content: "Tried to click",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          }),
      };

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          llm: llm as any,
          maxConsecutiveFailures: 3,
        }),
      );

      const result = await executor.executeGoal("Click save", "user");

      // Should end up stuck after 3 consecutive verification failures
      expect(result.status).toBe("stuck");
    });

    it("aborts after maxConsecutiveFailures", async () => {
      const llm = makeMockLLM(
        '{"success":false,"confidence":0.1,"description":"Failed"}',
      );

      const chatExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '[{"action":"click","description":"S1"},{"action":"click","description":"S2"},{"action":"click","description":"S3"},{"action":"click","description":"S4"}]',
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          .mockResolvedValue({
            content: "Tried",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          }),
      };

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          llm: llm as any,
          maxConsecutiveFailures: 2,
        }),
      );

      const result = await executor.executeGoal("Doomed task", "user");

      expect(result.status).toBe("stuck");
      expect(result.success).toBe(false);
    });

    it("handles malformed verification response", async () => {
      const llm = makeMockLLM("This is not JSON at all");
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          llm: llm as any,
          maxConsecutiveFailures: 2,
        }),
      );

      const result = await executor.executeGoal("Try something", "user");

      const verifyStep = result.steps.find((s) => s.type === "verify");
      expect(verifyStep).toBeDefined();
      expect(verifyStep!.verification!.success).toBe(false);
      expect(verifyStep!.verification!.description).toContain(
        "Unable to parse",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Safety / Approvals
  // --------------------------------------------------------------------------

  describe("safety", () => {
    it("proceeds when approval is granted", async () => {
      const approvalEngine = makeMockApprovalEngine(true);
      approvalEngine.requestApproval.mockResolvedValue({
        requestId: "approval-1",
        disposition: "yes",
      });
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          approvalEngine: approvalEngine as any,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      expect(approvalEngine.requiresApproval).toHaveBeenCalled();
      expect(approvalEngine.requestApproval).toHaveBeenCalled();
      // Should have an act step (not just skipped)
      const actStep = result.steps.find((s) => s.type === "act");
      expect(actStep).toBeDefined();
      expect(actStep!.description).not.toContain("Skipped");
    });

    it("skips step when approval is denied", async () => {
      const approvalEngine = makeMockApprovalEngine(true);
      approvalEngine.requestApproval.mockResolvedValue({
        requestId: "approval-1",
        disposition: "no",
      });
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          approvalEngine: approvalEngine as any,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      const skippedStep = result.steps.find(
        (s) => s.type === "act" && s.description.includes("Skipped"),
      );
      expect(skippedStep).toBeDefined();
    });

    it("handles 'always' elevation", async () => {
      const approvalEngine = makeMockApprovalEngine(true);
      approvalEngine.requestApproval.mockResolvedValue({
        requestId: "approval-1",
        disposition: "always",
      });
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          approvalEngine: approvalEngine as any,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      // Should proceed (always = yes for this request)
      const actStep = result.steps.find((s) => s.type === "act");
      expect(actStep).toBeDefined();
      expect(actStep!.description).not.toContain("Skipped");
    });

    it("auto-proceeds when no rule matches", async () => {
      const approvalEngine = makeMockApprovalEngine(false); // no rule matches
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          approvalEngine: approvalEngine as any,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      // requestApproval should NOT be called when no rule matches
      expect(approvalEngine.requestApproval).not.toHaveBeenCalled();
      expect(result.steps.find((s) => s.type === "act")).toBeDefined();
    });

    it("auto-proceeds when no approval engine configured", async () => {
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          // No approvalEngine
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      expect(result.steps.find((s) => s.type === "act")).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Cancellation
  // --------------------------------------------------------------------------

  describe("cancellation", () => {
    it("cancels mid-execution", async () => {
      let callCount = 0;
      let executor: DesktopExecutor;

      const chatExecutor = {
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // Plan step — return plan with 2 steps
            return {
              content:
                '[{"action":"click","description":"S1"},{"action":"click","description":"S2"}]',
              provider: "mock",
              usedFallback: false,
              toolCalls: [],
              tokenUsage: {
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
              },
              durationMs: 200,
            };
          }
          // Act step — cancel during execution
          executor.cancel();
          await new Promise((r) => setTimeout(r, 5));
          return {
            content: "Done",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: {
              promptTokens: 80,
              completionTokens: 40,
              totalTokens: 120,
            },
            durationMs: 100,
          };
        }),
      };

      executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      const result = await executor.executeGoal("Multi-step task", "user");

      expect(result.status).toBe("cancelled");
    });

    it("returns partial results on cancel", async () => {
      const chatExecutor = makePlanningChatExecutor();
      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      // Cancel immediately before executing
      executor.cancel();

      // executeGoal should still work — cancel flag is checked inside the loop
      const result = await executor.executeGoal("Task", "user");

      // The plan step should still be there, but execution should be cancelled
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    });

    it("reflects isRunning state correctly", async () => {
      const chatExecutor = makePlanningChatExecutor();
      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      expect(executor.isRunning).toBe(false);

      const promise = executor.executeGoal("Task", "user");

      // Note: since mocks resolve instantly, isRunning may already be false
      // We just verify it's false after completion
      await promise;
      expect(executor.isRunning).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Memory
  // --------------------------------------------------------------------------

  describe("memory", () => {
    it("stores plan in memory", async () => {
      const memory = makeMockMemory();
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          memory: memory as any,
        }),
      );

      await executor.executeGoal("Save file", "user");

      const planEntry = memory.addEntry.mock.calls.find(
        (c: any[]) =>
          typeof c[0].content === "string" && c[0].content.includes("Plan @"),
      );
      expect(planEntry).toBeDefined();
    });

    it("stores result in memory", async () => {
      const memory = makeMockMemory();
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          memory: memory as any,
        }),
      );

      await executor.executeGoal("Save file", "user");

      const resultEntry = memory.addEntry.mock.calls.find(
        (c: any[]) =>
          typeof c[0].content === "string" && c[0].content.includes("Result @"),
      );
      expect(resultEntry).toBeDefined();
    });

    it("stores error in memory on failure", async () => {
      const memory = makeMockMemory();
      const screenshotTool = makeMockScreenshotTool();
      screenshotTool.execute.mockRejectedValueOnce(new Error("Screenshot failed"));

      const executor = new DesktopExecutor(
        makeConfig({
          screenshotTool,
          memory: memory as any,
        }),
      );

      const result = await executor.executeGoal("Impossible task", "user");

      expect(result.status).toBe("failed");
      const errorEntry = memory.addEntry.mock.calls.find(
        (c: any[]) =>
          typeof c[0].content === "string" && c[0].content.includes("Error @"),
      );
      expect(errorEntry).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Progress / Communicator
  // --------------------------------------------------------------------------

  describe("progress", () => {
    it("broadcasts progress via communicator", async () => {
      const communicator = makeMockCommunicator();

      // Plan with 4 steps so we hit the every-3-steps broadcast
      const chatExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '[{"action":"click","description":"S1"},{"action":"click","description":"S2"},{"action":"click","description":"S3"},{"action":"click","description":"S4"}]',
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          .mockResolvedValue({
            content: "Done",
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            durationMs: 100,
          }),
      };

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          communicator: communicator as any,
        }),
      );

      await executor.executeGoal("Four step task", "user");

      // broadcast called at least once (progress + final)
      expect(communicator.broadcast).toHaveBeenCalled();
    });

    it("works gracefully without communicator", async () => {
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          // No communicator
        }),
      );

      // Should not throw
      const result = await executor.executeGoal("Task", "user");
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe("errors", () => {
    it("handles screenshot failure during planning", async () => {
      const screenshotTool = makeMockScreenshotTool();
      screenshotTool.execute.mockRejectedValueOnce(
        new Error("Permission denied"),
      );

      const executor = new DesktopExecutor(makeConfig({ screenshotTool }));

      const result = await executor.executeGoal("Take action", "user");

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("Permission denied");
    });

    it("handles LLM failure during verification", async () => {
      const llm = makeMockLLM();
      llm.chat.mockRejectedValue(new Error("LLM timeout"));
      const chatExecutor = makePlanningChatExecutor();

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          llm: llm as any,
          maxConsecutiveFailures: 2,
        }),
      );

      const result = await executor.executeGoal("Try action", "user");

      // Verification failures from LLM errors should be caught gracefully
      const verifyStep = result.steps.find((s) => s.type === "verify");
      expect(verifyStep).toBeDefined();
      expect(verifyStep!.verification!.success).toBe(false);
    });

    it("handles ChatExecutor failure during execution", async () => {
      const chatExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            content: '[{"action":"click","description":"Click button"}]',
            provider: "mock",
            usedFallback: false,
            toolCalls: [],
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 200,
          })
          .mockRejectedValue(new Error("ChatExecutor crashed")),
      };

      const executor = new DesktopExecutor(
        makeConfig({
          chatExecutor: chatExecutor as any,
          maxConsecutiveFailures: 2,
        }),
      );

      const result = await executor.executeGoal("Click button", "user");

      // Should handle the error and record it
      const failedStep = result.steps.find(
        (s) =>
          s.type === "act" && s.description.includes("ChatExecutor crashed"),
      );
      expect(failedStep).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent execution guard
  // --------------------------------------------------------------------------

  describe("concurrency", () => {
    it("rejects concurrent goals", async () => {
      let resolveFirst!: (v: any) => void;
      const chatExecutor = {
        execute: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        ),
      };

      const executor = new DesktopExecutor(
        makeConfig({ chatExecutor: chatExecutor as any }),
      );

      // Start first goal (will hang on plan step)
      const first = executor.executeGoal("Goal 1", "user");

      // Try second goal while first is running
      const second = await executor.executeGoal("Goal 2", "user");

      expect(second.success).toBe(false);
      expect(second.summary).toContain("Another goal is already executing");

      // Clean up: resolve the first promise
      resolveFirst({
        content: "[]",
        provider: "mock",
        usedFallback: false,
        toolCalls: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: 0,
      });
      await first;
    });
  });
});
