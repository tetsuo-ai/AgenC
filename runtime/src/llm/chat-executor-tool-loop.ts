/**
 * Tool call loop and single tool dispatch extracted from ChatExecutor.
 *
 * @module
 */

import type {
  LLMToolCall,
  LLMResponse,
  StreamProgressCallback,
  LLMStatefulResumeAnchor,
  LLMToolChoice,
} from "./types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";
import type { LLMRetryPolicyMatrix, LLMPipelineStopReason } from "./policy.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { ToolContractGuidance } from "./chat-executor-contract-guidance.js";
import type {
  ToolCallRecord,
  ChatExecutionTraceEvent,
  ChatCallUsageRecord,
  ExecutionContext,
  ToolLoopState,
  ToolCallAction,
  RecoveryHint,
} from "./chat-executor-types.js";
import type {
  RoundStuckState,
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";
import type { ToolRoundBudgetExtensionResult } from "./chat-executor-budget-extension.js";
import type { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";
import {
  MAX_TOOL_IMAGE_CHARS_BUDGET,
} from "./chat-executor-constants.js";
import {
  didToolCallFail,
  checkToolCallPermission,
  normalizeToolCallArguments,
  repairToolCallArgumentsFromMessageText,
  parseToolCallArguments,
  executeToolWithRetry,
  summarizeToolArgumentChanges,
  trackToolCallFailureState,
  checkToolLoopStuckDetection,
  buildToolLoopRecoveryMessages,
  buildRoutingExpansionMessage,
  summarizeToolRoundProgress,
  enrichToolResultMetadata,
} from "./chat-executor-tool-utils.js";
import { inferDoomTurnContract } from "./chat-executor-doom.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
} from "./chat-executor-routing-state.js";
import {
  buildSemanticToolCallKey,
  buildRecoveryHints,
} from "./chat-executor-recovery.js";
import {
  sanitizeToolCallsForReplay,
  generateFallbackContent,
  buildPromptToolContent,
} from "./chat-executor-text.js";

// ============================================================================
// Callback interfaces
// ============================================================================

export interface ToolLoopCallbacks {
  pushMessage(
    ctx: ExecutionContext,
    message: import("./types.js").LLMMessage,
    section: PromptBudgetSection,
    reconciliationMessage?: import("./types.js").LLMMessage,
  ): void;
  setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void;
  checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean;
  appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void;
  emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void;
  replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly RecoveryHint[],
  ): void;
  maybePushRuntimeInstruction(ctx: ExecutionContext, content: string): void;
  resolveActiveToolContractGuidance(
    ctx: ExecutionContext,
    input?: {
      readonly phase?: "initial" | "tool_followup" | "correction";
      readonly allowedToolNames?: readonly string[];
      readonly validationCode?: DelegationOutputValidationCode;
    },
  ): ToolContractGuidance | undefined;
  enforceRequiredToolEvidenceBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required">;
  enforcePlanOnlyExecutionBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required">;
  finalizeDelegatedTurnAfterToolBudgetExhaustion(
    ctx: ExecutionContext,
    effectiveMaxToolRounds: number,
  ): Promise<boolean>;
  callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly import("./types.js").LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: LLMToolChoice;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  evaluateToolRoundBudgetExtension(params: {
    readonly ctx: ExecutionContext;
    readonly currentLimit: number;
    readonly recentRounds: readonly ToolRoundProgressSummary[];
  }): ToolRoundBudgetExtensionResult;
  serializeRemainingRequestMs(remainingRequestMs: number): number | null;
}

export interface ToolLoopConfig {
  readonly maxRuntimeSystemHints: number;
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly allowedTools: Set<string> | null;
  readonly toolFailureBreaker: ToolFailureCircuitBreaker;
}

// ============================================================================
// executeSingleToolCall (standalone)
// ============================================================================

