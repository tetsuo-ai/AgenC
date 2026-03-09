import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_SCHEMA_VERSION,
  assertAgentRunStateTransition,
  assertValidAgentRunContract,
  canTransitionAgentRunState,
  inferAgentRunDomain,
  isRecoverableAgentRunState,
  isTerminalAgentRunState,
} from "./agent-run-contract.js";

describe("agent-run-contract", () => {
  it("exposes the current schema version", () => {
    expect(AGENT_RUN_SCHEMA_VERSION).toBe(2);
  });

  it("classifies terminal and recoverable states correctly", () => {
    expect(isTerminalAgentRunState("completed")).toBe(true);
    expect(isTerminalAgentRunState("failed")).toBe(true);
    expect(isTerminalAgentRunState("cancelled")).toBe(true);
    expect(isTerminalAgentRunState("blocked")).toBe(false);

    expect(isRecoverableAgentRunState("pending")).toBe(true);
    expect(isRecoverableAgentRunState("blocked")).toBe(true);
    expect(isRecoverableAgentRunState("suspended")).toBe(true);
    expect(isRecoverableAgentRunState("completed")).toBe(false);
  });

  it("permits documented lifecycle transitions", () => {
    expect(canTransitionAgentRunState("working", "running")).toBe(true);
    expect(canTransitionAgentRunState("running", "blocked")).toBe(true);
    expect(canTransitionAgentRunState("blocked", "running")).toBe(true);
    expect(canTransitionAgentRunState("blocked", "working")).toBe(true);
    expect(canTransitionAgentRunState("working", "suspended")).toBe(true);
    expect(canTransitionAgentRunState("suspended", "working")).toBe(true);
    expect(canTransitionAgentRunState("paused", "working")).toBe(true);
    expect(canTransitionAgentRunState("paused", "completed")).toBe(true);
    expect(canTransitionAgentRunState("blocked", "completed")).toBe(true);
    expect(canTransitionAgentRunState("suspended", "completed")).toBe(true);
  });

  it("rejects invalid lifecycle transitions", () => {
    expect(canTransitionAgentRunState("completed", "working")).toBe(false);
    expect(canTransitionAgentRunState("failed", "running")).toBe(false);
    expect(() =>
      assertAgentRunStateTransition("completed", "working", "test"),
    ).toThrow("Invalid AgentRun state transition");
  });

  it("validates canonical run contracts", () => {
    expect(() =>
      assertValidAgentRunContract({
        domain: "managed_process",
        kind: "until_condition",
        successCriteria: ["observe the desired state"],
        completionCriteria: ["verify the environment confirms success"],
        blockedCriteria: ["missing required tool access"],
        nextCheckMs: 4_000,
        heartbeatMs: 10_000,
        requiresUserStop: false,
        managedProcessPolicy: {
          mode: "restart_on_exit",
          maxRestarts: 3,
          restartBackoffMs: 5_000,
        },
      }),
    ).not.toThrow();
  });

  it("rejects malformed run contracts", () => {
    expect(() =>
      assertValidAgentRunContract({
        domain: "generic",
        kind: "finite",
        successCriteria: [],
        completionCriteria: ["done"],
        blockedCriteria: ["blocked"],
        nextCheckMs: 0,
        requiresUserStop: false,
      }),
    ).toThrow("successCriteria");

    expect(() =>
      assertValidAgentRunContract({
        domain: "managed_process",
        kind: "finite",
        successCriteria: ["ok"],
        completionCriteria: ["done"],
        blockedCriteria: ["blocked"],
        nextCheckMs: 1_000,
        requiresUserStop: false,
        managedProcessPolicy: {
          mode: "restart_on_exit",
          maxRestarts: 0,
        },
      }),
    ).toThrow("maxRestarts");
  });

  it("infers managed-process and approval domains from contract shape", () => {
    expect(
      inferAgentRunDomain({
        objective: "Watch the worker process until it exits.",
        successCriteria: ["Observe the process exit."],
        completionCriteria: ["Process exits."],
        blockedCriteria: ["Missing process tools."],
        managedProcessPolicy: { mode: "until_exit" },
      }),
    ).toBe("managed_process");

    expect(
      inferAgentRunDomain({
        objective: "Wait for approval before continuing.",
        successCriteria: ["Approval received."],
        completionCriteria: ["Resume after approval."],
        blockedCriteria: ["Approval missing."],
      }),
    ).toBe("approval");
  });
});
