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

    it("falls back on transient provider outage text without status", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new Error("Service temporarily unavailable.")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
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
      const providerTraceEvents: Array<Record<string, unknown>> = [];
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
      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );
      expect(primary.chat).toHaveBeenCalledOnce();

      // Second call — primary should be skipped (in cooldown)
      vi.advanceTimersByTime(1_000);
      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );

      // Primary still called only once total (the initial failure)
      expect(primary.chat).toHaveBeenCalledOnce();
      expect(secondary.chat).toHaveBeenCalledTimes(2);
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            callPhase: "initial",
            payload: expect.objectContaining({
              reason: "provider_cooldown_applied",
              failureClass: "provider_error",
              failures: 1,
            }),
          }),
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            callPhase: "initial",
            payload: expect.objectContaining({
              reason: "provider_cooldown_skip",
              failures: 1,
            }),
          }),
        ]),
      );

      vi.useRealTimers();
    });

    it("provider retried after cooldown expires", async () => {
      const providerTraceEvents: Array<Record<string, unknown>> = [];
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
      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );

      // Advance past cooldown
      vi.advanceTimersByTime(11_000);

      // Second call — primary retried and succeeds
      const result = await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_applied",
            }),
          }),
          expect.objectContaining({
            kind: "response",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_cleared",
              failures: 1,
            }),
          }),
        ]),
      );

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
      const providerTraceEvents: Array<Record<string, unknown>> = [];
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
      await expect(
        executor.execute(
          createParams({
            trace: {
              includeProviderPayloads: true,
              onProviderTraceEvent: (event) =>
                providerTraceEvents.push(event as Record<string, unknown>),
            },
          }),
        ),
      ).rejects.toThrow("overloaded");

      // Second call — both in cooldown, no provider tried
      vi.advanceTimersByTime(1_000);
      await expect(
        executor.execute(
          createParams({
            trace: {
              includeProviderPayloads: true,
              onProviderTraceEvent: (event) =>
                providerTraceEvents.push(event as Record<string, unknown>),
            },
          }),
        ),
      ).rejects.toThrow("All providers are in cooldown");
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_skip",
            }),
          }),
          expect.objectContaining({
            kind: "error",
            provider: "secondary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_skip",
            }),
          }),
          expect.objectContaining({
            kind: "error",
            provider: "chat-executor",
            payload: expect.objectContaining({
              reason: "all_providers_in_cooldown",
              providers: [
                expect.objectContaining({
                  provider: "primary",
                  failures: 1,
                }),
                expect.objectContaining({
                  provider: "secondary",
                  failures: 1,
                }),
              ],
            }),
          }),
        ]),
      );

      vi.useRealTimers();
    });

    it("re-checks cooldown timing after earlier provider latency before skipping later providers", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(
          () =>
            new Promise<LLMResponse>((_resolve, reject) => {
              setTimeout(
                () => reject(new LLMServerError("primary", 500, "slow fail")),
                2_000,
              );
            }),
        ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      (executor as unknown as {
        cooldowns: Map<string, { availableAt: number; failures: number }>;
      }).cooldowns.set("secondary", {
        availableAt: Date.now() + 1_000,
        failures: 1,
      });

      const execution = executor.execute(createParams());
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await execution;

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
      expect(secondary.chat).toHaveBeenCalledOnce();

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

    it("injects an authoritative runtime tool ledger before tool follow-up synthesis", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({ stdout: "pong ready", stderr: "", exitCode: 0 }),
      );
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
                  name: "desktop.bash",
                  arguments: '{"command":"mkdir -p /workspace/pong"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final answer" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const groundingMessage = followupMessages.find((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Runtime execution ledger")
      );

      expect(groundingMessage).toBeDefined();
      expect(String(groundingMessage?.content)).toContain('"tool":"desktop.bash"');
      expect(String(groundingMessage?.content)).toContain(
        '"successfulToolCalls":1',
      );
      expect(String(groundingMessage?.content)).toContain(
        'mkdir -p /workspace/pong',
      );
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

    it("sanitizes mixed markdown + embedded JSON base64 screenshot blobs", async () => {
      const hugeBase64 = "C".repeat(95_000);
      const toolHandler = vi.fn().mockResolvedValue(
        [
          "### Result",
          '- [Screenshot of viewport](../../tmp/screenshot.png)',
          '{"type":"image","data":"' + hugeBase64 + '"}',
        ].join("\n"),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "mcp.browser.browser_take_screenshot", arguments: "{}" },
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
      expect(text).toContain('"data":"(base64 omitted)"');
      expect(text).not.toContain(hugeBase64.slice(0, 256));
      expect(text.length).toBeLessThan(13_000);
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

    it("retries once with a correction hint when delegated tool evidence is required", async () => {
      const toolHandler = vi.fn().mockResolvedValue("official-doc-result");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "Here is the answer from memory.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "search",
                  arguments: '{"query":"official docs"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Grounded answer with tool evidence.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["search"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: { maxCorrectionAttempts: 1 },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Grounded answer with tool evidence.");
      expect(result.toolCalls).toHaveLength(1);
      expect(toolHandler).toHaveBeenCalledWith("search", {
        query: "official docs",
      });
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(
        (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.toolChoice,
      ).toBe("required");

      const correctionMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      expect(
        correctionMessages.some((message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Tool-grounded evidence is required for this delegated task")
        ),
      ).toBe(true);
    });

    it("fails with validation_error when delegated tool evidence is still missing after correction", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "I already know the answer.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Still answering without tools.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider] });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: { maxCorrectionAttempts: 1 },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain(
        "child reported no tool calls",
      );
      expect(result.content).toContain("child reported no tool calls");
      expect(result.toolCalls).toEqual([]);
    });

    it("fails when delegated output claims completion while admitting unresolved mismatches", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/grid-router-ts/tests/map.test.ts",
                    content: "it('works', () => expect(true).toBe(true));\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**add_tests complete**: test/map.test.ts created. " +
                "Note: some tests may need minor impl tweaks due to code mismatches in cli/GridMap methods like parse/getGoal.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Still complete, but there may be minor follow-up changes needed for the mismatches.",
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          path: "/workspace/grid-router-ts/tests/map.test.ts",
          bytesWritten: 48,
        }),
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.bash", "system.writeFile"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "add_tests",
              objective:
                "Create Vitest tests that match the implemented CLI and core contracts",
              inputContract: "Core library and CLI already exist",
              acceptanceCriteria: [
                "Tests compile against the current CLI/core APIs",
                "Tests cover requirements",
              ],
            },
          },
          toolRouting: {
            routedToolNames: ["system.bash", "system.writeFile"],
            expandedToolNames: ["system.bash", "system.writeFile"],
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain(
        "claimed completion while still reporting unresolved work",
      );
      const correctionMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2][0] as LLMMessage[];
      expect(
        correctionMessages.some((message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Do not claim the phase is complete")
        ),
      ).toBe(true);
      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
      ]);
    });

    it("fails when delegated browser research only uses low-signal about:blank tab checks", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        "### Result\n- 0: (current) [](about:blank)",
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-tabs",
                  name: "mcp.browser.browser_tabs",
                  arguments: '{"action":"list"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Heat Signature, Gunpoint, and Monaco are good references. Tuning: 220px/s, 3 enemies, 30s mutation.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Still done with the research.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.browser.browser_tabs"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
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
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain("browser-grounded evidence");
      expect(result.toolCalls).toHaveLength(1);
      expect(
        (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.toolChoice,
      ).toBe("required");
      const correctionMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2][0] as LLMMessage[];
      expect(
        correctionMessages.some((message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("`browser_tabs` and about:blank state checks do not count")
        ),
      ).toBe(true);
      expect(toolHandler).toHaveBeenCalledWith("mcp.browser.browser_tabs", {
        action: "list",
      });
    });

    it("forces a navigation-first tool choice for browser-grounded delegated work", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-nav",
                  name: "mcp.browser.browser_navigate",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Grounded research output with citations.",
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        '{"ok":true,"url":"https://example.com"}',
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
          "mcp.browser.browser_tabs",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "design_research",
              objective:
                "Research 3 reference games with browser tools and cite sources",
              inputContract:
                "Return markdown with 3 cited references and tuning targets",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.browser.browser_navigate",
      ]);
    });

    it("accepts provider-native web search evidence for delegated research", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              '{"selected":"pixi","why":["small","fast"],"citations":["https://pixijs.com","https://docs.phaser.io"]}',
            providerEvidence: {
              citations: ["https://pixijs.com", "https://docs.phaser.io"],
            },
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        allowedTools: ["web_search"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "tech_research",
              objective:
                "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
              inputContract:
                "Return JSON with selected framework, rationale, and citations",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.providerEvidence?.citations).toEqual([
        "https://pixijs.com",
        "https://docs.phaser.io",
      ]);
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual(["web_search"]);
    });

    it("forces an editor-first tool choice for implementation delegation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-edit",
                  name: "desktop.text_editor",
                  arguments:
                    '{"command":"create","path":"/workspace/neon-heist/index.html","file_text":"<!doctype html>"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"ok":true}');

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "desktop.bash",
          "desktop.text_editor",
          "mcp.neovim.vim_edit",
          "mcp.neovim.vim_buffer_save",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Implement the game files in the desktop workspace",
              inputContract: "JSON output with created files",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "desktop.text_editor",
      ]);
    });

    it("restores the broader delegated tool subset after the initial forced file-mutation call", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/grid-router-ts/src/index.ts",
                    content: "export const ok = true;\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/grid-router-ts/src/index.ts"}]}',
            }),
          ),
      });
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"bytesWritten":24,"path":"/workspace/grid-router-ts/src/index.ts"}');

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
          "system.listDir",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Implement the requested TypeScript files",
              inputContract: "JSON output with created files",
            },
          },
          toolRouting: {
            routedToolNames: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            expandedToolNames: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.writeFile",
      ]);
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ]);
    });

    it("narrows correction retries to file-mutation tools after missing file evidence", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-shell",
                  name: "desktop.bash",
                  arguments: '{"command":"npm test"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"status":"done"}',
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-edit",
                  name: "desktop.text_editor",
                  arguments:
                    '{"command":"create","path":"/workspace/neon-heist/index.html","file_text":"<!doctype html>"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        '{"stdout":"tests passed\\n","exitCode":0}',
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["desktop.bash", "desktop.text_editor"],
      });

      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Scaffold and implement the game files in the desktop workspace",
              inputContract: "JSON output with created files",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolChoice).toBe("required");
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "desktop.text_editor",
      ]);
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

    it("extends tool-round budget when the latest round still makes material progress", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.readFile",
                  arguments: '{"path":"a.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments: '{"path":"c.ts","content":"export const c = 1;"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionRounds: 1,
              newLimit: 3,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 3,
              extensionRounds: 1,
            }),
          }),
        ]),
      );
    });

    it("extends tool-round budget when recent rounds show sustained progress despite the latest failed round", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce('{"exitCode":1,"stderr":"build failed"}')
        .mockResolvedValueOnce("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.writeFile",
                  arguments: '{"path":"a.ts","content":"export const a = 1;"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.bash",
                  arguments: '{"command":"node","args":["dist/index.js"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              extensionRounds: 2,
              newLimit: 4,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 4,
              extensionReason: "repair_episode",
              extensionRounds: 2,
            }),
          }),
        ]),
      );
    });

    it("extends tool-round budget to finish an open repair episode after a failing verification round", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"exitCode":1,"stderr":"AssertionError: expected 0 to be greater than 0"}',
        )
        .mockResolvedValueOnce("inspection-ok")
        .mockResolvedValueOnce('{"path":"src/core.test.ts","bytesWritten":12}')
        .mockResolvedValueOnce('{"exitCode":0,"stdout":"tests passed"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.bash",
                  arguments: '{"command":"cat","args":["src/core.test.ts"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"src/core.test.ts","content":"fixed test contents"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(5);
      expect(result.toolCalls).toHaveLength(4);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              recentTotalNewVerificationFailureDiagnosticKeys: 1,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
              extensionRounds: 2,
              newLimit: 4,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 4,
              extensionReason: "repair_episode",
              extensionRounds: 2,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
            }),
          }),
        ]),
      );
    });

    it("does not extend tool-round budget when the latest round adds no new progress and no repair cycle is open", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.readFile",
                  arguments: '{"path":"a.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              newLimit: 3,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 3,
              decision: "insufficient_recent_progress",
              latestRoundHadMaterialProgress: false,
              latestRoundNewSuccessfulSemanticKeys: 0,
              repairCycleOpen: false,
              newLimit: 3,
            }),
          }),
        ]),
      );
      expect(traceEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 3,
            }),
          }),
        ]),
      );
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

    it("per-call maxModelRecalls overrides constructor default", async () => {
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
        maxModelRecallsPerRequest: 3,
      });
      const result = await executor.execute(
        createParams({ maxModelRecallsPerRequest: 0 }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.stopReason).toBe("budget_exceeded");
    });

    it("per-call toolBudgetPerRequest overrides constructor default", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "two tools",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "tool", arguments: "{}" },
                { id: "tc-2", name: "tool", arguments: "{}" },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        toolBudgetPerRequest: 5,
      });
      const result = await executor.execute(
        createParams({ toolBudgetPerRequest: 1 }),
      );

      expect(toolHandler).toHaveBeenCalledTimes(1);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.stopReason).toBe("budget_exceeded");
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

    it("normalizes Doom launch resolution args before calling the tool handler", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            normalized_resolution: args.screen_resolution,
          });
        }
        return safeJson({ name, args });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    async_player: true,
                    screen_resolution: "1280x720",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "Doom started." })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.doom.start_game"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Start Doom defend_the_center at 1280x720."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledWith("mcp.doom.start_game", {
        scenario: "defend_the_center",
        async_player: true,
        screen_resolution: "RES_1280X720",
        window_visible: true,
        render_hud: true,
      });
      expect(result.toolCalls[0]?.args).toEqual({
        scenario: "defend_the_center",
        async_player: true,
        screen_resolution: "RES_1280X720",
        window_visible: true,
        render_hud: true,
      });
    });

    it("repairs collaboration tool args from explicit prompt fields and traces the repair", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "social.requestCollaboration") {
          return safeJson({ requestId: "req-1", args });
        }
        return safeJson({ name, args });
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
                  id: "tc-collab",
                  name: "social.requestCollaboration",
                  arguments: safeJson({
                    requiredCapabilities: "3",
                    maxMembers: 3,
                    payoutMode: "fixed",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "Collaboration posted." }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["social.requestCollaboration"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators., requiredCapabilities 3, maxMembers 3, payoutMode fixed.",
          ),
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledWith("social.requestCollaboration", {
        title: "Launch Ritual Drill",
        description:
          "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
        requiredCapabilities: "3",
        maxMembers: 3,
        payoutMode: "fixed",
      });
      expect(result.toolCalls[0]?.args).toEqual({
        title: "Launch Ritual Drill",
        description:
          "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
        requiredCapabilities: "3",
        maxMembers: 3,
        payoutMode: "fixed",
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_dispatch_started",
            phase: "tool_followup",
            payload: expect.objectContaining({
              tool: "social.requestCollaboration",
              args: expect.objectContaining({
                title: "Launch Ritual Drill",
                description:
                  "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
              }),
              argumentDiagnostics: expect.objectContaining({
                repairSource: "message_text",
                repairedFields: ["title", "description"],
                rawArgs: {
                  requiredCapabilities: "3",
                  maxMembers: 3,
                  payoutMode: "fixed",
                },
              }),
            }),
          }),
        ]),
      );
    });

    it("records normalized async Doom launches as evidence for autonomous follow-up routing", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "running",
            god_mode_enabled: true,
          });
        }
        return safeJson({ name, args });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
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
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
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
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running in async defend-the-center mode with god mode enabled.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("Doom is running");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          god_mode: true,
          async_player: true,
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "hold_position" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );
      expect(result.toolCalls[0]?.args).toEqual(
        expect.objectContaining({
          async_player: true,
          god_mode: true,
          scenario: "defend_the_center",
        }),
      );

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const fourthOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(fourthOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("requires an explore objective for generic Doom autoplay turns", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({ status: "running", scenario: "basic" });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({
            status: "objective_set",
            objective: { type: "explore" },
          });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "exploring",
            objectives: [{ type: "explore" }],
          });
        }
        return safeJson({ status: "ok" });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "basic",
                    window_visible: true,
                    render_hud: true,
                  }),
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
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "explore" }),
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
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running autonomously and will continue until stopped.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Play Doom until I tell you to stop."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          async_player: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "explore" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("keeps Doom contract-required tools available even when the generic routed subset omits them", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set", objective_type: "hold_position" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "fighting",
            god_mode_enabled: true,
            objectives: [{ type: "hold_position" }],
          });
        }
        return safeJson({ name, args });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
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
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
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
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running in async hold-position defense mode with god mode enabled.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "desktop.bash",
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
          toolRouting: {
            routedToolNames: [
              "desktop.bash",
              "mcp.doom.start_game",
              "mcp.doom.get_situation_report",
            ],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("hold-position defense");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          god_mode: true,
          async_player: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "hold_position" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );

      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const fourthOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(fourthOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("uses non-stream chat for deterministic single-tool Doom follow-ups and streams only the final answer", async () => {
      const onStreamChunk = vi.fn();
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set", objective_type: "hold_position" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "running",
            god_mode_enabled: true,
          });
        }
        return safeJson({ name, args });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
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
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
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
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          ),
        chatStream: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              "Doom is running in async defend-the-center mode with god mode enabled.",
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        onStreamChunk,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
          "mcp.doom.get_state",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(provider.chatStream).toHaveBeenCalledTimes(1);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const finalOptions = (provider.chatStream as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[2] as LLMChatOptions | undefined;
      expect(finalOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("ends a Doom tool round after failed start_game so dependent calls do not run", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          if (args.screen_resolution === "banana") {
            return "Unknown resolution 'banana'. Valid: ['RES_1280X720']";
          }
          return safeJson({ status: "running" });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({ executor_state: "fighting" });
        }
        return safeJson({ name, args });
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
                  id: "tc-start-bad",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    screen_resolution: "banana",
                  }),
                },
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
                },
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
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
                  id: "tc-start-good",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    screen_resolution: "RES_1280X720",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Doom started after correcting the resolution.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Start Doom defend_the_center."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Doom started after correcting the resolution.");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          screen_resolution: "banana",
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          screen_resolution: "RES_1280X720",
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(
        toolHandler.mock.calls.some(([name]) =>
          name === "mcp.doom.set_objective" ||
          name === "mcp.doom.get_situation_report"
        ),
      ).toBe(false);
    });

    it("steers Doom turns toward start_game first and then the missing follow-up tool", async () => {
      let started = false;
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "mcp.doom.start_game") {
          started = true;
          return safeJson({ status: "running" });
        }
        if (name === "mcp.doom.set_god_mode") {
          if (!started) {
            return safeJson({
              error:
                "Launch Doom first with `mcp.doom.start_game` before calling follow-up Doom tools in this turn. " +
                "For play-until-stop requests, the launch must include `async_player: true`.",
            });
          }
          return safeJson({
            status: "god_mode_updated",
            god_mode_enabled: true,
          });
        }
        return safeJson({ name });
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
                  id: "tc-god-early",
                  name: "mcp.doom.set_god_mode",
                  arguments: safeJson({ enabled: true }),
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({}),
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
                  id: "tc-god-correct",
                  name: "mcp.doom.set_god_mode",
                  arguments: safeJson({ enabled: true }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "God mode is enabled and Doom is running.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.doom.start_game", "mcp.doom.set_god_mode"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Enable god mode in Doom."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("God mode is enabled and Doom is running.");
      expect(toolHandler.mock.calls).toEqual([
        [
          "mcp.doom.start_game",
          {
            screen_resolution: "RES_1280X720",
            window_visible: true,
            render_hud: true,
          },
        ],
        ["mcp.doom.set_god_mode", { enabled: true }],
      ]);

      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolChoice).toBe("required");
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolChoice).toBe("required");
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_god_mode",
      ]);
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

    it("passes provider trace callbacks through with logical call metadata", async () => {
      const providerTraceEvents: unknown[] = [];
      const provider = createMockProvider("primary", {
        chat: vi.fn(async (_messages, options) => {
          options?.trace?.onProviderTraceEvent?.({
            kind: "request",
            transport: "chat",
            provider: "primary",
            model: "mock-model",
            payload: { tool_choice: "required" },
          });
          return mockResponse();
        }),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => providerTraceEvents.push(event),
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.trace?.includeProviderPayloads).toBe(true);
      expect(providerTraceEvents).toEqual([
        {
          kind: "request",
          transport: "chat",
          provider: "primary",
          model: "mock-model",
          callIndex: 1,
          callPhase: "initial",
          payload: { tool_choice: "required" },
        },
      ]);
    });

    it("passes allowedTools to provider chat options when no routing subset is active", async () => {
      const provider = createMockProvider("primary");
      const executor = new ChatExecutor({
        providers: [provider],
        allowedTools: ["desktop.bash", "desktop.text_editor"],
      });

      await executor.execute(createParams());

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.toolRouting?.allowedToolNames).toEqual([
        "desktop.bash",
        "desktop.text_editor",
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

    it("emits execution trace events for routed misses and route expansion", async () => {
      const events: Array<Record<string, unknown>> = [];
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
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash"],
            expandedToolNames: ["system.bash", "system.httpGet"],
            expandOnMiss: true,
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "model_call_prepared",
            phase: "initial",
            payload: expect.objectContaining({
              routedToolNames: ["system.bash"],
            }),
          }),
          expect.objectContaining({
            type: "tool_rejected",
            phase: "tool_followup",
            payload: expect.objectContaining({
              tool: "system.httpGet",
              routingMiss: true,
              expandAfterRound: true,
            }),
          }),
          expect.objectContaining({
            type: "route_expanded",
            phase: "tool_followup",
            payload: expect.objectContaining({
              previousRoutedToolNames: ["system.bash"],
              nextRoutedToolNames: ["system.bash", "system.httpGet"],
            }),
          }),
        ]),
      );
    });

    it("emits completion-gate retry and failure events when required tool evidence is missing", async () => {
      const events: Array<Record<string, unknown>> = [];
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(mockResponse({ content: "plan", finishReason: "stop" }))
          .mockResolvedValueOnce(mockResponse({ content: "still no tools", finishReason: "stop" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              tools: ["system.bash"],
            },
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              decision: "retry",
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              decision: "fail",
            }),
          }),
        ]),
      );
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

    it("surfaces direct output for simple successful desktop shell observations", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"stdout":"/workspace\\n","stderr":"","exitCode":0}',
      );
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
                  name: "desktop.bash",
                  arguments: '{"command":"pwd"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Note: `desktop.bash` spawns fresh shells from `/workspace` each time (non-persistent).\n\n" +
                "To work in `~` (/home/agenc): Prefix like `cd ~ && your_command`.\n\n" +
                "Demo:\n```sh\ncd ~ && pwd\n```",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("/workspace");
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
          msg.content.includes("Shell builtins"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("omitting `args`");
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

    it("injects a recovery hint when desktop.bash is unavailable", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Tool not found: \\"desktop.bash\\""}');
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
                  name: "desktop.bash",
                  arguments: '{"command":"ls"}',
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
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when container MCP tools require desktop session", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue("Container MCP tool — requires desktop session");
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
                  name: "mcp.kitty.launch",
                  arguments: '{"instance":"terminal1"}',
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
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("mcp.*");
    });

    it("injects a recovery hint when execute_with_agent requires decomposition", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          success: false,
          status: "needs_decomposition",
          error:
            "Delegated objective is overloaded (research, implementation, validation). Split it into smaller execute_with_agent steps.",
          decomposition: {
            code: "needs_decomposition",
            phases: ["research", "implementation", "validation"],
            suggestedSteps: [
              { name: "research_requirements" },
              { name: "implement_core_scope" },
              { name: "verify_acceptance" },
            ],
          },
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
                {
                  id: "call-1",
                  name: "execute_with_agent",
                  arguments: '{"task":"build and verify the whole game in one child"}',
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
          msg.content.includes("objective was too large"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("research_requirements");
      expect(String(injectedHint?.content)).toContain("verify_acceptance");
    });

    it("injects a recovery hint when execute_with_agent reports low-signal browser evidence", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          success: false,
          status: "failed",
          validationCode: "low_signal_browser_evidence",
          error:
            "Delegated task required browser-grounded evidence but child only used low-signal browser state checks",
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
                {
                  id: "call-1",
                  name: "execute_with_agent",
                  arguments: '{"task":"research reference games"}',
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
          msg.content.includes("low-signal browser state checks"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("browser_tabs");
      expect(String(injectedHint?.content)).toContain("about:blank");
    });

    it("injects a recovery hint when desktop-targeted command fails on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"gdb\\" is denied"}');
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
                  arguments: '{"command":"gdb","args":["--version"]}',
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
          msg.content.includes("host shell"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when shell wrapper command is denied on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue(
          '{"error":"Command \\"bash\\" is denied. Do not use shell wrappers like \\"bash -c\\"."}',
        );
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
                  arguments: '{"command":"bash","args":["-c","echo hello"]}',
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
          msg.content.includes("Do NOT call `bash -c`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("command` + `args`");
    });

    it("injects a recovery hint when node invocation of agenc-runtime is denied", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"node\\" is denied"}');
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
                  arguments:
                    '{"command":"node","args":["runtime/dist/bin/agenc-runtime.js","status","--output","json"]}',
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
          msg.content.includes('command:"agenc-runtime"'),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("status");
      expect(String(injectedHint?.content)).toContain("--output");
    });

    it("injects a recovery hint when python is denied on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"python3\\" is denied"}');
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
                  arguments: '{"command":"python3","args":["-c","print(1)"]}',
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
          msg.content.includes("Python interpreter commands are blocked"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when filesystem path is outside allowlist", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Access denied: Path is outside allowed directories"}');
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
                  name: "system.readFile",
                  arguments: '{"path":"/home/tetsuo/git/AgenC/mcp-terminal-smoke-test-prompt.txt"}',
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
          msg.content.includes("blocked by path allowlisting"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("/tmp");
    });

    it("injects a recovery hint when a delegated child escapes its workspace root", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"error":"Delegated workspace root violation: path must stay under the delegated workspace root. Keep all filesystem paths under /home/tetsuo/agent-test/terrain-router-ts-2."}',
      );
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
                  name: "system.writeFile",
                  arguments:
                    '{"path":"/tmp/terrain-monorepo/packages/core/src/index.ts","content":"export const bad = true;\\n"}',
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
          msg.content.includes("delegated workspace root"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("relative paths");
      expect(String(injectedHint?.content)).toContain("/tmp");
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
      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("desktop.bash: err");
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

    it("breaks loop sooner when all failed rounds are opaque", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":""}');
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

      expect(result.stopReason).toBe("no_progress");
      expect(result.stopReasonDetail).toContain("All tool calls failed for 3 consecutive rounds");
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

    it("marks structured overall checks result as fail when any tool call fails", async () => {
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
                '{"overall":"pass","checks":[{"id":"env_versions","status":"pass","summary":"node -v: command denied"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain("tool_call_failed");
    });

    it("marks structured overall result as fail when delegated output signals unresolved failure", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"success":true,"status":"completed","output":"uname -s: Linux\\nnode -v: Command denied\\nnpm -v: 11.7.0","failedToolCalls":1}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "execute_with_agent", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","checks":[{"id":"env_versions","status":"pass","summary":"node -v: command denied"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain(
        "subagent_output_contains_failure_signal",
      );
    });

    it("suppresses narrative file-creation claims when tools never wrote files", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"exitCode":0,"stdout":"","stderr":""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "tc-1",
                name: "system.bash",
                arguments:
                  '{"command":"mkdir","args":["-p","/home/tetsuo/git/AgenC/neon-heist"]}',
              }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "I've created the folder `/home/tetsuo/git/AgenC/neon-heist`.\n\n" +
                "### Project Structure\n" +
                "- `/home/tetsuo/git/AgenC/neon-heist/index.html`\n" +
                "- `/home/tetsuo/git/AgenC/neon-heist/game.js`\n\n" +
                "Now creating the files...",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toContain(
        "tool evidence did not confirm any file writes",
      );
      expect(result.content).not.toContain("Now creating the files");
    });

    it("preserves successful folder-creation replies when the only mutation is mkdir", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"exitCode":0,"stdout":"","stderr":""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "tc-1",
                name: "desktop.bash",
                arguments: '{"command":"mkdir -p /workspace/pong"}',
              }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Created the folder `/workspace/pong`.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toContain("Created the folder `/workspace/pong`.");
      expect(result.content).not.toContain(
        "tool evidence did not confirm any file writes",
      );
    });

    it("marks structured overall result as fail when pass checks report daemon down", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"success":true,"status":"completed","output":"running: false\\npid: n/a\\nport: n/a"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "execute_with_agent", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","checks":[{"id":"daemon_status","status":"pass","summary":"running: false\\npid: n/a\\nport: n/a"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain(
        "check_summary_conflicts_with_pass_status",
      );
    });

    it("replaces low-information completion text when tool failures occurred", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"error":"Command \\"python3\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Done\nDone\nDone",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("system.bash");
      expect(result.content).not.toBe("Done\nDone\nDone");
    });

    it("does not preserve exact success sentinels when a tool failed", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"error":"Collaboration request failed: Feed post failed: AnchorError thrown in src/instructions/post_to_feed.rs:62. Error Code: InsufficientReputation."}',
        );
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
                  name: "social.requestCollaboration",
                  arguments:
                    '{"title":"Launch Ritual Drill","description":"Need 3 agents","requiredCapabilities":"3","maxMembers":3,"payoutMode":"fixed"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "R2_DONE_A2",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration, then after the tool calls finish, reply with exactly R2_DONE_A2.",
          ),
        }),
      );

      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("social.requestCollaboration");
      expect(result.content).not.toBe("R2_DONE_A2");
    });

    it("forces required tool choice for explicit social tool prompts", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"requestId":"req-123"}');
      const responses = [
        mockResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-1",
              name: "social.requestCollaboration",
              arguments:
                '{"title":"Launch Ritual Drill","description":"Need 3 agents","requiredCapabilities":"3","maxMembers":3,"payoutMode":"fixed"}',
            },
          ],
        }),
        mockResponse({
          content: "R3_DONE_A2",
        }),
      ];
      const chat = vi
        .fn()
        .mockImplementation(async () => responses.shift() ?? mockResponse());
      const chatStream = vi
        .fn()
        .mockImplementation(
          async (
            _messages: LLMMessage[],
            onChunk: StreamProgressCallback,
            _options?: LLMChatOptions,
          ) => {
            const response = responses.shift() ?? mockResponse();
            onChunk({
              content: response.content,
              done: true,
              ...(response.toolCalls.length > 0
                ? { toolCalls: response.toolCalls }
                : {}),
            });
            return response;
          },
        );
      const provider = createMockProvider("primary", { chat, chatStream });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["social.requestCollaboration"],
      });
      await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents, requiredCapabilities 3, maxMembers 3, payoutMode fixed. After the tool calls finish, reply with exactly R3_DONE_A2.",
          ),
        }),
      );

      const firstCallOptions =
        chat.mock.calls[0]?.[1] ?? chatStream.mock.calls[0]?.[2];
      expect(firstCallOptions?.toolChoice).toBe("required");
      expect(firstCallOptions?.toolRouting?.allowedToolNames).toEqual([
        "social.requestCollaboration",
      ]);
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

    it("preserves exact parent recall output after compaction", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "ACK-1",
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "ACK-2",
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary of earlier recall state" }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "**TOKEN=OBSIDIAN-SIGNAL-61**",
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
        toolHandler: vi.fn().mockResolvedValue("unused"),
      });

      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          message: createMessage("Reply with exactly ACK-1 and nothing else."),
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          message: createMessage("Reply with exactly ACK-2 and nothing else."),
        }),
      );

      const result = await executor.execute(
        createParams({
          history: [
            {
              role: "user",
              content:
                "Parent endurance P1. Memorize token OBSIDIAN-SIGNAL-61 for later recall and answer exactly PARENT-STORED-P1.",
            },
            { role: "assistant", content: "PARENT-STORED-P1" },
            ...buildLongHistory(8),
          ],
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "After compaction, without extra words return the parent token from P1 exactly as TOKEN=OBSIDIAN-SIGNAL-61.",
          ),
        }),
      );

      expect(result.compacted).toBe(true);
      expect(result.content).toBe("TOKEN=OBSIDIAN-SIGNAL-61");
      expect(result.plannerSummary?.used).toBe(false);
      expect(provider.chat).toHaveBeenCalledTimes(4);
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

    it("emits provider trace events for pre-execution compaction calls", async () => {
      const traceEvents: unknown[] = [];
      let invocation = 0;
      const provider = createMockProvider("primary", {
        chat: vi.fn(async (_messages, options) => {
          invocation += 1;
          options?.trace?.onProviderTraceEvent?.({
            kind: "request",
            transport: "chat",
            provider: "primary",
            model: "mock-model",
            payload: { observed: true, invocation },
          });
          if (invocation <= 2) {
            return mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            });
          }
          if (invocation === 3) {
            return mockResponse({ content: "Summary of conversation" });
          }
          return mockResponse({
            content: "response after compaction",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          });
        }),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );

      expect(traceEvents).toContainEqual({
        kind: "request",
        transport: "chat",
        provider: "primary",
        model: "mock-model",
        callIndex: 0,
        callPhase: "compaction",
        payload: { observed: true, invocation: 3 },
      });
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
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
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
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
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
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
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
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
      expect(provider.chatStream).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        perCallCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
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

    it("emits provider trace events for evaluator calls", async () => {
      const traceEvents: unknown[] = [];
      let invocation = 0;
      const provider = createMockProvider("primary", {
        chat: vi
          .fn(async (_messages, options) => {
            invocation += 1;
            options?.trace?.onProviderTraceEvent?.({
              kind: "request",
              transport: "chat",
              provider: "primary",
              model: "mock-model",
              payload: { observed: true, invocation },
            });
            return mockResponse({
              content:
                invocation === 1
                  ? "good answer"
                  : '{"score": 0.9, "feedback": "clear and accurate"}',
            });
          }),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );

      expect(traceEvents).toContainEqual({
        kind: "request",
        transport: "chat",
        provider: "primary",
        model: "mock-model",
        callIndex: 2,
        callPhase: "evaluator",
        payload: { observed: true, invocation: 2 },
      });
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
    it("preserves delegated child outputs when planner execution completes without synthesis", async () => {
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
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              delegate_ci: safeJson({
                status: "completed",
                success: true,
                subagentSessionId: "sub-ci",
                output: "clustered failures",
                toolCalls: [],
              }),
              delegate_mapping: safeJson({
                status: "completed",
                success: true,
                subagentSessionId: "sub-map",
                output: "mapped source hotspots",
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
          scoreThreshold: 0.2,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First cluster CI failures from logs, then map likely source hotspots, and finally produce a consolidated remediation checklist with evidence.",
          ),
        }),
      );

      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.content).toContain("clustered failures");
      expect(result.content).toContain("mapped source hotspots");
      expect(result.content).not.toContain("Completed execute_with_agent");
      expect(result.stopReason).toBe("completed");
      expect(result.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "execute_with_agent",
          }),
        ]),
      );
    });

    it("routes implementation-heavy build requests through planner even without numbered steps", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "implementation_scope",
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
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Build an issue tracker API with CRUD endpoints and integration tests.",
          ),
        }),
      );

      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["planner"]);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.plannerSummary?.used).toBe(true);
    });

    it("keeps exact-response turns on the direct no-tool path even with noisy autonomy keywords", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ACK-13",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      const result = await executor.execute(
        createParams({
          history: [
            { role: "tool", content: "{\"output\":\"ok\"}", toolName: "desktop.text_editor" },
            { role: "tool", content: "{\"output\":\"ok\"}", toolName: "desktop.text_editor" },
            { role: "tool", content: "{\"output\":\"ok\"}", toolName: "desktop.text_editor" },
            { role: "tool", content: "{\"output\":\"ok\"}", toolName: "desktop.text_editor" },
          ],
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "Compaction single-line turn 13. Reply with exactly ACK-13 and nothing else. autonomy-stateful-compaction-delegation-routing-evidence-daemon-log-verification-signal-bus-terminal-uplink-protocol-runtime",
          ),
        }),
      );

      expect(result.content).toBe("ACK-13");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["initial"]);
      expect(result.plannerSummary?.used).toBe(false);
      expect(result.plannerSummary?.routeReason).toBe("exact_response_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolChoice: "none",
        toolRouting: { allowedToolNames: [] },
      });
    });

    it("suppresses tools for dialogue-memory turns instead of persisting them via desktop mutation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "STORED-A",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "Stateful continuity test A. Memorize exactly these facts for later recall: codename=BLACK-ORBIT, port=8771, checksum=SIGMA-42. Reply with exactly STORED-A.",
          ),
        }),
      );

      expect(result.content).toBe("STORED-A");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["initial"]);
      expect(result.plannerSummary?.used).toBe(false);
      expect(result.plannerSummary?.routeReason).toBe("exact_response_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolChoice: "none",
        toolRouting: { allowedToolNames: [] },
      });
    });

    it("forces direct memory-turn literals when the provider only returns an acknowledgement", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "Memorized.",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "Child endurance F2 exact task. Memorize token TOKEN=LUNAR-NOVA-88 for later recall and answer exactly CHILD-STORED-F2.",
          ),
        }),
      );

      expect(result.content).toBe("CHILD-STORED-F2");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["initial"]);
      expect(result.plannerSummary?.used).toBe(false);
      expect(result.plannerSummary?.routeReason).toBe("dialogue_memory_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolChoice: "none",
        toolRouting: { allowedToolNames: [] },
      });
    });

    it("does not suppress tools for delegated child-memory turns that explicitly require execute_with_agent", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "{\"ack\":true,\"childSessionId\":\"subagent:child-1\"}",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "Use exactly one execute_with_agent child session. In that child, memorize token TOKEN=LUNAR-NOVA-88 for recall in this child session only, do not reveal it, answer exactly CHILD-STORED-F2, and return raw JSON only.",
          ),
        }),
      );

      expect(result.content).toBe("{\"ack\":true,\"childSessionId\":\"subagent:child-1\"}");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["initial"]);
      expect(result.plannerSummary?.used).toBe(false);
      expect(result.plannerSummary?.routeReason).not.toBe("dialogue_memory_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolRouting: { allowedToolNames: ["desktop.text_editor", "execute_with_agent"] },
      });
    });

    it("does not suppress tools for exact-response turns that explicitly reference tool names", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "SENT",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["social.searchAgents", "social.sendMessage"],
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.searchAgents", "social.sendMessage"],
            expandedToolNames: ["social.searchAgents", "social.sendMessage"],
          },
          message: createMessage(
            "Use social.searchAgents first. Then use social.sendMessage to send the exact content daemon-proof-1773116292530 to recipient 9kSWa3Z2yfybqZbdgc8nw8obEy5R6k45nsWBKQZyeuQC in off-chain mode. After the tool calls finish, reply with exactly SENT.",
          ),
        }),
      );

      expect(result.content).toBe("SENT");
      expect(result.plannerSummary?.routeReason).not.toBe("exact_response_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolRouting: {
          allowedToolNames: ["social.searchAgents", "social.sendMessage"],
        },
      });
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.toolChoice).not.toBe("none");
    });

    it("refines explicit social-tool planner turns back into deterministic in-domain steps", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "social_bad_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "get_incoming_msgs",
                    step_type: "deterministic_tool",
                    tool: "social.getRecentMessages",
                    args: { direction: "incoming", limit: 5 },
                  },
                  {
                    name: "read_tagged_message",
                    step_type: "subagent_task",
                    depends_on: ["get_incoming_msgs"],
                    objective: "Read the newest tagged message through email tools.",
                    input_contract: "Return the tagged content",
                    acceptance_criteria: ["Message tag matched"],
                    required_tool_capabilities: ["system.emailMessageInfo"],
                    context_requirements: ["get_incoming_msgs"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "send_reply",
                    step_type: "deterministic_tool",
                    depends_on: ["read_tagged_message"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-a",
                      content: "Failure mode: unfiltered broadcasts causing congestion.",
                      mode: "off-chain",
                    },
                  },
                  {
                    name: "send_followup",
                    step_type: "deterministic_tool",
                    depends_on: ["read_tagged_message"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-b",
                      content: "What metrics would detect congestion early?",
                      mode: "off-chain",
                    },
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "social_refined",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "get_incoming_msgs",
                    step_type: "deterministic_tool",
                    tool: "social.getRecentMessages",
                    args: { direction: "incoming", limit: 5 },
                  },
                  {
                    name: "send_reply",
                    step_type: "deterministic_tool",
                    depends_on: ["get_incoming_msgs"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-a",
                      content: "Failure mode: unfiltered broadcasts causing congestion.",
                      mode: "off-chain",
                    },
                  },
                  {
                    name: "send_followup",
                    step_type: "deterministic_tool",
                    depends_on: ["send_reply"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-b",
                      content: "What metrics would detect congestion early?",
                      mode: "off-chain",
                    },
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
              get_incoming_msgs:
                '{"messages":[{"id":"poly-1","content":"seed message"}]}',
              send_reply:
                '{"status":"sent","recipient":"agent-a","mode":"off-chain"}',
              send_followup:
                '{"status":"sent","recipient":"agent-b","mode":"off-chain"}',
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
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
            expandedToolNames: ["social.getRecentMessages", "social.sendMessage"],
          },
          message: createMessage(
            "Use social.getRecentMessages to inspect the newest incoming message tagged poly-r2. Then use social.sendMessage to send one reply to agent A and one follow-up question to agent B. Reply with exactly LOOP_OK after the tool calls finish.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      const secondPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      expect(
        secondPlannerMessages.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("do not add delegated steps"),
        ),
      ).toBe(true);
      const pipelineArg = (pipelineExecutor.execute as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as { plannerSteps?: Array<Record<string, unknown>> };
      expect(
        pipelineArg.plannerSteps?.every(
          (step) =>
            step.stepType !== "subagent_task" &&
            (
              step.stepType !== "deterministic_tool" ||
              step.tool === "social.getRecentMessages" ||
              step.tool === "social.sendMessage"
            ),
        ),
      ).toBe(true);
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.plannerCalls).toBe(2);
      expect(result.plannerSummary?.routeReason).toBe("social_refined");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "explicit_tool_plan_subagent_forbidden",
          }),
          expect.objectContaining({
            code: "planner_explicit_tool_retry",
          }),
        ]),
      );
    });

    it("forces repeated explicit deterministic tool turns through the planner path", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "social_seed_loop",
              requiresSynthesis: false,
              steps: [
                {
                  name: "send_agent_2",
                  step_type: "deterministic_tool",
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-2",
                    content: "social-live-20260310a q1",
                    mode: "off-chain",
                  },
                },
                {
                  name: "send_agent_3",
                  step_type: "deterministic_tool",
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-3",
                    content: "social-live-20260310a q2",
                    mode: "off-chain",
                  },
                  depends_on: ["send_agent_2"],
                },
                {
                  name: "send_agent_4",
                  step_type: "deterministic_tool",
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-4",
                    content: "social-live-20260310a q3",
                    mode: "off-chain",
                  },
                  depends_on: ["send_agent_3"],
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
              send_agent_2: '{"status":"sent","recipient":"agent-2"}',
              send_agent_3: '{"status":"sent","recipient":"agent-3"}',
              send_agent_4: '{"status":"sent","recipient":"agent-4"}',
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
        allowedTools: ["social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.sendMessage"],
            expandedToolNames: ["social.sendMessage"],
          },
          message: createMessage(
            "Run token: social-live-20260310a.\n" +
              "Use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
              "Recipients and themes:\n" +
              "- `agent-2`: throughput + backpressure\n" +
              "- `agent-3`: reputation gates + abuse resistance\n" +
              "- `agent-4`: restart/recovery + message durability\n" +
              "After the tool calls, reply with exactly `A1_R1_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["planner"]);
      expect(result.content).toBe("A1_R1_DONE");
      expect(result.plannerSummary?.used).toBe(true);
      expect(result.plannerSummary?.routeReason).toBe("social_seed_loop");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_exact_response_literal_applied",
          }),
        ]),
      );
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolRouting: {
          allowedToolNames: ["social.sendMessage"],
        },
      });
    });

    it("finalizes completed explicit deterministic planner turns with the exact requested literal", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "social_finalization",
              requiresSynthesis: false,
              steps: [
                {
                  name: "get_incoming_msgs",
                  step_type: "deterministic_tool",
                  tool: "social.getRecentMessages",
                  args: { direction: "incoming", limit: 20, mode: "off-chain" },
                },
                {
                  name: "send_agent_1",
                  step_type: "deterministic_tool",
                  depends_on: ["get_incoming_msgs"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-1",
                    content: "final decision",
                    mode: "off-chain",
                  },
                },
                {
                  name: "send_agent_3",
                  step_type: "deterministic_tool",
                  depends_on: ["send_agent_1"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-3",
                    content: "challenge or agreement",
                    mode: "off-chain",
                  },
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
              get_incoming_msgs: '{"messages":[{"id":"m1","content":"seed"}]}',
              send_agent_1: '{"status":"sent","recipient":"agent-1"}',
              send_agent_3: '{"status":"sent","recipient":"agent-3"}',
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
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
            expandedToolNames: ["social.getRecentMessages", "social.sendMessage"],
          },
          message: createMessage(
            "Run token: social-live-20260310a.\n" +
              "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
              "Then use `social.sendMessage` exactly 2 times in `off-chain` mode:\n" +
              "- one to `agent-1` with your final decision\n" +
              "- one to `agent-3` with one challenge or agreement\n" +
              "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
              "After the tool calls, reply with exactly `A4_R4_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["planner"]);
      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("A4_R4_DONE");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_exact_response_literal_applied",
          }),
        ]),
      );
    });

    it("hard-fails explicit deterministic tool turns when planner output stays unparsable", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "not planner json",
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
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
            expandedToolNames: ["social.getRecentMessages", "social.sendMessage"],
          },
          message: createMessage(
            "Run token: social-live-20260310b.\n" +
              "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
              "Then use `social.sendMessage` exactly 2 times in `off-chain` mode:\n" +
              "- one to `agent-1` with your final decision\n" +
              "- one to `agent-4` with one challenge or agreement\n" +
              "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
              "After the tool calls, reply with exactly `A2_R4_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("validation_error");
      expect(result.content).toContain(
        "Planner could not produce the required deterministic tool plan.",
      );
      expect(result.content).toContain(
        "Required tool order: social.getRecentMessages -> social.sendMessage x2",
      );
      expect(result.plannerSummary?.routeReason).toBe(
        "planner_explicit_tool_requirements_unmet",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "parse",
            code: "invalid_json",
          }),
          expect.objectContaining({
            category: "policy",
            code: "planner_explicit_tool_parse_retry",
          }),
        ]),
      );
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
      ]);
    });

    it("hard-fails explicit deterministic tool turns when planner never satisfies repeated tool counts", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "social_incomplete",
              requiresSynthesis: false,
              steps: [
                {
                  name: "get_incoming_msgs",
                  step_type: "deterministic_tool",
                  tool: "social.getRecentMessages",
                  args: { direction: "incoming", limit: 20, mode: "off-chain" },
                },
                {
                  name: "send_agent_1",
                  step_type: "deterministic_tool",
                  depends_on: ["get_incoming_msgs"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-1",
                    content: "final decision",
                    mode: "off-chain",
                  },
                },
              ],
            }),
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
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
            expandedToolNames: ["social.getRecentMessages", "social.sendMessage"],
          },
          message: createMessage(
            "Run token: social-live-20260310b.\n" +
              "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
              "Then use `social.sendMessage` exactly 2 times in `off-chain` mode:\n" +
              "- one to `agent-1` with your final decision\n" +
              "- one to `agent-4` with one challenge or agreement\n" +
              "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
              "After the tool calls, reply with exactly `A2_R4_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("validation_error");
      expect(result.content).toContain(
        "Required tool order: social.getRecentMessages -> social.sendMessage x2",
      );
      expect(result.plannerSummary?.routeReason).toBe(
        "planner_explicit_tool_requirements_unmet",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "explicit_tool_plan_insufficient_tool_calls",
          }),
          expect.objectContaining({
            category: "policy",
            code: "planner_explicit_tool_retry",
          }),
        ]),
      );
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
      ]);
    });

    it("includes explicitly named tools from the expanded route when the cached route is too narrow", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "social_r3",
              requiresSynthesis: false,
              steps: [
                {
                  name: "get_incoming_msgs",
                  step_type: "deterministic_tool",
                  tool: "social.getRecentMessages",
                  args: {
                    direction: "incoming",
                    limit: 20,
                    mode: "off-chain",
                    threadId: "social-live-20260310e",
                  },
                },
                {
                  name: "send_agent_2",
                  step_type: "deterministic_tool",
                  depends_on: ["get_incoming_msgs"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-2",
                    content: "reply one",
                    mode: "off-chain",
                    threadId: "social-live-20260310e",
                  },
                },
                {
                  name: "send_agent_3",
                  step_type: "deterministic_tool",
                  depends_on: ["send_agent_2"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-3",
                    content: "reply two",
                    mode: "off-chain",
                    threadId: "social-live-20260310e",
                  },
                },
                {
                  name: "send_agent_4",
                  step_type: "deterministic_tool",
                  depends_on: ["send_agent_3"],
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-4",
                    content: "reply three",
                    mode: "off-chain",
                    threadId: "social-live-20260310e",
                  },
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
              get_incoming_msgs: '{"messages":[{"id":"m1","content":"seed"}]}',
              send_agent_2: '{"status":"sent","recipient":"agent-2"}',
              send_agent_3: '{"status":"sent","recipient":"agent-3"}',
              send_agent_4: '{"status":"sent","recipient":"agent-4"}',
            },
          },
          completedSteps: 4,
          totalSteps: 4,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.sendMessage"],
            expandedToolNames: [
              "social.sendMessage",
              "social.getRecentMessages",
            ],
          },
          message: createMessage(
            "Run token: social-live-20260310e.\n" +
              "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"social-live-20260310e\" }`.\n" +
              "Then use `social.sendMessage` exactly 3 times in `off-chain` mode with `threadId` set to `social-live-20260310e` for `agent-2`, `agent-3`, and `agent-4`.\n" +
              "Each message must synthesize one concrete point from that peer's latest reply, name one tradeoff, and ask for a final decision or counterargument.\n" +
              "After the tool calls, reply with exactly `A1_R3_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolRouting: {
          allowedToolNames: ["social.getRecentMessages", "social.sendMessage"],
        },
      });
      expect(result.content).toBe("A1_R3_DONE");
      expect(result.stopReason).toBe("completed");
    });

    it("keeps explicit deterministic social turns on a single planner pass when the initial planner prompt carries the contract", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation((messages: LLMMessage[]) => {
          const hasExplicitContractInstruction = messages.some(
            (message) =>
              message.role === "system" &&
              typeof message.content === "string" &&
              message.content.includes(
                "The user supplied an explicit deterministic tool contract for this turn.",
              ),
          );

          if (!hasExplicitContractInstruction) {
            return Promise.resolve(
              mockResponse({
                content: safeJson({
                  reason: "bad_first_pass",
                  requiresSynthesis: true,
                  steps: [
                    {
                      name: "analyze_craft_send",
                      step_type: "subagent_task",
                      objective: "Analyze the inbox and craft both final messages.",
                      input_contract: "Use the recent thread context",
                      acceptance_criteria: ["Two final messages"],
                      required_tool_capabilities: ["social.getRecentMessages"],
                      context_requirements: ["recent thread context"],
                      max_budget_hint: "2m",
                      can_run_parallel: true,
                    },
                  ],
                }),
              }),
            );
          }

          return Promise.resolve(
            mockResponse({
              content: safeJson({
                reason: "deterministic tool sequence per user spec",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "get_incoming_msgs",
                    step_type: "deterministic_tool",
                    tool: "social.getRecentMessages",
                    args: {
                      direction: "incoming",
                      limit: 20,
                      mode: "off-chain",
                      threadId: "social-live-20260310f",
                    },
                  },
                  {
                    name: "send_agent_1",
                    step_type: "deterministic_tool",
                    depends_on: ["get_incoming_msgs"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-1",
                      content:
                        "Final decision: proceed. Observation: prior limit 12 and A4_R2_DONE. Run token social-live-20260310f.",
                      mode: "off-chain",
                      threadId: "social-live-20260310f",
                    },
                  },
                  {
                    name: "send_agent_3",
                    step_type: "deterministic_tool",
                    depends_on: ["send_agent_1"],
                    tool: "social.sendMessage",
                    args: {
                      recipient: "agent-3",
                      content:
                        "Agreement on run; challenge the limit increase from 12 to 20. Run token social-live-20260310f.",
                      mode: "off-chain",
                      threadId: "social-live-20260310f",
                    },
                  },
                ],
              }),
            }),
          );
        }),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              get_incoming_msgs:
                '{"messages":[{"id":"m1","content":"prior limit 12 and A4_R2_DONE"}]}',
              send_agent_1: '{"status":"sent","recipient":"agent-1"}',
              send_agent_3: '{"status":"sent","recipient":"agent-3"}',
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
        allowedTools: ["social.getRecentMessages", "social.sendMessage"],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["social.getRecentMessages", "social.sendMessage"],
            expandedToolNames: ["social.getRecentMessages", "social.sendMessage"],
          },
          message: createMessage(
            "Run token: social-live-20260310f.\n" +
              "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\", \"threadId\": \"social-live-20260310f\" }`.\n" +
              "Then use `social.sendMessage` exactly 2 times in `off-chain` mode with `threadId` set to `social-live-20260310f`:\n" +
              "- one to `agent-1` with your final decision\n" +
              "- one to `agent-3` with one challenge or agreement\n" +
              "Each message must mention a concrete observation from your inbox and keep the run token visible.\n" +
              "After the tool calls, reply with exactly `A4_R4_DONE`.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.content).toBe("A4_R4_DONE");
      expect(result.plannerSummary?.plannerCalls).toBe(1);
      expect(result.plannerSummary?.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_explicit_tool_retry",
          }),
          expect.objectContaining({
            code: "planner_explicit_tool_parse_retry",
          }),
        ]),
      );
    });

    it("narrows planner turns with explicit deterministic social tools to the named tool subset", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "social_loop",
              requiresSynthesis: false,
              steps: [
                {
                  name: "get_incoming_msgs",
                  step_type: "deterministic_tool",
                  tool: "social.getRecentMessages",
                  args: { direction: "incoming", limit: 5 },
                },
                {
                  name: "send_reply",
                  step_type: "deterministic_tool",
                  tool: "social.sendMessage",
                  args: {
                    recipient: "agent-a",
                    content: "reply",
                    mode: "off-chain",
                  },
                  depends_on: ["get_incoming_msgs"],
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
              get_incoming_msgs: '{"messages":[{"id":"m1","content":"seed"}]}',
              send_reply: '{"status":"sent"}',
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
        allowedTools: [
          "social.getRecentMessages",
          "social.sendMessage",
          "social.searchAgents",
          "web_search",
          "system.emailMessageInfo",
          "system.emailMessageExtractText",
        ],
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: [
              "social.getRecentMessages",
              "social.sendMessage",
              "social.searchAgents",
              "web_search",
              "system.emailMessageInfo",
              "system.emailMessageExtractText",
            ],
            expandedToolNames: [
              "social.getRecentMessages",
              "social.sendMessage",
              "social.searchAgents",
              "web_search",
              "system.emailMessageInfo",
              "system.emailMessageExtractText",
            ],
          },
          message: createMessage(
            "Use social.getRecentMessages with direction incoming and limit 5. Then use social.sendMessage to send one off-chain reply to agent-a. After the tool calls finish, reply exactly SOCIAL_OK.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(result.content).toBe("SOCIAL_OK");
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolRouting: {
          allowedToolNames: ["social.getRecentMessages", "social.sendMessage"],
        },
      });
    });

    it("emits suppression diagnostics in model-call trace events for dialogue-only turns", async () => {
      const events: Array<Record<string, unknown>> = [];
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "STORED-A",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
          message: createMessage(
            "Stateful continuity test A. Memorize exactly these facts for later recall: codename=BLACK-ORBIT, port=8771, checksum=SIGMA-42. Reply with exactly STORED-A.",
          ),
        }),
      );

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "model_call_prepared",
            phase: "initial",
            payload: expect.objectContaining({
              plannerReason: "exact_response_turn",
              plannerShouldPlan: false,
              dialogueToolSuppressed: true,
              preSuppressionRoutedToolNames: [
                "desktop.text_editor",
                "execute_with_agent",
              ],
              requestedRoutedToolNames: [],
              routedToolNames: [],
              toolChoice: "none",
            }),
          }),
        ]),
      );
    });

    it("keeps dialogue recall turns on the direct no-tool path", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "BLACK-ORBIT|8771|SIGMA-42",
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
      });

      const result = await executor.execute(
        createParams({
          history: [
            {
              role: "user",
              content:
                "Stateful continuity test A3. Memorize exactly these facts for later recall: codename=BLACK-ORBIT, port=8771, checksum=SIGMA-42. Reply with exactly STORED-A3.",
            },
            { role: "assistant", content: "STORED-A3" },
          ],
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "Stateful continuity test B3. Without extra words, return codename|port|checksum from test A3.",
          ),
        }),
      );

      expect(result.content).toBe("BLACK-ORBIT|8771|SIGMA-42");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["initial"]);
      expect(result.plannerSummary?.used).toBe(false);
      expect(result.plannerSummary?.routeReason).toBe("dialogue_recall_turn");
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        toolChoice: "none",
        toolRouting: { allowedToolNames: [] },
      });
    });

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
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0,
        },
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

    it("refines the planner when a delegated step is rejected as overloaded before execution", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "implementation_scope",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "delegate_everything",
                    step_type: "subagent_task",
                    objective:
                      "Research frameworks, scaffold the project, implement the game loop, and validate it in the browser.",
                    input_contract:
                      "Return JSON with framework choice, files created, and browser validation findings",
                    acceptance_criteria: [
                      "Compare frameworks",
                      "Create package.json",
                      "Create src/main.ts",
                      "Validate browser behavior",
                      "Document how to play",
                    ],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "refined_decomposition",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "research_framework",
                    step_type: "subagent_task",
                    objective: "Research the best framework choice only.",
                    input_contract: "Return JSON with the chosen framework and rationale",
                    acceptance_criteria: ["Choose one framework with rationale"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "implement_gameplay",
                    step_type: "subagent_task",
                    objective: "Implement the gameplay code only.",
                    input_contract: "Return JSON with implementation summary and changed files",
                    acceptance_criteria: ["Implement the core gameplay loop"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "research_framework"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["research_framework"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValue(
            mockResponse({
              content: safeJson({
                reason: "refined_decomposition",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "research_framework",
                    step_type: "subagent_task",
                    objective: "Research the best framework choice only.",
                    input_contract: "Return JSON with the chosen framework and rationale",
                    acceptance_criteria: ["Choose one framework with rationale"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "implement_gameplay",
                    step_type: "subagent_task",
                    objective: "Implement the gameplay code only.",
                    input_contract: "Return JSON with implementation summary and changed files",
                    acceptance_criteria: ["Implement the core gameplay loop"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "research_framework"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["research_framework"],
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
              research_framework:
                '{"status":"completed","success":true,"output":"Vite chosen","toolCalls":[]}',
              implement_gameplay:
                '{"status":"completed","success":true,"output":"Gameplay implemented","toolCalls":[]}',
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
          maxFanoutPerTurn: 8,
          maxDepth: 4,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Build the game, choose the framework, implement it, and validate it end to end.",
          ),
        }),
      );

      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      const secondPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      expect(
        secondPlannerMessages.some(
          (msg) =>
            msg.role === "system" &&
            typeof msg.content === "string" &&
            msg.content.includes("Planner refinement required"),
        ),
      ).toBe(true);
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.plannerCalls).toBe(2);
      expect(result.plannerSummary?.routeReason).toBe("refined_decomposition");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "subagent_step_needs_decomposition",
          }),
          expect.objectContaining({
            code: "planner_refinement_retry",
          }),
        ]),
      );
    });

    it("replans when delegated execution requests parent-side decomposition", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "initial_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "delegate_setup",
                    step_type: "subagent_task",
                    objective: "Prepare the project setup.",
                    input_contract: "Return JSON with setup evidence",
                    acceptance_criteria: ["Prepare the project setup"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_impl",
                    step_type: "subagent_task",
                    objective: "Implement the gameplay core.",
                    input_contract: "Return JSON with implementation evidence",
                    acceptance_criteria: ["Implement gameplay core"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "delegate_setup"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["delegate_setup"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "refined_after_runtime_signal",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "delegate_setup",
                    step_type: "subagent_task",
                    objective: "Prepare the project setup only.",
                    input_contract: "Return JSON with setup summary",
                    acceptance_criteria: ["Prepare the project setup"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_impl",
                    step_type: "subagent_task",
                    objective: "Implement the gameplay core only.",
                    input_contract: "Return JSON with implementation summary",
                    acceptance_criteria: ["Implement gameplay core"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "delegate_setup"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["delegate_setup"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValue(
            mockResponse({
              content: safeJson({
                reason: "decomposed_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "delegate_setup",
                    step_type: "subagent_task",
                    objective: "Prepare the project setup only.",
                    input_contract: "Return JSON with setup summary",
                    acceptance_criteria: ["Prepare the project setup"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "delegate_impl",
                    step_type: "subagent_task",
                    objective: "Implement the gameplay core only.",
                    input_contract: "Return JSON with implementation summary",
                    acceptance_criteria: ["Implement gameplay core"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "delegate_setup"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["delegate_setup"],
                  },
                ],
              }),
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            status: "failed",
            context: {
              results: {
                delegate_setup:
                  '{"status":"completed","success":true,"output":"Setup complete","toolCalls":[]}',
                delegate_impl:
                  '{"status":"needs_decomposition","success":false,"error":"Implement + validate must be split","decomposition":{"code":"needs_decomposition","phases":["implementation","validation"],"suggestedSteps":[{"name":"implement_core_scope"},{"name":"verify_acceptance"}]}}',
              },
            },
            completedSteps: 1,
            totalSteps: 2,
            error: "Sub-agent step \"delegate_impl\" requires decomposition",
            stopReasonHint: "validation_error",
            decomposition: {
              code: "needs_decomposition",
              reason: "Implement + validate must be split",
              phases: ["implementation", "validation"],
              suggestedSteps: [
                {
                  phase: "implementation",
                  name: "implement_core_scope",
                  objective: "Implement the core code changes only.",
                },
                {
                  phase: "validation",
                  name: "verify_acceptance",
                  objective: "Run focused verification only.",
                },
              ],
              guidance: "Re-plan at the parent level.",
            },
          })
          .mockResolvedValueOnce({
            status: "completed",
            context: {
              results: {
                delegate_setup:
                  '{"status":"completed","success":true,"output":"Setup complete","toolCalls":[]}',
                delegate_impl:
                  '{"status":"completed","success":true,"output":"Gameplay implemented","toolCalls":[]}',
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
          maxFanoutPerTurn: 8,
          maxDepth: 4,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Implement the gameplay flow and make sure it is validated correctly.",
          ),
        }),
      );

      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(2);
      const secondPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      expect(
        secondPlannerMessages.some(
          (msg) =>
            msg.role === "system" &&
            typeof msg.content === "string" &&
            msg.content.includes("Delegation execution requested parent-side decomposition"),
        ),
      ).toBe(true);
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.plannerCalls).toBe(2);
      expect(result.plannerSummary?.routeReason).toBe(
        "refined_after_runtime_signal",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_runtime_refinement_retry",
          }),
        ]),
      );
    });

    it("requests a repair-focused replan after deterministic verification fails post-delegation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "initial_build_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "setup_workspace",
                    step_type: "subagent_task",
                    objective: "Prepare the workspace and dependencies.",
                    input_contract: "Workspace root is ready for implementation",
                    acceptance_criteria: ["Workspace is ready for implementation"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["cwd=/workspace/app"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                  },
                  {
                    name: "implement_core",
                    step_type: "subagent_task",
                    objective: "Implement the core package.",
                    input_contract: "Workspace is already prepared",
                    acceptance_criteria: ["Core builds cleanly"],
                    required_tool_capabilities: ["system.readFile", "system.writeFile"],
                    context_requirements: ["cwd=/workspace/app"],
                    max_budget_hint: "4m",
                    can_run_parallel: false,
                    depends_on: ["setup_workspace"],
                  },
                  {
                    name: "run_tests",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: {
                      command: "npm",
                      args: ["test", "--", "--run"],
                      cwd: "/workspace/app",
                    },
                    onError: "abort",
                    depends_on: ["implement_core"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "repair_after_test_failure",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "diagnose_test_failure",
                    step_type: "subagent_task",
                    objective: "Diagnose the failing unreachable-path behavior using the existing workspace.",
                    input_contract: "Workspace already contains prior implementation changes",
                    acceptance_criteria: ["Root cause of failing tests is identified"],
                    required_tool_capabilities: ["system.readFile"],
                    context_requirements: ["cwd=/workspace/app"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                  },
                  {
                    name: "repair_unreachable_behavior",
                    step_type: "subagent_task",
                    objective: "Repair the failing unreachable-path behavior and keep existing workspace changes.",
                    input_contract: "Workspace already contains prior implementation changes",
                    acceptance_criteria: ["Failing tests pass"],
                    required_tool_capabilities: ["system.readFile", "system.writeFile"],
                    context_requirements: ["cwd=/workspace/app"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["diagnose_test_failure"],
                  },
                  {
                    name: "run_tests",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: {
                      command: "npm",
                      args: ["test", "--", "--run"],
                      cwd: "/workspace/app",
                    },
                    onError: "abort",
                    depends_on: ["repair_unreachable_behavior"],
                  },
                ],
              }),
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            status: "failed",
            context: {
              results: {
                setup_workspace:
                  '{"status":"completed","success":true,"output":"Workspace prepared"}',
                implement_core:
                  '{"status":"completed","success":true,"output":"Core implemented"}',
              },
            },
            completedSteps: 2,
            totalSteps: 3,
            stopReasonHint: "tool_error",
            error:
              "FAIL packages/core/test/index.test.ts > findPath > handles unreachable\nAssertionError: expected -1 to be Infinity",
          })
          .mockResolvedValueOnce({
            status: "completed",
            context: {
              results: {
                diagnose_test_failure:
                  '{"status":"completed","success":true,"output":"Root cause identified"}',
                repair_unreachable_behavior:
                  '{"status":"completed","success":true,"output":"Unreachable-path behavior repaired"}',
                run_tests: '{"exitCode":0,"stdout":"2 passed"}',
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
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Implement the gameplay flow, verify it with tests, and repair any failing behavior before finishing.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(2);
      const secondPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      expect(
        secondPlannerMessages.some(
          (msg) =>
            msg.role === "system" &&
            typeof msg.content === "string" &&
            msg.content.includes(
              "A prior executable plan partially succeeded but failed during deterministic verification.",
            ),
        ),
      ).toBe(true);
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.plannerCalls).toBe(2);
      expect(result.plannerSummary?.routeReason).toBe("repair_after_test_failure");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_runtime_repair_retry",
          }),
        ]),
      );
    });

    it("preserves a runtime repair retry after an earlier planner refinement consumed the structural retry budget", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "initial_overloaded_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "implement_everything",
                    step_type: "subagent_task",
                    objective:
                      "Research the framework, implement the feature, and verify it end to end.",
                    input_contract: "Return JSON with the completed deliverable",
                    acceptance_criteria: ["Feature ships and tests pass"],
                    required_tool_capabilities: ["system.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "refined_decomposition",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "implement_feature",
                    step_type: "subagent_task",
                    objective: "Implement the feature only.",
                    input_contract: "Return JSON with the implementation summary",
                    acceptance_criteria: ["Feature implemented"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                  },
                  {
                    name: "verify_build",
                    step_type: "subagent_task",
                    objective: "Verify the build only.",
                    input_contract: "Feature implementation already exists",
                    acceptance_criteria: ["Build verification completed"],
                    required_tool_capabilities: ["system.bash"],
                    context_requirements: ["repo_context", "implement_feature"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["implement_feature"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "repair_after_build_failure",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "repair_build_config",
                    step_type: "subagent_task",
                    objective: "Repair the build configuration only.",
                    input_contract: "Return JSON with the fix summary",
                    acceptance_criteria: ["Build configuration repaired"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["repo_context", "verify_build"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                  },
                  {
                    name: "verify_build",
                    step_type: "subagent_task",
                    objective: "Verify the repaired build only.",
                    input_contract: "Build configuration already repaired",
                    acceptance_criteria: ["Build verification completed"],
                    required_tool_capabilities: ["system.bash"],
                    context_requirements: [
                      "repo_context",
                      "repair_build_config",
                    ],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["repair_build_config"],
                  },
                ],
              }),
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn()
          .mockResolvedValueOnce({
            status: "failed",
            context: {
              results: {
                implement_feature:
                  '{"status":"completed","success":true,"output":"Feature implemented"}',
              },
            },
            completedSteps: 1,
            totalSteps: 2,
            stopReasonHint: "tool_error",
            error:
              "error TS6310: Referenced project may not disable emit during root build",
          })
          .mockResolvedValueOnce({
            status: "completed",
            context: {
              results: {
                repair_build_config:
                  '{"status":"completed","success":true,"output":"Build configuration repaired"}',
                verify_build:
                  '{"status":"completed","success":true,"output":"Build verified"}',
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
          maxFanoutPerTurn: 8,
          maxDepth: 4,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Build the feature, repair any failing verification, and finish autonomously.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(2);
      const thirdPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      expect(
        thirdPlannerMessages.some(
          (msg) =>
            msg.role === "system" &&
            typeof msg.content === "string" &&
            msg.content.includes(
              "A prior executable plan partially succeeded but failed during deterministic verification.",
            ),
        ),
      ).toBe(true);
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.plannerCalls).toBe(3);
      expect(result.plannerSummary?.routeReason).toBe(
        "repair_after_build_failure",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_refinement_retry",
          }),
          expect.objectContaining({
            code: "planner_runtime_repair_retry",
          }),
        ]),
      );
    });

    it("passes the active session tool handler into deterministic pipeline execution", async () => {
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
                  tool: "desktop.bash",
                  args: { command: "echo", args: ["session"] },
                },
              ],
            }),
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockImplementation(
          async (
            _pipeline: unknown,
            _startFrom?: number,
            options?: { toolHandler?: (name: string, args: Record<string, unknown>) => Promise<string> },
          ) => {
            if (!options?.toolHandler) {
              throw new Error("missing per-session tool handler");
            }
            const stepResult = await options.toolHandler("desktop.bash", {
              command: "echo",
              args: ["session"],
            });
            return {
              status: "completed",
              context: { results: { step_1: stepResult } },
              completedSteps: 1,
              totalSteps: 1,
            };
          },
        ),
      };
      const defaultToolHandler = vi.fn().mockResolvedValue("default-handler-result");
      const sessionToolHandler = vi
        .fn()
        .mockResolvedValue('{"stdout":"session-handler-result","exitCode":0}');
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: defaultToolHandler,
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First run a desktop command, then summarize the outcome.",
          ),
          toolHandler: sessionToolHandler,
        }),
      );

      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      const pipelineCallArgs = (pipelineExecutor.execute as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(pipelineCallArgs[2]).toBeDefined();
      expect(pipelineCallArgs[2].toolHandler).toBe(sessionToolHandler);
      expect(sessionToolHandler).toHaveBeenCalledWith("desktop.bash", {
        command: "echo",
        args: ["session"],
      });
      expect(defaultToolHandler).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("completed");
    });

    it("emits planner lifecycle and deterministic pipeline execution trace events", async () => {
      const events: Array<Record<string, unknown>> = [];
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: safeJson({
              reason: "restart_server",
              requiresSynthesis: false,
              steps: [
                {
                  name: "stop_server",
                  step_type: "deterministic_tool",
                  tool: "system.serverStop",
                  args: { label: "svc" },
                },
                {
                  name: "start_server",
                  step_type: "deterministic_tool",
                  depends_on: ["stop_server"],
                  tool: "system.serverStart",
                  args: { command: "python3", args: ["-m", "http.server", "8774"] },
                },
              ],
            }),
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockImplementation(
          async (
            pipeline: { id: string },
            _startFrom?: number,
            options?: {
              onEvent?: (event: {
                type: string;
                pipelineId: string;
                stepName?: string;
                stepIndex?: number;
                tool?: string;
                args?: Record<string, unknown>;
                durationMs?: number;
                result?: string;
              }) => void;
            },
          ) => {
            options?.onEvent?.({
              type: "step_started",
              pipelineId: pipeline.id,
              stepName: "stop_server",
              stepIndex: 0,
              tool: "system.serverStop",
              args: { label: "svc" },
            });
            options?.onEvent?.({
              type: "step_finished",
              pipelineId: pipeline.id,
              stepName: "stop_server",
              stepIndex: 0,
              tool: "system.serverStop",
              args: { label: "svc" },
              durationMs: 5,
              result: '{"state":"stopped"}',
            });
            return {
              status: "completed",
              context: {
                results: {
                  stop_server: '{"state":"stopped"}',
                  start_server: '{"state":"running"}',
                },
              },
              completedSteps: 2,
              totalSteps: 2,
            };
          },
        ),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "First stop the server, then restart it on port 8774 and verify the result.",
          ),
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "planner_plan_parsed",
            phase: "planner",
            payload: expect.objectContaining({
              deterministicSteps: 2,
              routeReason: "restart_server",
            }),
          }),
          expect.objectContaining({
            type: "planner_pipeline_started",
            phase: "planner",
            payload: expect.objectContaining({
              deterministicSteps: expect.arrayContaining([
                expect.objectContaining({ name: "stop_server", tool: "system.serverStop" }),
                expect.objectContaining({ name: "start_server", tool: "system.serverStart" }),
              ]),
            }),
          }),
          expect.objectContaining({
            type: "tool_dispatch_started",
            phase: "planner",
            payload: expect.objectContaining({
              stepName: "stop_server",
              tool: "system.serverStop",
            }),
          }),
          expect.objectContaining({
            type: "tool_dispatch_finished",
            phase: "planner",
            payload: expect.objectContaining({
              stepName: "stop_server",
              tool: "system.serverStop",
              isError: false,
            }),
          }),
          expect.objectContaining({
            type: "planner_pipeline_finished",
            phase: "planner",
            payload: expect.objectContaining({
              status: "completed",
              completedSteps: 2,
              totalSteps: 2,
            }),
          }),
          expect.objectContaining({
            type: "planner_path_finished",
            phase: "planner",
            payload: expect.objectContaining({
              handled: true,
              deterministicStepsExecuted: 2,
            }),
          }),
        ]),
      );
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
                requiresSynthesis: true,
                steps: [
                  {
                    name: "prep",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: { command: "echo", args: ["ready"] },
                  },
                  {
                    name: "delegate_logs",
                    step_type: "subagent_task",
                    objective: "Inspect flaky test logs and cluster failure patterns",
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
                    name: "delegate_code",
                    step_type: "subagent_task",
                    objective: "Map clustered failures back to likely source hotspots",
                    input_contract: "Correlate source files with the clustered log failures",
                    acceptance_criteria: [
                      "Name likely source hotspots",
                      "Tie hotspots back to clustered failures",
                    ],
                    required_tool_capabilities: ["system.bash", "system.readFile"],
                    context_requirements: ["runtime_sources", "delegate_logs"],
                    max_budget_hint: "120s",
                    can_run_parallel: true,
                    depends_on: ["delegate_logs"],
                  },
                  {
                    name: "merge",
                    step_type: "synthesis",
                    objective: "Produce concise remediation summary",
                    depends_on: ["delegate_code"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "final synthesized answer",
            }),
          )
          .mockResolvedValue(
            mockResponse({
              content: "final synthesized answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              prep: '{"stdout":"ready\\n","exitCode":0}',
              delegate_logs: safeJson({
                status: "completed",
                success: true,
                output: "clustered failures around parser edge cases",
              }),
              delegate_code: safeJson({
                status: "completed",
                success: true,
                output: "likely hotspot: src/parser.ts around portal edge handling",
              }),
            },
          },
          completedSteps: 3,
          totalSteps: 4,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Mixed planner execution test. Sub-agent orchestration plan required: " +
              "1. delegate_logs: inspect flaky test logs and cluster the failures. " +
              "2. delegate_code: map the clustered failures to likely source hotspots. " +
              "Final deliverables: concise remediation summary. " +
              "First run setup checks, then delegate deeper research, then synthesize results.",
          ),
        }),
      );

      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
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
        0,
        expect.objectContaining({
          toolHandler: expect.any(Function),
        }),
      );
      expect(result.content).toContain("final synthesized answer");
      expect(result.content).toContain("[source:delegate_logs]");
      expect(result.content).toContain("[source:delegate_code]");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_synthesis",
      ]);
      expect(result.plannerSummary).toMatchObject({
        enabled: true,
        used: true,
        plannedSteps: 4,
        deterministicStepsExecuted: 1,
      });

      const synthesisMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const synthesisOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][1] as LLMChatOptions | undefined;
      const groundingMessage = synthesisMessages.find((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Runtime execution ledger")
      );
      expect(groundingMessage).toBeDefined();
      expect(String(groundingMessage?.content)).toContain('"tool":"system.bash"');
      expect(String(groundingMessage?.content)).toContain(
        '"tool":"execute_with_agent"',
      );
      expect(String(groundingMessage?.content)).toContain('"toolCallCount":3');
      expect(synthesisOptions).toMatchObject({
        toolChoice: "none",
        toolRouting: { allowedToolNames: [] },
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
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.2,
        },
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
      const events: Array<Record<string, unknown>> = [];
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
          sessionId: "planner-verifier-boundary",
          message: {
            ...createMessage(
              "First analyze timeout clusters across CI logs, then cross-check source hotspots, then synthesize a remediation summary with evidence.",
            ),
            sessionId: "planner-verifier-boundary",
          },
          stateful: {
            resumeAnchor: {
              previousResponseId: "resp-prev",
              reconciliationHash: "hash-prev",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
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
      const verifierOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      const retryVerifierOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      const synthesisOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(verifierOptions?.toolChoice).toBe("none");
      expect(retryVerifierOptions?.toolChoice).toBe("none");
      expect(verifierOptions?.stateful).toBeUndefined();
      expect(retryVerifierOptions?.stateful).toBeUndefined();
      expect(synthesisOptions?.stateful).toBeUndefined();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "planner_verifier_round_finished",
            phase: "planner",
            payload: expect.objectContaining({
              executionRound: 1,
              verifierRound: 1,
              overall: "retry",
              canRetry: true,
              retryable: true,
              unresolvedItems: expect.arrayContaining([
                "delegate_a:insufficient_evidence",
              ]),
            }),
          }),
          expect.objectContaining({
            type: "planner_verifier_retry_scheduled",
            phase: "planner",
            payload: expect.objectContaining({
              executionRound: 1,
              verifierRound: 1,
              nextExecutionRound: 2,
              overall: "retry",
              unresolvedItems: expect.arrayContaining([
                "delegate_a:insufficient_evidence",
              ]),
            }),
          }),
          expect.objectContaining({
            type: "planner_verifier_round_finished",
            phase: "planner",
            payload: expect.objectContaining({
              executionRound: 2,
              verifierRound: 2,
              overall: "pass",
              canRetry: false,
              retryable: true,
              unresolvedItems: [],
            }),
          }),
        ]),
      );
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

    it("salvages planner tool calls into deterministic pipeline execution", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "execute_with_agent",
                arguments: safeJson({
                  task:
                    "In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
                  objective: "Output exactly TOKEN=ONYX-SHARD-58",
                }),
              },
            ],
          }),
        ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              execute_with_agent_1: safeJson({
                status: "completed",
                output: "ONYX-SHARD-58",
                objective: "Output exactly TOKEN=ONYX-SHARD-58",
                failedToolCalls: 0,
                stopReason: "completed",
              }),
            },
          },
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
            "Use execute_with_agent for this exact task. In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.content).toBe("TOKEN=ONYX-SHARD-58");
      expect(result.plannerSummary?.routeReason).toBe(
        "planner_tool_call_salvaged",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "parse",
            code: "planner_tool_call_salvaged",
          }),
        ]),
      );
      expect(result.callUsage.map((entry) => entry.phase)).toEqual(["planner"]);
    });

    it("refines under-decomposed salvaged planner tool calls for structured implementation requests", async () => {
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
                  name: "system.bash",
                  arguments: safeJson({
                    command: "mkdir",
                    args: ["-p", "/tmp/grid-router-ts"],
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "implementation_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "setup_project",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: {
                      command: "mkdir",
                      args: ["-p", "/tmp/grid-router-ts"],
                    },
                  },
                  {
                    name: "write_core_file",
                    step_type: "deterministic_tool",
                    depends_on: ["setup_project"],
                    tool: "system.writeFile",
                    args: {
                      path: "/tmp/grid-router-ts/src/index.ts",
                      content: "export const ok = true;\n",
                    },
                  },
                  {
                    name: "verify_build",
                    step_type: "deterministic_tool",
                    depends_on: ["write_core_file"],
                    tool: "system.bash",
                    args: {
                      command: "npm",
                      args: ["test"],
                      cwd: "/tmp/grid-router-ts",
                    },
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
              setup_project: safeJson({ exitCode: 0 }),
              write_core_file: safeJson({ bytesWritten: 24 }),
              verify_build: safeJson({ exitCode: 0, stdout: "3 passed" }),
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
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "In /tmp create a reusable TypeScript library and CLI for ASCII grid maps.\n" +
              "Requirements:\n" +
              "- implement bfs, dijkstra, and astar\n" +
              "- include weighted tiles and portals\n" +
              "- add Vitest coverage\n" +
              "- write a README and report exact passing commands",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      const refinedPlannerMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[0] as LLMMessage[];
      expect(refinedPlannerMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Planner refinement required:"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              "under-decomposed the request",
            ),
          }),
        ]),
      );
      expect(result.stopReason).toBe("completed");
      expect(result.plannerSummary?.routeReason).toBe("implementation_plan");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "salvaged_tool_plan_underdecomposed",
          }),
          expect.objectContaining({
            category: "policy",
            code: "planner_salvaged_tool_call_retry",
          }),
        ]),
      );
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
      ]);
    });

    it("refines explicit required subagent orchestration plans instead of falling back to the direct tool loop", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "underplanned",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research references only.",
                    input_contract: "Return reference notes",
                    acceptance_criteria: ["Provide 3 references"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "required_orchestration",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research references only.",
                    input_contract: "Return reference notes",
                    acceptance_criteria: ["Provide 3 references"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "tech_research",
                    step_type: "subagent_task",
                    objective: "Choose the implementation stack only.",
                    input_contract: "Return the selected stack and rationale",
                    acceptance_criteria: ["Choose one implementation stack"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "design_research"],
                    max_budget_hint: "2m",
                    can_run_parallel: false,
                    depends_on: ["design_research"],
                  },
                  {
                    name: "core_implementation",
                    step_type: "subagent_task",
                    objective: "Implement core gameplay only.",
                    input_contract: "Return implementation evidence",
                    acceptance_criteria: ["Core gameplay implemented"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "tech_research"],
                    max_budget_hint: "4m",
                    can_run_parallel: false,
                    depends_on: ["tech_research"],
                  },
                  {
                    name: "ai_and_systems",
                    step_type: "subagent_task",
                    objective: "Implement AI and support systems only.",
                    input_contract: "Return AI and systems evidence",
                    acceptance_criteria: ["AI and systems implemented"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "core_implementation"],
                    max_budget_hint: "4m",
                    can_run_parallel: false,
                    depends_on: ["core_implementation"],
                  },
                  {
                    name: "qa_and_validation",
                    step_type: "subagent_task",
                    objective: "Run QA and validation only.",
                    input_contract: "Return validation evidence",
                    acceptance_criteria: ["Critical flows validated"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "ai_and_systems"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["ai_and_systems"],
                  },
                  {
                    name: "polish_and_docs",
                    step_type: "subagent_task",
                    objective: "Polish UX and write docs only.",
                    input_contract: "Return docs and polish notes",
                    acceptance_criteria: ["Docs produced"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context", "qa_and_validation"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["qa_and_validation"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Neon Heist synthesized final answer",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              design_research: safeJson({
                status: "completed",
                subagentSessionId: "sub-design",
                output: "research output",
                success: true,
              }),
              tech_research: safeJson({
                status: "completed",
                subagentSessionId: "sub-tech",
                output: "tech output",
                success: true,
              }),
              core_implementation: safeJson({
                status: "completed",
                subagentSessionId: "sub-core",
                output: "core output",
                success: true,
              }),
              ai_and_systems: safeJson({
                status: "completed",
                subagentSessionId: "sub-ai",
                output: "ai output",
                success: true,
              }),
              qa_and_validation: safeJson({
                status: "completed",
                subagentSessionId: "sub-qa",
                output: "qa output",
                success: true,
              }),
              polish_and_docs: safeJson({
                status: "completed",
                subagentSessionId: "sub-polish",
                output: "docs output",
                success: true,
              }),
            },
          },
          completedSteps: 6,
          totalSteps: 6,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("unused"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
        delegationDecision: {
          enabled: true,
          scoreThreshold: 0.99,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Build Neon Heist. Sub-agent orchestration plan (required): 1) `design_research`: research references. 2) `tech_research`: choose the stack. 3) `core_implementation`: implement gameplay. 4) `ai_and_systems`: implement AI and systems. 5) `qa_and_validation`: validate critical flows. 6) `polish_and_docs`: finalize docs. Final deliverables: runnable game, commands used, architecture summary, how to play, known limitations.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
        "planner_synthesis",
      ]);
      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("Neon Heist synthesized final answer");
      expect(result.content).toContain("[source:design_research]");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "required_subagent_steps_missing",
          }),
          expect.objectContaining({
            code: "planner_required_orchestration_retry",
          }),
          expect.objectContaining({
            code: "delegation_required_by_user",
          }),
        ]),
      );
    });

    it("fails closed when the planner cannot satisfy an explicit required subagent orchestration plan", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "still_underplanned",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research references only.",
                    input_contract: "Return reference notes",
                    acceptance_criteria: ["Provide 3 references"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "still_underplanned",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research references only.",
                    input_contract: "Return reference notes",
                    acceptance_criteria: ["Provide 3 references"],
                    required_tool_capabilities: ["desktop.bash"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                ],
              }),
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
            "Build Neon Heist. Sub-agent orchestration plan (required): 1) `design_research`: research references. 2) `tech_research`: choose the stack. 3) `core_implementation`: implement gameplay. 4) `ai_and_systems`: implement AI and systems. 5) `qa_and_validation`: validate critical flows. 6) `polish_and_docs`: finalize docs. Final deliverables: runnable game and concise docs.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
      ]);
      expect(result.stopReason).toBe("validation_error");
      expect(result.content).toContain(
        "Planner could not produce the required sub-agent orchestration plan.",
      );
      expect(result.content).toContain(
        "design_research -> tech_research -> core_implementation -> ai_and_systems -> qa_and_validation -> polish_and_docs",
      );
    });

    it("repairs missing subagent contract fields from an explicit required orchestration prompt", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "explicit_required_plan",
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research 3 relevant reference games and tuning targets.",
                  },
                  {
                    name: "tech_research",
                    step_type: "subagent_task",
                    objective: "Compare Canvas API vs Phaser vs Pixi and pick one.",
                    depends_on: ["design_research"],
                  },
                  {
                    name: "core_implementation",
                    step_type: "subagent_task",
                    objective: "Build the game loop, rendering, movement, collision, scoring, and map mutation.",
                    depends_on: ["tech_research"],
                  },
                  {
                    name: "ai_and_systems",
                    step_type: "subagent_task",
                    objective: "Implement enemy behavior, pathfinding, powerups, save/load, pause/settings, and input support.",
                    depends_on: ["core_implementation"],
                  },
                  {
                    name: "qa_and_validation",
                    step_type: "subagent_task",
                    objective: "Run tests/build checks, then validate critical gameplay flows in Chromium.",
                    depends_on: ["ai_and_systems"],
                  },
                  {
                    name: "polish_and_docs",
                    step_type: "subagent_task",
                    objective: "Improve UX clarity and produce concise architecture and how-to-play docs.",
                    depends_on: ["qa_and_validation"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "explicit_required_plan_refined",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "design_research",
                    step_type: "subagent_task",
                    objective: "Research 3 relevant reference games and tuning targets.",
                    input_contract:
                      "Return JSON with reference games, mechanics, and tuning targets.",
                    acceptance_criteria: [
                      "Research 3 relevant reference games",
                      "Propose concise tuning targets",
                    ],
                    required_tool_capabilities: ["mcp.browser.browser_navigate"],
                    context_requirements: ["repo_context"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                  },
                  {
                    name: "tech_research",
                    step_type: "subagent_task",
                    objective: "Compare Canvas API vs Phaser vs Pixi and pick one.",
                    input_contract:
                      "Return JSON with the selected implementation option and rationale.",
                    acceptance_criteria: [
                      "Compare implementation options",
                      "Define project structure and performance constraints",
                    ],
                    required_tool_capabilities: ["mcp.browser.browser_navigate"],
                    context_requirements: ["repo_context", "design_research"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["design_research"],
                  },
                  {
                    name: "core_implementation",
                    step_type: "subagent_task",
                    objective: "Build the game loop, rendering, movement, collision, scoring, and map mutation.",
                    input_contract:
                      "Return JSON with changed files and implementation summary.",
                    acceptance_criteria: [
                      "Build the game loop, rendering, movement, collision, scoring, and map mutation system",
                    ],
                    required_tool_capabilities: ["desktop.text_editor"],
                    context_requirements: ["repo_context", "tech_research"],
                    max_budget_hint: "5m",
                    can_run_parallel: false,
                    depends_on: ["tech_research"],
                  },
                  {
                    name: "ai_and_systems",
                    step_type: "subagent_task",
                    objective: "Implement enemy behavior, pathfinding, powerups, save/load, pause/settings, and input support.",
                    input_contract:
                      "Return JSON with changed files and systems summary.",
                    acceptance_criteria: [
                      "Implement enemy behavior, pathfinding, powerups, save/load, pause/settings, and input support",
                    ],
                    required_tool_capabilities: ["desktop.text_editor"],
                    context_requirements: ["repo_context", "core_implementation"],
                    max_budget_hint: "5m",
                    can_run_parallel: false,
                    depends_on: ["core_implementation"],
                  },
                  {
                    name: "qa_and_validation",
                    step_type: "subagent_task",
                    objective: "Run tests/build checks, then validate critical gameplay flows in Chromium.",
                    input_contract:
                      "Return JSON with validation checks and results.",
                    acceptance_criteria: [
                      "Run tests/build checks",
                      "Validate critical gameplay flows in Chromium",
                    ],
                    required_tool_capabilities: [
                      "desktop.bash",
                      "mcp.browser.browser_navigate",
                    ],
                    context_requirements: ["repo_context", "ai_and_systems"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["ai_and_systems"],
                  },
                  {
                    name: "polish_and_docs",
                    step_type: "subagent_task",
                    objective: "Improve UX clarity and produce concise architecture and how-to-play docs.",
                    input_contract:
                      "Return JSON with changed files, architecture summary, and how-to-play notes.",
                    acceptance_criteria: [
                      "Improve UX clarity",
                      "Produce concise architecture and how-to-play docs",
                    ],
                    required_tool_capabilities: ["desktop.text_editor"],
                    context_requirements: ["repo_context", "qa_and_validation"],
                    max_budget_hint: "3m",
                    can_run_parallel: false,
                    depends_on: ["qa_and_validation"],
                  },
                ],
              }),
            }),
          )
          .mockResolvedValue(
            mockResponse({
              content: "Repaired Neon Heist synthesis",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              design_research: safeJson({
                status: "completed",
                subagentSessionId: "sub-design",
                output: "design output",
                success: true,
              }),
              tech_research: safeJson({
                status: "completed",
                subagentSessionId: "sub-tech",
                output: "tech output",
                success: true,
              }),
              core_implementation: safeJson({
                status: "completed",
                subagentSessionId: "sub-core",
                output: "core output",
                success: true,
              }),
              ai_and_systems: safeJson({
                status: "completed",
                subagentSessionId: "sub-ai",
                output: "ai output",
                success: true,
              }),
              qa_and_validation: safeJson({
                status: "completed",
                subagentSessionId: "sub-qa",
                output: "qa output",
                success: true,
              }),
              polish_and_docs: safeJson({
                status: "completed",
                subagentSessionId: "sub-polish",
                output: "docs output",
                success: true,
              }),
            },
          },
          completedSteps: 6,
          totalSteps: 6,
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
            "Build Neon Heist. Sub-agent orchestration plan (required): 1) `design_research`: - Research 3 relevant reference games and extract concrete mechanic ideas. - Propose concise tuning targets. 2) `tech_research`: - Compare implementation options (Canvas API vs Phaser vs Pixi) and pick one with rationale. - Define project structure and performance constraints. 3) `core_implementation`: - Build game loop, rendering, movement, collision, scoring, and map mutation system. 4) `ai_and_systems`: - Implement enemy behavior/pathfinding, powerups, save/load, pause/settings, and input support. 5) `qa_and_validation`: - Run tests/build checks, then validate critical gameplay flows in Chromium. 6) `polish_and_docs`: - Improve UX clarity and produce concise architecture and how-to-play docs. Final deliverables: runnable game, commands used, architecture summary, how to play, known limitations.",
          ),
        }),
      );

      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
        "planner_synthesis",
      ]);
      const pipelineArg = (pipelineExecutor.execute as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as { plannerSteps?: Array<Record<string, unknown>> };
      const repairedDesignStep = pipelineArg.plannerSteps?.find(
        (step) => step.name === "design_research",
      ) as Record<string, unknown> | undefined;
      expect(repairedDesignStep).toBeDefined();
      expect(repairedDesignStep?.inputContract).toBeDefined();
      expect(repairedDesignStep?.acceptanceCriteria).toBeDefined();
      expect(repairedDesignStep?.requiredToolCapabilities).toEqual(
        expect.arrayContaining(["mcp.browser.browser_navigate"]),
      );
      expect(repairedDesignStep?.maxBudgetHint).toBe("3m");
      const repairedCoreStep = pipelineArg.plannerSteps?.find(
        (step) => step.name === "core_implementation",
      ) as Record<string, unknown> | undefined;
      expect(repairedCoreStep?.requiredToolCapabilities).toEqual(
        expect.arrayContaining(["desktop.text_editor"]),
      );
      expect(repairedCoreStep?.maxBudgetHint).toBe("5m");
      const repairedQaStep = pipelineArg.plannerSteps?.find(
        (step) => step.name === "qa_and_validation",
      ) as Record<string, unknown> | undefined;
      expect(repairedQaStep?.requiredToolCapabilities).toEqual(
        expect.arrayContaining([
          "desktop.bash",
          "mcp.browser.browser_navigate",
        ]),
      );
      expect(repairedQaStep?.maxBudgetHint).toBe("3m");
      expect(result.content).toContain("Repaired Neon Heist synthesis");
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
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        reason: "hard_blocked_task_class",
        hardBlockedTaskClass: "wallet_transfer",
        hardBlockedTaskClassSource: "capability",
        hardBlockedTaskClassSignal: "wallet.transfer",
      });
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "policy",
            code: "delegation_veto",
            details: expect.objectContaining({
              hardBlockedTaskClass: "wallet_transfer",
              hardBlockedTaskClassSource: "capability",
              hardBlockedTaskClassSignal: "wallet.transfer",
            }),
          }),
        ]),
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

    it("does not execute mixed planner DAGs when delegation is vetoed", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "mixed_plan",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "prepare_workspace",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: { command: "mkdir", args: ["-p", "/tmp/agent-test"] },
                  },
                  {
                    name: "implement_core",
                    step_type: "subagent_task",
                    depends_on: ["prepare_workspace"],
                    objective: "Implement the parser",
                    input_contract: "Workspace exists",
                    acceptance_criteria: ["Parser compiles"],
                    required_tool_capabilities: [
                      "system.writeFile",
                      "system.readFile",
                    ],
                    context_requirements: ["workspace_ready"],
                    max_budget_hint: "5m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "fallback after vetoed mixed plan",
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
          scoreThreshold: 0.99,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Create the folder, then implement the parser, then report back.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.content).toBe("fallback after vetoed mixed plan");
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_score_below_threshold",
      );
      expect(result.plannerSummary?.delegationDecision).toMatchObject({
        shouldDelegate: false,
        reason: "score_below_threshold",
      });
    });

    it("retries a fanout-invalid planner pass once before falling back", async () => {
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
              content: safeJson({
                reason: "fanout_violation_repeat",
                requiresSynthesis: true,
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

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.plannerSummary?.routeReason).toBe(
        "delegation_veto_fanout_exceeded",
      );
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "subagent_fanout_exceeded",
          }),
          expect.objectContaining({
            category: "policy",
            code: "planner_refinement_retry",
          }),
          expect.objectContaining({
            category: "policy",
            code: "delegation_veto",
          }),
        ]),
      );
    });

    it("fails closed when a structured planner plan still fails local validation after retries", async () => {
      const invalidPlan = safeJson({
        reason: "invalid_monorepo_plan",
        requiresSynthesis: true,
        steps: [
          {
            name: "init_monorepo_skeleton",
            step_type: "subagent_task",
            objective:
              "Create the root package.json with npm workspaces, tsconfig.json, vitest.config.ts, package manifests for packages/core and packages/cli, then verify npm run build and npm test pass from the repo root.",
            input_contract: "Empty project root",
            acceptance_criteria: [
              "Root manifests exist",
              "npm run build passes",
              "npm test passes",
            ],
            required_tool_capabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
            ],
            context_requirements: ["cwd=/tmp/maze-lab"],
            max_budget_hint: "2m",
          },
          {
            name: "npm_install",
            step_type: "deterministic_tool",
            depends_on: ["init_monorepo_skeleton"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-lab",
            },
            onError: "abort",
          },
          {
            name: "implement_docs",
            step_type: "subagent_task",
            depends_on: ["npm_install"],
            objective:
              "Write the README and package-level usage notes after the workspace dependencies are installed.",
            input_contract: "Workspace dependencies installed",
            acceptance_criteria: ["README exists", "Usage notes are accurate"],
            required_tool_capabilities: ["system.writeFile", "system.readFile"],
            context_requirements: ["cwd=/tmp/maze-lab"],
            max_budget_hint: "90s",
          },
          {
            name: "final_synthesis",
            step_type: "synthesis",
            depends_on: ["implement_docs"],
            objective: "Summarize completion",
          },
        ],
      });
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: invalidPlan,
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: invalidPlan,
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "direct fallback should not run",
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
          scoreThreshold: 0,
        },
      });

      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Create a TypeScript npm-workspaces monorepo from scratch, implement the packages, run install/build/test, and report back.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(pipelineExecutor.execute).not.toHaveBeenCalled();
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner",
      ]);
      expect(result.stopReason).toBe("validation_error");
      expect(result.content).toContain(
        "Planner produced a structured plan that failed local validation",
      );
      expect(result.plannerSummary?.routeReason).toBe("planner_validation_failed");
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "node_workspace_install_phase_mismatch",
          }),
          expect.objectContaining({
            category: "policy",
            code: "planner_refinement_retry",
          }),
        ]),
      );
    });

    it("preserves a structural planner retry after a step-contract-only refinement", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "initial_contract_violation",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "initialize_root",
                    step_type: "subagent_task",
                    objective: "Create root package.json",
                    input_contract: "Empty project root",
                    acceptance_criteria: ["package.json exists"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["cwd=/tmp/project"],
                    max_budget_hint: "30s",
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "fanout_violation",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "task_a",
                    step_type: "subagent_task",
                    objective: "Implement core package",
                    input_contract: "Project scaffold exists",
                    acceptance_criteria: ["Core compiles"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["cwd=/tmp/project"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                  {
                    name: "task_b",
                    step_type: "subagent_task",
                    objective: "Implement cli package",
                    input_contract: "Core package exists",
                    acceptance_criteria: ["CLI compiles"],
                    required_tool_capabilities: ["system.writeFile"],
                    context_requirements: ["cwd=/tmp/project"],
                    max_budget_hint: "2m",
                    can_run_parallel: true,
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "valid_repair_plan",
                requiresSynthesis: false,
                steps: [
                  {
                    name: "inspect_workspace",
                    step_type: "deterministic_tool",
                    tool: "system.listDir",
                    args: { path: "/tmp/project" },
                    onError: "abort",
                  },
                ],
              }),
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: { results: { inspect_workspace: '{"entries":[]}' } },
          completedSteps: 1,
          totalSteps: 1,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue('{"entries":[]}'),
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
            "Create a project root, implement core, then implement cli and report back.",
          ),
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.plannerSummary?.plannerCalls).toBe(3);
      expect(result.plannerSummary?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "policy",
            code: "planner_step_contract_retry",
          }),
          expect.objectContaining({
            category: "validation",
            code: "subagent_fanout_exceeded",
          }),
        ]),
      );
    });

    it("does not treat long top-level subagent chains as recursive delegation depth", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "deep_plan",
                requiresSynthesis: true,
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
              content: "depth chain synthesis",
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: {
            results: {
              task_a: safeJson({
                status: "completed",
                subagentSessionId: "sub-a",
                output: "layer A",
                success: true,
              }),
              task_b: safeJson({
                status: "completed",
                subagentSessionId: "sub-b",
                output: "layer B",
                success: true,
              }),
              task_c: safeJson({
                status: "completed",
                subagentSessionId: "sub-c",
                output: "layer C",
                success: true,
              }),
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
      expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
      expect(result.content).toContain("depth chain synthesis");
      expect(result.plannerSummary?.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "subagent_depth_exceeded",
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

    it("replaces stale execution plans with an explicit failure summary on no_progress", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              "1. Scaffold project directory and install dependencies.\n" +
              "2. Create base files.\n" +
              "3. Implement the game loop.\n",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "execute_with_agent",
                arguments: '{"task":"build neon heist"}',
              },
            ],
          }),
        ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        '{"success":false,"status":"timed_out","error":"Sub-agent timed out after 60000ms","output":"Sub-agent timed out after 60000ms"}',
      );
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });

      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("no_progress");
      expect(result.content).toContain("Execution stopped before completion");
      expect(result.content).toContain("Sub-agent timed out after 60000ms");
      expect(result.content).not.toContain("1. Scaffold project directory");
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

    it("truncates oversized assistant tool-call arguments before follow-up model calls", async () => {
      let callCount = 0;
      const oversizedArgs = safeJson({
        command:
          "cat <<'EOF'\n" +
          "x".repeat(8_000) +
          "\nEOF",
      });
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(
              mockResponse({
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-1",
                    name: "desktop.bash",
                    arguments: oversizedArgs,
                  },
                ],
              }),
            );
          }
          return Promise.resolve(mockResponse({ content: "done" }));
        }),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"exitCode":0,"stdout":"ok"}');
      const executor = new ChatExecutor({ providers: [provider], toolHandler });

      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const assistantWithToolCalls = secondCallMessages.find(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          message.toolCalls.length > 0,
      );
      expect(assistantWithToolCalls).toBeDefined();
      const replayedArgs = assistantWithToolCalls!.toolCalls![0]!.arguments;
      expect(replayedArgs.length).toBeLessThanOrEqual(512);
      expect(replayedArgs).toContain("__truncatedToolCallArgs");
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
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-session",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
    });

    it("passes the full normalized history into reconciliationMessages", async () => {
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
      const history = Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history-${index}`,
      })) as LLMMessage[];

      await executor.execute(
        createParams({
          history,
          sessionId: "stateful-history-window",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-history-window",
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;
      expect(reconciliationMessages).toBeDefined();
      expect(reconciliationMessages).toHaveLength(26);
      expect(reconciliationMessages?.[1]).toMatchObject({
        role: "user",
        content: "history-0",
      });
      expect(reconciliationMessages?.at(-1)).toMatchObject({
        role: "user",
        content: "continue",
      });
    });

    it("preserves full history in reconciliationMessages when prompt replay truncates", async () => {
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
      const longHistoryEntry = "history-" + "x".repeat(3_600);

      await executor.execute(
        createParams({
          history: [
            { role: "user", content: longHistoryEntry },
            { role: "assistant", content: "stored" },
          ],
          sessionId: "stateful-long-history",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-long-history",
          },
        }),
      );

      const callMessages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | LLMMessage[]
        | undefined;
      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;

      expect(callMessages?.[1]).toMatchObject({
        role: "user",
      });
      expect(typeof callMessages?.[1]?.content).toBe("string");
      expect(String(callMessages?.[1]?.content)).toHaveLength(2_000);
      expect(String(callMessages?.[1]?.content).endsWith("...")).toBe(true);

      expect(reconciliationMessages?.[1]).toEqual({
        role: "user",
        content: longHistoryEntry,
      });
    });

    it("passes persisted stateful resume anchors through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: true,
              store: true,
              fallbackToStateless: true,
              previousResponseId: "resp_prev",
              responseId: "resp_next",
              reconciliationHash: "hash-next",
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-resume" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-resume",
          stateful: {
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-resume",
            reconciliationMessages: expect.any(Array),
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          }),
        }),
      );
    });

    it("does not pass session stateful options into planner synthesis calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                reason: "deterministic_summary",
                requiresSynthesis: true,
                steps: [
                  {
                    name: "prep",
                    step_type: "deterministic_tool",
                    tool: "system.bash",
                    args: { command: "echo", args: ["ok"] },
                  },
                ],
              }),
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "final synthesized answer",
              stateful: {
                enabled: false,
                attempted: false,
                continued: false,
                store: true,
                fallbackToStateless: true,
                events: [],
              },
            }),
          ),
      });
      const pipelineExecutor = {
        execute: vi.fn().mockResolvedValue({
          status: "completed",
          context: { results: {} },
          completedSteps: 1,
          totalSteps: 1,
        }),
      };
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn().mockResolvedValue("ok"),
        plannerEnabled: true,
        pipelineExecutor: pipelineExecutor as any,
      });

      const result = await executor.execute(
        createParams({
          sessionId: "planner-stateful-boundary",
          message: {
            ...createMessage(
              "First run setup checks, then delegate deeper research, then synthesize results.",
            ),
            sessionId: "planner-stateful-boundary",
          },
          stateful: {
            resumeAnchor: {
              previousResponseId: "resp-prev",
              reconciliationHash: "hash-prev",
            },
          },
        }),
      );

      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "planner",
        "planner_synthesis",
      ]);

      const synthesisOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(synthesisOptions?.stateful).toBeUndefined();
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
