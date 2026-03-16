/**
 * Provider fallback call logic extracted from ChatExecutor.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMProvider,
  LLMMessage,
  LLMStatefulResumeAnchor,
  LLMToolChoice,
  StreamProgressCallback,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import {
  applyPromptBudget,
  type PromptBudgetConfig,
  type PromptBudgetSection,
} from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import type {
  ChatExecuteParams,
  ChatCallUsageRecord,
  CooldownEntry,
  FallbackResult,
} from "./chat-executor-types.js";
import {
  shouldRetryProviderImmediately,
  shouldFallbackForFailureClass,
  computeProviderCooldownMs,
  buildActiveCooldownSnapshot,
  emitProviderTraceEvent,
} from "./chat-executor-provider-retry.js";
import {
  estimatePromptShape,
} from "./chat-executor-text.js";

// ============================================================================
// Helper
// ============================================================================

function shouldBypassStreamingForForcedSingleToolTurn(
  options: LLMChatOptions | undefined,
): boolean {
  if (!options?.toolRouting?.allowedToolNames) {
    return false;
  }
  if (options.toolRouting.allowedToolNames.length !== 1) {
    return false;
  }
  if (options.toolChoice === "required") {
    return true;
  }
  return typeof options.toolChoice === "object" &&
    options.toolChoice !== null &&
    options.toolChoice.type === "function";
}

// ============================================================================
// Configuration interface for callWithFallback
// ============================================================================

export interface CallWithFallbackDeps {
  readonly providers: readonly LLMProvider[];
  readonly cooldowns: Map<string, CooldownEntry>;
  readonly promptBudget: PromptBudgetConfig;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
}

export interface CallWithFallbackOptions {
  statefulSessionId?: string;
  statefulResumeAnchor?: LLMStatefulResumeAnchor;
  statefulHistoryCompacted?: boolean;
  reconciliationMessages?: readonly LLMMessage[];
  routedToolNames?: readonly string[];
  toolChoice?: LLMToolChoice;
  requestDeadlineAt?: number;
  signal?: AbortSignal;
  trace?: ChatExecuteParams["trace"];
  callIndex?: number;
  callPhase?: ChatCallUsageRecord["phase"];
}

// ============================================================================
// callWithFallback
// ============================================================================

/**
 * Call LLM providers with fallback and cooldown management.
 */
