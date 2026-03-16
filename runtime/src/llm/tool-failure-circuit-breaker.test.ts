/**
 * Contract tests for ToolFailureCircuitBreaker.
 * Gate 4 — validates the extracted seam independently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";

describe("ToolFailureCircuitBreaker", () => {
  let breaker: ToolFailureCircuitBreaker;

  beforeEach(() => {
    breaker = new ToolFailureCircuitBreaker({
      enabled: true,
      windowMs: 10_000,
      threshold: 3,
      cooldownMs: 5_000,
    });
  });

  it("returns null from getActiveCircuit when no failures recorded", () => {
    expect(breaker.getActiveCircuit("session-1")).toBeNull();
  });

  it("does not trip after fewer failures than threshold", () => {
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.recordFailure("s1", "key1", "tool.test");
    expect(breaker.getActiveCircuit("s1")).toBeNull();
  });

  it("trips after threshold failures with same semantic key", () => {
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.recordFailure("s1", "key1", "tool.test");
    const reason = breaker.recordFailure("s1", "key1", "tool.test");
    expect(reason).toContain("tool.test");
    const circuit = breaker.getActiveCircuit("s1");
    expect(circuit).not.toBeNull();
    expect(circuit!.retryAfterMs).toBeGreaterThan(0);
  });

  it("does not trip for different semantic keys", () => {
    breaker.recordFailure("s1", "key1", "tool.a");
    breaker.recordFailure("s1", "key2", "tool.b");
    breaker.recordFailure("s1", "key3", "tool.c");
    expect(breaker.getActiveCircuit("s1")).toBeNull();
  });

  it("clears a pattern on success", () => {
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.clearPattern("s1", "key1");
    breaker.recordFailure("s1", "key1", "tool.test");
    // Should not trip — counter reset
    expect(breaker.getActiveCircuit("s1")).toBeNull();
  });

  it("clearSession removes all state for a session", () => {
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.recordFailure("s1", "key1", "tool.test");
    breaker.recordFailure("s1", "key1", "tool.test");
    expect(breaker.getActiveCircuit("s1")).not.toBeNull();
    breaker.clearSession("s1");
    expect(breaker.getActiveCircuit("s1")).toBeNull();
  });

  it("clearAll removes state for all sessions", () => {
    breaker.recordFailure("s1", "k", "t");
    breaker.recordFailure("s1", "k", "t");
    breaker.recordFailure("s1", "k", "t");
    breaker.recordFailure("s2", "k", "t");
    breaker.recordFailure("s2", "k", "t");
    breaker.recordFailure("s2", "k", "t");
    breaker.clearAll();
    expect(breaker.getActiveCircuit("s1")).toBeNull();
    expect(breaker.getActiveCircuit("s2")).toBeNull();
  });

  it("does nothing when disabled", () => {
    const disabled = new ToolFailureCircuitBreaker({ enabled: false });
    disabled.recordFailure("s1", "k", "t");
    disabled.recordFailure("s1", "k", "t");
    disabled.recordFailure("s1", "k", "t");
    expect(disabled.getActiveCircuit("s1")).toBeNull();
  });

  it("isolates sessions from each other", () => {
    breaker.recordFailure("s1", "k", "t");
    breaker.recordFailure("s1", "k", "t");
    breaker.recordFailure("s1", "k", "t");
    expect(breaker.getActiveCircuit("s1")).not.toBeNull();
    expect(breaker.getActiveCircuit("s2")).toBeNull();
  });
});
