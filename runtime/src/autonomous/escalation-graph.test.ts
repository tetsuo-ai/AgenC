import { describe, expect, it } from "vitest";
import { resolveEscalationTransition } from "./escalation-graph.js";

describe("resolveEscalationTransition", () => {
  it("returns pass transition for pass verdict", () => {
    const transition = resolveEscalationTransition({
      verdict: "pass",
      attempt: 1,
      maxAttempts: 3,
      disagreements: 0,
      maxDisagreements: 2,
      revisionAvailable: true,
      reexecuteOnNeedsRevision: false,
    });

    expect(transition).toEqual({ state: "pass", reason: "pass" });
  });

  it("escalates on timeout and disagreement thresholds deterministically", () => {
    const timeout = resolveEscalationTransition({
      verdict: "fail",
      attempt: 1,
      maxAttempts: 3,
      disagreements: 0,
      maxDisagreements: 2,
      revisionAvailable: true,
      reexecuteOnNeedsRevision: true,
      timedOut: true,
    });

    const disagreement = resolveEscalationTransition({
      verdict: "fail",
      attempt: 2,
      maxAttempts: 3,
      disagreements: 2,
      maxDisagreements: 2,
      revisionAvailable: true,
      reexecuteOnNeedsRevision: true,
    });

    expect(timeout).toEqual({ state: "escalate", reason: "timeout" });
    expect(disagreement).toEqual({
      state: "escalate",
      reason: "disagreement_threshold",
    });
  });

  it("chooses revise/retry/escalate branches based on policy constraints", () => {
    const revise = resolveEscalationTransition({
      verdict: "needs_revision",
      attempt: 1,
      maxAttempts: 3,
      disagreements: 1,
      maxDisagreements: 3,
      revisionAvailable: true,
      reexecuteOnNeedsRevision: false,
    });

    const retry = resolveEscalationTransition({
      verdict: "fail",
      attempt: 1,
      maxAttempts: 3,
      disagreements: 0,
      maxDisagreements: 3,
      revisionAvailable: false,
      reexecuteOnNeedsRevision: true,
    });

    const unavailable = resolveEscalationTransition({
      verdict: "needs_revision",
      attempt: 1,
      maxAttempts: 3,
      disagreements: 0,
      maxDisagreements: 3,
      revisionAvailable: false,
      reexecuteOnNeedsRevision: false,
    });

    expect(revise).toEqual({ state: "revise", reason: "needs_revision" });
    expect(retry).toEqual({ state: "retry", reason: "retry_allowed" });
    expect(unavailable).toEqual({
      state: "escalate",
      reason: "revision_unavailable",
    });
  });
});
