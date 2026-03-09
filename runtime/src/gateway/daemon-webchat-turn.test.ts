import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { hydrateWebSessionRuntimeState } from "./daemon-session-state.js";
import { executeWebChatConversationTurn } from "./daemon-webchat-turn.js";
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
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    query: vi.fn(async () => []),
    deleteThread: vi.fn(async () => 0),
    listSessions: vi.fn(async () => []),
    set: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    }),
    get: vi.fn(async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    }),
    delete: vi.fn(async (key: string) => kv.delete(key)),
    has: vi.fn(async (key: string) => kv.has(key)),
    listKeys: vi.fn(async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    ),
    getDurability: vi.fn(() => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    })),
    flush: vi.fn(async () => undefined),
    clear: vi.fn(async () => {
      kv.clear();
    }),
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
    content: "reply",
    provider: "grok",
    model: "grok-4.1",
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

describe("executeWebChatConversationTurn", () => {
  it("runs the shared webchat turn flow and persists stateful continuity", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const onModelInfo = vi.fn();
    const onSubagentSynthesis = vi.fn();
    const result = createResult({
      compacted: true,
      toolCalls: [
        {
          name: "system.serverStatus",
          args: { handleId: "srv-1" },
          result: JSON.stringify({ status: "ready" }),
          isError: false,
          durationMs: 12,
        },
      ],
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

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      webChat,
      chatExecutor: {
        execute: vi.fn(async () => result),
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 42,
      onModelInfo,
      onSubagentSynthesis,
    });

    expect(signals.signalThinking).toHaveBeenCalledWith("session:test");
    expect(signals.signalIdle).toHaveBeenCalledWith("session:test");
    expect(webChat.clearAbortController).toHaveBeenCalledWith("session:test");
    expect(sessionMgr.compact).toHaveBeenCalledWith("session:test");
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(1, "session:test", {
      role: "user",
      content: "hello",
    });
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(2, "session:test", {
      role: "assistant",
      content: "reply",
    });
    expect(webChat.send).toHaveBeenCalledWith({
      sessionId: "session:test",
      content: "reply",
    });
    expect(webChat.pushToSession).toHaveBeenCalledWith(
      "session:test",
      expect.objectContaining({ type: "chat.usage" }),
    );
    expect(webChat.broadcastEvent).toHaveBeenCalledWith("chat.response", {
      sessionId: "session:test",
    });
    expect(hooks.dispatch).toHaveBeenCalledWith("message:outbound", {
      sessionId: "session:test",
      content: "reply",
      provider: "grok",
      userMessage: "hello",
      agentResponse: "reply",
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
    expect(onModelInfo).toHaveBeenCalledWith(result);
    expect(onSubagentSynthesis).toHaveBeenCalledWith(result);
    expect(logger.info).toHaveBeenCalledWith("Chat used 1 tool call(s)", {
      traceId: "trace-1",
      tools: ["system.serverStatus"],
      provider: "grok",
      failedToolCalls: 0,
    });

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(memoryBackend, "session:test", hydrated);
    expect(
      hydrated.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY],
    ).toEqual({
      previousResponseId: "resp-next",
      reconciliationHash: "hash-next",
    });
  });

  it("surfaces failures to webchat and skips outbound persistence side effects", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const sessionMgr = {
      getOrCreate: vi.fn(() => createSession()),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      webChat,
      chatExecutor: {
        execute: vi.fn(async () => {
          throw Object.assign(new Error("provider failed"), {
            stopReason: "timeout",
            stopReasonDetail: "tool follow-up timed out",
          });
        }),
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(webChat.clearAbortController).toHaveBeenCalledWith("session:test");
    expect(signals.signalIdle).toHaveBeenCalledWith("session:test");
    expect(webChat.send).toHaveBeenCalledWith({
      sessionId: "session:test",
      content: "Error (timeout): tool follow-up timed out",
    });
    expect(sessionMgr.appendMessage).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(memoryBackend.addEntry).not.toHaveBeenCalled();
  });
});
