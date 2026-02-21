/**
 * Deterministic escalation transition graph for verifier lane outcomes.
 *
 * @module
 */

import type { VerifierVerdict } from "./types.js";

export type EscalationTransitionState =
  | "pass"
  | "retry"
  | "revise"
  | "escalate";

export type EscalationTransitionReason =
  | "pass"
  | "retry_allowed"
  | "needs_revision"
  | "retries_exhausted"
  | "revision_unavailable"
  | "disagreement_threshold"
  | "timeout"
  | "policy_denied"
  | "budget_exhausted";

export interface EscalationGraphInput {
  verdict: VerifierVerdict;
  attempt: number;
  maxAttempts: number;
  disagreements: number;
  maxDisagreements: number;
  revisionAvailable: boolean;
  reexecuteOnNeedsRevision: boolean;
  timedOut?: boolean;
  policyDenied?: boolean;
  budgetExhausted?: boolean;
}

export interface EscalationGraphTransition {
  state: EscalationTransitionState;
  reason: EscalationTransitionReason;
}

/**
 * Resolve deterministic verifier transition for a single attempt.
 */
export function resolveEscalationTransition(
  input: EscalationGraphInput,
): EscalationGraphTransition {
  if (input.policyDenied) {
    return { state: "escalate", reason: "policy_denied" };
  }

  if (input.timedOut) {
    return { state: "escalate", reason: "timeout" };
  }

  if (input.budgetExhausted) {
    return { state: "escalate", reason: "budget_exhausted" };
  }

  if (input.verdict === "pass") {
    return { state: "pass", reason: "pass" };
  }

  if (input.disagreements >= input.maxDisagreements) {
    return { state: "escalate", reason: "disagreement_threshold" };
  }

  const attemptsRemaining = input.attempt < input.maxAttempts;
  if (!attemptsRemaining) {
    return { state: "escalate", reason: "retries_exhausted" };
  }

  if (input.verdict === "needs_revision") {
    if (input.revisionAvailable) {
      return { state: "revise", reason: "needs_revision" };
    }

    if (input.reexecuteOnNeedsRevision) {
      return { state: "retry", reason: "retry_allowed" };
    }

    return { state: "escalate", reason: "revision_unavailable" };
  }

  return { state: "retry", reason: "retry_allowed" };
}
