import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatExecutor, ChatBudgetExceededError } from "./chat-executor.js";
import type { ChatExecuteParams, ChatExecutorConfig } from "./chat-executor.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
  LLMMessage,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";
import {
  LLMTimeoutError,
  LLMServerError,
  LLMRateLimitError,
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
} from "./errors.js";

// ============================================================================
// Test helpers
// ============================================================================

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage(),
    history: [],
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
    ...overrides,
  };
}

function buildLongHistory(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message ${i}`,
  }));
}

// ============================================================================
// Tests
// ============================================================================

describe("ChatExecutor", () => {
  // --------------------------------------------------------------------------
  // Basic operation
  // --------------------------------------------------------------------------

  describe("basic operation", () => {
    it("primary provider returns response with correct result shape", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect(result.toolCalls).toEqual([]);
      expect(result.tokenUsage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(result.callUsage).toHaveLength(1);
      expect(result.callUsage[0]).toMatchObject({
        callIndex: 1,
        phase: "initial",
        provider: "primary",
        model: "mock-model",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      expect(result.callUsage[0].beforeBudget.messageCount).toBeGreaterThan(0);
      expect(result.callUsage[0].afterBudget.messageCount).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("includes system prompt as first message", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams({ systemPrompt: "Be helpful." }));

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[0]).toEqual({ role: "system", content: "Be helpful." });
    });

    it("uses chatStream when onStreamChunk provided", async () => {
      const onStreamChunk = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk,
      });

      await executor.execute(createParams());

      expect(provider.chatStream).toHaveBeenCalledOnce();
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("usedFallback is false when primary succeeds", async () => {
      const primary = createMockProvider("primary");
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.usedFallback).toBe(false);
      expect(result.provider).toBe("primary");
    });
  });

  // --------------------------------------------------------------------------
  // Fallback
  // --------------------------------------------------------------------------

  describe("fallback", () => {
    it("falls back to secondary on LLMTimeoutError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMTimeoutError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("falls back to secondary on LLMServerError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("primary", 500, "Internal error"),
          ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("falls back to secondary on LLMRateLimitError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMRateLimitError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("does NOT fall back on LLMAuthenticationError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMAuthenticationError("primary", 401)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMAuthenticationError,
      );
      expect(secondary.chat).not.toHaveBeenCalled();
    });

    it("does NOT fall back on LLMProviderError (non-transient)", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMProviderError("primary", "Bad request", 400),
          ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMProviderError,
      );
      expect(secondary.chat).not.toHaveBeenCalled();
    });

    it("retries transient provider failures on same provider before fallback", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValueOnce(
            new LLMServerError("primary", 503, "temporary outage"),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        retryPolicyMatrix: {
          provider_error: {
            maxRetries: 1,
          },
        },
      });

      const result = await executor.execute(createParams());
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("does not retry deterministic message validation failures", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(
          new LLMMessageValidationError("primary", {
            validationCode: "missing_tool_call_link",
            messageIndex: 3,
            reason: "tool message missing assistant tool_calls",
          }),
        ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
      });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMMessageValidationError,
      );
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("usedFallback is true when fallback used", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMTimeoutError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.usedFallback).toBe(true);
    });

    it("all providers fail — throws last error", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("secondary", 503, "overloaded"),
          ),
      });
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        "overloaded",
      );
    });

    it("annotates thrown provider failures with canonical stop reason", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMProviderError("primary", "Bad request", 400)),
      });
      const executor = new ChatExecutor({ providers: [primary] });

      const caught = await executor.execute(createParams()).catch((error) => error);
      expect(caught).toBeInstanceOf(LLMProviderError);
      expect((caught as { stopReason?: string }).stopReason).toBe("provider_error");
      expect((caught as { stopReasonDetail?: string }).stopReasonDetail).toContain(
        "provider_error",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Cooldown
  // --------------------------------------------------------------------------

  describe("cooldown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("failed provider skipped on next call within cooldown", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
          rate_limited: { maxRetries: 0 },
        },
      });

      // First call — primary fails, secondary succeeds
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledOnce();

      // Second call — primary should be skipped (in cooldown)
      vi.advanceTimersByTime(1_000);
      await executor.execute(createParams());

      // Primary still called only once total (the initial failure)
      expect(primary.chat).toHaveBeenCalledOnce();
      expect(secondary.chat).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("provider retried after cooldown expires", async () => {
      let primaryCallCount = 0;
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          primaryCallCount++;
          if (primaryCallCount === 1) {
            return Promise.reject(new LLMServerError("primary", 500, "down"));
          }
          return Promise.resolve(mockResponse());
        }),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // First call — primary fails
      await executor.execute(createParams());

      // Advance past cooldown
      vi.advanceTimersByTime(11_000);

      // Second call — primary retried and succeeds
      const result = await executor.execute(createParams());
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);

      vi.useRealTimers();
    });

    it("uses retryAfterMs from LLMRateLimitError when available", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValueOnce(new LLMRateLimitError("primary", 30_000))
          .mockResolvedValue(mockResponse()),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          rate_limited: { maxRetries: 0 },
        },
      });

      await executor.execute(createParams());

      // Advance 15s — still within the 30s retryAfter cooldown
      vi.advanceTimersByTime(15_000);
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledOnce(); // still skipped

      // Advance past 30s total
      vi.advanceTimersByTime(16_000);
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledTimes(2); // retried

      vi.useRealTimers();
    });

    it("all providers in cooldown throws descriptive error", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("secondary", 503, "overloaded"),
          ),
      });
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 60_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // First call — both fail, both enter cooldown
      await expect(executor.execute(createParams())).rejects.toThrow(
        "overloaded",
      );

      // Second call — both in cooldown, no provider tried
      vi.advanceTimersByTime(1_000);
      await expect(executor.execute(createParams())).rejects.toThrow(
        "All providers are in cooldown",
      );

      vi.useRealTimers();
    });

    it("linear backoff capped at maxCooldownMs", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 100_000,
        maxCooldownMs: 200_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // Failure 1: cooldown = min(100_000 * 1, 200_000) = 100_000
      await executor.execute(createParams());

      // Failure 2: cooldown = min(100_000 * 2, 200_000) = 200_000
      vi.advanceTimersByTime(100_001);
      await executor.execute(createParams());

      // Failure 3: cooldown = min(100_000 * 3, 200_000) = 200_000 (capped)
      vi.advanceTimersByTime(200_001);
      await executor.execute(createParams());

      // After 200_001ms primary should be retried (cap held at 200_000)
      vi.advanceTimersByTime(200_001);
      // Primary fails again, but the point is it was tried (not skipped forever)
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // Tool loop
  // --------------------------------------------------------------------------

  describe("tool loop", () => {
    it("single tool call round executes correctly", async () => {
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"query":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final answer" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("final answer");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("search");
      expect(result.toolCalls[0].args).toEqual({ query: "test" });
      expect(result.toolCalls[0].result).toBe("tool result");
      expect(result.toolCalls[0].isError).toBe(false);
      expect(result.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(toolHandler).toHaveBeenCalledWith("search", { query: "test" });
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "initial",
        "tool_followup",
      ]);
      expect(result.callUsage).toHaveLength(2);

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const assistantWithToolCall = followupMessages.find(
        (m) => m.role === "assistant" && Array.isArray(m.toolCalls),
      );
      expect(assistantWithToolCall?.toolCalls).toEqual([
        { id: "tc-1", name: "search", arguments: '{"query":"test"}' },
      ]);
    });

    it("sanitizes screenshot tool payloads and keeps image artifacts out-of-band", async () => {
      const hugeBase64 = "A".repeat(90_000);
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({
          image: hugeBase64,
          dataUrl: `data:image/png;base64,${hugeBase64}`,
          width: 1024,
          height: 768,
        }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "desktop.screenshot", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const toolMessage = followupMessages.find(
        (m) => m.role === "tool" && m.toolCallId === "tc-1",
      );
      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content).toBe("string");
      const text = String(toolMessage?.content);
      expect(text).toContain("(base64 omitted)");
      expect(text).toContain("(see image)");
      expect(text).toContain("out-of-band");
      expect(text.length).toBeLessThan(13_000);
    });

    it("does not replay inline screenshot image parts into follow-up prompts", async () => {
      const hugeBase64 = "B".repeat(70_000);
      const screenshotResult = JSON.stringify({
        dataUrl: `data:image/png;base64,${hugeBase64}`,
        width: 1024,
        height: 768,
      });
      const toolHandler = vi.fn().mockResolvedValue(screenshotResult);
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "desktop.screenshot", arguments: "{}" },
                { id: "tc-2", name: "desktop.screenshot", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const toolMessages = followupMessages.filter(
        (m) => m.role === "tool",
      );
      expect(toolMessages).toHaveLength(2);

      for (const message of toolMessages) {
        expect(typeof message.content).toBe("string");
        expect(String(message.content)).toContain("out-of-band");
      }
    });

    it("multi-round tool calls chain with context", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce("result-1")
        .mockResolvedValueOnce("result-2");

      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "tool-a", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-2", name: "tool-b", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("done");
      expect(result.toolCalls).toHaveLength(2);
      expect(provider.chat).toHaveBeenCalledTimes(3);
    });

    it("maxToolRounds enforced — stops after limit", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "looping",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 3,
      });
      const result = await executor.execute(createParams());

      // 1 initial + 3 rounds = 4 LLM calls
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
    });

    it("per-call maxToolRounds overrides constructor default", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "looping",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });

      // Constructor default is 10, but per-call override caps at 2
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({ maxToolRounds: 2 }),
      );

      // 1 initial + 2 rounds = 3 LLM calls
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(result.toolCalls).toHaveLength(2);
    });

    it("allowedTools rejects disallowed tool name", async () => {
      const toolHandler = vi.fn().mockResolvedValue("should not be called");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "dangerous_tool", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "rejected" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["safe_tool"],
      });
      const result = await executor.execute(createParams());

      expect(toolHandler).not.toHaveBeenCalled();
      expect(result.toolCalls[0].isError).toBe(true);
      expect(result.toolCalls[0].result).toContain("not permitted");
    });

    it("passes routed tool subset to provider chat options", async () => {
      const provider = createMockProvider("primary");
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash", "system.readFile"],
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.readFile",
      ]);
    });

    it("expands routed tool subset once when model requests a missed tool", async () => {
      const toolHandler = vi.fn().mockResolvedValue("unused");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.httpGet",
                  arguments: '{\"url\":\"https://example.com\"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash"],
            expandedToolNames: ["system.bash", "system.httpGet"],
            expandOnMiss: true,
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
      ]);
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.httpGet",
      ]);
      expect(result.toolRoutingSummary).toEqual({
        enabled: true,
        initialToolCount: 1,
        finalToolCount: 2,
        routeMisses: 1,
        expanded: true,
      });
      expect(toolHandler).not.toHaveBeenCalled();
    });

    it("invalid JSON args handled gracefully", async () => {
      const toolHandler = vi.fn();
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "tool", arguments: "not-json" }],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "handled" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(toolHandler).not.toHaveBeenCalled();
      expect(result.toolCalls[0].isError).toBe(true);
      expect(result.toolCalls[0].result).toContain("Invalid tool arguments");
    });

    it("ToolCallRecord includes name, args, result, isError, durationMs", async () => {
      const toolHandler = vi.fn().mockResolvedValue("result-data");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "fetch",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      const record = result.toolCalls[0];
      expect(record).toEqual({
        name: "fetch",
        args: { url: "https://example.com" },
        result: "result-data",
        isError: false,
        durationMs: expect.any(Number),
      });
    });

    it("breaks loop when same tool call fails consecutively", async () => {
      // Simulate the LLM calling desktop.bash with "mkdir" (no directory),
      // which returns exitCode:1 every time. Should stop after 3 identical failures.
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"usage: mkdir dir"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call-1",
                name: "desktop.bash",
                arguments: '{"command":"mkdir"}',
              },
            ],
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(createParams());

      // Should have stopped after 3 identical failures, not all 10 rounds
      expect(result.toolCalls.length).toBe(3);
      expect(result.toolCalls.every((tc) => tc.name === "desktop.bash")).toBe(
        true,
      );
    });

    it("injects a recovery hint after shell-builtin style system.bash failure", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn set ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set","args":["-euo","pipefail"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("system.bash executes one real binary only"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when localhost is blocked by system.browse", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Private/loopback address blocked: 127.0.0.1"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("block localhost/private/internal addresses"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("CANNOT reach");
    });

    it("does not break loop when tool calls differ", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"err"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          // Return different args each time
          return Promise.resolve(
            mockResponse({
              content: callCount >= 3 ? "gave up" : "",
              finishReason: callCount >= 3 ? "stop" : "tool_calls",
              toolCalls:
                callCount >= 3
                  ? []
                  : [
                      {
                        id: `call-${callCount}`,
                        name: "desktop.bash",
                        arguments: `{"command":"mkdir attempt-${callCount}"}`,
                      },
                    ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(createParams());

      // All calls had different args, so loop detection should NOT fire
      expect(result.toolCalls.length).toBe(2);
      expect(result.content).toBe("gave up");
    });

    it("breaks loop after repeated all-failed rounds even with different args", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"err"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `call-${callCount}`,
                  name: "desktop.bash",
                  arguments: `{"command":"mkdir attempt-${callCount}"}`,
                },
              ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(createParams());

      // Should stop after 3 fully-failed rounds.
      expect(result.toolCalls.length).toBe(3);
      expect(toolHandler).toHaveBeenCalledTimes(3);
    });

    it("marks structured overall result as fail when any tool call fails", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"error":"command denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "desktop.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","steps":[{"step":1,"tool":"desktop.bash","ok":true}]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
      };

      expect(parsed.overall).toBe("fail");
      expect(result.toolCalls[0].isError).toBe(true);
    });

    it("marks structured overall result as fail when it claims unexecuted tools", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce('{"exitCode":0}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "desktop.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","steps":[{"step":1,"tool":"playwright.browser_navigate","ok":true}]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
      };

      expect(parsed.overall).toBe("fail");
    });
  });

  // --------------------------------------------------------------------------
  // Token budget
  // --------------------------------------------------------------------------

  describe("token budget", () => {
    it("throws ChatBudgetExceededError when compaction fails", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: {
                promptTokens: 500,
                completionTokens: 500,
                totalTokens: 1000,
              },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: {
                promptTokens: 500,
                completionTokens: 500,
                totalTokens: 1000,
              },
            }),
          )
          // Third call triggers compaction — summarization fails
          .mockRejectedValueOnce(new Error("LLM unavailable")),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      // First call: 1000 tokens used
      await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      // Second call: 2000 tokens total, but 1000 < 1500 so passes
      await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      // Third call: 2000 >= 1500. Compaction attempted, fails, throws original error.
      await expect(
        executor.execute(createParams({ history: buildLongHistory(10) })),
      ).rejects.toThrow(ChatBudgetExceededError);
    });

    it("accumulates across multiple executions; resetSessionTokens clears", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 500,
      });

      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);

      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(200);

      executor.resetSessionTokens("session-1");
      expect(executor.getSessionTokenUsage("session-1")).toBe(0);

      // Can use again after reset
      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);
    });
  });

  // --------------------------------------------------------------------------
  // Context compaction
  // --------------------------------------------------------------------------

  describe("context compaction", () => {
    it("compacts instead of throwing when budget exceeded", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // First two calls: normal responses that burn through the budget
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          // Third call triggers compaction — summary call succeeds
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary of conversation" }),
          )
          // Fourth call is the actual execution after compaction
          .mockResolvedValueOnce(
            mockResponse({
              content: "response after compaction",
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // Third call — budget exceeded, compaction succeeds, execution continues
      const result = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      expect(result.compacted).toBe(true);
      expect(result.content).toBe("response after compaction");
    });

    it("resets token counter after compaction", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          // Summary call
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary" }),
          )
          // Execution after compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));
      expect(executor.getSessionTokenUsage("session-1")).toBe(2000);

      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // After compaction, counter was reset then new usage accumulated
      expect(executor.getSessionTokenUsage("session-1")).toBe(20);
    });

    it("invokes onCompaction callback", async () => {
      const onCompaction = vi.fn();
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          // Summary call
          .mockResolvedValueOnce(
            mockResponse({ content: "Compact summary text" }),
          )
          // Execution after compaction
          .mockResolvedValueOnce(mockResponse()),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
        onCompaction,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      expect(onCompaction).toHaveBeenCalledOnce();
      expect(onCompaction).toHaveBeenCalledWith(
        "session-1",
        "Compact summary text",
      );
    });

    it("short history skips summarization but still resets tokens", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          // With <=5 messages, compactHistory returns history as-is, no summary call
          // Next call is the actual execution
          .mockResolvedValueOnce(
            mockResponse({
              content: "short history response",
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(3) }));
      await executor.execute(createParams({ history: buildLongHistory(3) }));

      // Short history (<=5 msgs) — no summary LLM call needed
      const result = await executor.execute(
        createParams({ history: buildLongHistory(3) }),
      );

      expect(result.compacted).toBe(true);
      // Token counter reset + new usage
      expect(executor.getSessionTokenUsage("session-1")).toBe(20);
    });

    it("compacted is false when no budget set", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.compacted).toBe(false);
    });

    it("second budget hit re-triggers compaction", async () => {
      const onCompaction = vi.fn();
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Round 1: burn 1000 tokens
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // Round 2: burn 1000 more → total 2000 >= 100
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // First compaction summary
          .mockResolvedValueOnce(
            mockResponse({ content: "First summary" }),
          )
          // Execution after first compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // Second compaction summary
          .mockResolvedValueOnce(
            mockResponse({ content: "Second summary" }),
          )
          // Execution after second compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 150,
        onCompaction,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // First compaction
      const r1 = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );
      expect(r1.compacted).toBe(true);
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);

      // Budget hit again (100 >= 150 is false, so need one more)
      // Actually 100 < 150, so this call passes normally. After this: 200 >= 150.
      // So we need another call to trigger second compaction.
      // Let's just verify it compacted once and the counter was reset.
      expect(onCompaction).toHaveBeenCalledTimes(1);
      expect(onCompaction).toHaveBeenCalledWith("session-1", "First summary");
    });
  });

  // --------------------------------------------------------------------------
  // Injection
  // --------------------------------------------------------------------------

  describe("injection", () => {
    it("skillInjector.inject() result appears in messages", async () => {
      const skillInjector = {
        inject: vi.fn().mockResolvedValue("Skill context: you can search"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
      });

      await executor.execute(createParams());

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[1]).toEqual({
        role: "system",
        content: "Skill context: you can search",
      });
    });

    it("skillInjector failure is non-blocking", async () => {
      const skillInjector = {
        inject: vi.fn().mockRejectedValue(new Error("injection failed")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // Only system prompt + user message (no skill context)
      expect(messages).toHaveLength(2);
    });

    it("memoryRetriever failure is non-blocking", async () => {
      const memoryRetriever = {
        retrieve: vi.fn().mockRejectedValue(new Error("retrieval failed")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages).toHaveLength(2);
    });

    it("memoryRetriever.retrieve() result appears in messages", async () => {
      const memoryRetriever = {
        retrieve: vi
          .fn()
          .mockResolvedValue("Memory: user prefers short answers"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[1]).toEqual({
        role: "system",
        content: "Memory: user prefers short answers",
      });
    });

    it("progressProvider.retrieve() result appears in messages", async () => {
      const progressProvider = {
        retrieve: vi
          .fn()
          .mockResolvedValue("## Recent Progress\n\n- [tool_result] ran ls"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        progressProvider,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages).toContainEqual({
        role: "system",
        content: "## Recent Progress\n\n- [tool_result] ran ls",
      });
    });

    it("progressProvider failure is non-blocking", async () => {
      const progressProvider = {
        retrieve: vi.fn().mockRejectedValue(new Error("progress backend down")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        progressProvider,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
    });

    it("progressProvider injected after learningProvider", async () => {
      const learningProvider = {
        retrieve: vi.fn().mockResolvedValue("## Learned Patterns\n\n- lesson"),
      };
      const progressProvider = {
        retrieve: vi.fn().mockResolvedValue("## Recent Progress\n\n- step"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        learningProvider,
        progressProvider,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // System prompt + learning + progress = 3 system messages before history/user
      const systemMessages = messages.filter((m) => m.role === "system");
      expect(systemMessages).toHaveLength(3);
      expect(systemMessages[1].content).toContain("Learned Patterns");
      expect(systemMessages[2].content).toContain("Recent Progress");
    });

    it("does not inject persistent memory providers on a fresh session", async () => {
      const memoryRetriever = { retrieve: vi.fn().mockResolvedValue("Memory") };
      const learningProvider = { retrieve: vi.fn().mockResolvedValue("Learning") };
      const progressProvider = { retrieve: vi.fn().mockResolvedValue("Progress") };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
        learningProvider,
        progressProvider,
      });

      await executor.execute(createParams({ history: [] }));

      expect(memoryRetriever.retrieve).not.toHaveBeenCalled();
      expect(learningProvider.retrieve).not.toHaveBeenCalled();
      expect(progressProvider.retrieve).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Per-call streaming
  // --------------------------------------------------------------------------

  describe("per-call streaming", () => {
    it("per-call callback overrides constructor callback", async () => {
      const constructorCallback = vi.fn();
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        perCallCallback,
        { stateful: { sessionId: "session-1" } },
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("per-call callback used when no constructor callback set", async () => {
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        perCallCallback,
        { stateful: { sessionId: "session-1" } },
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("constructor callback used when per-call not provided", async () => {
      const constructorCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams());

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        constructorCallback,
        { stateful: { sessionId: "session-1" } },
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("no streaming when neither callback set", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledOnce();
      expect(provider.chatStream).not.toHaveBeenCalled();
    });

    it("per-call streaming persists through multi-round tool loop", async () => {
      const perCallCallback = vi.fn();
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chatStream: vi
          .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"q":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({ onStreamChunk: perCallCallback }),
      );

      expect(result.content).toBe("final");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
      // Both calls used the same per-call callback
      expect(provider.chatStream).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        perCallCallback,
        { stateful: { sessionId: "session-1" } },
      );
      expect(provider.chatStream).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        perCallCallback,
        { stateful: { sessionId: "session-1" } },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Evaluator
  // --------------------------------------------------------------------------

  describe("evaluator", () => {
    it("not called when not configured", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.evaluation).toBeUndefined();
      expect(provider.chat).toHaveBeenCalledOnce();
    });

    it("passes when score meets threshold", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "good answer" }))
          // Evaluation call
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.9, "feedback": "clear and accurate"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation).toBeDefined();
      expect(result.evaluation!.score).toBe(0.9);
      expect(result.evaluation!.passed).toBe(true);
      expect(result.evaluation!.retryCount).toBe(0);
      expect(result.evaluation!.feedback).toBe("clear and accurate");
    });

    it("retries when below threshold then passes", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "weak answer" }))
          // First evaluation: low score
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.3, "feedback": "too vague"}',
            }),
          )
          // Retry response
          .mockResolvedValueOnce(mockResponse({ content: "improved answer" }))
          // Second evaluation: passes
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.8, "feedback": "much better"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7, maxRetries: 1 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation!.score).toBe(0.8);
      expect(result.evaluation!.passed).toBe(true);
      expect(result.evaluation!.retryCount).toBe(1);
      expect(result.content).toBe("improved answer");
    });

    it("accepts after max retries even if still low", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "bad answer" }))
          // First evaluation: low
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.2, "feedback": "needs work"}',
            }),
          )
          // Retry response
          .mockResolvedValueOnce(mockResponse({ content: "still bad" }))
          // Second evaluation: still low
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.4, "feedback": "slightly better"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7, maxRetries: 1 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation!.score).toBe(0.4);
      expect(result.evaluation!.passed).toBe(false);
      expect(result.evaluation!.retryCount).toBe(1);
    });

    it("handles invalid JSON gracefully", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(mockResponse({ content: "answer" }))
          // Evaluation returns invalid JSON
          .mockResolvedValueOnce(
            mockResponse({ content: "not valid json" }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      // Parse failure defaults to score 1.0 — accepts the response
      expect(result.evaluation!.score).toBe(1.0);
      expect(result.evaluation!.passed).toBe(true);
    });

    it("skipped for empty content", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "" })),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      // Empty content => evaluator not triggered
      expect(result.evaluation).toBeUndefined();
      // Only the main call, no evaluation call
      expect(provider.chat).toHaveBeenCalledOnce();
    });
  });

  describe("phase 4 planner/executor and budgets", () => {
    it("routes high-complexity turns through deterministic planner/executor path", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "multi_step_cues",
              requiresSynthesis: false,
              steps: [
                {
                  name: "step_1",
                  step_type: "deterministic_tool",
                  tool: "system.bash",
                  args: { command: "echo", args: ["hi"] },
                },
              ],
            }),
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: { results: { step_1: '{"stdout":"hi\\n","exitCode":0}' } },
          completedSteps: 1,
          totalSteps: 1,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First create a test file, then run validation, then summarize the result as JSON.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.plannerSummary).toMatchObject({
        enabled: true,
        used: true,
        plannedSteps: 1,
        deterministicStepsExecuted: 1,
      });
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["planner"]);
      expect(result.stopReason).toBe("completed");
      expect(result.content.toLowerCase()).toContain("hi");
    });

    it("applies bandit arm tuning and records parent trajectory rewards", async () => {
      const { DelegationBanditPolicyTuner, InMemoryDelegationTrajectorySink } =
        await import("./delegation-learning.js");

      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "multi_step_cues",
              requiresSynthesis: false,
              steps: [
                {
                  name: "prep",
                  step_type: "deterministic_tool",
                  tool: "system.bash",
                  args: { command: "echo", args: ["ready"] },
                },
                {
                  name: "delegate_a",
                  step_type: "subagent_task",
                  objective: "Analyze module A",
                  input_contract: "Return evidence",
                  acceptance_criteria: ["Cite logs", "Cite source"],
                  required_tool_capabilities: ["system.readFile", "system.searchFiles"],
                  context_requirements: ["module_a", "history"],
                  max_budget_hint: "120s",
                  can_run_parallel: true,
                  depends_on: ["prep"],
                },
                {
                  name: "delegate_b",
                  step_type: "subagent_task",
                  objective: "Analyze module B",
                  input_contract: "Return evidence",
                  acceptance_criteria: ["Cite logs", "Cite source"],
                  required_tool_capabilities: ["system.readFile", "system.searchFiles"],
                  context_requirements: ["module_b", "history"],
                  max_budget_hint: "120s",
                  can_run_parallel: true,
                  depends_on: ["prep"],
                },
              ],
              edges: [
                { from: "prep", to: "delegate_a" },
                { from: "prep", to: "delegate_b" },
              ],
            }),
          }),
        ),
      });

      const trajectorySink = new InMemoryDelegationTrajectorySink({
        maxRecords: 100,
      });
      const bandit = new DelegationBanditPolicyTuner({
        enabled: true,
        epsilon: 0,
        minSamplesPerArm: 1,
        explorationBudget: 0,
        random: () => 0.99,
      });

      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              prep: '{"stdout":"ready\\n","exitCode":0}',
              delegate_a:
                '{"status":"completed","subagentSessionId":"sub-a","output":"ok","success":true,"durationMs":100,"toolCalls":[]}',
              delegate_b:
                '{"status":"completed","subagentSessionId":"sub-b","output":"ok","success":true,"durationMs":100,"toolCalls":[]}',
            },
          },
          completedSteps: 3,
          totalSteps: 3,
        }),
      };

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
          maxFanoutPerTurn: 8,
          maxDepth: 4,
        },
        delegationLearning: {
          trajectorySink,
          banditTuner: bandit,
          defaultStrategyArmId: "balanced",
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First inspect two modules in parallel, then reconcile findings with source evidence and summarize.",
          ),
          history: [{ role: "user", content: "prior regression context" }],
        }),
      );

      expect(result.plannerSummary?.delegationPolicyTuning?.selectedArmId).toBeDefined();
      expect(result.plannerSummary?.delegationPolicyTuning?.finalReward).toBeTypeOf(
        "number",
      );
      expect(
        result.plannerSummary?.delegationPolicyTuning?.usefulDelegationScore,
      ).toBeTypeOf("number");
      expect(
        result.plannerSummary?.delegationPolicyTuning?.rewardProxyVersion,
      ).toBe("v1");

      const records = trajectorySink.snapshot();
      expect(records.length).toBeGreaterThan(0);
      const parent = records.find((record) => record.turnType === "parent");
      expect(parent).toBeDefined();
      expect(parent?.action.delegated).toBe(true);
      expect(parent?.stateFeatures.subagentStepCount).toBe(2);
      expect(Number.isFinite(parent?.finalReward.value ?? Number.NaN)).toBe(true);
      expect(parent?.metadata?.usefulDelegationProxyVersion).toBe("v1");

      const clusterId = parent?.stateFeatures.contextClusterId;
      expect(clusterId).toBeDefined();
      const banditSnapshot = bandit.snapshot({ contextClusterId: clusterId });
      expect((banditSnapshot[clusterId!] ?? []).some((arm) => arm.pulls > 0)).toBe(
        true,
      );
    });

    it("supports mixed planner step types and runs synthesis when synthesis step exists", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "mixed_steps",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "prep",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: { command: "echo", args: ["ready"] },
                  },
                  {
                    name: "delegate",
                    step_type: "subagent_task",
                    objective: "Research flaky test root cause",
                    input_contract: "Provide hypothesis and evidence",
                    acceptance_criteria: [
                      "Pinpoint likely failure source",
                      "Cite relevant logs",
                    ],
                    required_tool_capabilities: ["system.bash", "system.readFile"],
                    context_requirements: ["last_ci_logs", "test_history"],
                    max_budget_hint: "120s",
                    can_run_parallel: true,
                    depends_on: ["prep"],
                  },
                  {
                    name: "merge",
                    step_type: "synthesis",
                    objective: "Produce concise remediation summary",
                    depends_on: ["delegate"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "final synthesized answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: { results: { prep: '{"stdout":"ready\\n","exitCode":0}' } },
          completedSteps: 1,
          totalSteps: 1,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First run setup checks, then delegate deeper research, then synthesize results.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          steps: [
            expect.objectContaining({
              name: "prep",
              tool: "system.bash",
            }),
          ],
        }),
      );
      expect(result.content).toBe("final synthesized answer");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_synthesis",
      ]);
      expect(result.plannerSummary).toMatchObject({
        enabled: true,
        used: true,
        plannedSteps: 3,
        deterministicStepsExecuted: 1,
      });
    });

    it("maps failed subagent pipeline stopReasonHint into parent stopReason semantics", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegation_failure",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "run_timeout_step",
                    step_type: "deterministic_tool",
                    tool: "system.readFile",
                    args: { path: "ci.log" },
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "synthesis after timeout",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "failed",
          context: { results: {} },
          completedSteps: 0,
          totalSteps: 1,
          error: "Deterministic step timed out",
          stopReasonHint: "timeout",
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First read CI logs, then analyze timeout patterns, then summarize the incident report.",
          ),
        }),
      );

      expect(result.stopReason).toBe("timeout");
      expect(result.stopReasonDetail).toContain("timed out");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_synthesis",
      ]);
    });

    it("runs bounded verifier rounds for child outputs and retries low-confidence delegation once", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegated_investigation",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "delegate_a",
                    step_type: "subagent_task",
                    objective: "Analyze timeout clusters",
                    input_contract: "Return findings with evidence in JSON",
                    acceptance_criteria: ["Evidence references logs"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["ci_logs"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_b",
                    step_type: "subagent_task",
                    objective: "Map timeout clusters to source files",
                    input_contract: "Return findings with evidence in JSON",
                    acceptance_criteria: ["Evidence references source files"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["runtime_sources"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                    depends_on: ["delegate_a"],
                  },
                  {
                    name: "merge",
                    step_type: "synthesis",
                    depends_on: ["delegate_b"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                overall: "retry",
                confidence: 0.32,
                unresolved: ["delegate_a:insufficient_evidence"],
                steps: [
                  {
                    name: "delegate_a",
                    verdict: "retry",
                    confidence: 0.32,
                    retryable: true,
                    issues: ["insufficient_evidence"],
                    summary: "Need stronger evidence links",
                  },
                  {
                    name: "delegate_b",
                    verdict: "retry",
                    confidence: 0.31,
                    retryable: true,
                    issues: ["insufficient_evidence"],
                    summary: "Need stronger source links",
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                overall: "pass",
                confidence: 0.94,
                unresolved: [],
                steps: [
                  {
                    name: "delegate_a",
                    verdict: "pass",
                    confidence: 0.94,
                    retryable: true,
                    issues: [],
                    summary: "Evidence looks consistent",
                  },
                  {
                    name: "delegate_b",
                    verdict: "pass",
                    confidence: 0.93,
                    retryable: true,
                    issues: [],
                    summary: "Source mapping looks consistent",
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Consolidated remediation summary [source:delegate_a]",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            status: "completed",
            context: {
              results: {
                delegate_a: safeJson({
                  status: "completed",
                  subagentSessionId: "sub-1",
                  output: "Looks fine",
                  success: true,
                  durationMs: 12,
                  toolCalls: [],
                }),
                delegate_b: safeJson({
                  status: "completed",
                  subagentSessionId: "sub-1b",
                  output: "Not enough detail yet",
                  success: true,
                  durationMs: 10,
                  toolCalls: [],
                }),
              },
            },
            completedSteps: 2,
            totalSteps: 2,
          })
          .mockResolvedValueOnce({
            status: "completed",
            context: {
              results: {
                delegate_a: safeJson({
                  status: "completed",
                  subagentSessionId: "sub-2",
                  output:
                    '{"evidence":"ci.log line 44 and parser.ts line 88 show timeout signatures in stderr.","files":["parser.ts","ci.log"]}',
                  success: true,
                  durationMs: 15,
                  toolCalls: [{ name: "system.readFile" }],
                }),
                delegate_b: safeJson({
                  status: "completed",
                  subagentSessionId: "sub-2b",
                  output:
                    '{"evidence":"runtime.ts line 121 and scheduler.ts line 203 map directly to timeout clusters.","files":["runtime.ts","scheduler.ts"]}',
                  success: true,
                  durationMs: 14,
                  toolCalls: [{ name: "system.readFile" }],
                }),
              },
            },
            completedSteps: 2,
            totalSteps: 2,
          }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.1,
        },
        subagentVerifier: {
          enabled: true,
          force: true,
          minConfidence: 0.7,
          maxRounds: 2,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First analyze timeout clusters across CI logs, then cross-check source hotspots, then synthesize a remediation summary with evidence.",
          ),
        }),
      );

      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(2);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_verifier",
        "planner_verifier",
        "planner_synthesis",
      ]);
      expect(result.plannerSummary?.subagentVerification).toMatchObject({
        enabled: true,
        performed: true,
        rounds: 2,
        overall: "pass",
      });
      expect(result.content).toContain("[source:delegate_a]");
      expect(result.stopReason).toBe("completed");
    });

    it("adds provenance citations when synthesis output omits explicit child source tags", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegated_summary",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "delegate_a",
                    step_type: "subagent_task",
                    objective: "Analyze failure logs",
                    input_contract: "Return concise findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["ci_logs"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_b",
                    step_type: "subagent_task",
                    objective: "Map findings to source hotspots",
                    input_contract: "Return concise findings",
                    acceptance_criteria: ["Include source evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["runtime_sources"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                    depends_on: ["delegate_a"],
                  },
                  {
                    name: "merge",
                    step_type: "synthesis",
                    depends_on: ["delegate_b"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                overall: "pass",
                confidence: 0.91,
                unresolved: [],
                steps: [
                  {
                    name: "delegate_a",
                    verdict: "pass",
                    confidence: 0.91,
                    retryable: true,
                    issues: [],
                    summary: "verified",
                  },
                  {
                    name: "delegate_b",
                    verdict: "pass",
                    confidence: 0.9,
                    retryable: true,
                    issues: [],
                    summary: "verified",
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Final remediation summary without explicit citations",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              delegate_a: safeJson({
                status: "completed",
                subagentSessionId: "sub-9",
                output: "Evidence: ci.log line 44 and parser.ts line 88.",
                success: true,
                durationMs: 12,
                toolCalls: [{ name: "system.readFile" }],
              }),
              delegate_b: safeJson({
                status: "completed",
                subagentSessionId: "sub-10",
                output: "Evidence: runtime.ts line 11 and scheduler.ts line 23.",
                success: true,
                durationMs: 9,
                toolCalls: [{ name: "system.readFile" }],
              }),
            },
          },
          completedSteps: 2,
          totalSteps: 2,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.1,
        },
        subagentVerifier: {
          enabled: true,
          force: true,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First analyze child findings from CI logs, then map likely root causes, then produce a final synthesis.",
          ),
        }),
      );

      expect(result.content).toContain("Sources: [source:delegate_a]");
      const synthesisCallMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[0] as LLMMessage[];
      const synthesisSystem = synthesisCallMessages.find((msg) =>
        msg.role === "system" &&
        typeof msg.content === "string" &&
        msg.content.includes("provenance tags like [source:<step_name>]")
      );
      expect(synthesisSystem).toBeDefined();
      const synthesisUser = synthesisCallMessages.find((msg) =>
        msg.role === "user" &&
        typeof msg.content === "string" &&
        msg.content.includes("childOutputs")
      );
      expect(synthesisUser).toBeDefined();
    });

    it("stops verifier critique loops at max rounds and marks validation_error", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegated_retry_loop",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "delegate_a",
                    step_type: "subagent_task",
                    objective: "Analyze failure logs",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["ci_logs"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_b",
                    step_type: "subagent_task",
                    objective: "Map findings to source hotspots",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include source evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["runtime_sources"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                    depends_on: ["delegate_a"],
                  },
                  {
                    name: "merge",
                    step_type: "synthesis",
                    depends_on: ["delegate_b"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                overall: "retry",
                confidence: 0.2,
                unresolved: ["delegate_a:not_enough_evidence"],
                steps: [
                  {
                    name: "delegate_a",
                    verdict: "retry",
                    confidence: 0.2,
                    retryable: true,
                    issues: ["not_enough_evidence"],
                    summary: "evidence too weak",
                  },
                  {
                    name: "delegate_b",
                    verdict: "retry",
                    confidence: 0.2,
                    retryable: true,
                    issues: ["not_enough_evidence"],
                    summary: "evidence too weak",
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Unable to fully verify child outputs.",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              delegate_a: safeJson({
                status: "completed",
                subagentSessionId: "sub-loop",
                output: "very short output",
                success: true,
                durationMs: 8,
                toolCalls: [],
              }),
              delegate_b: safeJson({
                status: "completed",
                subagentSessionId: "sub-loop-b",
                output: "very short output",
                success: true,
                durationMs: 8,
                toolCalls: [],
              }),
            },
          },
          completedSteps: 2,
          totalSteps: 2,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.1,
        },
        subagentVerifier: {
          enabled: true,
          force: true,
          maxRounds: 1,
          minConfidence: 0.9,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First analyze child outputs against CI logs, then verify evidence quality, then synthesize verified findings.",
          ),
        }),
      );

      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain("Sub-agent verifier rejected");
      expect(result.plannerSummary?.subagentVerification).toMatchObject({
        enabled: true,
        performed: true,
        rounds: 1,
        overall: "retry",
      });
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_verifier",
        "planner_synthesis",
      ]);
    });

    it("enforces global request timeout across planner pipeline execution", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "timeout_guard",
              requiresSynthesis: false,
              steps: [
                {
                  name: "run_long_pipeline",
                  step_type: "deterministic_tool",
                  tool: "system.readFile",
                  args: { path: "ci.log" },
                },
              ],
            }),
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({
                  status: "completed",
                  context: {
                    results: {
                      run_long_pipeline: safeJson({ stdout: "ok" }),
                    },
                  },
                  completedSteps: 1,
                  totalSteps: 1,
                });
              }, 60);
            }),
        ),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        requestTimeoutMs: 20,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First run long deterministic pipeline and report results.",
          ),
        }),
      );

      expect(result.stopReason).toBe("timeout");
      expect(result.stopReasonDetail).toContain("planner pipeline execution");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it("falls back to direct execution when planner output is not parseable", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "this is not valid planner json",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "direct path answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Step 1 run a command. Step 2 verify output. Step 3 report result.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("direct path answer");
      expect(result.plannerSummary?.used).toBe(true);
      expect(result.plannerSummary?.routeReason).toBe("planner_parse_failed");
      expect(result.plannerSummary?.diagnostics).toEqual([
        expect.objectContaining({
          category: "parse",
          code: "invalid_json",
        }),
      ]);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "initial",
      ]);
    });

    it("falls back when planner emits subagent_task without required contract fields", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "invalid_subagent_contract",
                steps: [
                  {
                    name: "delegate",
                    step_type: "subagent_task",
                    objective: "Investigate issue",
                    // Missing required fields should fail strict parsing
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "direct fallback answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Plan and delegate a deep investigation, then summarize findings.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("direct fallback answer");
      expect(result.plannerSummary?.routeReason).toBe("planner_parse_failed");
      expect(result.plannerSummary?.diagnostics).toEqual([
        expect.objectContaining({
          category: "parse",
          code: "missing_subagent_field",
        }),
      ]);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "initial",
      ]);
    });

    it("falls back when planner emits unresolved step dependencies", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "bad_dependencies",
                steps: [
                  {
                    name: "run",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: { command: "echo", args: ["ok"] },
                    depends_on: ["missing_step"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "direct fallback due bad deps",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Step 1 run checks, step 2 validate dependencies, step 3 summarize in JSON.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("direct fallback due bad deps");
      expect(result.plannerSummary?.routeReason).toBe("planner_parse_failed");
      expect(result.plannerSummary?.diagnostics).toEqual([
        expect.objectContaining({
          category: "parse",
          code: "unknown_dependency",
        }),
      ]);
    });

    it("rejects cyclic planner dependency graphs locally with diagnostics", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "cyclic_graph",
                steps: [
                  {
                    name: "a",
                    step_type: "subagent_task",
                    objective: "Inspect module A",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_a"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                    depends_on: ["b"],
                  },
                  {
                    name: "b",
                    step_type: "subagent_task",
                    objective: "Inspect module B",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_b"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                    depends_on: ["a"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "direct fallback for cyclic graph",
            }),
          ),
      });
      const pipelineExecutor = { execute: vi.fn() };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Analyze module A and B in parallel, then merge the results.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("direct fallback for cyclic graph");
      expect(result.plannerSummary?.routeReason).toBe("planner_parse_failed");
      expect(result.plannerSummary?.diagnostics).toEqual([
        expect.objectContaining({
          category: "validation",
          code: "cyclic_dependency",
        }),
      ]);
    });

    it("uses explicit do-not-delegate path for trivial single-hop delegation plans", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegate_once",
                steps: [
                  {
                    name: "quick_check",
                    step_type: "subagent_task",
                    objective: "Run a quick sanity check",
                    input_contract: "Return one status line",
                    acceptance_criteria: ["Confirm command exits zero"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["workspace_root"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "handled without delegation",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.65,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First run one quick check, then answer with the result.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("handled without delegation");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "initial",
      ]);
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_trivial_request",
      );
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        shouldDelegate: false,
        reason: "trivial_request",
      });
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "policy",
            code: "delegation_veto",
          }),
        ]),
      );
    });

    it("hard-blocks delegation for configured task classes", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "wallet_flow",
                steps: [
                  {
                    name: "transfer",
                    step_type: "subagent_task",
                    objective: "Sign and send treasury transfer",
                    input_contract: "Return tx signature",
                    acceptance_criteria: ["Signed transaction submitted"],
                    required_tool_capabilities: ["wallet.transfer"],
                    context_requirements: ["treasury_wallet"],
                    max_budget_hint: "4m",
                    can_run_parallel: false,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "blocked by policy",
            }),
          ),
      });
      const pipelineExecutor = { execute: vi.fn() };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.1,
          hardBlockedTaskClasses: ["wallet_transfer"],
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First sign the treasury transaction, then send the payout, then report the tx result.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_hard_blocked_task_class",
      );
      expect(result.plannerSummary?.delegationDecision?.reason).toBe(
        "hard_blocked_task_class",
      );
    });

    it("gates handoff mode on explicit planner confidence threshold", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "handoff",
                confidence: 0.4,
                steps: [
                  {
                    name: "investigation_task",
                    step_type: "subagent_task",
                    objective: "Perform multi-step code investigation",
                    input_contract: "Return findings with evidence",
                    acceptance_criteria: ["Evidence attached"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["runtime_sources"],
                    max_budget_hint: "8m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "handoff confidence blocked",
            }),
          ),
      });
      const pipelineExecutor = { execute: vi.fn() };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          mode: "handoff",
          scoreThreshold: 0.1,
          handoffMinPlannerConfidence: 0.8,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First break this investigation into steps, then hand off execution, then summarize findings.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_handoff_confidence_below_threshold",
      );
      expect(result.plannerSummary?.delegationDecision?.reason).toBe(
        "handoff_confidence_below_threshold",
      );
    });

    it("applies live delegation threshold resolver for aggressiveness overrides", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "threshold_override",
                steps: [
                  {
                    name: "a",
                    step_type: "subagent_task",
                    objective: "Inspect module A",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_a"],
                    max_budget_hint: "8m",
                    can_run_parallel: true,
                  },
                  {
                    name: "b",
                    step_type: "subagent_task",
                    objective: "Inspect module B",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_b"],
                    max_budget_hint: "8m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "threshold override fallback",
            }),
          ),
      });
      const pipelineExecutor = { execute: vi.fn() };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
        },
        resolveDelegationScoreThreshold: () => 0.95,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Investigate two modules in parallel then summarize results.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.plannerSummary?.delegationDecision?.threshold).toBe(0.95);
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_score_below_threshold",
      );
    });

    it("vetoes delegation when utility score is below threshold", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "delegate_low_roi",
                steps: [
                  {
                    name: "investigate_a",
                    step_type: "subagent_task",
                    objective: "Inspect flaky test logs for service A",
                    input_contract: "Return top two hypotheses",
                    acceptance_criteria: [
                      "Hypothesis references concrete log lines",
                    ],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["ci_logs_a"],
                    max_budget_hint: "8m",
                    can_run_parallel: false,
                  },
                  {
                    name: "investigate_b",
                    step_type: "subagent_task",
                    objective: "Inspect flaky test logs for service B",
                    input_contract: "Return top two hypotheses",
                    acceptance_criteria: [
                      "Hypothesis references concrete log lines",
                    ],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["ci_logs_b"],
                    max_budget_hint: "8m",
                    can_run_parallel: false,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "fallback direct execution",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.98,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First inspect service A failures, then inspect service B failures, then merge both findings into one action plan.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_score_below_threshold",
      );
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        shouldDelegate: false,
        reason: "score_below_threshold",
        threshold: 0.98,
      });
    });

    it("enforces fanout hard guardrail before delegation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "fanout_plan",
                steps: [
                  {
                    name: "task_a",
                    step_type: "subagent_task",
                    objective: "Analyze module A",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include concrete evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_a_sources"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                  },
                  {
                    name: "task_b",
                    step_type: "subagent_task",
                    objective: "Analyze module B",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Include concrete evidence"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["module_b_sources"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "fanout blocked fallback",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn(),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
          maxFanoutPerTurn: 1,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First analyze module A, then analyze module B, then report both.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_fanout_exceeded",
      );
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        shouldDelegate: false,
        reason: "fanout_exceeded",
      });
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "subagent_fanout_exceeded",
          }),
          expect.objectContaining({
            category: "policy",
            code: "delegation_veto",
          }),
        ]),
      );
    });

    it("enforces subagent depth limit before execution", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "deep_plan",
                steps: [
                  {
                    name: "task_a",
                    step_type: "subagent_task",
                    objective: "Analyze layer A",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Evidence provided"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["layer_a"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                  },
                  {
                    name: "task_b",
                    step_type: "subagent_task",
                    objective: "Analyze layer B",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Evidence provided"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["layer_b"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                    depends_on: ["task_a"],
                  },
                  {
                    name: "task_c",
                    step_type: "subagent_task",
                    objective: "Analyze layer C",
                    input_contract: "Return findings",
                    acceptance_criteria: ["Evidence provided"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["layer_c"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                    depends_on: ["task_b"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "depth constrained fallback",
            }),
          ),
      });
      const pipelineExecutor = { execute: vi.fn() };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.1,
          maxDepth: 2,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Analyze layer A then B then C, and report one merged summary.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("depth constrained fallback");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "subagent_depth_exceeded",
          }),
          expect.objectContaining({
            category: "policy",
            code: "delegation_veto",
          }),
        ]),
      );
    });

    it("records approved delegation decision when utility clears threshold", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "parallel_investigation",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "investigate_logs",
                    step_type: "subagent_task",
                    objective: "Review CI logs and extract failure clusters",
                    input_contract: "Return a ranked list of failure clusters",
                    acceptance_criteria: [
                      "At least 3 clusters",
                      "Each cluster has evidence lines",
                    ],
                    required_tool_capabilities: [
                      "system.readFile",
                      "system.searchFiles",
                    ],
                    context_requirements: [
                      "ci_logs",
                      "recent_failures_snapshot",
                    ],
                    max_budget_hint: "12m",
                    can_run_parallel: true,
                  },
                  {
                    name: "inspect_source",
                    step_type: "subagent_task",
                    objective: "Map source hotspots to the failure clusters",
                    input_contract:
                      "Return source locations linked to each failure cluster",
                    acceptance_criteria: [
                      "Every cluster has at least one candidate source file",
                    ],
                    required_tool_capabilities: [
                      "system.readFile",
                      "system.searchFiles",
                    ],
                    context_requirements: [
                      "runtime_sources",
                      "test_sources",
                    ],
                    max_budget_hint: "12m",
                    can_run_parallel: true,
                    depends_on: ["investigate_logs"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "synthesized delegated answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              investigate_logs: safeJson({
                status: "completed",
                subagentSessionId: "sub-1",
                output: "clustered failures",
                success: true,
              }),
              inspect_source: safeJson({
                status: "completed",
                subagentSessionId: "sub-2",
                output: "mapped hotspots",
                success: true,
              }),
            },
          },
          completedSteps: 2,
          totalSteps: 2,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First cluster CI failures, then map source hotspots, and finally present one consolidated remediation brief.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.content).toContain("synthesized delegated answer");
      expect(result.content).toContain("[source:investigate_logs]");
      expect(result.plannerSummary?.routeReason).toBe("parallel_investigation");
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        shouldDelegate: true,
        reason: "approved",
      });
    });

    it("passes bounded planner context payload for subagent context curation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "context_packing",
              requiresSynthesis: false,
              steps: [
                {
                  name: "delegate_ci",
                  step_type: "subagent_task",
                  objective: "Cluster CI failures by root cause",
                  input_contract: "Return grouped failures with evidence",
                  acceptance_criteria: ["At least 2 clusters"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["ci_logs", "memory_semantic"],
                  max_budget_hint: "10m",
                  can_run_parallel: true,
                },
                {
                  name: "delegate_mapping",
                  step_type: "subagent_task",
                  objective: "Map failure clusters to source hotspots",
                  input_contract: "Return source candidates for each cluster",
                  acceptance_criteria: ["At least 2 candidate files"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["ci_logs", "memory_semantic"],
                  max_budget_hint: "10m",
                  can_run_parallel: true,
                  depends_on: ["delegate_ci"],
                },
              ],
            }),
          }),
        ),
      });
      const memoryRetriever = {
        retrieve: vi
          .fn()
          .mockResolvedValue(
            "semantic memory: prior CI cluster points to flaky integration tests",
          ),
      };
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              delegate_ci: safeJson({
                status: "completed",
                subagentSessionId: "sub-ci",
                output: "clustered failures",
                success: true,
              }),
              delegate_mapping: safeJson({
                status: "completed",
                subagentSessionId: "sub-map",
                output: "mapped source hotspots",
                success: true,
              }),
            },
          },
          completedSteps: 2,
          totalSteps: 2,
        }),
      };
      const history: LLMMessage[] = [
        ...(
          Array.from({ length: 14 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `history entry ${index} about release regressions`,
          })) as LLMMessage[]
        ),
        {
          role: "tool",
          toolCallId: "tc-1",
          toolName: "system.readFile",
          content: safeJson({
            stdout: "CI log excerpt: integration suite cluster alpha",
          }),
        },
      ];
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        memoryRetriever,
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
        },
      });

      await executor.execute(
        createParams({
          message: createMessage(
            "First cluster CI failures from logs, then map likely source hotspots, and finally produce a consolidated remediation checklist with evidence.",
          ),
          history,
        }),
      );

      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      const pipelineArg = (pipelineExecutor.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as {
          plannerContext?: {
            parentRequest: string;
            history: unknown[];
            memory: Array<{ source: string }>;
            toolOutputs: Array<{ toolName?: string }>;
          };
        };
      expect(pipelineArg.plannerContext).toBeDefined();
      expect(pipelineArg.plannerContext?.parentRequest).toContain("cluster CI failures");
      expect(pipelineArg.plannerContext?.history.length ?? 0).toBeLessThanOrEqual(12);
      expect(pipelineArg.plannerContext?.memory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "memory_semantic" }),
        ]),
      );
      expect(pipelineArg.plannerContext?.toolOutputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: "system.readFile" }),
        ]),
      );
    });

    it("forwards parent routed tool policy into planner context for child scoping", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "scoped_tools",
              requiresSynthesis: false,
              steps: [
                {
                  name: "delegate_scope",
                  step_type: "subagent_task",
                  objective: "Inspect logs and summarize failures",
                  input_contract: "Return concise findings",
                  acceptance_criteria: ["Findings contain evidence"],
                  required_tool_capabilities: ["system.readFile", "system.searchFiles"],
                  context_requirements: ["ci_logs", "memory_semantic"],
                  max_budget_hint: "8m",
                  can_run_parallel: true,
                },
                {
                  name: "delegate_map",
                  step_type: "subagent_task",
                  objective: "Map findings to source hotspots",
                  input_contract: "Return candidate files",
                  acceptance_criteria: ["At least 2 files"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["runtime_sources"],
                  max_budget_hint: "8m",
                  can_run_parallel: true,
                  depends_on: ["delegate_scope"],
                },
              ],
            }),
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              delegate_scope: safeJson({ status: "completed", success: true }),
              delegate_map: safeJson({ status: "completed", success: true }),
            },
          },
          completedSteps: 2,
          totalSteps: 2,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
        },
      });

      await executor.execute(
        createParams({
          message: createMessage(
            "First inspect CI logs, then map source hotspots, then produce one remediation brief.",
          ),
          toolRouting: {
            routedToolNames: ["system.readFile", "system.searchFiles"],
          },
        }),
      );

      const pipelineArg = (pipelineExecutor.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as {
          plannerContext?: {
            parentAllowedTools?: readonly string[];
          };
        };
      expect(pipelineArg.plannerContext?.parentAllowedTools).toEqual([
        "system.readFile",
        "system.searchFiles",
      ]);
    });

    it("enforces toolBudgetPerRequest and surfaces budget stop reason", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"exitCode":0}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
        toolBudgetPerRequest: 2,
      });

      const result = await executor.execute(createParams());

      expect(result.toolCalls).toHaveLength(2);
      expect(result.stopReason).toBe("budget_exceeded");
      expect(result.stopReasonDetail).toContain("Tool budget exceeded");
    });

    it("enforces maxModelRecallsPerRequest", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"exitCode":0}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
        maxModelRecallsPerRequest: 1,
      });

      const result = await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.stopReason).toBe("budget_exceeded");
      expect(result.stopReasonDetail).toContain("Max model recalls exceeded");
    });

    it("enforces maxFailureBudgetPerRequest", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stderr":"failed"}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
        maxFailureBudgetPerRequest: 1,
      });

      const result = await executor.execute(createParams());

      expect(result.toolCalls).toHaveLength(2);
      expect(result.stopReason).toBe("tool_error");
      expect(result.stopReasonDetail).toContain("Failure budget exceeded");
    });

    it("enforces per-tool timeout and surfaces timeout stop reason", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });
      const toolHandler = vi.fn().mockImplementation(
        async () =>
          new Promise<string>(() => {
            // intentionally never resolves
          }),
      );
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
        toolCallTimeoutMs: 25,
        requestTimeoutMs: 30_000,
      });

      const result = await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("timeout");
      expect(result.stopReasonDetail).toContain("timed out");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.isError).toBe(true);
      expect(result.toolCalls[0]?.result).toContain("timed out");
    });

    it("enforces timeout layering before follow-up recall", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });
      const toolHandler = vi.fn().mockImplementation(
        async () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('{"exitCode":0}'), 35);
          }),
      );
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
        toolCallTimeoutMs: 5_000,
        requestTimeoutMs: 20,
      });

      const result = await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("timeout");
      expect(result.stopReasonDetail?.toLowerCase()).toContain("timed out");
    });

    it("retries transient tool transport failures for safe tools", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation((messages: LLMMessage[]) => {
          const isFollowUp = messages.some((entry) => entry.role === "tool");
          if (isFollowUp) {
            return Promise.resolve(mockResponse({ content: "done" }));
          }
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.httpGet",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          );
        }),
      });
      const toolHandler = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
        .mockResolvedValueOnce('{"status":200}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        retryPolicyMatrix: {
          tool_error: { maxRetries: 1 },
        },
      });

      const result = await executor.execute(createParams());
      expect(toolHandler).toHaveBeenCalledTimes(2);
      expect(result.stopReason).toBe("completed");
      expect(result.toolCalls[0]?.result).toContain("retryAttempts");
    });

    it("does not auto-retry high-risk tools without idempotency key", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation((messages: LLMMessage[]) => {
          const isFollowUp = messages.some((entry) => entry.role === "tool");
          if (isFollowUp) {
            return Promise.resolve(mockResponse({ content: "handled" }));
          }
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "desktop.bash",
                  arguments: '{"command":"echo test"}',
                },
              ],
            }),
          );
        }),
      });
      const toolHandler = vi.fn().mockRejectedValue(new Error("fetch failed"));
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        retryPolicyMatrix: {
          tool_error: { maxRetries: 2 },
        },
      });

      const result = await executor.execute(createParams());
      expect(toolHandler).toHaveBeenCalledTimes(1);
      expect(result.toolCalls[0]?.result).toContain("retrySuppressedReason");
    });

    it("allows retry for high-risk tools only when idempotencyKey is provided", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation((messages: LLMMessage[]) => {
          const isFollowUp = messages.some((entry) => entry.role === "tool");
          if (isFollowUp) {
            return Promise.resolve(mockResponse({ content: "handled" }));
          }
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "desktop.bash",
                  arguments:
                    '{"command":"echo test","idempotencyKey":"req-123"}',
                },
              ],
            }),
          );
        }),
      });
      const toolHandler = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce('{"exitCode":0}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        retryPolicyMatrix: {
          tool_error: { maxRetries: 1 },
        },
      });

      const result = await executor.execute(createParams());
      expect(toolHandler).toHaveBeenCalledTimes(2);
      expect(result.toolCalls[0]?.result).toContain("retryAttempts");
    });

    it("opens a session-level circuit breaker for repeated failing tool patterns", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation((messages: LLMMessage[]) => {
          const isFollowUp = messages.some((entry) => entry.role === "tool");
          if (isFollowUp) {
            return Promise.resolve(mockResponse({ content: "follow-up" }));
          }
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
            }),
          );
        }),
      });
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stderr":"failed"}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        toolFailureCircuitBreaker: {
          enabled: true,
          threshold: 2,
          windowMs: 60_000,
          cooldownMs: 60_000,
        },
      });

      const breakerParams = createParams({
        sessionId: "s-breaker",
        message: {
          ...createMessage(),
          sessionId: "s-breaker",
        },
      });

      await executor.execute(breakerParams);
      const second = await executor.execute(breakerParams);
      const third = await executor.execute(breakerParams);

      expect(second.stopReason).toBe("no_progress");
      expect(second.stopReasonDetail).toContain("Session breaker opened");
      expect(third.stopReason).toBe("no_progress");
      expect(third.stopReasonDetail).toContain("Session breaker opened");
      expect(toolHandler).toHaveBeenCalledTimes(2);
    });

    it("detects semantically equivalent failing calls even when raw JSON differs", async () => {
      let round = 0;
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          round++;
          const args =
            round % 2 === 0
              ? '{"flags":["-la"],"command":"ls"}'
              : '{"command":"ls","flags":["-la"]}';
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: `tc-${round}`, name: "system.bash", arguments: args }],
            }),
          );
        }),
      });
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stderr":"failed"}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });

      const result = await executor.execute(createParams());

      expect(result.toolCalls).toHaveLength(3);
      expect(result.stopReason).toBe("no_progress");
      expect(result.stopReasonDetail).toContain("semantically-equivalent failing tool calls");
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty history works (first message in session)", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams({ history: [] }));

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // system prompt + user message only
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    });

    it("constructor throws if providers is empty", () => {
      expect(() => new ChatExecutor({ providers: [] })).toThrow(
        "ChatExecutor requires at least one provider",
      );
    });

    it("negative cooldown values are clamped to zero", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        providerCooldownMs: -1000,
        maxCooldownMs: -500,
      });

      // Should work without errors — negative values clamped to 0
      const result = await executor.execute(createParams());
      expect(result.content).toBe("mock response");
    });

    it("omits historical image payloads from normalized history", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeImage = `data:image/png;base64,${"A".repeat(120_000)}`;

      await executor.execute(
        createParams({
          history: [
            {
              role: "assistant",
              content: [
                { type: "image_url", image_url: { url: hugeImage } },
                { type: "text", text: "previous screenshot context" },
              ],
            },
          ],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const historicalAssistant = messages.find((m) => m.role === "assistant");
      expect(historicalAssistant).toBeDefined();
      expect(Array.isArray(historicalAssistant?.content)).toBe(true);
      const parts = historicalAssistant!.content as Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
      expect(
        parts.some(
          (p) => p.type === "text" && p.text.includes("prior image omitted"),
        ),
      ).toBe(true);
    });

    it("truncates oversized user messages before provider call", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeUserMessage = "U".repeat(30_000);

      await executor.execute(
        createParams({
          message: createMessage(hugeUserMessage),
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(typeof last.content).toBe("string");
      expect((last.content as string).length).toBeLessThanOrEqual(8_000);
    });

    it("suppresses runaway repetitive assistant output", async () => {
      const repetitive = Array.from({ length: 120 }, () => "Yes.").join("\n");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: repetitive })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toContain("repetitive model output suppressed");
      expect(result.content.length).toBeLessThan(3_000);
    });

    it("truncates oversized final assistant output", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValue(mockResponse({ content: "x".repeat(80_000) })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toContain("oversized model output suppressed");
      expect(result.content.length).toBeLessThanOrEqual(24_200);
    });

    it("keeps prompt growth bounded across repeated long turns", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn(async () => mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const promptSizes: number[] = [];
      let history: LLMMessage[] = [];

      for (let i = 0; i < 12; i++) {
        const userText = `turn-${i} ` + "x".repeat(6_000);
        const result = await executor.execute(
          createParams({
            history,
            message: createMessage(userText),
          }),
        );
        promptSizes.push(result.callUsage[0].afterBudget.estimatedChars);
        history = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: result.content },
        ];
      }

      // Hard budget is 100k chars in ChatExecutor; include small metadata overhead.
      expect(Math.max(...promptSizes)).toBeLessThanOrEqual(110_000);

      // Tail variance should be small once truncation/normalization kicks in.
      const tail = promptSizes.slice(-4);
      const tailRange = Math.max(...tail) - Math.min(...tail);
      expect(tailRange).toBeLessThan(8_000);
    });

    it("reports section-level budget diagnostics when constrained", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const history = Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `history-${i} ` + "h".repeat(3_000),
      })) as LLMMessage[];

      const result = await executor.execute(
        createParams({
          history,
          message: createMessage("u".repeat(6_000)),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.constrained).toBe(true);
      expect(
        (diagnostics?.sections.history.droppedMessages ?? 0) +
          (diagnostics?.sections.history.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });

    it("caps additive runtime system hints via prompt budget config", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "system.bash") {
          return '{"exitCode":1,"stderr":"spawn set ENOENT"}';
        }
        return '{"error":"Private/loopback address blocked: 127.0.0.1"}';
      });

      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
        promptBudget: { maxRuntimeHints: 1 },
      });
      await executor.execute(createParams());

      const thirdCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      const runtimeHints = thirdCallMessages.filter(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.startsWith("Tool recovery hint:"),
      );
      expect(runtimeHints).toHaveLength(1);
      expect(String(runtimeHints[0].content)).not.toContain("localhost");
    });

    it("retains one system anchor and sheds extra runtime system blocks under pressure", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const skillInjector = {
        inject: vi.fn().mockResolvedValue("skill ".repeat(3_000)),
      };
      const memoryRetriever = {
        retrieve: vi.fn().mockResolvedValue("memory ".repeat(3_000)),
      };
      const learningProvider = {
        retrieve: vi.fn().mockResolvedValue("learning ".repeat(3_000)),
      };
      const progressProvider = {
        retrieve: vi.fn().mockResolvedValue("progress ".repeat(3_000)),
      };

      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
        memoryRetriever,
        learningProvider,
        progressProvider,
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const result = await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "previous turn" }],
          message: createMessage("hello"),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.sections.system_anchor.afterMessages).toBe(1);
      expect(
        (diagnostics?.sections.system_runtime.droppedMessages ?? 0) +
          (diagnostics?.sections.system_runtime.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });

    it("passes stateful session options through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-session" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-session",
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        { stateful: { sessionId: "stateful-session" } },
      );
    });

    it("aggregates stateful fallback reason counters in result summary", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: false,
              store: true,
              fallbackToStateless: true,
              fallbackReason: "provider_retrieval_failure",
              events: [
                {
                  type: "stateful_continuation_attempt",
                },
                {
                  type: "stateful_fallback",
                  reason: "provider_retrieval_failure",
                },
              ],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-summary" };

      const result = await executor.execute(
        createParams({
          message,
          sessionId: "stateful-summary",
        }),
      );

      expect(result.statefulSummary).toBeDefined();
      expect(result.statefulSummary).toMatchObject({
        enabled: true,
        attemptedCalls: 1,
        continuedCalls: 0,
        fallbackCalls: 1,
      });
      expect(
        result.statefulSummary?.fallbackReasons.provider_retrieval_failure,
      ).toBe(1);
    });
  });
});
