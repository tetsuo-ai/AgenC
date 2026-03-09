import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SubAgentManager,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SUB_AGENT_SESSION_PREFIX,
  type SubAgentManagerConfig,
} from "./sub-agent.js";
import { SubAgentSpawnError } from "./errors.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import type {
  IsolatedSessionContext,
  SubAgentSessionIdentity,
} from "./session-isolation.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMMessage,
  StreamProgressCallback,
} from "../llm/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { RuntimeErrorCodes } from "../types/errors.js";

// ============================================================================
// Helpers
// ============================================================================

function makeMockLLMProvider(name = "mock-llm"): LLMProvider {
  return {
    name,
    chat: vi.fn(
      async (_msgs: LLMMessage[]): Promise<LLMResponse> => ({
        content: "sub-agent output",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "mock",
        finishReason: "stop",
      }),
    ),
    chatStream: vi.fn(
      async (
        _msgs: LLMMessage[],
        _cb: StreamProgressCallback,
      ): Promise<LLMResponse> => ({
        content: "sub-agent output",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "mock",
        finishReason: "stop",
      }),
    ),
    healthCheck: vi.fn(async () => true),
  };
}

function makeSequencedLLMProvider(
  outputs: readonly string[],
  observedMessages: LLMMessage[][],
  name = "mock-llm",
): LLMProvider {
  const queue = [...outputs];
  const nextResponse = async (
    messages: LLMMessage[],
  ): Promise<LLMResponse> => {
    observedMessages.push(messages.map((message) => ({ ...message })));
    const content = queue.shift() ?? "done";
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "mock",
      finishReason: "stop",
    };
  };

  return {
    name,
    chat: vi.fn(nextResponse),
    chatStream: vi.fn(async (
      messages: LLMMessage[],
      _cb: StreamProgressCallback,
    ) => nextResponse(messages)),
    healthCheck: vi.fn(async () => true),
  };
}

function makeMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(
      async (): Promise<ToolResult> => ({ content: "ok", isError: false }),
    ),
  };
}

function makeMockContext(workspaceId = "default"): IsolatedSessionContext {
  const toolRegistry = new ToolRegistry({});
  toolRegistry.register(makeMockTool("tool.a"));
  toolRegistry.register(makeMockTool("tool.b"));

  return {
    workspaceId,
    memoryBackend: {
      addEntry: vi.fn(),
      getEntries: vi.fn(async () => []),
      getSessionCount: vi.fn(async () => 0),
      deleteSession: vi.fn(),
      set: vi.fn(),
      get: vi.fn(async () => undefined),
      delete: vi.fn(),
      close: vi.fn(),
    } as any,
    policyEngine: {} as any,
    toolRegistry,
    llmProvider: makeMockLLMProvider(),
    skills: [],
    authState: { authenticated: false, permissions: new Set() },
  };
}

