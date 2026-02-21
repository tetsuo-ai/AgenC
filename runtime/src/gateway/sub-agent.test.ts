import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SubAgentManager,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SUB_AGENT_SESSION_PREFIX,
  type SubAgentManagerConfig,
} from "./sub-agent.js";
import { SubAgentSpawnError } from "./errors.js";
import type { IsolatedSessionContext } from "./session-isolation.js";
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
      const contextKey = createContext.mock.calls[0][0] as string;
      expect(contextKey).toContain("custom-ws");
      expect(contextKey).toContain(sessionId);
    });

    it("inherits default workspace when none specified", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(
        makeManagerConfig({ createContext, defaultWorkspaceId: "my-default" }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      const contextKey = createContext.mock.calls[0][0] as string;
      expect(contextKey).toContain("my-default");
    });

    it('falls back to "default" when no workspace or default specified', async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      const contextKey = createContext.mock.calls[0][0] as string;
      expect(contextKey).toMatch(/^default:/);
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
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

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
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

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
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

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
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      await manager.spawn({ parentSessionId: "p", task: "a" });

      // Not timed out before default
      await vi.advanceTimersByTimeAsync(DEFAULT_SUB_AGENT_TIMEOUT_MS - 1000);
      expect(manager.activeCount).toBe(1);

      // Timed out after default
      await vi.advanceTimersByTimeAsync(2000);
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
  // Execution flow
  // --------------------------------------------------------------------------

  describe("execution flow", () => {
    it("calls createContext with unique key per sub-agent", async () => {
      const createContext = vi.fn(async () => makeMockContext());
      const manager = new SubAgentManager(makeManagerConfig({ createContext }));

      const id1 = await manager.spawn({ parentSessionId: "p", task: "a" });
      const id2 = await manager.spawn({ parentSessionId: "p", task: "b" });
      await settle();

      expect(createContext).toHaveBeenCalledTimes(2);
      const key1 = createContext.mock.calls[0][0] as string;
      const key2 = createContext.mock.calls[1][0] as string;
      expect(key1).not.toBe(key2);
      expect(key1).toContain(id1);
      expect(key2).toContain(id2);
    });

    it("calls destroyContext after completion", async () => {
      const destroyContext = vi.fn(async () => {});
      const manager = new SubAgentManager(
        makeManagerConfig({ destroyContext }),
      );

      await manager.spawn({ parentSessionId: "p", task: "a" });
      await settle();

      expect(destroyContext).toHaveBeenCalledTimes(1);
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
