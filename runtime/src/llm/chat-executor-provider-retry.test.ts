/**
 * Contract tests for provider retry/cooldown helpers.
 * Gate 4 — validates the extracted seam independently.
 */
import { describe, it, expect, vi } from "vitest";
import {
  shouldRetryProviderImmediately,
  shouldFallbackForFailureClass,
  computeProviderCooldownMs,
  annotateFailureError,
  buildActiveCooldownSnapshot,
  emitProviderTraceEvent,
} from "./chat-executor-provider-retry.js";

describe("shouldRetryProviderImmediately", () => {
  const rule = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };

  it("returns false when attempts >= maxRetries", () => {
    expect(
      shouldRetryProviderImmediately("timeout", rule, new Error(), 3),
    ).toBe(false);
  });

  it("returns false for validation_error", () => {
    expect(
      shouldRetryProviderImmediately("validation_error", rule, new Error(), 0),
    ).toBe(false);
  });

  it("returns false for authentication_error", () => {
    expect(
      shouldRetryProviderImmediately("authentication_error", rule, new Error(), 0),
    ).toBe(false);
  });

  it("returns true for timeout with remaining retries", () => {
    expect(
      shouldRetryProviderImmediately("timeout", rule, new Error(), 0),
    ).toBe(true);
  });
});

describe("shouldFallbackForFailureClass", () => {
  it("returns false for validation_error", () => {
    expect(shouldFallbackForFailureClass("validation_error", new Error())).toBe(false);
  });

  it("returns false for cancelled", () => {
    expect(shouldFallbackForFailureClass("cancelled", new Error())).toBe(false);
  });

  it("returns true for timeout", () => {
    expect(shouldFallbackForFailureClass("timeout", new Error())).toBe(true);
  });

  it("returns true for rate_limited", () => {
    expect(shouldFallbackForFailureClass("rate_limited", new Error())).toBe(true);
  });
});

describe("computeProviderCooldownMs", () => {
  const rule = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000 };

  it("returns linear cooldown based on failure count", () => {
    const result = computeProviderCooldownMs(2, rule, new Error(), 1000, 10000);
    expect(result).toBeGreaterThan(0);
  });

  it("caps at maxCooldownMs", () => {
    const result = computeProviderCooldownMs(100, rule, new Error(), 1000, 5000);
    expect(result).toBeLessThanOrEqual(5000);
  });

  it("returns 0 for first failure with zero delays", () => {
    const zeroRule = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 };
    const result = computeProviderCooldownMs(1, zeroRule, new Error(), 0, 0);
    expect(result).toBe(0);
  });
});

describe("annotateFailureError", () => {
  it("annotates error with failureClass and stopReason", () => {
    const result = annotateFailureError(new Error("test"), "model_call");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.failureClass).toBeDefined();
    expect(result.stopReason).toBeDefined();
    expect(result.stopReasonDetail).toContain("model_call");
  });

  it("handles non-Error values", () => {
    const result = annotateFailureError("string error", "fallback");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("string error");
  });
});

describe("buildActiveCooldownSnapshot", () => {
  it("returns empty array when no cooldowns active", () => {
    const cooldowns = new Map();
    expect(buildActiveCooldownSnapshot(cooldowns, Date.now())).toEqual([]);
  });

  it("filters out expired cooldowns", () => {
    const cooldowns = new Map([
      ["grok", { availableAt: Date.now() - 1000, failures: 1 }],
    ]);
    expect(buildActiveCooldownSnapshot(cooldowns, Date.now())).toEqual([]);
  });

  it("includes active cooldowns with retryAfterMs", () => {
    const future = Date.now() + 5000;
    const cooldowns = new Map([
      ["grok", { availableAt: future, failures: 2 }],
    ]);
    const snapshot = buildActiveCooldownSnapshot(cooldowns, Date.now());
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.provider).toBe("grok");
    expect(snapshot[0]!.retryAfterMs).toBeGreaterThan(0);
    expect(snapshot[0]!.failures).toBe(2);
  });

  it("sorts by provider name", () => {
    const future = Date.now() + 5000;
    const cooldowns = new Map([
      ["ollama", { availableAt: future, failures: 1 }],
      ["grok", { availableAt: future, failures: 1 }],
    ]);
    const snapshot = buildActiveCooldownSnapshot(cooldowns, Date.now());
    expect(snapshot[0]!.provider).toBe("grok");
    expect(snapshot[1]!.provider).toBe("ollama");
  });
});

describe("emitProviderTraceEvent", () => {
  it("calls onProviderTraceEvent when provided", () => {
    const handler = vi.fn();
    emitProviderTraceEvent(
      { trace: { onProviderTraceEvent: handler }, callIndex: 1, callPhase: "initial" },
      { kind: "request", transport: "http", provider: "grok", payload: {} },
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "request",
        provider: "grok",
        callIndex: 1,
        callPhase: "initial",
      }),
    );
  });

  it("does nothing when no trace handler", () => {
    // Should not throw
    emitProviderTraceEvent(undefined, {
      kind: "request",
      transport: "http",
      provider: "grok",
      payload: {},
    });
  });
});