function makeManagerConfig(
  overrides?: Partial<SubAgentManagerConfig>,
): SubAgentManagerConfig {
  return {
    createContext: vi.fn(async () => makeMockContext()),
    destroyContext: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Wait for async execution to settle.
 * Uses real microtask flushing (no setTimeout) so it works with both
 * real and fake timers.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("SubAgentManager", () => {
  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    it("accepts valid config", () => {
      const manager = new SubAgentManager(makeManagerConfig());
      expect(manager.activeCount).toBe(0);
    });

    it("uses default maxConcurrent", () => {
      const manager = new SubAgentManager(makeManagerConfig());
      expect(manager.activeCount).toBe(0);
    });

    it("uses custom maxConcurrent", () => {
      const config = makeManagerConfig({ maxConcurrent: 2 });
      const manager = new SubAgentManager(config);
      expect(manager.activeCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // spawn
  // --------------------------------------------------------------------------

  describe("spawn", () => {
    it("returns session ID with subagent prefix", async () => {
      const manager = new SubAgentManager(makeManagerConfig());
      const sessionId = await manager.spawn({
        parentSessionId: "parent-1",
        task: "Do something",
      });
      expect(sessionId).toMatch(new RegExp(`^${SUB_AGENT_SESSION_PREFIX}`));
    });

    it("generates unique session IDs", async () => {
      const manager = new SubAgentManager(makeManagerConfig());
      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      const id2 = await manager.spawn({ parentSessionId: "p", task: "b" });
      expect(id1).not.toBe(id2);
    });

    it("starts async execution", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p", task: "a" });
      expect(manager.activeCount).toBe(1);

      await settle();

      expect(createContext).toHaveBeenCalledTimes(1);
    });

    it("passes provider and execution trace callbacks when sub-agent tracing is enabled", async () => {
      const executeSpy = vi
        .spyOn(ChatExecutor.prototype, "execute")
        .mockResolvedValue({
          content: "sub-agent output",
          toolCalls: [],
          providerEvidence: undefined,
          tokenUsage: undefined,
          stopReason: "completed",
          stopReasonDetail: undefined,
          callUsage: [],
          finalPromptShape: undefined,
          statefulSummary: undefined,
          toolRoutingSummary: undefined,
          plannerSummary: undefined,
          model: "mock",
        });
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(
        makeManagerConfig({
          createContext,
          traceProviderPayloads: true,
        }),
      );

      try {
        await manager.spawn({ parentSessionId: "p", task: "trace this" });
        await settle();

        expect(executeSpy).toHaveBeenCalledTimes(1);
        const params = executeSpy.mock.calls[0][0] as {
          trace?: Record<string, unknown>;
        };
        expect(params.trace).toEqual(
          expect.objectContaining({
            includeProviderPayloads: true,
            onProviderTraceEvent: expect.any(Function),
            onExecutionTraceEvent: expect.any(Function),
          }),
        );
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("passes workspace override to createContext", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
        workspace: "custom-ws",
      });

      await settle();

      expect(createContext).toHaveBeenCalledTimes(1);
      const identity = createContext.mock.calls[0][0] as SubAgentSessionIdentity;
      expect(identity.workspaceId).toBe("custom-ws");
      expect(identity.parentSessionId).toBe("p");
      expect(identity.subagentSessionId).toBe(sessionId);
    });

    it("inherits default workspace when none specified", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext, defaultWorkspaceId: "my-default" }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      const identity = createContext.mock.calls[0][0] as SubAgentSessionIdentity;
      expect(identity.workspaceId).toBe("my-default");
    });

    it('falls back to "default" workspace when not specified', async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      const identity = createContext.mock.calls[0][0] as SubAgentSessionIdentity;
      expect(identity.workspaceId).toBe("default");
    });

    it("throws SubAgentSpawnError on empty parentSessionId", async () => {
      const manager = new SubAgentManager(makeManagerConfig());
      await expect(
        manager.spawn({ parentSessionId: "", task: "a" }),
      ).rejects.toThrow(SubAgentSpawnError);
    });

    it("throws SubAgentSpawnError on empty task", async () => {
      const manager = new SubAgentManager(makeManagerConfig());
      await expect(
        manager.spawn({ parentSessionId: "p", task: "" }),
      ).rejects.toThrow(SubAgentSpawnError);
    });

    it("throws SubAgentSpawnError when max concurrent reached", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext, maxConcurrent: 2 }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await manager.spawn({ parentSessionId: "p", task: "b" });

      await expect(
        manager.spawn({ parentSessionId: "p", task: "c" }),
      ).rejects.toThrow(SubAgentSpawnError);
    });

    it("enforces max sub-agent depth across parent-child chains", async () => {
      const manager = new SubAgentManager(
        makeManagerConfig({ maxDepth: 2 }),
      );

      const child = await manager.spawn({ parentSessionId: "parent", task: "a" });
      const grandchild = await manager.spawn({
        parentSessionId: child,
        task: "b",
      });

      await expect(
        manager.spawn({ parentSessionId: grandchild, task: "c" }),
      ).rejects.toThrow("max sub-agent depth reached (2)");
    });

    it("error has correct code", async () => {
      const manager = new SubAgentManager(makeManagerConfig());
      try {
        await manager.spawn({ parentSessionId: "", task: "a" });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SubAgentSpawnError);
        expect((err as SubAgentSpawnError).code).toBe(
          RuntimeErrorCodes.SUB_AGENT_SPAWN_ERROR,
        );
      }
    });

    it("passes tool allowlist via ChatExecutor config", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({
        parentSessionId: "p",
        task: "a",
        tools: ["tool.a"],
      });

      await settle();

      expect(createContext).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getResult
  // --------------------------------------------------------------------------

  describe("getResult", () => {
    it("returns null for unknown session ID", () => {
      const manager = new SubAgentManager(makeManagerConfig());
      expect(manager.getResult("unknown")).toBeNull();
    });

    it("returns null for running sub-agent", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      expect(manager.getResult(sessionId)).toBeNull();
    });

    it("returns result for completed sub-agent", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe(sessionId);
      expect(result!.success).toBe(true);
      expect(result!.output).toBe("sub-agent output");
    });

    it("returns result for failed sub-agent", async () => {
      const mockContext = makeMockContext();
      (mockContext.llmProvider.chat as any).mockRejectedValue(
        new Error("LLM boom"),
      );

      const manager = new SubAgentManager(
        makeManagerConfig({ createContext: vi.fn(async () => mockContext) }),
      );

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.output).toContain("LLM boom");
    });

    it("treats non-completed chat executor stop reasons as failed sub-agent results", async () => {
      const executeSpy = vi.spyOn(ChatExecutor.prototype, "execute")
        .mockResolvedValueOnce({
          content: "Execution stopped before completion.",
          provider: "mock",
          model: "mock",
          usedFallback: false,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          callUsage: [],
          durationMs: 1,
          compacted: false,
          stopReason: "validation_error",
          stopReasonDetail:
            "Delegated task required successful tool-grounded evidence but child reported no tool calls",
        });

      try {
        const manager = new SubAgentManager(makeManagerConfig());
        const sessionId = await manager.spawn({
          parentSessionId: "p",
          task: "a",
        });
        await settle();

        const result = manager.getResult(sessionId);
        expect(result).not.toBeNull();
        expect(result!.success).toBe(false);
        expect(result!.stopReason).toBe("validation_error");
        expect(result!.stopReasonDetail).toContain(
          "child reported no tool calls",
        );
        expect(result!.output).toContain("child reported no tool calls");
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("enforces successful tool-call evidence when the sub-agent phase requires tools", async () => {
      const executeSpy = vi.spyOn(ChatExecutor.prototype, "execute")
        .mockResolvedValueOnce({
          content: "Completed from memory",
          provider: "mock",
          model: "mock",
          usedFallback: false,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          callUsage: [],
          durationMs: 1,
          compacted: false,
          stopReason: "completed",
        });

      try {
        const manager = new SubAgentManager(makeManagerConfig());
        const delegationSpec = {
          objective: "Research official docs with browser tools",
          requiredToolCapabilities: ["mcp.browser.browser_navigate"],
        } as const;
        const sessionId = await manager.spawn({
          parentSessionId: "p",
          task: "a",
          tools: ["tool.a"],
          requireToolCall: true,
          delegationSpec,
        });
        await settle();

        const result = manager.getResult(sessionId);
        expect(result).not.toBeNull();
        expect(result!.success).toBe(false);
        expect(result!.stopReason).toBe("validation_error");
        expect(result!.stopReasonDetail).toContain(
          "child reported no tool calls",
        );
        expect(executeSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            requiredToolEvidence: expect.objectContaining({
              maxCorrectionAttempts: 1,
              delegationSpec,
            }),
          }),
        );
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("preserves delegated validation codes for low-signal browser evidence", async () => {
      const executeSpy = vi.spyOn(ChatExecutor.prototype, "execute")
        .mockResolvedValueOnce({
          content: "Heat Signature, Gunpoint, Monaco.",
          provider: "mock",
          model: "mock",
          usedFallback: false,
          toolCalls: [{
            name: "mcp.browser.browser_tabs",
            args: { action: "list" },
            result: "### Result\n- 0: (current) [](about:blank)",
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          callUsage: [],
          durationMs: 1,
          compacted: false,
          stopReason: "completed",
        });

      try {
        const manager = new SubAgentManager(makeManagerConfig());
        const sessionId = await manager.spawn({
          parentSessionId: "p",
          task: "a",
          requireToolCall: true,
          delegationSpec: {
            task: "design_research",
            objective:
              "Research 3 reference games with browser tools and cite sources",
            inputContract:
              "Return markdown with 3 cited references and tuning targets",
            requiredToolCapabilities: [
              "mcp.browser.browser_navigate",
              "mcp.browser.browser_snapshot",
            ],
          },
        });
        await settle();

        const result = manager.getResult(sessionId);
        expect(result).not.toBeNull();
        expect(result!.success).toBe(false);
        expect(result!.stopReason).toBe("validation_error");
        expect(result!.validationCode).toBe("low_signal_browser_evidence");
        expect(result!.stopReasonDetail).toContain("browser-grounded evidence");
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("includes durationMs in result", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("includes toolCalls in result", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(Array.isArray(result!.toolCalls)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // cancel
  // --------------------------------------------------------------------------

  describe("cancel", () => {
    it("returns false for unknown session ID", () => {
      const manager = new SubAgentManager(makeManagerConfig());
      expect(manager.cancel("unknown")).toBe(false);
    });

    it("returns true and cancels running sub-agent", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      expect(manager.cancel(sessionId)).toBe(true);
      expect(manager.activeCount).toBe(0);
    });

    it("returns false for already completed sub-agent", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      expect(manager.cancel(sessionId)).toBe(false);
    });

    it("returns false for already cancelled sub-agent", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      expect(manager.cancel(sessionId)).toBe(true);
      expect(manager.cancel(sessionId)).toBe(false);
    });

    it("triggers abort signal and sets result", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      manager.cancel(sessionId);

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.output).toContain("cancelled");
    });

    it("sets cancelled status", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      manager.cancel(sessionId);

      const all = manager.listAll();
      const info = all.find((i) => i.sessionId === sessionId);
      expect(info).toBeDefined();
      expect(info!.status).toBe("cancelled");
    });
  });

  // --------------------------------------------------------------------------
  // listActive / listAll
  // --------------------------------------------------------------------------

  describe("listActive", () => {
    it("returns empty array when no sub-agents", () => {
      const manager = new SubAgentManager(makeManagerConfig());
      expect(manager.listActive()).toEqual([]);
    });

    it("returns only running sub-agents", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      const id2 = await manager.spawn({ parentSessionId: "p", task: "b" });

      manager.cancel(id1);

      const active = manager.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]).toBe(id2);
    });
  });

  describe("listAll", () => {
    it("returns info for all sub-agents", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p1", task: "a" });
      await manager.spawn({ parentSessionId: "p2", task: "b" });

      const all = manager.listAll();
      expect(all).toHaveLength(2);
      expect(all[0].parentSessionId).toBe("p1");
      expect(all[0].task).toBe("a");
      expect(all[1].parentSessionId).toBe("p2");
      expect(all[1].task).toBe("b");
    });

    it("includes correct status fields", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      await manager.spawn({ parentSessionId: "p", task: "b" });
      manager.cancel(id1);

      const all = manager.listAll();
      const cancelled = all.find((i) => i.sessionId === id1);
      const running = all.find((i) => i.sessionId !== id1);
      expect(cancelled!.status).toBe("cancelled");
      expect(running!.status).toBe("running");
    });
  });

  // --------------------------------------------------------------------------
  // activeCount
  // --------------------------------------------------------------------------

  describe("activeCount", () => {
    it("reflects running count", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      expect(manager.activeCount).toBe(0);

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      expect(manager.activeCount).toBe(1);

      await manager.spawn({ parentSessionId: "p", task: "b" });
      expect(manager.activeCount).toBe(2);

      manager.cancel(id1);
      expect(manager.activeCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Timeout (uses fake timers)
  // --------------------------------------------------------------------------

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-archives on timeout", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({
        createContext,
        contextStartupTimeoutMs: 5_000,
      }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "slow",
        timeoutMs: 5000,
      });

      expect(manager.activeCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5001);

      expect(manager.activeCount).toBe(0);

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.output).toContain("timed out");
    });

    it("sets timed_out status", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({
        createContext,
        contextStartupTimeoutMs: 3_000,
      }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "slow",
        timeoutMs: 3000,
      });

      await vi.advanceTimersByTimeAsync(3001);

      const all = manager.listAll();
      const info = all.find((i) => i.sessionId === sessionId);
      expect(info!.status).toBe("timed_out");
    });

    it("does not timeout before deadline", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({
        createContext,
        contextStartupTimeoutMs: 10_000,
      }));

      await manager.spawn({
        parentSessionId: "p",
        task: "a",
        timeoutMs: 10_000,
      });

      await vi.advanceTimersByTimeAsync(9000);
      expect(manager.activeCount).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(manager.activeCount).toBe(0);
    });

    it("uses default timeout when not specified", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({
        createContext,
        contextStartupTimeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
      }));

      await manager.spawn({ parentSessionId: "p", task: "a" });

      // Not timed out before default
      await vi.advanceTimersByTimeAsync(DEFAULT_SUB_AGENT_TIMEOUT_MS - 1000);
      expect(manager.activeCount).toBe(1);

      // Timed out after default
      await vi.advanceTimersByTimeAsync(2000);
      expect(manager.activeCount).toBe(0);
    });

    it("starts the execution timeout after context startup completes", async () => {
      const slowContext = makeMockContext();
      slowContext.llmProvider = {
        ...makeMockLLMProvider("slow-llm"),
        chat: vi.fn(async () => await new Promise<LLMResponse>(() => {})),
        chatStream: vi.fn(
          async () => await new Promise<LLMResponse>(() => {}),
        ),
      };
      const createContext = vi.fn(
        () =>
          new Promise<IsolatedSessionContext>((resolve) => {
            setTimeout(() => resolve(slowContext), 2_000);
          }),
      );
      const manager = new SubAgentManager(makeManagerConfig({
        createContext,
        contextStartupTimeoutMs: 60_000,
      }));

      await manager.spawn({
        parentSessionId: "p",
        task: "slow after startup",
        timeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(6_000);
      expect(manager.activeCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(manager.activeCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // destroyAll
  // --------------------------------------------------------------------------

  describe("destroyAll", () => {
    it("cancels all running sub-agents", async () => {
      const createContext = vi.fn(
        () => new Promise<IsolatedSessionContext>(() => {}),
      );
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await manager.spawn({ parentSessionId: "p", task: "b" });

      expect(manager.activeCount).toBe(2);

      await manager.destroyAll();

      expect(manager.activeCount).toBe(0);
      expect(manager.listAll()).toHaveLength(0);
    });

    it("clears handles map", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(manager.listAll()).toHaveLength(1);

      await manager.destroyAll();

      expect(manager.listAll()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Terminal handle retention
  // --------------------------------------------------------------------------

  describe("terminal handle retention", () => {
    it("prunes oldest completed handles when max retained is exceeded", async () => {
      const manager = new SubAgentManager(
        makeManagerConfig({ maxRetainedTerminalHandles: 2 }),
      );

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();
      const id2 = await manager.spawn({ parentSessionId: "p", task: "b" });
      await settle();
      const id3 = await manager.spawn({ parentSessionId: "p", task: "c" });
      await settle();

      const allIds = manager.listAll().map((entry) => entry.sessionId);
      expect(allIds).toHaveLength(2);
      expect(allIds).not.toContain(id1);
      expect(allIds).toContain(id2);
      expect(allIds).toContain(id3);
      expect(manager.getResult(id1)).toBeNull();
    });

    it("retains running handles while pruning terminal handles", async () => {
      let createCall = 0;
      const createContext = vi.fn(async () => {
        createCall += 1;
        if (createCall === 1) {
          return await new Promise<IsolatedSessionContext>(() => {});
        }
        return makeMockContext();
      });
      const manager = new SubAgentManager(
        makeManagerConfig({
          createContext,
          maxConcurrent: 4,
          maxRetainedTerminalHandles: 1,
        }),
      );

      const runningId = await manager.spawn({ parentSessionId: "p", task: "slow" });
      const completedId = await manager.spawn({
        parentSessionId: "p",
        task: "fast-1",
      });
      await settle();
      const newestId = await manager.spawn({
        parentSessionId: "p",
        task: "fast-2",
      });
      await settle();

      const all = manager.listAll();
      expect(all.find((entry) => entry.sessionId === runningId)?.status).toBe(
        "running",
      );
      expect(all.map((entry) => entry.sessionId)).not.toContain(completedId);
      expect(all.map((entry) => entry.sessionId)).toContain(newestId);
    });

    it("prunes terminal handles by retention TTL", async () => {
      vi.useFakeTimers();
      try {
        const manager = new SubAgentManager(
          makeManagerConfig({ terminalHandleRetentionMs: 1_000 }),
        );

        await manager.spawn({ parentSessionId: "p", task: "a" });
        await settle();
        expect(manager.listAll()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1_001);
        expect(manager.listAll()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Execution flow
  // --------------------------------------------------------------------------

  describe("execution flow", () => {
    it("passes composed tool handler config for delegated child sessions", async () => {
      const composeToolHandler = vi.fn(
        ({ baseToolHandler }: { baseToolHandler: (...args: any[]) => Promise<string> }) =>
          baseToolHandler,
      );
      const manager = new SubAgentManager(
        makeManagerConfig({
          composeToolHandler: composeToolHandler as any,
        }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(composeToolHandler).toHaveBeenCalledTimes(1);
      expect(composeToolHandler.mock.calls[0][0]).toMatchObject({
        sessionIdentity: {
          workspaceId: "default",
          parentSessionId: "p",
        },
        task: "a",
        desktopRoutingSessionId: "p",
      });
      expect(typeof composeToolHandler.mock.calls[0][0].sessionIdentity.subagentSessionId).toBe(
        "string",
      );
      expect(typeof composeToolHandler.mock.calls[0][0].baseToolHandler).toBe(
        "function",
      );
    });

    it("routes nested delegated desktop sessions through the root parent session", async () => {
      const composeToolHandler = vi.fn(
        ({ baseToolHandler }: { baseToolHandler: (...args: any[]) => Promise<string> }) =>
          baseToolHandler,
      );
      const manager = new SubAgentManager(
        makeManagerConfig({
          composeToolHandler: composeToolHandler as any,
        }),
      );

      const parentId = await manager.spawn({ parentSessionId: "root-session", task: "parent" });
      await settle();
      await manager.spawn({ parentSessionId: parentId, task: "child" });
      await settle();

      expect(composeToolHandler).toHaveBeenCalledTimes(2);
      expect(composeToolHandler.mock.calls[1][0]).toMatchObject({
        desktopRoutingSessionId: "root-session",
      });
    });

    it("stores child token usage from ChatExecutor results", async () => {
      const manager = new SubAgentManager(makeManagerConfig());

      const sessionId = await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result?.tokenUsage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it("selects child provider via selectLLMProvider and records providerName", async () => {
      const selectedProvider = makeMockLLMProvider("matched-provider");
      const selectLLMProvider = vi.fn(() => selectedProvider);
      const manager = new SubAgentManager(
        makeManagerConfig({
          selectLLMProvider,
        }),
      );

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "delegate",
        requiredCapabilities: ["system.readFile", "system.searchFiles"],
      });
      await settle();

      expect(selectLLMProvider).toHaveBeenCalledTimes(1);
      expect(selectLLMProvider.mock.calls[0]?.[0]).toMatchObject({
        task: "delegate",
        requiredCapabilities: ["system.readFile", "system.searchFiles"],
      });
      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result?.providerName).toBe("matched-provider");
    });

    it("calls createContext with unique typed identity per sub-agent", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      const id2 = await manager.spawn({ parentSessionId: "p", task: "b" });
      await settle();

      expect(createContext).toHaveBeenCalledTimes(2);
      const identity1 = createContext.mock.calls[0][0] as SubAgentSessionIdentity;
      const identity2 = createContext.mock.calls[1][0] as SubAgentSessionIdentity;
      expect(identity1).toEqual({
        workspaceId: "default",
        parentSessionId: "p",
        subagentSessionId: id1,
      });
      expect(identity2).toEqual({
        workspaceId: "default",
        parentSessionId: "p",
        subagentSessionId: id2,
      });
    });

    it("calls destroyContext after completion", async () => {
      const destroyContext = vi.fn(async () => {});
      const manager = new SubAgentManager(
        makeManagerConfig({ destroyContext }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(destroyContext).toHaveBeenCalledTimes(1);
      expect(destroyContext).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "default",
          parentSessionId: "p",
        }),
      );
    });

    it("reuses a terminal child session when continuationSessionId is provided", async () => {
      const executeSpy = vi
        .spyOn(ChatExecutor.prototype, "execute")
        .mockResolvedValueOnce({
          content: "CHILD-STORED-S1",
          provider: "mock-llm",
          usedFallback: false,
          toolCalls: [],
          tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          callUsage: [],
          durationMs: 10,
          compacted: false,
          stopReason: "completed",
        } as any)
        .mockResolvedValueOnce({
          content: "TOKEN=NEON-AXIS-17",
          provider: "mock-llm",
          usedFallback: false,
          toolCalls: [],
          tokenUsage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
          callUsage: [],
          durationMs: 12,
          compacted: false,
          stopReason: "completed",
        } as any);
      const manager = new SubAgentManager(makeManagerConfig());

      try {
        const firstSessionId = await manager.spawn({
          parentSessionId: "parent-1",
          task: "Store the token for later recall",
          prompt: "Store the token for later recall",
        });
        await settle();

        const secondSessionId = await manager.spawn({
          parentSessionId: "parent-1",
          task: "Recall the token",
          prompt: "Recall the token",
          continuationSessionId: firstSessionId,
        });
        await settle();

        expect(secondSessionId).toBe(firstSessionId);
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect(executeSpy.mock.calls[1]?.[0]).toMatchObject({
          sessionId: firstSessionId,
          history: [
            { role: "user", content: "Store the token for later recall" },
            { role: "assistant", content: "CHILD-STORED-S1" },
          ],
        });
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("persists forced exact child outputs into continuation history", async () => {
      const observedMessages: LLMMessage[][] = [];
      const provider = makeSequencedLLMProvider(
        [
          "Memorized.",
          "TOKEN=NEON-AXIS-17",
        ],
        observedMessages,
      );
      const createContext = vi.fn(async () => {
        const context = makeMockContext();
        return {
          ...context,
          llmProvider: provider,
        };
      });
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext }),
      );

      const firstSessionId = await manager.spawn({
        parentSessionId: "parent-1",
        task: "Child endurance F2 exact task",
        prompt:
          "Task: Child endurance F2 exact task\nObjective: In the child agent only, memorize token TOKEN=NEON-AXIS-17 for later recall, do not reveal it now, and answer exactly CHILD-STORED-F2.",
      });
      await settle();

      expect(manager.getResult(firstSessionId)?.output).toBe("CHILD-STORED-F2");

      const secondSessionId = await manager.spawn({
        parentSessionId: "parent-1",
        task: "Child endurance F2 exact task reuse session",
        prompt:
          "Task: Child endurance F2 exact task reuse session\nObjective: Reuse the same child session from F2. Recall the memorized child token and return exactly TOKEN=NEON-AXIS-17 without any extra words.",
        continuationSessionId: firstSessionId,
      });
      await settle();

      expect(secondSessionId).toBe(firstSessionId);
      expect(manager.getResult(secondSessionId)?.output).toBe("TOKEN=NEON-AXIS-17");
      expect(observedMessages[1]).toEqual(
        expect.arrayContaining([
          { role: "user", content: "Task: Child endurance F2 exact task\nObjective: In the child agent only, memorize token TOKEN=NEON-AXIS-17 for later recall, do not reveal it now, and answer exactly CHILD-STORED-F2." },
          { role: "assistant", content: "CHILD-STORED-F2" },
        ]),
      );
    });

    it("finds the latest successful child session for a parent", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-03-09T14:00:00.000Z"));
        const manager = new SubAgentManager(makeManagerConfig());

        const firstSessionId = await manager.spawn({
          parentSessionId: "parent-1",
          task: "First child",
        });
        await settle();

        vi.setSystemTime(new Date("2026-03-09T14:00:01.000Z"));
        const secondSessionId = await manager.spawn({
          parentSessionId: "parent-1",
          task: "Second child",
        });
        await settle();

        expect(manager.findLatestSuccessfulSessionId("parent-1")).toBe(
          secondSessionId,
        );
        expect(firstSessionId).not.toBe(secondSessionId);
      } finally {
        vi.useRealTimers();
      }
    });

    it("calls destroyContext after failure", async () => {
      const mockContext = makeMockContext();
      (mockContext.llmProvider.chat as any).mockRejectedValue(
        new Error("fail"),
      );

      const destroyContext = vi.fn(async () => {});
      const manager = new SubAgentManager(
        makeManagerConfig({
          createContext: vi.fn(async () => mockContext),
          destroyContext,
        }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(destroyContext).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite result when cancelled during execution", async () => {
      let resolveContext!: (ctx: IsolatedSessionContext) => void;
      const contextPromise = new Promise<IsolatedSessionContext>((resolve) => {
        resolveContext = resolve;
      });
      const createContext = vi.fn(() => contextPromise);
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });

      // Cancel before context resolves
      manager.cancel(sessionId);

      // Now resolve context — execution should see aborted signal
      resolveContext(makeMockContext());
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.output).toContain("cancelled");
    });

    it("handles createContext failure gracefully", async () => {
      const createContext = vi.fn(async () => {
        throw new Error("context creation failed");
      });
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.output).toContain("context creation failed");
    });

    it("handles destroyContext failure gracefully", async () => {
      const destroyContext = vi.fn(async () => {
        throw new Error("cleanup failed");
      });
      const manager = new SubAgentManager(
        makeManagerConfig({ destroyContext }),
      );

      const sessionId = await manager.spawn({
        parentSessionId: "p",
        task: "a",
      });
      await settle();

      const result = manager.getResult(sessionId);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });

    it("uses custom system prompt", async () => {
      const mockContext = makeMockContext();
      const chatSpy = mockContext.llmProvider.chat as ReturnType<typeof vi.fn>;
      const manager = new SubAgentManager(
        makeManagerConfig({
          createContext: vi.fn(async () => mockContext),
          systemPrompt: "Custom prompt for sub-agent",
        }),
      );

      await manager.spawn({ parentSessionId: "p", task: "do work" });
      await settle();

      expect(chatSpy).toHaveBeenCalledTimes(1);
      const messages = chatSpy.mock.calls[0][0] as LLMMessage[];
      expect(messages[0]).toEqual({
        role: "system",
        content: "Custom prompt for sub-agent",
      });
    });

    it("passes task as user message content", async () => {
      const mockContext = makeMockContext();
      const chatSpy = mockContext.llmProvider.chat as ReturnType<typeof vi.fn>;
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext: vi.fn(async () => mockContext) }),
      );

      await manager.spawn({ parentSessionId: "p", task: "analyze data" });
      await settle();

      const messages = chatSpy.mock.calls[0][0] as LLMMessage[];
      const userMsg = messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("analyze data");
    });

    it("prefers prompt over task for user message content when provided", async () => {
      const mockContext = makeMockContext();
      const chatSpy = mockContext.llmProvider.chat as ReturnType<typeof vi.fn>;
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext: vi.fn(async () => mockContext) }),
      );

      await manager.spawn({
        parentSessionId: "p",
        task: "inspect docs",
        prompt:
          "Task: inspect docs\nObjective: Read /workspace/docs/RUNTIME_API.md and extract one risk.",
      });
      await settle();

      const messages = chatSpy.mock.calls[0][0] as LLMMessage[];
      const userMsg = messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe(
        "Task: inspect docs\nObjective: Read /workspace/docs/RUNTIME_API.md and extract one risk.",
      );
    });

    it("does not call destroyContext when createContext fails", async () => {
      const destroyContext = vi.fn(async () => {});
      const createContext = vi.fn(async () => {
        throw new Error("setup failed");
      });
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext, destroyContext }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(destroyContext).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe("constants", () => {
    it("DEFAULT_SUB_AGENT_TIMEOUT_MS is 60 minutes", () => {
      expect(DEFAULT_SUB_AGENT_TIMEOUT_MS).toBe(3_600_000);
    });

    it("MAX_CONCURRENT_SUB_AGENTS is 16", () => {
      expect(MAX_CONCURRENT_SUB_AGENTS).toBe(16);
    });

    it('SUB_AGENT_SESSION_PREFIX is "subagent:"', () => {
      expect(SUB_AGENT_SESSION_PREFIX).toBe("subagent:");
    });
  });
});
