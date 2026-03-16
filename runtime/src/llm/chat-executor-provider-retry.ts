/**
 * Provider retry/cooldown decision logic extracted from ChatExecutor (Gate 4).
 *
 * Pure functions for determining whether a provider call should be retried
 * immediately, fall back to the next provider, compute cooldown durations,
 * annotate failure errors with pipeline stop reasons, build cooldown snapshots,
 * and emit provider-level trace events.
 *
 * @module
 */

import type {
  LLMProviderTraceEvent,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import { toPipelineStopReason } from "./policy.js";
import type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyRule,
} from "./policy.js";
import type {
  ChatExecuteParams,
  ChatCallUsageRecord,
  CooldownEntry,
} from "./chat-executor-types.js";

// ---------------------------------------------------------------------------
// shouldRetryProviderImmediately
// ---------------------------------------------------------------------------

/**
 * Determine whether a failed provider call should be retried immediately
 * (within the same provider) rather than falling back to the next one.
 */
export function shouldRetryProviderImmediately(
  failureClass: LLMFailureClass,
  retryRule: LLMRetryPolicyRule,
  error: Error,
  attempts: number,
): boolean {
  if (attempts >= retryRule.maxRetries) return false;
  switch (failureClass) {
    case "validation_error":
    case "authentication_error":
    case "budget_exceeded":
    case "cancelled":
    case "tool_error":
    case "no_progress":
      return false;
    case "rate_limited":
      // Respect provider retry-after via cooldown/fallback instead of tight-loop retries.
      return !(error instanceof LLMRateLimitError && Boolean(error.retryAfterMs));
    case "provider_error":
      // 4xx-style provider validation/config failures are deterministic.
      if (error instanceof LLMProviderError) return false;
      return true;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// shouldFallbackForFailureClass
// ---------------------------------------------------------------------------

/**
 * Determine whether a failure class warrants falling back to the next provider.
 * Returns false for deterministic / non-recoverable failures that should be
 * thrown immediately.
 */
export function shouldFallbackForFailureClass(
  failureClass: LLMFailureClass,
  error: Error,
): boolean {
  switch (failureClass) {
    case "validation_error":
    case "authentication_error":
    case "budget_exceeded":
    case "cancelled":
      return false;
    case "provider_error":
      return !(error instanceof LLMProviderError);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// computeProviderCooldownMs
// ---------------------------------------------------------------------------

/**
 * Compute the cooldown duration (in milliseconds) to apply to a provider
 * after a failure.  Respects provider-supplied `retryAfterMs` when present,
 * otherwise uses linear back-off capped at `maxCooldownMs`.
 *
 * @param failures       - cumulative failure count for this provider
 * @param retryRule      - the retry policy rule for this failure class
 * @param error          - the original error
 * @param cooldownMs     - base cooldown duration (from ChatExecutor config)
 * @param maxCooldownMs  - maximum cooldown cap   (from ChatExecutor config)
 */
export function computeProviderCooldownMs(
  failures: number,
  retryRule: LLMRetryPolicyRule,
  error: Error,
  cooldownMs: number,
  maxCooldownMs: number,
): number {
  if (error instanceof LLMRateLimitError && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  const linearCooldown = Math.min(
    cooldownMs * failures,
    maxCooldownMs,
  );
  const policyCooldown = retryRule.baseDelayMs > 0
    ? Math.min(retryRule.baseDelayMs * failures, retryRule.maxDelayMs)
    : 0;
  return Math.max(0, Math.max(linearCooldown, policyCooldown));
}

// ---------------------------------------------------------------------------
// annotateFailureError
// ---------------------------------------------------------------------------

/**
 * Annotate an error with pipeline failure classification metadata
 * (`failureClass`, `stopReason`, `stopReasonDetail`).
 */
export function annotateFailureError(
  error: unknown,
  stage: string,
): {
  error: Error;
  failureClass: LLMFailureClass;
  stopReason: LLMPipelineStopReason;
  stopReasonDetail: string;
} {
  const baseError = error instanceof Error ? error : new Error(String(error));
  const failureClass = classifyLLMFailure(baseError);
  const stopReason = toPipelineStopReason(failureClass);
  const stopReasonDetail = `${stage} failed (${stopReason}): ${baseError.message}`;
  const annotated = baseError as Error & {
    failureClass?: LLMFailureClass;
    stopReason?: LLMPipelineStopReason;
    stopReasonDetail?: string;
  };
  annotated.failureClass = failureClass;
  annotated.stopReason = stopReason;
  annotated.stopReasonDetail = stopReasonDetail;
  return {
    error: annotated,
    failureClass,
    stopReason,
    stopReasonDetail,
  };
}

// ---------------------------------------------------------------------------
// buildActiveCooldownSnapshot
// ---------------------------------------------------------------------------

/**
 * Build a sorted snapshot of all providers currently in cooldown.
 *
 * @param cooldowns - the live cooldown map from ChatExecutor
 * @param now       - current timestamp (milliseconds)
 */
export function buildActiveCooldownSnapshot(
  cooldowns: Map<string, CooldownEntry>,
  now: number,
): Array<{
  provider: string;
  retryAfterMs: number;
  availableAt: number;
  failures: number;
}> {
  return Array.from(cooldowns.entries())
    .map(([provider, cooldown]) => ({
      provider,
      retryAfterMs: Math.max(0, cooldown.availableAt - now),
      availableAt: cooldown.availableAt,
      failures: cooldown.failures,
    }))
    .filter((entry) => entry.retryAfterMs > 0)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

// ---------------------------------------------------------------------------
// emitProviderTraceEvent
// ---------------------------------------------------------------------------

/**
 * Emit a provider-level trace event, enriching with callIndex / callPhase
 * when available.
 */
export function emitProviderTraceEvent(
  options:
    | {
        trace?: ChatExecuteParams["trace"];
        callIndex?: number;
        callPhase?: ChatCallUsageRecord["phase"];
      }
    | undefined,
  event: Omit<LLMProviderTraceEvent, "callIndex" | "callPhase">,
): void {
  options?.trace?.onProviderTraceEvent?.({
    ...event,
    ...(options.callIndex !== undefined
      ? { callIndex: options.callIndex }
      : {}),
    ...(options.callPhase !== undefined
      ? { callPhase: options.callPhase }
      : {}),
  });
}
