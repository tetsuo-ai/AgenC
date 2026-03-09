import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { executeTextChannelTurn } from "./daemon-text-channel-turn.js";
import {
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  type Session,
} from "./session.js";

function createLoggerStub(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  };
}

function createMemoryBackendStub(): MemoryBackend {
  return {
    name: "stub",
    addEntry: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    query: vi.fn(async () => []),
    deleteThread: vi.fn(async () => 0),
    listSessions: vi.fn(async () => []),
    set: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    has: vi.fn(async () => false),
    listKeys: vi.fn(async () => []),
    getDurability: vi.fn(() => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    })),
    flush: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => true),
  };
}

function createSession(): Session {
  return {
    id: "session:test",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata: {},
  };
}

function createResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "ok",
    provider: "grok",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    ...overrides,
  };
}

describe("executeTextChannelTurn", () => {
  it("runs the shared text-channel turn path and persists session continuity", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const result = createResult({
      content: "reply",
      callUsage: [
        {
          callIndex: 1,
          phase: "initial",
          provider: "grok",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          beforeBudget: {
            messageCount: 2,
            systemMessages: 1,
            userMessages: 1,
            assistantMessages: 0,
            toolMessages: 0,
            estimatedChars: 100,
            systemPromptChars: 50,
          },
          afterBudget: {
            messageCount: 2,
            systemMessages: 1,
            userMessages: 1,
            assistantMessages: 0,
            toolMessages: 0,
            estimatedChars: 100,
            systemPromptChars: 50,
          },
          statefulDiagnostics: {
            enabled: true,
            attempted: true,
            continued: true,
            store: true,
            fallbackToStateless: true,
            responseId: "resp-next",
            reconciliationHash: "hash-next",
            events: [],
          },
        },
      ],
    });
    const execute = vi.fn(async () => result);
    const recordToolRoutingOutcome = vi.fn();

    const returned = await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "hello",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-1",
      memoryBackend,
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome,
    });

    expect(returned).toBe(result);
    expect(execute).toHaveBeenCalledOnce();
    expect(recordToolRoutingOutcome).toHaveBeenCalledWith(
      "session:test",
      undefined,
    );
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(1, "session:test", {
      role: "user",
      content: "hello",
    });
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(2, "session:test", {
      role: "assistant",
      content: "reply",
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(1, {
      sessionId: "session:test",
      role: "user",
      content: "hello",
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(2, {
      sessionId: "session:test",
      role: "assistant",
      content: "reply",
    });
    expect(
      session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY],
    ).toEqual({
      previousResponseId: "resp-next",
      reconciliationHash: "hash-next",
    });
  });

  it("rethrows executor failures without mutating session history", async () => {
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const memoryBackend = createMemoryBackendStub();

    await expect(
      executeTextChannelTurn({
        logger: createLoggerStub(),
        channelName: "telegram",
        msg: {
          sessionId: "session:test",
          senderId: "user-1",
          channel: "telegram",
          content: "hello",
        },
        session,
        sessionMgr,
        systemPrompt: "system",
        chatExecutor: {
          execute: vi.fn(async () => {
            throw new Error("provider failed");
          }),
        } as any,
        toolHandler: vi.fn() as any,
        traceConfig: {
          enabled: false,
          includeHistory: true,
          includeSystemPrompt: true,
          includeToolArgs: true,
          includeToolResults: true,
          includeProviderPayloads: false,
          maxChars: 20_000,
        },
        turnTraceId: "trace-1",
        memoryBackend,
        buildToolRoutingDecision: () => undefined,
        recordToolRoutingOutcome: vi.fn(),
      }),
    ).rejects.toThrow("provider failed");

    expect(sessionMgr.appendMessage).not.toHaveBeenCalled();
    expect(memoryBackend.addEntry).not.toHaveBeenCalled();
  });
});