export async function callWithFallback(
  deps: CallWithFallbackDeps,
  messages: readonly LLMMessage[],
  onStreamChunk?: StreamProgressCallback,
  messageSections?: readonly PromptBudgetSection[],
  options?: CallWithFallbackOptions,
): Promise<FallbackResult> {
  const beforeBudget = estimatePromptShape(messages);
  const budgeted = applyPromptBudget(
    messages.map((message, index) => ({
      message,
      section: messageSections?.[index],
    })),
    deps.promptBudget,
  );
  const boundedMessages = budgeted.messages;
  const afterBudget = estimatePromptShape(boundedMessages);
  const budgetDiagnostics = budgeted.diagnostics;
  const hasStatefulSessionId = Boolean(options?.statefulSessionId);
  const hasStatefulResumeAnchor =
    hasStatefulSessionId && options?.statefulResumeAnchor !== undefined;
  const hasStatefulHistoryCompacted =
    hasStatefulSessionId && options?.statefulHistoryCompacted === true;
  const hasRoutedToolNames = options?.routedToolNames !== undefined;
  const hasToolChoice = options?.toolChoice !== undefined;
  const hasAbortSignal = options?.signal !== undefined;
  const hasProviderTrace =
    options?.trace?.includeProviderPayloads === true ||
    options?.trace?.onProviderTraceEvent !== undefined;
  const baseChatOptions: LLMChatOptions | undefined =
    hasStatefulSessionId ||
      hasRoutedToolNames ||
      hasToolChoice ||
      hasAbortSignal ||
      hasProviderTrace
      ? {
        ...(hasStatefulSessionId
          ? {
            stateful: {
              sessionId: String(options?.statefulSessionId),
              reconciliationMessages:
                options?.reconciliationMessages ?? messages,
              ...(hasStatefulHistoryCompacted
                ? { historyCompacted: true }
                : {}),
              ...(hasStatefulResumeAnchor
                ? { resumeAnchor: options?.statefulResumeAnchor }
                : {}),
            },
          }
          : {}),
        ...(hasRoutedToolNames
          ? { toolRouting: { allowedToolNames: options?.routedToolNames } }
          : {}),
        ...(hasToolChoice ? { toolChoice: options?.toolChoice } : {}),
        ...(hasAbortSignal ? { signal: options?.signal } : {}),
        ...(hasProviderTrace
          ? {
            trace: {
              includeProviderPayloads:
                options?.trace?.includeProviderPayloads === true,
              ...(options?.trace?.onProviderTraceEvent
                ? {
                  onProviderTraceEvent: (event: Parameters<NonNullable<NonNullable<LLMChatOptions["trace"]>["onProviderTraceEvent"]>>[0]) =>
                    emitProviderTraceEvent(options, event),
                }
                : {}),
            },
          }
          : {}),
      }
      : undefined;
  let lastError: Error | undefined;
  const transport =
    onStreamChunk !== undefined &&
    !shouldBypassStreamingForForcedSingleToolTurn(baseChatOptions)
      ? "chat_stream"
      : "chat";

  for (let i = 0; i < deps.providers.length; i++) {
    const provider = deps.providers[i];
    const now = Date.now();
    const cooldown = deps.cooldowns.get(provider.name);

    if (cooldown && cooldown.availableAt > now) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport,
        provider: provider.name,
        payload: {
          reason: "provider_cooldown_skip",
          retryAfterMs: Math.max(0, cooldown.availableAt - now),
          availableAt: cooldown.availableAt,
          failures: cooldown.failures,
        },
        context: {
          stage: "fallback_selection",
        },
      });
      continue;
    }

    let attempts = 0;
    while (true) {
      try {
        const streamChunkCallback = onStreamChunk;
        const shouldStream =
          transport === "chat_stream" && streamChunkCallback !== undefined;
        const remainingProviderMs =
          options?.requestDeadlineAt !== undefined &&
            Number.isFinite(options.requestDeadlineAt)
            ? Math.max(1, options.requestDeadlineAt - Date.now())
            : undefined;
        const providerChatOptions: LLMChatOptions | undefined =
          baseChatOptions || remainingProviderMs !== undefined
            ? {
              ...(baseChatOptions ?? {}),
              ...(remainingProviderMs !== undefined
                ? { timeoutMs: remainingProviderMs }
                : {}),
            }
            : undefined;
        const response = shouldStream
          ? await provider.chatStream(
            boundedMessages,
            streamChunkCallback,
            providerChatOptions,
          )
          : await provider.chat(boundedMessages, providerChatOptions);

        if (response.finishReason === "error") {
          throw (
            response.error ??
            new LLMProviderError(provider.name, "Provider returned error")
          );
        }

        // Success — clear cooldown
        const priorCooldown = deps.cooldowns.get(provider.name);
        deps.cooldowns.delete(provider.name);
        if (priorCooldown) {
          emitProviderTraceEvent(options, {
            kind: "response",
            transport,
            provider: provider.name,
            model: response.model,
            payload: {
              reason: "provider_cooldown_cleared",
              failures: priorCooldown.failures,
              previousAvailableAt: priorCooldown.availableAt,
            },
            context: {
              stage: "fallback_selection",
            },
          });
        }

        return {
          response,
          providerName: provider.name,
          usedFallback: i > 0,
          beforeBudget,
          afterBudget,
          budgetDiagnostics,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failureClass = classifyLLMFailure(lastError);
        const retryRule = deps.retryPolicyMatrix[failureClass];

        if (
          shouldRetryProviderImmediately(
            failureClass,
            retryRule,
            lastError,
            attempts,
          )
        ) {
          attempts++;
          continue;
        }

        if (!shouldFallbackForFailureClass(failureClass, lastError)) {
          throw lastError;
        }

        // Apply cooldown for this provider before trying fallbacks.
        const failures =
          (deps.cooldowns.get(provider.name)?.failures ?? 0) + 1;
        const cooldownDuration = computeProviderCooldownMs(
          failures,
          retryRule,
          lastError,
          deps.cooldownMs,
          deps.maxCooldownMs,
        );
        const availableAt = Date.now() + cooldownDuration;
        deps.cooldowns.set(provider.name, {
          availableAt,
          failures,
        });
        emitProviderTraceEvent(options, {
          kind: "error",
          transport,
          provider: provider.name,
          payload: {
            reason: "provider_cooldown_applied",
            failureClass,
            retryAfterMs: cooldownDuration,
            cooldownDurationMs: cooldownDuration,
            availableAt,
            failures,
            errorName: lastError.name,
            errorMessage: lastError.message,
            ...(lastError instanceof LLMProviderError &&
            lastError.statusCode !== undefined
              ? { statusCode: lastError.statusCode }
              : {}),
            ...(lastError instanceof LLMRateLimitError &&
            lastError.retryAfterMs !== undefined
              ? { providerRetryAfterMs: lastError.retryAfterMs }
              : {}),
          },
          context: {
            stage: "fallback_selection",
            attempts,
          },
        });
        break;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  const now = Date.now();
  emitProviderTraceEvent(options, {
    kind: "error",
    transport,
    provider: "chat-executor",
    payload: {
      reason: "all_providers_in_cooldown",
      providers: buildActiveCooldownSnapshot(deps.cooldowns, now),
    },
    context: {
      stage: "fallback_selection",
    },
  });
  // All providers were skipped (in cooldown) — no provider was attempted
  throw new LLMProviderError(
    "chat-executor",
    "All providers are in cooldown",
  );
}