export async function executeSingleToolCall(
  ctx: ExecutionContext,
  toolCall: LLMToolCall,
  loopState: ToolLoopState,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<ToolCallAction> {
  if (callbacks.checkRequestTimeout(ctx, `tool "${toolCall.name}" dispatch`)) {
    return "abort_loop";
  }
  if (ctx.allToolCalls.length >= ctx.effectiveToolBudget) {
    callbacks.setStopReason(
      ctx,
      "budget_exceeded",
      `Tool budget exceeded (${ctx.effectiveToolBudget} per request)`,
    );
    return "abort_loop";
  }

  // Permission check (allowlist, routed subset).
  const permission = checkToolCallPermission(
    toolCall,
    config.allowedTools,
    loopState.activeRoutedToolSet,
    ctx.canExpandOnRoutingMiss,
    ctx.routedToolsExpanded,
  );
  if (permission.errorResult) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_rejected",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        routingMiss: permission.routingMiss === true,
        expandAfterRound: permission.expandAfterRound === true,
        activeRoutedToolNames: loopState.activeRoutedToolSet
          ? [...loopState.activeRoutedToolSet]
          : [],
        error: permission.errorResult,
      },
    });
    if (permission.routingMiss) ctx.routedToolMisses++;
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: permission.errorResult,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args: {},
      result: permission.errorResult,
      isError: true,
      durationMs: 0,
    });
    if (permission.expandAfterRound) loopState.expandAfterRound = true;
    return "skip";
  }
  // Parse arguments.
  const parseResult = parseToolCallArguments(toolCall);
  if (!parseResult.ok) {
    callbacks.emitExecutionTrace(ctx, {
      type: "tool_arguments_invalid",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        error: parseResult.error,
        rawArguments: toolCall.arguments,
      },
    });
    callbacks.pushMessage(
      ctx,
      {
        role: "tool",
        content: parseResult.error,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "tools",
    );
    callbacks.appendToolRecord(ctx, {
      name: toolCall.name,
      args: {},
      result: parseResult.error,
      isError: true,
      durationMs: 0,
    });
    return "skip";
  }
  const rawArgs = parseResult.args;
  let args = normalizeToolCallArguments(toolCall.name, rawArgs);
  const normalizedFields = summarizeToolArgumentChanges(rawArgs, args);
  const repaired = repairToolCallArgumentsFromMessageText(
    toolCall.name,
    args,
    ctx.messageText,
  );
  args = repaired.args;
  const contractAdjustedFields: string[] = [];
  if (toolCall.name === "mcp.doom.start_game") {
    const doomTurnContract = inferDoomTurnContract(ctx.messageText);
    if (
      doomTurnContract?.requiresAutonomousPlay &&
      args.async_player !== true
    ) {
      args = { ...args, async_player: true };
      contractAdjustedFields.push("async_player");
    }
  }
  const argumentDiagnostics: Record<string, unknown> = {};
  if (normalizedFields.length > 0) {
    argumentDiagnostics.normalizedFields = normalizedFields;
  }
  if (repaired.repairedFields.length > 0) {
    argumentDiagnostics.repairSource = "message_text";
    argumentDiagnostics.repairedFields = repaired.repairedFields;
  }
  if (contractAdjustedFields.length > 0) {
    argumentDiagnostics.contractAdjustedFields = contractAdjustedFields;
  }
  if (Object.keys(argumentDiagnostics).length > 0) {
    argumentDiagnostics.rawArgs = rawArgs;
  }
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_dispatch_started",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      tool: toolCall.name,
      args,
      ...(Object.keys(argumentDiagnostics).length > 0
        ? { argumentDiagnostics }
        : {}),
    },
  });

  // Execute tool with retry.
  const exec = await executeToolWithRetry(
    toolCall,
    args,
    ctx.activeToolHandler!,
    {
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      retryPolicyMatrix: config.retryPolicyMatrix,
      signal: ctx.signal,
      requestDeadlineAt: ctx.requestDeadlineAt,
    },
  );

  let { result } = exec;
  let abortRound = false;
  if (exec.timedOut && exec.toolFailed) {
    callbacks.setStopReason(
      ctx,
      "timeout",
      `Tool "${toolCall.name}" timed out after ${exec.finalToolTimeoutMs}ms`,
    );
    abortRound = true;
  }

  if (exec.toolFailed) {
    const failKey = buildSemanticToolCallKey(toolCall.name, args);
    const circuitReason = config.toolFailureBreaker.recordFailure(
      ctx.sessionId,
      failKey,
      toolCall.name,
    );
    if (circuitReason) {
      callbacks.setStopReason(ctx, "no_progress", circuitReason);
      abortRound = true;
      result = enrichToolResultMetadata(result, {
        circuitBreaker: "open",
        circuitBreakerReason: circuitReason,
      });
    }
  }

  callbacks.appendToolRecord(ctx, {
    name: toolCall.name,
    args,
    result,
    isError: exec.toolFailed,
    durationMs: exec.durationMs,
  });
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_dispatch_finished",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      tool: toolCall.name,
      args,
      durationMs: exec.durationMs,
      isError: exec.toolFailed,
      timedOut: exec.timedOut,
      result,
    },
  });

  if (ctx.failedToolCalls > ctx.effectiveFailureBudget) {
    callbacks.setStopReason(
      ctx,
      "tool_error",
      `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget})`,
    );
    abortRound = true;
  }

  // Track consecutive semantic failures to detect stuck loops.
  const semanticToolKey = buildSemanticToolCallKey(toolCall.name, args);
  if (!exec.toolFailed) {
    config.toolFailureBreaker.clearPattern(ctx.sessionId, semanticToolKey);
  }
  trackToolCallFailureState(exec.toolFailed, semanticToolKey, loopState);

  const promptToolContent = buildPromptToolContent(
    result,
    loopState.remainingToolImageChars,
  );
  loopState.remainingToolImageChars = promptToolContent.remainingImageBudget;
  callbacks.pushMessage(
    ctx,
    {
      role: "tool",
      content: promptToolContent.content,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    "tools",
  );

  if (abortRound) return "abort_round";
  if (exec.toolFailed && toolCall.name === "mcp.doom.start_game") {
    // Downstream Doom setup calls depend on a live game/executor.
    return "end_round";
  }
  return "processed";
}

