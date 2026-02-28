/**
 * Shared LLM pipeline failure taxonomy and retry/circuit-breaker policy schema.
 *
 * Phase 1 introduces these provider-agnostic types so later phases can reuse
 * one canonical stop-reason and retry-decision contract.
 */

/** Canonical failure class used across provider adapters and chat orchestration. */
export type LLMFailureClass =
  | "validation_error"
  | "provider_error"
  | "authentication_error"
  | "rate_limited"
  | "timeout"
  | "tool_error"
  | "budget_exceeded"
  | "no_progress"
  | "cancelled"
  | "unknown";

/** Canonical stop reasons surfaced by the runtime pipeline. */
export type LLMPipelineStopReason =
  | "completed"
  | "tool_calls"
  | "validation_error"
  | "provider_error"
  | "authentication_error"
  | "rate_limited"
  | "timeout"
  | "tool_error"
  | "budget_exceeded"
  | "no_progress"
  | "cancelled";

/** Retry/circuit-breaker behavior for one failure class. */
export interface LLMRetryPolicyRule {
  /** Maximum retry attempts after the initial call. */
  readonly maxRetries: number;
  /** Base backoff delay in milliseconds. */
  readonly baseDelayMs: number;
  /** Max backoff delay in milliseconds. */
  readonly maxDelayMs: number;
  /** Whether randomized backoff jitter is applied. */
  readonly jitter: boolean;
  /** Whether failures of this class should contribute to breaker windows. */
  readonly circuitBreakerEligible: boolean;
}

/** Global retry policy matrix keyed by canonical failure class. */
export type LLMRetryPolicyMatrix = {
  readonly [K in LLMFailureClass]: LLMRetryPolicyRule;
};

/**
 * Baseline retry policy matrix.
 *
 * - Deterministic/local failures do not retry.
 * - Transient transport/provider failures can retry with capped backoff.
 */
export const DEFAULT_LLM_RETRY_POLICY_MATRIX: LLMRetryPolicyMatrix = {
  validation_error: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    circuitBreakerEligible: false,
  },
  provider_error: {
    maxRetries: 2,
    baseDelayMs: 500,
    maxDelayMs: 5_000,
    jitter: true,
    circuitBreakerEligible: true,
  },
  authentication_error: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    circuitBreakerEligible: false,
  },
  rate_limited: {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
    jitter: true,
    circuitBreakerEligible: true,
  },
  timeout: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitter: true,
    circuitBreakerEligible: true,
  },
  tool_error: {
    maxRetries: 1,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    jitter: true,
    circuitBreakerEligible: true,
  },
  budget_exceeded: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    circuitBreakerEligible: false,
  },
  no_progress: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    circuitBreakerEligible: true,
  },
  cancelled: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    circuitBreakerEligible: false,
  },
  unknown: {
    maxRetries: 1,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    jitter: true,
    circuitBreakerEligible: true,
  },
};

/** Map canonical failure classes to canonical stop reasons. */
export function toPipelineStopReason(
  failureClass: LLMFailureClass,
): LLMPipelineStopReason {
  if (failureClass === "unknown") {
    return "provider_error";
  }
  return failureClass;
}