// ============================================================================
// executeToolCallLoop (standalone)
// ============================================================================

export async function executeToolCallLoop(
  ctx: ExecutionContext,
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<void> {
  const suppressToolsForDialogueTurn =
    !ctx.plannerDecision.shouldPlan &&
    (ctx.plannerDecision.reason === "exact_response_turn" ||
      ctx.plannerDecision.reason === "dialogue_memory_turn" ||
      ctx.plannerDecision.reason === "dialogue_recall_turn");
  const initialContractGuidance = callbacks.resolveActiveToolContractGuidance(ctx, {
    phase: "initial",
  });
  const dialogueToolSuppressed =
    suppressToolsForDialogueTurn &&
    initialContractGuidance?.routedToolNames === undefined &&
    ctx.initialRoutedToolNames.length > 0;
  if (initialContractGuidance) {
    callbacks.emitExecutionTrace(ctx, {
      type: "contract_guidance_resolved",
      phase: "initial",
      callIndex: ctx.callIndex + 1,
      payload: {
        source: initialContractGuidance.source,
        routedToolNames: initialContractGuidance.routedToolNames ?? [],
        toolChoice:
          typeof initialContractGuidance.toolChoice === "string"
            ? initialContractGuidance.toolChoice
            : initialContractGuidance.toolChoice.name,
        hasRuntimeInstruction: Boolean(initialContractGuidance.runtimeInstruction),
      },
    });
  }
  if (initialContractGuidance?.runtimeInstruction) {
    callbacks.maybePushRuntimeInstruction(
      ctx,
      initialContractGuidance.runtimeInstruction,
    );
  }
  const initialToolChoice =
    initialContractGuidance?.toolChoice ??
    (ctx.requiredToolEvidence
      ? "required"
      : suppressToolsForDialogueTurn
        ? "none"
        : undefined);
  const initialRoutedToolNames =
    initialContractGuidance?.routedToolNames ??
    (suppressToolsForDialogueTurn ? [] : undefined);
  ctx.response = await callbacks.callModelForPhase(ctx, {
    phase: "initial",
    callMessages: ctx.messages,
    callSections: ctx.messageSections,
    onStreamChunk: ctx.activeStreamCallback,
    statefulSessionId: ctx.sessionId,
    statefulResumeAnchor: ctx.stateful?.resumeAnchor,
    statefulHistoryCompacted: ctx.stateful?.historyCompacted,
    preparationDiagnostics: {
      plannerReason: ctx.plannerDecision.reason,
      plannerShouldPlan: ctx.plannerDecision.shouldPlan,
      dialogueToolSuppressed,
      ...(dialogueToolSuppressed
        ? { preSuppressionRoutedToolNames: ctx.initialRoutedToolNames }
        : {}),
    },
    ...((initialToolChoice !== undefined || initialRoutedToolNames !== undefined)
      ? {
        ...(initialToolChoice !== undefined
          ? { toolChoice: initialToolChoice }
          : {}),
        ...(initialRoutedToolNames !== undefined
          ? { routedToolNames: initialRoutedToolNames }
          : {}),
        ...(initialContractGuidance?.persistRoutedToolNames === false
          ? { persistRoutedToolNames: false }
          : {}),
      }
      : {}),
    budgetReason:
      "Initial completion blocked by max model recalls per request budget",
  });
  const initialPlanOnlyAction =
    await callbacks.enforcePlanOnlyExecutionBeforeCompletion(ctx, "initial");
  if (initialPlanOnlyAction === "failed" && !ctx.finalContent) {
    ctx.finalContent = ctx.response?.content ?? ctx.finalContent;
  }
  if (initialPlanOnlyAction === "failed") {
    return;
  }

  const initialEvidenceAction =
    await callbacks.enforceRequiredToolEvidenceBeforeCompletion(ctx, "initial");
  if (initialEvidenceAction === "failed" && !ctx.finalContent) {
    ctx.finalContent = ctx.response?.content ?? ctx.finalContent;
  }

  let rounds = 0;
  let effectiveMaxToolRounds = ctx.effectiveMaxToolRounds;
  const successfulSemanticToolKeys = new Set<string>();
  const verificationFailureDiagnosticKeys = new Set<string>();
  const recentRoundProgress: ToolRoundProgressSummary[] = [];
  const stuckState: RoundStuckState = {
    consecutiveAllFailedRounds: 0,
    lastRoundSemanticKey: "",
    consecutiveSemanticDuplicateRounds: 0,
  };
  const loopState: ToolLoopState = {
    remainingToolImageChars: MAX_TOOL_IMAGE_CHARS_BUDGET,
    activeRoutedToolSet: null,
    expandAfterRound: false,
    lastFailKey: "",
    consecutiveFailCount: 0,
  };

  while (
    ctx.response &&
    ctx.response.finishReason === "tool_calls" &&
    ctx.response.toolCalls.length > 0 &&
    ctx.activeToolHandler &&
    rounds < effectiveMaxToolRounds
  ) {
    if (ctx.signal?.aborted) {
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool loop")) break;
    const activeCircuit = config.toolFailureBreaker.getActiveCircuit(ctx.sessionId);
    if (activeCircuit) {
      callbacks.setStopReason(ctx, "no_progress", activeCircuit.reason);
      break;
    }

    rounds++;
    const roundToolCallStart = ctx.allToolCalls.length;
    const roundStartedAt = Date.now();
    const roundRoutedToolNames =
      ctx.transientRoutedToolNames ?? ctx.activeRoutedToolNames;
    loopState.activeRoutedToolSet = buildActiveRoutedToolSet(
      roundRoutedToolNames,
    );
    ctx.transientRoutedToolNames = undefined;
    loopState.expandAfterRound = false;

    callbacks.pushMessage(
      ctx,
      {
        role: "assistant",
        content: ctx.response.content,
        phase: "commentary",
        toolCalls: sanitizeToolCallsForReplay(ctx.response.toolCalls),
      },
      "assistant_runtime",
    );

    let abortRound = false;
    for (const toolCall of ctx.response.toolCalls) {
      const action = await executeSingleToolCall(ctx, toolCall, loopState, config, callbacks);
      if (action === "end_round") {
        break;
      }
      if (action === "abort_loop" || action === "abort_round") {
        abortRound = true;
        break;
      }
    }

    if (ctx.signal?.aborted) {
      callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
      break;
    }
    if (callbacks.checkRequestTimeout(ctx, "tool follow-up")) break;

    const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
    if (abortRound) break;

    // Stuck-loop detection (consecutive failures, semantic duplicates).
    const stuckResult = checkToolLoopStuckDetection(roundCalls, loopState, stuckState);
    if (stuckResult.shouldBreak) {
      const roundFailures = roundCalls.filter((call) =>
        didToolCallFail(call.isError, call.result)
      ).length;
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_loop_stuck_detected",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          reason: stuckResult.reason,
          roundToolCallCount: roundCalls.length,
          roundFailureCount: roundFailures,
          consecutiveFailCount: loopState.consecutiveFailCount,
          consecutiveAllFailedRounds: stuckState.consecutiveAllFailedRounds,
          consecutiveSemanticDuplicateRounds:
            stuckState.consecutiveSemanticDuplicateRounds,
        },
      });
      callbacks.setStopReason(ctx, "no_progress", stuckResult.reason);
      break;
    }

    // Recovery hints.
    const recoveryHints = buildRecoveryHints(roundCalls, new Set<string>());
    callbacks.replaceRuntimeRecoveryHintMessages(ctx, recoveryHints);
    if (recoveryHints.length > 0) {
      callbacks.emitExecutionTrace(ctx, {
        type: "recovery_hints_injected",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          count: recoveryHints.length,
          hints: recoveryHints.map((hint) => ({
            key: hint.key,
            message: hint.message,
          })),
        },
      });
    }
    const runtimeHintCount = ctx.messageSections.filter(
      (s) => s === "system_runtime",
    ).length;
    for (const msg of buildToolLoopRecoveryMessages(
      recoveryHints,
      config.maxRuntimeSystemHints,
      runtimeHintCount,
    )) {
      callbacks.pushMessage(ctx, msg, "system_runtime");
    }

    // Routing expansion on miss.
    if (loopState.expandAfterRound && ctx.expandedRoutedToolNames.length > 0) {
      const previousRoutedToolNames = [...ctx.activeRoutedToolNames];
      ctx.routedToolsExpanded = true;
      applyActiveRoutedToolNames(ctx, ctx.expandedRoutedToolNames);
      callbacks.emitExecutionTrace(ctx, {
        type: "route_expanded",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          previousRoutedToolNames,
          nextRoutedToolNames: ctx.activeRoutedToolNames,
          routedToolMisses: ctx.routedToolMisses,
        },
      });
      const updatedHintCount = ctx.messageSections.filter(
        (s) => s === "system_runtime",
      ).length;
      const expansionMsg = buildRoutingExpansionMessage(
        config.maxRuntimeSystemHints,
        updatedHintCount,
      );
      if (expansionMsg) {
        callbacks.pushMessage(ctx, expansionMsg, "system_runtime");
      }
    }

    const followupContractGuidance = callbacks.resolveActiveToolContractGuidance(
      ctx,
      {
        phase: "tool_followup",
      },
    );
    if (followupContractGuidance) {
      callbacks.emitExecutionTrace(ctx, {
        type: "contract_guidance_resolved",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          source: followupContractGuidance.source,
          routedToolNames: followupContractGuidance.routedToolNames ?? [],
          toolChoice:
            typeof followupContractGuidance.toolChoice === "string"
              ? followupContractGuidance.toolChoice
              : followupContractGuidance.toolChoice.name,
          hasRuntimeInstruction: Boolean(
            followupContractGuidance.runtimeInstruction,
          ),
        },
      });
    }
    if (followupContractGuidance?.runtimeInstruction) {
      callbacks.maybePushRuntimeInstruction(
        ctx,
        followupContractGuidance.runtimeInstruction,
      );
    }

    // Re-call LLM.
    const nextResponse = await callbacks.callModelForPhase(ctx, {
      phase: "tool_followup",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      statefulHistoryCompacted: ctx.stateful?.historyCompacted,
      ...(followupContractGuidance
        ? {
          toolChoice: followupContractGuidance.toolChoice,
          ...(followupContractGuidance.routedToolNames
            ? {
              routedToolNames: followupContractGuidance.routedToolNames,
              ...(followupContractGuidance.persistRoutedToolNames === false
                ? { persistRoutedToolNames: false }
                : {}),
            }
            : {}),
        }
        : {}),
      budgetReason:
        "Max model recalls exceeded while following up after tool calls",
    });
    if (!nextResponse) break;
    ctx.response = nextResponse;
    const planOnlyAction =
      await callbacks.enforcePlanOnlyExecutionBeforeCompletion(
        ctx,
        "tool_followup",
      );
    if (planOnlyAction === "failed") break;
    const evidenceAction =
      await callbacks.enforceRequiredToolEvidenceBeforeCompletion(
        ctx,
        "tool_followup",
      );
    if (evidenceAction === "failed") break;

    const roundProgress = summarizeToolRoundProgress(
      roundCalls,
      Date.now() - roundStartedAt,
      successfulSemanticToolKeys,
      verificationFailureDiagnosticKeys,
    );
    recentRoundProgress.push(roundProgress);
    if (recentRoundProgress.length > 3) {
      recentRoundProgress.shift();
    }

    if (
      ctx.response.finishReason === "tool_calls" &&
      rounds >= effectiveMaxToolRounds
    ) {
      const extension = callbacks.evaluateToolRoundBudgetExtension({
        ctx,
        currentLimit: effectiveMaxToolRounds,
        recentRounds: recentRoundProgress,
      });
      callbacks.emitExecutionTrace(ctx, {
        type: "tool_round_budget_extension_evaluated",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          currentLimit: effectiveMaxToolRounds,
          decision: extension.decision,
          recentProgressRate: extension.recentProgressRate,
          recentTotalNewSuccessfulSemanticKeys:
            extension.recentTotalNewSuccessfulSemanticKeys,
          recentTotalNewVerificationFailureDiagnosticKeys:
            extension.recentTotalNewVerificationFailureDiagnosticKeys,
          weightedAverageNewSuccessfulSemanticKeys:
            extension.weightedAverageNewSuccessfulSemanticKeys,
          latestRoundHadMaterialProgress:
            extension.latestRoundHadMaterialProgress,
          latestRoundNewSuccessfulSemanticKeys:
            extension.latestRoundNewSuccessfulSemanticKeys,
          latestRoundNewVerificationFailureDiagnosticKeys:
            extension.latestRoundNewVerificationFailureDiagnosticKeys,
          extensionReason: extension.extensionReason,
          repairCycleOpen: extension.repairCycleOpen,
          repairCycleNeedsMutation:
            extension.repairCycleNeedsMutation,
          repairCycleNeedsVerification:
            extension.repairCycleNeedsVerification,
          effectiveToolBudget: ctx.effectiveToolBudget,
          remainingToolBudget: extension.remainingToolBudget,
          remainingRequestMs: callbacks.serializeRemainingRequestMs(
            extension.remainingRequestMs,
          ),
          recentAverageRoundMs: extension.recentAverageRoundMs,
          extensionRounds: extension.extensionRounds,
          newLimit: extension.newLimit,
        },
      });
      if (extension.decision === "extended") {
        const previousLimit = effectiveMaxToolRounds;
        effectiveMaxToolRounds = extension.newLimit;
        callbacks.emitExecutionTrace(ctx, {
          type: "tool_round_budget_extended",
          phase: "tool_followup",
          callIndex: ctx.callIndex + 1,
          payload: {
            previousLimit,
            newLimit: effectiveMaxToolRounds,
            extensionRounds: extension.extensionRounds,
            remainingRequestMs: callbacks.serializeRemainingRequestMs(
              extension.remainingRequestMs,
            ),
            recentAverageRoundMs: extension.recentAverageRoundMs,
            extensionReason: extension.extensionReason,
            latestRoundNewSuccessfulSemanticKeys:
              extension.latestRoundNewSuccessfulSemanticKeys,
            latestRoundNewVerificationFailureDiagnosticKeys:
              extension.latestRoundNewVerificationFailureDiagnosticKeys,
            effectiveToolBudget: ctx.effectiveToolBudget,
            remainingToolBudget: extension.remainingToolBudget,
            repairCycleOpen: extension.repairCycleOpen,
            repairCycleNeedsMutation:
              extension.repairCycleNeedsMutation,
            repairCycleNeedsVerification:
              extension.repairCycleNeedsVerification,
          },
        });
      }
    }
  }

  if (ctx.signal?.aborted) {
    callbacks.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
  } else if (
    ctx.response &&
    ctx.response.finishReason === "tool_calls" &&
    rounds >= effectiveMaxToolRounds
  ) {
    const finalized = await callbacks.finalizeDelegatedTurnAfterToolBudgetExhaustion(
      ctx,
      effectiveMaxToolRounds,
    );
    if (!finalized) {
      callbacks.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${effectiveMaxToolRounds})`,
      );
    }
  }

  ctx.finalContent = ctx.response?.content ?? "";
  if (!ctx.finalContent && ctx.allToolCalls.length > 0) {
    ctx.finalContent =
      generateFallbackContent(ctx.allToolCalls) ?? ctx.finalContent;
  }
  if (!ctx.finalContent && ctx.stopReason !== "completed" && ctx.stopReasonDetail) {
    ctx.finalContent = ctx.stopReasonDetail;
  }
}
