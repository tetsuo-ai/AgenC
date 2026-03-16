/**
 * ChatExecutor — message-oriented LLM executor with cooldown-based fallback.
 *
 * Unlike LLMTaskExecutor (which takes on-chain Tasks and returns bigints),
 * ChatExecutor takes text messages and conversation history, returning string
 * responses. It adds cooldown-based provider fallback and session-level token
 * budget tracking.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMProvider,
  LLMProviderEvidence,
  LLMMessage,
  LLMStatefulResumeAnchor,
  LLMToolChoice,
  LLMToolCall,
  LLMResponse,
  LLMUsage,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import {
  applyPromptBudget,
  type PromptBudgetConfig,
  type PromptBudgetDiagnostics,
  type PromptBudgetSection,
} from "./prompt-budget.js";
import type {
  LLMPipelineStopReason,
  LLMRetryPolicyMatrix,
} from "./policy.js";
import type {
  Pipeline,
  PipelineExecutionEvent,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import {
  resolveDelegationDecisionConfig,
  type ResolvedDelegationDecisionConfig,
} from "./delegation-decision.js";
import {
  computeDelegationFinalReward,
  computeUsefulDelegationProxy,
  DELEGATION_USEFULNESS_PROXY_VERSION,
  deriveDelegationContextClusterId,
  type DelegationBanditPolicyTuner,
  type DelegationTrajectorySink,
} from "./delegation-learning.js";
// ---------------------------------------------------------------------------
// Imports from extracted sibling modules
// ---------------------------------------------------------------------------

import {
  shouldRetryProviderImmediately,
  shouldFallbackForFailureClass,
  computeProviderCooldownMs,
  annotateFailureError,
  buildActiveCooldownSnapshot,
  emitProviderTraceEvent,
} from "./chat-executor-provider-retry.js";
import {
  ChatBudgetExceededError,
  buildDefaultExecutionContext,
} from "./chat-executor-types.js";
import type {
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatExecutionTraceEvent,
  ChatExecuteParams,
  ChatPromptShape,
  ChatCallUsageRecord,
  ChatPlannerSummary,
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  ChatExecutorConfig,
  EvaluatorConfig,
  CooldownEntry,
  FallbackResult,
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  ResolvedSubagentVerifierConfig,
  ToolLoopState,
  ToolCallAction,
  ExecutionContext,
  PlannerDiagnostic,
} from "./chat-executor-types.js";
import {
  MAX_EVAL_USER_CHARS,
  MAX_EVAL_RESPONSE_CHARS,
  MAX_CONTEXT_INJECTION_CHARS,
  MAX_PROMPT_CHARS_BUDGET,
  MAX_TOOL_IMAGE_CHARS_BUDGET,
  DEFAULT_MAX_RUNTIME_SYSTEM_HINTS,
  DEFAULT_PLANNER_MAX_TOKENS,
  DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
  DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
  DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES,
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
  DEFAULT_MODEL_RECALLS_PER_REQUEST,
  DEFAULT_FAILURE_BUDGET_PER_REQUEST,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_ADAPTIVE_TOOL_ROUNDS,
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  DEFAULT_EVAL_RUBRIC,
  MAX_COMPACT_INPUT,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
import {
  buildRequiredToolEvidenceRetryInstruction,
  canRetryDelegatedOutputWithoutAdditionalToolCalls,
  resolveCorrectionAllowedToolNames,
  resolveExecutionToolContractGuidance,
  validateRequiredToolEvidence,
} from "./chat-executor-contract-flow.js";
import type { ToolContractGuidance } from "./chat-executor-contract-guidance.js";
import {
  didToolCallFail,
  resolveRetryPolicyMatrix,
  enrichToolResultMetadata,
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
} from "./chat-executor-tool-utils.js";
import { inferDoomTurnContract } from "./chat-executor-doom.js";
import {
  applyActiveRoutedToolNames,
  buildActiveRoutedToolSet,
  resolveEffectiveRoutedToolNames,
} from "./chat-executor-routing-state.js";
import { ToolFailureCircuitBreaker } from "./tool-failure-circuit-breaker.js";

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

function shouldUseSessionStatefulContinuationForPhase(
  phase: ChatCallUsageRecord["phase"],
): boolean {
  return phase === "initial" || phase === "tool_followup";
}

function buildPlannerDiagnosticSignature(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const stepName =
        typeof diagnostic.details?.stepName === "string"
          ? diagnostic.details.stepName
          : "";
      const installSteps =
        typeof diagnostic.details?.installSteps === "string"
          ? diagnostic.details.installSteps
          : "";
      const phases =
        typeof diagnostic.details?.phases === "string"
          ? diagnostic.details.phases
          : "";
      return [
        diagnostic.category,
        diagnostic.code,
        stepName,
        installSteps,
        phases,
        diagnostic.message,
      ].join("::");
    })
    .sort()
    .join("||");
}

interface DetailedMemoryTraceEntry {
  readonly role?: string;
  readonly source?: string;
  readonly provenance?: string;
  readonly combinedScore?: number;
}

interface DetailedMemoryRetrievalResult {
  readonly content: string | undefined;
  readonly entries?: readonly DetailedMemoryTraceEntry[];
  readonly curatedIncluded?: boolean;
  readonly estimatedTokens?: number;
}

interface DetailedMemoryRetriever extends MemoryRetriever {
  retrieveDetailed(
    message: string,
    sessionId: string,
  ): Promise<DetailedMemoryRetrievalResult>;
}

function isDetailedMemoryRetriever(
  provider: SkillInjector | MemoryRetriever | undefined,
): provider is DetailedMemoryRetriever {
  return (
    !!provider &&
    "retrieveDetailed" in provider &&
    typeof provider.retrieveDetailed === "function"
  );
}

function buildPipelineFailureSignature(result: PipelineResult): string {
  const normalizedError =
    typeof result.error === "string"
      ? truncateText(result.error.replace(/\s+/g, " ").trim(), 320)
      : "";
  return [
    result.status,
    result.stopReasonHint ?? "",
    String(result.completedSteps),
    String(result.totalSteps),
    normalizedError,
  ].join("::");
}

function mergeProviderEvidence(
  current: LLMProviderEvidence | undefined,
  incoming: LLMProviderEvidence | undefined,
): LLMProviderEvidence | undefined {
  if (!current) return incoming;
  if (!incoming) return current;

  const citations = Array.from(new Set([
    ...(current.citations ?? []),
    ...(incoming.citations ?? []),
  ]));
  if (citations.length === 0) return undefined;
  return { citations };
}

function mergeExplicitRequirementToolNames(
  primaryToolNames: readonly string[],
  secondaryToolNames: readonly string[],
  fallbackToolNames: readonly string[],
): readonly string[] {
  const merged = Array.from(
    new Set([
      ...primaryToolNames,
      ...secondaryToolNames,
    ]),
  );
  if (merged.length > 0) {
    return merged;
  }
  return Array.from(new Set(fallbackToolNames));
}

function buildDelegatedBudgetFinalizationInstruction(params: {
  readonly acceptanceCriteria?: readonly string[];
  readonly requestedToolNames: readonly string[];
}): string {
  const acceptanceSummary = (params.acceptanceCriteria ?? [])
    .filter((criterion) => typeof criterion === "string" && criterion.trim().length > 0)
    .slice(0, 4)
    .join("; ");
  const requestedToolSummary = params.requestedToolNames.length > 0
    ? ` The last tool request was not executed because the budget was exhausted: ${
      params.requestedToolNames.join(", ")
    }.`
    : "";

  return (
    "Tool-call budget is exhausted for this delegated phase. " +
    "Do not request more tools. " +
    "Using only the authoritative runtime tool ledger and tool results already collected, " +
    "produce the final grounded phase result now. " +
    "Only claim work backed by executed tool results, and explicitly name the concrete files or artifacts created or updated. " +
    "If any acceptance criterion is still unmet, state exactly which one lacks evidence instead of requesting another tool." +
    (acceptanceSummary.length > 0
      ? ` Acceptance criteria: ${acceptanceSummary}.`
      : "") +
    requestedToolSummary
  );
}

const MAX_PLAN_ONLY_EXECUTION_CORRECTIONS = 1;

function buildPlanOnlyExecutionRetryInstruction(
  allowedToolNames: readonly string[],
): string {
  const allowedToolSummary = allowedToolNames.length > 0
    ? ` Allowed tools for this turn: ${allowedToolNames.slice(0, 12).join(", ")}${allowedToolNames.length > 12 ? ", ..." : ""}.`
    : "";
  return (
    "Do not stop after a plan for this turn. " +
    "The user asked you to execute work in the environment, so start performing the requested file or system actions immediately using tools. " +
    "Only answer after tool results show what you actually completed. " +
    "If execution is blocked, state the concrete blocker instead of returning another plan." +
    allowedToolSummary
  );
}
import type {
  RoundStuckState,
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";
import {
  extractMessageText,
  truncateText,
  sanitizeFinalContent,
  reconcileDirectShellObservationContent,
  reconcileExactResponseContract,
  reconcileVerifiedFileWorkflowContent,
  reconcileStructuredToolOutcome,
  reconcileTerminalFailureContent,
  estimatePromptShape,
  normalizeHistory,
  normalizeHistoryForStatefulReconciliation,
  sanitizeToolCallsForReplay,
  toStatefulReconciliationMessage,
  buildPromptToolContent,
  appendUserMessage,
  generateFallbackContent,
  summarizeToolCalls,
  buildToolExecutionGroundingMessage,
  isPlanOnlyExecutionResponse,
} from "./chat-executor-text.js";
import {
  buildSemanticToolCallKey,
  summarizeStateful,
  buildRecoveryHints,
  computeQualityProxy,
  buildDelegationTrajectoryEntry,
  buildPlannerSummary,
} from "./chat-executor-recovery.js";
import {
  assessPlannerDecision,
  buildPlannerMessages,
  buildPlannerExecutionContext,
  buildPlannerVerificationRequirementsFailureMessage,
  buildPlannerVerificationRequirementsRefinementHint,
  validatePlannerGraph,
  validatePlannerVerificationRequirements,
  validatePlannerStepContracts,
  extractPlannerVerificationCommandRequirements,
  extractPlannerVerificationRequirements,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  validateExplicitDeterministicToolRequirements,
  validateExplicitSubagentOrchestrationRequirements,
  extractPlannerDecompositionDiagnostics,
  extractPlannerStructuralDiagnostics,
  buildExplicitDeterministicToolRefinementHint,
  buildExplicitDeterministicToolFailureMessage,
  buildPlannerParseRefinementHint,
  buildPlannerStructuralRefinementHint,
  buildPlannerValidationFailureMessage,
  buildPipelineDecompositionRefinementHint,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerStepContractRefinementHint,
  buildSalvagedPlannerToolCallRefinementHint,
  buildExplicitSubagentOrchestrationRefinementHint,
  buildExplicitSubagentOrchestrationFailureMessage,
  extractRecoverablePlannerParseDiagnostics,
  isHighRiskSubagentPlan,
  computePlannerGraphDepth,
  isPipelineStopReasonHint,
  buildPlannerSynthesisMessages,
  buildPlannerSynthesisFallbackContent,
  ensureSubagentProvenanceCitations,
  resolveDelegationBanditArm,
  assessAndRecordDelegationDecision,
  mapPlannerStepsToPipelineSteps,
  requestRequiresToolGroundedExecution,
  validateSalvagedPlannerToolPlan,
} from "./chat-executor-planner.js";
import { normalizePlannerResponse } from "./chat-executor-planner-normalization.js";
import {
  executePlannerPipelineWithVerifierLoop,
  runSubagentVerifierRound,
} from "./chat-executor-planner-verifier-loop.js";
// ---------------------------------------------------------------------------
// Re-exports — preserve backward-compatible import paths for consumers
// ---------------------------------------------------------------------------

export { ChatBudgetExceededError } from "./chat-executor-types.js";
export type {
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatExecuteParams,
  ChatPromptShape,
  ChatCallUsageRecord,
  ChatPlannerSummary,
  PlannerDiagnostic,
  ChatStatefulSummary,
  ChatToolRoutingSummary,
  ChatExecutorResult,
  DeterministicPipelineExecutor,
  LLMRetryPolicyOverrides,
  ToolFailureCircuitBreakerConfig,
  ChatExecutorConfig,
  EvaluatorConfig,
  EvaluationResult,
} from "./chat-executor-types.js";


// ============================================================================
// ChatExecutor
// ============================================================================

/**
 * Message-oriented LLM executor with cooldown-based provider fallback
 * and session-level token budget tracking.
 */
export class ChatExecutor {
  private readonly providers: readonly LLMProvider[];
  private readonly toolHandler?: ToolHandler;
  private readonly maxToolRounds: number;
  private readonly onStreamChunk?: StreamProgressCallback;
  private readonly allowedTools: Set<string> | null;
  private readonly sessionTokenBudget?: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxTrackedSessions: number;
  private readonly skillInjector?: SkillInjector;
  private readonly memoryRetriever?: MemoryRetriever;
  private readonly learningProvider?: MemoryRetriever;
  private readonly progressProvider?: MemoryRetriever;
  private readonly promptBudget: PromptBudgetConfig;
  private readonly maxRuntimeSystemHints: number;
  private readonly onCompaction?: (sessionId: string, summary: string) => void;
  private readonly evaluator?: EvaluatorConfig;
  private readonly plannerEnabled: boolean;
  private readonly plannerMaxTokens: number;
  private readonly delegationNestingDepth: number;
  private readonly pipelineExecutor?: DeterministicPipelineExecutor;
  private readonly delegationDecisionConfig: ResolvedDelegationDecisionConfig;
  private readonly resolveDelegationScoreThreshold?: () => number | undefined;
  private readonly subagentVerifierConfig: ResolvedSubagentVerifierConfig;
  private readonly delegationTrajectorySink?: DelegationTrajectorySink;
  private readonly delegationBanditTuner?: DelegationBanditPolicyTuner;
  private readonly delegationDefaultStrategyArmId: string;
  private readonly toolBudgetPerRequest: number;
  private readonly maxModelRecallsPerRequest: number;
  private readonly maxFailureBudgetPerRequest: number;
  private readonly toolCallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  private readonly toolFailureBreaker: ToolFailureCircuitBreaker;
  private readonly resolveHostToolingProfile?: () => HostToolingProfile | null;

  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly sessionTokens = new Map<string, number>();

  private static normalizeRequestTimeoutMs(timeoutMs: number | undefined): number {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return DEFAULT_REQUEST_TIMEOUT_MS;
    }
    const normalized = Math.floor(timeoutMs);
    if (normalized <= 0) {
      return 0;
    }
    return Math.max(1, normalized);
  }

  constructor(config: ChatExecutorConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("ChatExecutor requires at least one provider");
    }
    this.providers = config.providers;
    this.toolHandler = config.toolHandler;
    this.maxToolRounds = config.maxToolRounds ?? 10;
    this.onStreamChunk = config.onStreamChunk;
    this.allowedTools = config.allowedTools
      ? new Set(config.allowedTools)
      : null;
    this.sessionTokenBudget = config.sessionTokenBudget;
    this.cooldownMs = Math.max(0, config.providerCooldownMs ?? 60_000);
    this.maxCooldownMs = Math.max(0, config.maxCooldownMs ?? 300_000);
    this.maxTrackedSessions = Math.max(1, config.maxTrackedSessions ?? 10_000);
    this.skillInjector = config.skillInjector;
    this.memoryRetriever = config.memoryRetriever;
    this.learningProvider = config.learningProvider;
    this.progressProvider = config.progressProvider;
    const configuredPromptBudget = config.promptBudget ?? {};
    this.promptBudget = {
      hardMaxPromptChars:
        configuredPromptBudget.hardMaxPromptChars ?? MAX_PROMPT_CHARS_BUDGET,
      ...configuredPromptBudget,
    };
    const maxRuntimeHints = configuredPromptBudget.maxRuntimeHints;
    this.maxRuntimeSystemHints =
      typeof maxRuntimeHints === "number" && Number.isFinite(maxRuntimeHints)
        ? Math.max(0, Math.floor(maxRuntimeHints))
        : DEFAULT_MAX_RUNTIME_SYSTEM_HINTS;
    this.onCompaction = config.onCompaction;
    this.evaluator = config.evaluator;
    this.plannerEnabled = config.plannerEnabled ?? false;
    this.plannerMaxTokens = Math.max(
      32,
      Math.floor(config.plannerMaxTokens ?? DEFAULT_PLANNER_MAX_TOKENS),
    );
    this.delegationNestingDepth = Math.max(
      0,
      Math.floor(config.delegationNestingDepth ?? 0),
    );
    this.pipelineExecutor = config.pipelineExecutor;
    this.delegationDecisionConfig = resolveDelegationDecisionConfig(
      config.delegationDecision,
    );
    this.resolveDelegationScoreThreshold = config.resolveDelegationScoreThreshold;
    this.resolveHostToolingProfile = config.resolveHostToolingProfile;
    this.subagentVerifierConfig = ChatExecutor.resolveSubagentVerifierConfig(
      config.subagentVerifier,
    );
    this.delegationTrajectorySink = config.delegationLearning?.trajectorySink;
    this.delegationBanditTuner = config.delegationLearning?.banditTuner;
    this.delegationDefaultStrategyArmId =
      config.delegationLearning?.defaultStrategyArmId?.trim() || "balanced";
    this.toolBudgetPerRequest = Math.max(
      1,
      Math.floor(config.toolBudgetPerRequest ?? DEFAULT_TOOL_BUDGET_PER_REQUEST),
    );
    this.maxModelRecallsPerRequest = Math.max(
      0,
      Math.floor(
        config.maxModelRecallsPerRequest ?? DEFAULT_MODEL_RECALLS_PER_REQUEST,
      ),
    );
    this.maxFailureBudgetPerRequest = Math.max(
      1,
      Math.floor(
        config.maxFailureBudgetPerRequest ?? DEFAULT_FAILURE_BUDGET_PER_REQUEST,
      ),
    );
    this.toolCallTimeoutMs = Math.max(
      1,
      Math.floor(config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS),
    );
    this.requestTimeoutMs = ChatExecutor.normalizeRequestTimeoutMs(
      config.requestTimeoutMs,
    );
    this.retryPolicyMatrix = resolveRetryPolicyMatrix(config.retryPolicyMatrix);
    this.toolFailureBreaker = new ToolFailureCircuitBreaker({
      enabled: config.toolFailureCircuitBreaker?.enabled ?? true,
      windowMs: Math.max(
        1_000,
        Math.floor(
          config.toolFailureCircuitBreaker?.windowMs ??
            DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
        ),
      ),
      threshold: Math.max(
        2,
        Math.floor(
          config.toolFailureCircuitBreaker?.threshold ??
            DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
        ),
      ),
      cooldownMs: Math.max(
        1_000,
        Math.floor(
          config.toolFailureCircuitBreaker?.cooldownMs ??
            DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
        ),
      ),
      maxTrackedSessions: this.maxTrackedSessions,
    });
  }

  private static resolveSubagentVerifierConfig(
    config: ChatExecutorConfig["subagentVerifier"] | undefined,
  ): ResolvedSubagentVerifierConfig {
    const maxRoundsRaw = config?.maxRounds ?? DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS;
    return {
      enabled: config?.enabled === true,
      force: config?.force === true,
      minConfidence: Math.min(
        1,
        Math.max(
          0,
          config?.minConfidence ?? DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
        ),
      ),
      maxRounds: Math.max(1, Math.floor(maxRoundsRaw)),
    };
  }

  /**
   * Execute a chat message against the provider chain.
   */
  async execute(params: ChatExecuteParams): Promise<ChatExecutorResult> {
    return this.executeRequest(params);
  }

  private async executeRequest(
    params: ChatExecuteParams,
  ): Promise<ChatExecutorResult> {
    const ctx = await this.initializeExecutionContext(params);

    // Planner path (complexity-based delegation)
    if (
      this.plannerEnabled &&
      ctx.plannerDecision.shouldPlan &&
      this.pipelineExecutor &&
      ctx.activeToolHandler
    ) {
      await this.executePlannerPath(ctx);
    }

    // Direct path: initial LLM call + tool loop
    if (!ctx.plannerHandled) {
      await this.executeToolCallLoop(ctx);
    }

    this.checkRequestTimeout(ctx, "finalization");
    this.trackTokenUsage(ctx.sessionId, ctx.cumulativeUsage.totalTokens);

    // Optional response evaluation (critic)
    if (this.evaluator && ctx.finalContent && ctx.stopReason === "completed") {
      await this.evaluateAndRetryResponse(ctx);
    }

    // Finalization, trajectory recording, bandit outcome
    const { plannerSummary, durationMs } = this.recordOutcomeAndFinalize(ctx);

    // Sanitize + assemble result
    ctx.finalContent = sanitizeFinalContent(ctx.finalContent);
    ctx.finalContent = reconcileDirectShellObservationContent(
      ctx.finalContent,
      ctx.allToolCalls,
    );
    ctx.finalContent = reconcileVerifiedFileWorkflowContent(
      ctx.finalContent,
      ctx.allToolCalls,
    );
    ctx.finalContent = reconcileExactResponseContract(
      ctx.finalContent,
      ctx.allToolCalls,
      ctx.messageText,
      {
        forceLiteralWhenNoToolEvidence:
          plannerSummary?.routeReason === "exact_response_turn" ||
          plannerSummary?.routeReason === "dialogue_memory_turn",
      },
    );
    ctx.finalContent = reconcileStructuredToolOutcome(
      ctx.finalContent,
      ctx.allToolCalls,
      ctx.messageText,
    );
    ctx.finalContent = reconcileTerminalFailureContent({
      content: ctx.finalContent,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      toolCalls: ctx.allToolCalls,
    });
    ctx.finalContent = sanitizeFinalContent(ctx.finalContent);

    return {
      content: ctx.finalContent,
      provider: ctx.providerName,
      model: ctx.responseModel,
      usedFallback: ctx.usedFallback,
      toolCalls: ctx.allToolCalls,
      providerEvidence: ctx.providerEvidence,
      tokenUsage: ctx.cumulativeUsage,
      callUsage: ctx.callUsage,
      durationMs,
      compacted: ctx.compacted,
      statefulSummary: summarizeStateful(ctx.callUsage),
      toolRoutingSummary: ctx.toolRouting
        ? {
          enabled: true,
          initialToolCount: ctx.initialRoutedToolNames.length,
          finalToolCount: ctx.activeRoutedToolNames.length,
          routeMisses: ctx.routedToolMisses,
          expanded: ctx.routedToolsExpanded,
        }
        : undefined,
      plannerSummary,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      validationCode: ctx.validationCode,
      evaluation: ctx.evaluation,
    };
  }

  // ===========================================================================
  // Utility helpers extracted from executeRequest() closures (Steps 2-6)
  // ===========================================================================

  private pushMessage(
    ctx: ExecutionContext,
    nextMessage: LLMMessage,
    section: PromptBudgetSection,
    reconciliationMessage?: LLMMessage,
  ): void {
    ctx.messages.push(nextMessage);
    ctx.reconciliationMessages.push(
      toStatefulReconciliationMessage(reconciliationMessage ?? nextMessage),
    );
    ctx.messageSections.push(section);
  }

  private setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void {
    if (ctx.stopReason === "completed") {
      ctx.stopReason = reason;
      ctx.stopReasonDetail = detail;
    }
  }

  private timeoutDetail(
    stage: string,
    requestTimeoutMs = this.requestTimeoutMs,
  ): string {
    if (requestTimeoutMs <= 0) {
      return `Request exceeded end-to-end timeout during ${stage}`;
    }
    return `Request exceeded end-to-end timeout (${requestTimeoutMs}ms) during ${stage}`;
  }

  private checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean {
    if (this.getRemainingRequestMs(ctx) > 0) return false;
    this.setStopReason(
      ctx,
      "timeout",
      this.timeoutDetail(stage, ctx.effectiveRequestTimeoutMs),
    );
    return true;
  }

  private appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void {
    ctx.allToolCalls.push(record);
    if (didToolCallFail(record.isError, record.result)) {
      ctx.failedToolCalls++;
    }
  }

  private hasModelRecallBudget(ctx: ExecutionContext): boolean {
    if (ctx.modelCalls === 0) return true;
    if (ctx.effectiveMaxModelRecalls <= 0) return true;
    return ctx.modelCalls - 1 < ctx.effectiveMaxModelRecalls;
  }

  private getRemainingRequestMs(ctx: ExecutionContext): number {
    if (ctx.effectiveRequestTimeoutMs <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return ctx.requestDeadlineAt - Date.now();
  }

  private serializeRequestTimeoutMs(timeoutMs: number): number | null {
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  }

  private serializeRemainingRequestMs(remainingRequestMs: number): number | null {
    return Number.isFinite(remainingRequestMs)
      ? Math.max(0, remainingRequestMs)
      : null;
  }

  private evaluateToolRoundBudgetExtension(params: {
    readonly ctx: ExecutionContext;
    readonly currentLimit: number;
    readonly recentRounds: readonly ToolRoundProgressSummary[];
  }): {
    readonly decision:
      | "extended"
      | "ceiling_reached"
      | "no_recent_rounds"
      | "insufficient_recent_progress"
      | "request_time_exhausted"
      | "time_bound_exhausted"
      | "tool_budget_exhausted"
      | "extension_budget_exhausted";
    readonly recentProgressRate: number;
    readonly recentTotalNewSuccessfulSemanticKeys: number;
    readonly recentTotalNewVerificationFailureDiagnosticKeys: number;
    readonly weightedAverageNewSuccessfulSemanticKeys: number;
    readonly latestRoundHadMaterialProgress: boolean;
    readonly newLimit: number;
    readonly extensionRounds: number;
    readonly remainingToolBudget: number;
    readonly remainingRequestMs: number;
    readonly recentAverageRoundMs: number;
    readonly latestRoundNewSuccessfulSemanticKeys: number;
    readonly latestRoundNewVerificationFailureDiagnosticKeys: number;
    readonly extensionReason:
      | "none"
      | "repair_episode"
      | "sustained_progress";
    readonly repairCycleOpen: boolean;
    readonly repairCycleNeedsMutation: boolean;
    readonly repairCycleNeedsVerification: boolean;
  } {
    const remainingToolBudget = Math.max(
      0,
      params.ctx.effectiveToolBudget - params.ctx.allToolCalls.length,
    );
    const effectiveRoundCeiling = Math.min(
      MAX_ADAPTIVE_TOOL_ROUNDS,
      params.ctx.effectiveToolBudget,
    );
    if (params.currentLimit >= effectiveRoundCeiling) {
      return {
        decision: "ceiling_reached",
        recentProgressRate: 0,
        recentTotalNewSuccessfulSemanticKeys: 0,
        recentTotalNewVerificationFailureDiagnosticKeys: 0,
        weightedAverageNewSuccessfulSemanticKeys: 0,
        latestRoundHadMaterialProgress: false,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs: 0,
        recentAverageRoundMs: 0,
        latestRoundNewSuccessfulSemanticKeys: 0,
        latestRoundNewVerificationFailureDiagnosticKeys: 0,
        extensionReason: "none",
        repairCycleOpen: false,
        repairCycleNeedsMutation: false,
        repairCycleNeedsVerification: false,
      };
    }
    const latestRound = params.recentRounds[params.recentRounds.length - 1];
    if (!latestRound) {
      return {
        decision: "no_recent_rounds",
        recentProgressRate: 0,
        recentTotalNewSuccessfulSemanticKeys: 0,
        recentTotalNewVerificationFailureDiagnosticKeys: 0,
        weightedAverageNewSuccessfulSemanticKeys: 0,
        latestRoundHadMaterialProgress: false,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs: 0,
        recentAverageRoundMs: 0,
        latestRoundNewSuccessfulSemanticKeys: 0,
        latestRoundNewVerificationFailureDiagnosticKeys: 0,
        extensionReason: "none",
        repairCycleOpen: false,
        repairCycleNeedsMutation: false,
        repairCycleNeedsVerification: false,
      };
    }
    const recentProgressRounds = params.recentRounds.filter((round) =>
      round.hadMaterialProgress
    ).length;
    const recentProgressRate =
      recentProgressRounds / Math.max(1, params.recentRounds.length);
    const recentTotalNewSuccessfulSemanticKeys = params.recentRounds.reduce(
      (sum, round) => sum + round.newSuccessfulSemanticKeys,
      0,
    );
    const recentTotalNewVerificationFailureDiagnosticKeys = params.recentRounds
      .reduce(
        (sum, round) => sum + round.newVerificationFailureDiagnosticKeys,
        0,
      );
    const weightedAverageNewSuccessfulSemanticKeys = params.recentRounds.reduce(
      (sum, round, index) => sum + round.newSuccessfulSemanticKeys * (index + 1),
      0,
    ) /
      params.recentRounds.reduce(
        (sum, _round, index) => sum + index + 1,
        0,
      );
    let latestVerificationFailureRoundIndex = -1;
    for (let index = params.recentRounds.length - 1; index >= 0; index--) {
      if (params.recentRounds[index]?.newVerificationFailureDiagnosticKeys > 0) {
        latestVerificationFailureRoundIndex = index;
        break;
      }
    }
    let latestMutationRoundIndex = -1;
    if (latestVerificationFailureRoundIndex >= 0) {
      for (
        let index = latestVerificationFailureRoundIndex + 1;
        index < params.recentRounds.length;
        index++
      ) {
        if (params.recentRounds[index]?.hadSuccessfulMutation) {
          latestMutationRoundIndex = index;
        }
      }
    }
    const repairCycleNeedsMutation =
      latestVerificationFailureRoundIndex >= 0 && latestMutationRoundIndex < 0;
    const repairCycleNeedsVerification =
      latestVerificationFailureRoundIndex >= 0 &&
      (
        latestMutationRoundIndex < 0 ||
        !params.recentRounds
          .slice(latestMutationRoundIndex + 1)
          .some((round) => round.hadVerificationCall)
      );
    const repairCycleOpen =
      repairCycleNeedsMutation || repairCycleNeedsVerification;
    const repairCycleExtensionRounds =
      (repairCycleNeedsMutation ? 1 : 0) +
      (repairCycleNeedsVerification ? 1 : 0);
    // Historical progress can size an extension, but absent an open repair cycle
    // only the latest round can authorize additional rounds.
    const extendForSustainedProgress =
      latestRound.newSuccessfulSemanticKeys > 0 &&
      recentTotalNewSuccessfulSemanticKeys > 0;
    if (!extendForSustainedProgress && !repairCycleOpen) {
      return {
        decision: "insufficient_recent_progress",
        recentProgressRate,
        recentTotalNewSuccessfulSemanticKeys,
        recentTotalNewVerificationFailureDiagnosticKeys,
        weightedAverageNewSuccessfulSemanticKeys,
        latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs: this.getRemainingRequestMs(params.ctx),
        recentAverageRoundMs: 0,
        latestRoundNewSuccessfulSemanticKeys:
          latestRound.newSuccessfulSemanticKeys,
        latestRoundNewVerificationFailureDiagnosticKeys:
          latestRound.newVerificationFailureDiagnosticKeys,
        extensionReason: "none",
        repairCycleOpen,
        repairCycleNeedsMutation,
        repairCycleNeedsVerification,
      };
    }
    const remainingRequestMs = this.getRemainingRequestMs(params.ctx);
    if (remainingRequestMs <= 0) {
      return {
        decision: "request_time_exhausted",
        recentProgressRate,
        recentTotalNewSuccessfulSemanticKeys,
        recentTotalNewVerificationFailureDiagnosticKeys,
        weightedAverageNewSuccessfulSemanticKeys,
        latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs,
        recentAverageRoundMs: 0,
        latestRoundNewSuccessfulSemanticKeys:
          latestRound.newSuccessfulSemanticKeys,
        latestRoundNewVerificationFailureDiagnosticKeys:
          latestRound.newVerificationFailureDiagnosticKeys,
        extensionReason: "none",
        repairCycleOpen,
        repairCycleNeedsMutation,
        repairCycleNeedsVerification,
      };
    }
    const recentAverageRoundMs = Math.max(
      1_000,
      Math.round(
        params.recentRounds.reduce((sum, round) => sum + round.durationMs, 0) /
          params.recentRounds.length,
      ),
    );
    const timeBoundExtension = Math.floor(remainingRequestMs / recentAverageRoundMs);
    if (timeBoundExtension <= 0) {
      return {
        decision: "time_bound_exhausted",
        recentProgressRate,
        recentTotalNewSuccessfulSemanticKeys,
        recentTotalNewVerificationFailureDiagnosticKeys,
        weightedAverageNewSuccessfulSemanticKeys,
        latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs,
        recentAverageRoundMs,
        latestRoundNewSuccessfulSemanticKeys:
          latestRound.newSuccessfulSemanticKeys,
        latestRoundNewVerificationFailureDiagnosticKeys:
          latestRound.newVerificationFailureDiagnosticKeys,
        extensionReason: "none",
        repairCycleOpen,
        repairCycleNeedsMutation,
        repairCycleNeedsVerification,
      };
    }
    const expectedMarginalRounds = repairCycleOpen
      ? repairCycleExtensionRounds
      : Math.max(
        latestRound.newSuccessfulSemanticKeys,
        Math.ceil(weightedAverageNewSuccessfulSemanticKeys),
      );
    if (remainingToolBudget <= 0) {
      return {
        decision: "tool_budget_exhausted",
        recentProgressRate,
        recentTotalNewSuccessfulSemanticKeys,
        recentTotalNewVerificationFailureDiagnosticKeys,
        weightedAverageNewSuccessfulSemanticKeys,
        latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs,
        recentAverageRoundMs,
        latestRoundNewSuccessfulSemanticKeys:
          latestRound.newSuccessfulSemanticKeys,
        latestRoundNewVerificationFailureDiagnosticKeys:
          latestRound.newVerificationFailureDiagnosticKeys,
        extensionReason: "none",
        repairCycleOpen,
        repairCycleNeedsMutation,
        repairCycleNeedsVerification,
      };
    }
    const extensionRounds = Math.min(
      expectedMarginalRounds,
      timeBoundExtension,
      effectiveRoundCeiling - params.currentLimit,
      remainingToolBudget,
    );
    if (extensionRounds <= 0) {
      return {
        decision: "extension_budget_exhausted",
        recentProgressRate,
        recentTotalNewSuccessfulSemanticKeys,
        recentTotalNewVerificationFailureDiagnosticKeys,
        weightedAverageNewSuccessfulSemanticKeys,
        latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
        newLimit: params.currentLimit,
        extensionRounds: 0,
        remainingToolBudget,
        remainingRequestMs,
        recentAverageRoundMs,
        latestRoundNewSuccessfulSemanticKeys:
          latestRound.newSuccessfulSemanticKeys,
        latestRoundNewVerificationFailureDiagnosticKeys:
          latestRound.newVerificationFailureDiagnosticKeys,
        extensionReason: "none",
        repairCycleOpen,
        repairCycleNeedsMutation,
        repairCycleNeedsVerification,
      };
    }
    return {
      decision: "extended",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit + extensionRounds,
      extensionRounds,
      remainingToolBudget,
      remainingRequestMs,
      recentAverageRoundMs,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: repairCycleOpen
        ? "repair_episode"
        : "sustained_progress",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }

  private emitExecutionTrace(
    ctx: ExecutionContext,
    event: ChatExecutionTraceEvent,
  ): void {
    ctx.trace?.onExecutionTraceEvent?.(event);
  }

  private emitPlannerTrace(
    ctx: ExecutionContext,
    type:
      | "planner_path_finished"
      | "planner_pipeline_finished"
      | "planner_synthesis_fallback_applied"
      | "planner_pipeline_started"
      | "planner_plan_parsed"
      | "planner_refinement_requested"
      | "planner_verifier_retry_scheduled"
      | "planner_verifier_round_finished",
    payload: Record<string, unknown>,
  ): void {
    this.emitExecutionTrace(ctx, {
      type,
      phase: "planner",
      callIndex: ctx.callIndex + 1,
      payload,
    });
  }

  private emitPipelineExecutionTrace(
    ctx: ExecutionContext,
    event: PipelineExecutionEvent,
  ): void {
    if (event.type === "step_started") {
      this.emitExecutionTrace(ctx, {
        type: "tool_dispatch_started",
        phase: "planner",
        callIndex: ctx.callIndex + 1,
        payload: {
          pipelineId: event.pipelineId,
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          tool: event.tool,
          args: event.args,
        },
      });
      return;
    }
    if (event.type === "step_finished") {
      this.emitExecutionTrace(ctx, {
        type: "tool_dispatch_finished",
        phase: "planner",
        callIndex: ctx.callIndex + 1,
        payload: {
          pipelineId: event.pipelineId,
          stepName: event.stepName,
          stepIndex: event.stepIndex,
          tool: event.tool,
          args: event.args,
          durationMs: event.durationMs,
          isError: typeof event.error === "string",
          ...(typeof event.result === "string"
            ? { result: event.result }
            : {}),
          ...(typeof event.error === "string"
            ? { error: event.error }
            : {}),
        },
      });
      return;
    }
    this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
      pipelineId: event.pipelineId,
      halted: true,
      stepName: event.stepName,
      stepIndex: event.stepIndex,
      tool: event.tool,
      args: event.args,
      error: event.error,
    });
  }

  private maybePushRuntimeInstruction(
    ctx: ExecutionContext,
    content: string,
  ): void {
    const runtimeHintCount = ctx.messageSections.filter(
      (section) => section === "system_runtime",
    ).length;
    if (runtimeHintCount >= this.maxRuntimeSystemHints) return;

    const alreadyPresent = ctx.messages.some((message, index) => {
      if (ctx.messageSections[index] !== "system_runtime") return false;
      return message.role === "system" &&
        typeof message.content === "string" &&
        message.content === content;
    });
    if (alreadyPresent) return;

    this.pushMessage(ctx, { role: "system", content }, "system_runtime");
  }

  private replaceRuntimeRecoveryHintMessages(
    ctx: ExecutionContext,
    recoveryHints: readonly { key: string }[],
  ): void {
    const nextMessages: LLMMessage[] = [];
    const nextSections: PromptBudgetSection[] = [];
    for (let index = 0; index < ctx.messages.length; index++) {
      const message = ctx.messages[index];
      const section = ctx.messageSections[index];
      if (
        section === "system_runtime" &&
        message?.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(RECOVERY_HINT_PREFIX)
      ) {
        continue;
      }
      nextMessages.push(message);
      nextSections.push(section);
    }
    ctx.messages = nextMessages;
    ctx.messageSections = nextSections;
    ctx.activeRecoveryHintKeys = recoveryHints.map((hint) => hint.key);
  }

  private resolveActiveToolContractGuidance(
    ctx: ExecutionContext,
    input?: {
      readonly phase?: "initial" | "tool_followup" | "correction";
      readonly allowedToolNames?: readonly string[];
      readonly validationCode?: DelegationOutputValidationCode;
    },
  ): ToolContractGuidance | undefined {
    return resolveExecutionToolContractGuidance({
      ctx,
      allowedTools: this.allowedTools ?? undefined,
      phase: input?.phase,
      allowedToolNames: input?.allowedToolNames,
      validationCode: input?.validationCode,
    });
  }

  private async enforceRequiredToolEvidenceBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required"> {
    if (!ctx.requiredToolEvidence) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          decision: "not_required",
          finishReason: ctx.response?.finishReason,
        },
      });
      return "not_required";
    }

    let retried = false;
    while (ctx.response?.finishReason !== "tool_calls") {
      const {
        contractValidation,
        missingEvidenceMessage,
      } = validateRequiredToolEvidence({ ctx });
      if (!missingEvidenceMessage) {
        ctx.validationCode = undefined;
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            decision: retried ? "accept_after_retry" : "accept",
            finishReason: ctx.response?.finishReason,
            correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
          },
        });
        return retried ? "continue" : "not_required";
      }

      const canRetryWithoutAdditionalToolCalls =
        canRetryDelegatedOutputWithoutAdditionalToolCalls({
          validationCode: contractValidation?.code,
          toolCalls: ctx.allToolCalls,
          delegationSpec: ctx.requiredToolEvidence.delegationSpec,
          providerEvidence: ctx.providerEvidence,
        });
      const allowFinalToollessRetry =
        canRetryWithoutAdditionalToolCalls &&
        ctx.requiredToolEvidenceCorrectionAttempts ===
          ctx.requiredToolEvidence.maxCorrectionAttempts;

      if (
        ctx.requiredToolEvidenceCorrectionAttempts >=
          ctx.requiredToolEvidence.maxCorrectionAttempts &&
        !allowFinalToollessRetry
      ) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            decision: "fail",
            finishReason: ctx.response?.finishReason,
            correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
            missingEvidenceMessage,
            validationCode: contractValidation?.code,
          },
        });
        ctx.validationCode = contractValidation?.code;
        this.setStopReason(ctx, "validation_error", missingEvidenceMessage);
        ctx.finalContent = missingEvidenceMessage;
        return "failed";
      }

      const correctionAllowedTools = canRetryWithoutAdditionalToolCalls
        ? []
        : resolveCorrectionAllowedToolNames(
          ctx.activeRoutedToolNames,
          this.allowedTools ?? undefined,
        );
      const retryInstruction = buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage,
        validationCode: contractValidation?.code,
        allowedToolNames: correctionAllowedTools,
        requiresAdditionalToolCalls: !canRetryWithoutAdditionalToolCalls,
      });

      if (
        typeof ctx.response?.content === "string" &&
        ctx.response.content.trim().length > 0
      ) {
        this.pushMessage(
          ctx,
          { role: "assistant", content: ctx.response.content, phase: "commentary" },
          "assistant_runtime",
        );
      }
      this.pushMessage(
        ctx,
        { role: "system", content: retryInstruction },
        "system_runtime",
      );
      ctx.requiredToolEvidenceCorrectionAttempts += 1;
      retried = true;
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          decision: "retry",
          finishReason: ctx.response?.finishReason,
          correctionAttempts: ctx.requiredToolEvidenceCorrectionAttempts,
          missingEvidenceMessage,
          validationCode: contractValidation?.code,
          allowedToolNames: correctionAllowedTools,
          toollessRetry: canRetryWithoutAdditionalToolCalls,
        },
      });

      const correctionContractGuidance = canRetryWithoutAdditionalToolCalls
        ? undefined
        : this.resolveActiveToolContractGuidance(
          ctx,
          {
            phase: "correction",
            allowedToolNames: correctionAllowedTools,
            validationCode: contractValidation?.code,
          },
        );
      if (correctionContractGuidance) {
        this.emitExecutionTrace(ctx, {
          type: "contract_guidance_resolved",
          phase,
          callIndex: ctx.callIndex + 1,
          payload: {
            source: correctionContractGuidance.source,
            routedToolNames: correctionContractGuidance.routedToolNames ?? [],
            toolChoice:
              typeof correctionContractGuidance.toolChoice === "string"
                ? correctionContractGuidance.toolChoice
                : correctionContractGuidance.toolChoice.name,
            hasRuntimeInstruction: Boolean(
              correctionContractGuidance.runtimeInstruction,
            ),
          },
        });
      }
      const nextResponse = await this.callModelForPhase(ctx, {
        phase,
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice:
          canRetryWithoutAdditionalToolCalls
            ? "none"
            : correctionContractGuidance?.toolChoice ?? "required",
        ...((correctionContractGuidance?.routedToolNames?.length ?? 0) > 0
          ? {
            routedToolNames: correctionContractGuidance!.routedToolNames,
            ...(correctionContractGuidance?.persistRoutedToolNames === false
              ? { persistRoutedToolNames: false }
              : {}),
          }
          : {}),
        budgetReason:
          "Max model recalls exceeded while enforcing delegated tool-grounded evidence",
      });
      if (!nextResponse) return "failed";
      ctx.response = nextResponse;
    }

    return retried ? "continue" : "not_required";
  }

  private async enforcePlanOnlyExecutionBeforeCompletion(
    ctx: ExecutionContext,
    phase: "initial" | "tool_followup",
  ): Promise<"continue" | "failed" | "not_required"> {
    const executionRequested = requestRequiresToolGroundedExecution(
      ctx.messageText,
    );
    const toolsAvailable = Boolean(ctx.activeToolHandler);
    if (!executionRequested || !toolsAvailable) {
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "plan_only_execution",
          decision: "not_required",
          finishReason: ctx.response?.finishReason,
          executionRequested,
          toolsAvailable,
        },
      });
      return "not_required";
    }

    let correctionAttempts = 0;
    let retried = false;
    while (ctx.response?.finishReason !== "tool_calls") {
      const responseContent =
        typeof ctx.response?.content === "string"
          ? ctx.response.content.trim()
          : "";
      const planOnly =
        responseContent.length > 0 &&
        isPlanOnlyExecutionResponse(responseContent);
      if (!planOnly) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "plan_only_execution",
            decision: retried ? "accept_after_retry" : "accept",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
          },
        });
        return retried ? "continue" : "not_required";
      }

      const allowedToolNames = resolveCorrectionAllowedToolNames(
        ctx.activeRoutedToolNames,
        this.allowedTools ?? undefined,
      );
      const failureMessage =
        "Execution task returned only a plan without grounded tool work. Start executing with tools or report a concrete blocker instead of another plan.";
      if (correctionAttempts >= MAX_PLAN_ONLY_EXECUTION_CORRECTIONS) {
        this.emitExecutionTrace(ctx, {
          type: "completion_gate_checked",
          phase,
          callIndex: ctx.callIndex,
          payload: {
            gate: "plan_only_execution",
            decision: "fail",
            finishReason: ctx.response?.finishReason,
            correctionAttempts,
            responsePreview: truncateText(responseContent, 180),
          },
        });
        this.setStopReason(ctx, "validation_error", failureMessage);
        ctx.finalContent = failureMessage;
        return "failed";
      }

      if (responseContent.length > 0) {
        this.pushMessage(
          ctx,
          { role: "assistant", content: responseContent, phase: "commentary" },
          "assistant_runtime",
        );
      }
      this.pushMessage(
        ctx,
        {
          role: "system",
          content: buildPlanOnlyExecutionRetryInstruction(allowedToolNames),
        },
        "system_runtime",
      );
      correctionAttempts += 1;
      retried = true;
      this.emitExecutionTrace(ctx, {
        type: "completion_gate_checked",
        phase,
        callIndex: ctx.callIndex,
        payload: {
          gate: "plan_only_execution",
          decision: "retry",
          finishReason: ctx.response?.finishReason,
          correctionAttempts,
          allowedToolNames,
          responsePreview: truncateText(responseContent, 180),
        },
      });

      const nextResponse = await this.callModelForPhase(ctx, {
        phase,
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        statefulResumeAnchor: ctx.stateful?.resumeAnchor,
        statefulHistoryCompacted: ctx.stateful?.historyCompacted,
        toolChoice: "required",
        budgetReason:
          "Max model recalls exceeded while retrying a plan-only execution response",
      });
      if (!nextResponse) return "failed";
      ctx.response = nextResponse;
    }

    return retried ? "continue" : "not_required";
  }

  private async finalizeDelegatedTurnAfterToolBudgetExhaustion(
    ctx: ExecutionContext,
    effectiveMaxToolRounds: number,
  ): Promise<boolean> {
    const delegationSpec = ctx.requiredToolEvidence?.delegationSpec;
    if (!delegationSpec || ctx.response?.finishReason !== "tool_calls") {
      return false;
    }

    const requestedToolNames = ctx.response.toolCalls
      .map((toolCall) => toolCall.name?.trim())
      .filter((toolName): toolName is string => Boolean(toolName));
    const instruction = buildDelegatedBudgetFinalizationInstruction({
      acceptanceCriteria: delegationSpec.acceptanceCriteria,
      requestedToolNames,
    });

    this.pushMessage(
      ctx,
      { role: "system", content: instruction },
      "system_runtime",
    );

    const finalResponse = await this.callModelForPhase(ctx, {
      phase: "tool_followup",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      statefulHistoryCompacted: ctx.stateful?.historyCompacted,
      routedToolNames: [],
      persistRoutedToolNames: false,
      toolChoice: "none",
      preparationDiagnostics: {
        toolBudgetFinalization: true,
        requestedToolNames,
        recallBudgetBypassed: true,
      },
      allowRecallBudgetBypass: true,
      budgetReason:
        "Max model recalls exceeded while finalizing delegated result after tool budget exhaustion",
    });
    const supersededStopReason =
      ctx.stopReason === "completed" ? undefined : ctx.stopReason;

    if (!finalResponse) {
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex + 1,
        payload: {
          outcome: "model_call_unavailable",
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      return true;
    }

    ctx.response = finalResponse;
    const {
      contractValidation,
      missingEvidenceMessage,
    } = validateRequiredToolEvidence({ ctx });
    const validationCode = contractValidation?.code;

    if (ctx.response.finishReason === "tool_calls") {
      ctx.validationCode = undefined;
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          outcome: "returned_tool_calls",
          finishReason: ctx.response.finishReason,
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      this.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${effectiveMaxToolRounds})`,
      );
      return true;
    }

    if (missingEvidenceMessage) {
      ctx.validationCode = validationCode;
      this.emitExecutionTrace(ctx, {
        type: "tool_round_budget_finalization_finished",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          outcome: "validation_error",
          finishReason: ctx.response.finishReason,
          maxToolRounds: effectiveMaxToolRounds,
          requestedToolNames,
          requestedToolCount: requestedToolNames.length,
          validationCode,
          missingEvidenceMessage,
          ...(supersededStopReason
            ? { supersededStopReason }
            : {}),
        },
      });
      this.setStopReason(ctx, "validation_error", missingEvidenceMessage);
      ctx.finalContent = missingEvidenceMessage;
      return true;
    }

    if (supersededStopReason) {
      ctx.stopReason = "completed";
      ctx.stopReasonDetail = undefined;
    }
    ctx.validationCode = undefined;
    this.emitExecutionTrace(ctx, {
      type: "tool_round_budget_finalization_finished",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        outcome: "completed",
        finishReason: ctx.response.finishReason,
        maxToolRounds: effectiveMaxToolRounds,
        requestedToolNames,
        requestedToolCount: requestedToolNames.length,
        ...(supersededStopReason
          ? { supersededStopReason }
          : {}),
      },
    });
    return true;
  }

  private async callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly LLMMessage[];
      callReconciliationMessages?: readonly LLMMessage[];
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
  ): Promise<LLMResponse | undefined> {
    if (!input.allowRecallBudgetBypass && !this.hasModelRecallBudget(ctx)) {
      this.setStopReason(ctx, "budget_exceeded", input.budgetReason);
      return undefined;
    }
    if (this.checkRequestTimeout(ctx, `${input.phase} model call`)) {
      return undefined;
    }
    const effectiveRoutedToolNames = resolveEffectiveRoutedToolNames({
      requestedRoutedToolNames: input.routedToolNames,
      hasToolRouting: Boolean(ctx.toolRouting),
      activeRoutedToolNames: ctx.activeRoutedToolNames,
      allowedTools: this.allowedTools ?? undefined,
    });
    const allowStatefulContinuation =
      shouldUseSessionStatefulContinuationForPhase(input.phase);
    if (input.persistRoutedToolNames !== false) {
      applyActiveRoutedToolNames(ctx, effectiveRoutedToolNames);
      ctx.transientRoutedToolNames = undefined;
    } else {
      ctx.transientRoutedToolNames = effectiveRoutedToolNames;
    }
    const groundingMessage =
      input.phase === "tool_followup" || input.phase === "planner_synthesis"
        ? buildToolExecutionGroundingMessage({
          toolCalls: ctx.allToolCalls,
          providerEvidence: ctx.providerEvidence,
        })
        : undefined;
    const effectiveCallMessages = groundingMessage
      ? [...input.callMessages, groundingMessage]
      : [...input.callMessages];
    const effectiveCallSections = groundingMessage && input.callSections
      ? [...input.callSections, "system_runtime" as const]
      : input.callSections;
    this.emitExecutionTrace(ctx, {
      type: "model_call_prepared",
      phase: input.phase,
      callIndex: ctx.callIndex + 1,
      payload: {
        ...(input.routedToolNames !== undefined
          ? { requestedRoutedToolNames: input.routedToolNames }
          : {}),
        ...(input.preparationDiagnostics ?? {}),
        routedToolNames: effectiveRoutedToolNames ?? [],
        activeRecoveryHintKeys: ctx.activeRecoveryHintKeys,
        remainingRequestMs: this.serializeRemainingRequestMs(
          this.getRemainingRequestMs(ctx),
        ),
        effectiveRequestTimeoutMs: this.serializeRequestTimeoutMs(
          ctx.effectiveRequestTimeoutMs,
        ),
        toolChoice:
          input.toolChoice === undefined
            ? undefined
            : typeof input.toolChoice === "string"
            ? input.toolChoice
            : input.toolChoice.name,
        messageCount: effectiveCallMessages.length,
        groundingMessageAdded: Boolean(groundingMessage),
        activeRouteMisses: ctx.routedToolMisses,
        routedToolsExpanded: ctx.routedToolsExpanded,
      },
    });
    let next: FallbackResult;
    try {
      next = await this.callWithFallback(
        effectiveCallMessages,
        input.onStreamChunk,
        effectiveCallSections,
        {
          requestDeadlineAt: ctx.requestDeadlineAt,
          signal: ctx.signal,
          ...(allowStatefulContinuation && input.statefulSessionId
            ? {
              statefulSessionId: input.statefulSessionId,
              reconciliationMessages:
                input.callReconciliationMessages ?? ctx.reconciliationMessages,
              ...(input.statefulHistoryCompacted
                ? { statefulHistoryCompacted: true }
                : {}),
              ...(input.statefulResumeAnchor
                ? { statefulResumeAnchor: input.statefulResumeAnchor }
                : {}),
            }
            : {}),
          ...(effectiveRoutedToolNames !== undefined
            ? { routedToolNames: effectiveRoutedToolNames }
            : {}),
          ...(input.toolChoice !== undefined
            ? { toolChoice: input.toolChoice }
            : {}),
          ...(ctx.trace
            ? {
              trace: ctx.trace,
              callIndex: ctx.callIndex + 1,
              callPhase: input.phase,
            }
            : {}),
        },
      );
    } catch (error) {
      const annotated = annotateFailureError(
        error,
        `${input.phase} model call`,
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    }
    ctx.modelCalls++;
    ctx.providerName = next.providerName;
    ctx.responseModel = next.response.model;
    ctx.providerEvidence = mergeProviderEvidence(
      ctx.providerEvidence,
      next.response.providerEvidence,
    );
    if (next.usedFallback) ctx.usedFallback = true;
    this.accumulateUsage(ctx.cumulativeUsage, next.response.usage);
    ctx.callUsage.push(
      this.createCallUsageRecord({
        callIndex: ++ctx.callIndex,
        phase: input.phase,
        providerName: next.providerName,
        response: next.response,
        beforeBudget: next.beforeBudget,
        afterBudget: next.afterBudget,
        budgetDiagnostics: next.budgetDiagnostics,
      }),
    );
    return next.response;
  }

  private async runPipelineWithTimeout(
    ctx: ExecutionContext,
    pipeline: Pipeline,
  ): Promise<PipelineResult | undefined> {
    const remainingMs = this.getRemainingRequestMs(ctx);
    if (!Number.isFinite(remainingMs)) {
      return this.pipelineExecutor!.execute(
        pipeline,
        0,
        {
          ...(ctx.activeToolHandler
            ? { toolHandler: ctx.activeToolHandler }
            : {}),
          onEvent: (event) => this.emitPipelineExecutionTrace(ctx, event),
        },
      );
    }
    if (remainingMs <= 0) {
      this.setStopReason(
        ctx,
        "timeout",
        this.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
      );
      return undefined;
    }
    const timeoutMessage = `planner pipeline timed out after ${remainingMs}ms`;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, remainingMs);
    });
    try {
      return await Promise.race([
        this.pipelineExecutor!.execute(
          pipeline,
          0,
          {
            ...(ctx.activeToolHandler
              ? { toolHandler: ctx.activeToolHandler }
              : {}),
            onEvent: (event) => this.emitPipelineExecutionTrace(ctx, event),
          },
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === timeoutMessage) {
        this.setStopReason(
          ctx,
          "timeout",
          this.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
        );
        return undefined;
      }
      const annotated = annotateFailureError(
        error,
        "planner pipeline execution",
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async initializeExecutionContext(
    params: ChatExecuteParams,
  ): Promise<ExecutionContext> {
    const { message, systemPrompt, sessionId, signal } = params;
    let { history } = params;
    const effectiveMaxToolRounds =
      typeof params.maxToolRounds === "number" && Number.isFinite(params.maxToolRounds)
        ? Math.max(1, Math.floor(params.maxToolRounds))
        : this.maxToolRounds;
    const effectiveToolBudget =
      typeof params.toolBudgetPerRequest === "number" &&
        Number.isFinite(params.toolBudgetPerRequest)
        ? Math.max(1, Math.floor(params.toolBudgetPerRequest))
        : this.toolBudgetPerRequest;
    const effectiveMaxModelRecalls =
      typeof params.maxModelRecallsPerRequest === "number" &&
        Number.isFinite(params.maxModelRecallsPerRequest)
        ? Math.max(0, Math.floor(params.maxModelRecallsPerRequest))
        : this.maxModelRecallsPerRequest;
    const messageText = extractMessageText(message);
    const initialRoutedToolNames = params.toolRouting?.routedToolNames
      ? Array.from(new Set(params.toolRouting.routedToolNames))
      : [];
    const expandedRoutedToolNames = params.toolRouting?.expandedToolNames
      ? Array.from(new Set(params.toolRouting.expandedToolNames))
      : [];
    const explicitRequirementToolNames =
      mergeExplicitRequirementToolNames(
        initialRoutedToolNames,
        expandedRoutedToolNames,
        this.allowedTools ? [...this.allowedTools] : [],
      );
    const explicitDeterministicToolRequirements =
      extractExplicitDeterministicToolRequirements(
        messageText,
        explicitRequirementToolNames,
      );
    let plannerDecision = assessPlannerDecision(
      this.plannerEnabled,
      messageText,
      history,
    );
    if (
      explicitDeterministicToolRequirements?.forcePlanner &&
      !plannerDecision.shouldPlan
    ) {
      plannerDecision = {
        score: Math.max(plannerDecision.score, 3),
        shouldPlan: true,
        reason: "explicit_deterministic_tool_requirements",
      };
    }
    const resolvedThresholdOverride = this.resolveDelegationScoreThreshold?.();
    const baseDelegationThreshold =
      typeof resolvedThresholdOverride === "number" &&
        Number.isFinite(resolvedThresholdOverride)
        ? Math.max(0, Math.min(1, resolvedThresholdOverride))
        : this.delegationDecisionConfig.scoreThreshold;

    // Pre-check token budget — attempt compaction instead of hard fail
    let compacted = false;
    if (this.sessionTokenBudget !== undefined) {
      const used = this.sessionTokens.get(sessionId) ?? 0;
      if (used >= this.sessionTokenBudget) {
        try {
          history = await this.compactHistory(history, sessionId, params.trace);
          this.resetSessionTokens(sessionId);
          compacted = true;
        } catch {
          throw new ChatBudgetExceededError(
            sessionId,
            used,
            this.sessionTokenBudget,
          );
        }
      }
    }

    const ctx = buildDefaultExecutionContext(
      {
        message,
        messageText,
        systemPrompt,
        sessionId,
        signal,
        history,
        plannerDecision,
        compacted,
        toolHandler: params.toolHandler ?? this.toolHandler,
        streamCallback: params.onStreamChunk ?? this.onStreamChunk,
        toolRouting: params.toolRouting,
        stateful: params.stateful,
        trace: params.trace,
        requiredToolEvidence: params.requiredToolEvidence,
        initialRoutedToolNames,
        expandedRoutedToolNames,
        baseDelegationThreshold,
      },
      {
        maxToolRounds: effectiveMaxToolRounds,
        toolBudgetPerRequest: effectiveToolBudget,
        maxModelRecallsPerRequest: effectiveMaxModelRecalls,
        maxFailureBudgetPerRequest: this.maxFailureBudgetPerRequest,
        requestTimeoutMs: ChatExecutor.normalizeRequestTimeoutMs(
          params.requestTimeoutMs ?? this.requestTimeoutMs,
        ),
        providerName: this.providers[0]?.name ?? "unknown",
        plannerEnabled: this.plannerEnabled,
        subagentVerifierEnabled: this.subagentVerifierConfig.enabled,
        delegationBanditTunerEnabled: Boolean(this.delegationBanditTuner),
        delegationScoreThreshold: this.delegationDecisionConfig.scoreThreshold,
      },
    );

    // Build messages array with explicit section tags for prompt budgeting.
    this.pushMessage(ctx, { role: "system", content: ctx.systemPrompt }, "system_anchor");

    // Context injection — skill, memory, and learning (all best-effort)
    await this.injectContext(
      ctx,
      this.skillInjector,
      ctx.messageText,
      ctx.sessionId,
      ctx.messages,
      ctx.messageSections,
      "system_runtime",
    );
    // Session-scoped persistence should not bleed into truly fresh chats.
    // For the first turn, only inject static skill context.
    if (ctx.hasHistory) {
      await this.injectContext(
        ctx,
        this.memoryRetriever,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_semantic",
      );
      await this.injectContext(
        ctx,
        this.learningProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_episodic",
      );
      await this.injectContext(
        ctx,
        this.progressProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_working",
      );
    }

    // Append history and user message
    const normalizedHistory = normalizeHistory(ctx.history);
    const reconciliationHistory =
      normalizeHistoryForStatefulReconciliation(ctx.history);
    for (let index = 0; index < normalizedHistory.length; index++) {
      this.pushMessage(
        ctx,
        normalizedHistory[index]!,
        "history",
        reconciliationHistory[index],
      );
    }

    appendUserMessage(
      ctx.messages,
      ctx.messageSections,
      ctx.message,
      ctx.reconciliationMessages,
    );

    return ctx;
  }

  private recordOutcomeAndFinalize(ctx: ExecutionContext): {
    plannerSummary: ChatPlannerSummary;
    durationMs: number;
  } {
    const durationMs = Date.now() - ctx.startTime;
    const verifierSnapshot = ctx.plannerSummaryState.subagentVerification;
    const qualityProxy = computeQualityProxy({
      stopReason: ctx.stopReason,
      verifierPerformed: verifierSnapshot.performed,
      verifierOverall: verifierSnapshot.overall,
      evaluation: ctx.evaluation,
      failedToolCalls: ctx.failedToolCalls,
    });
    const rewardSignal = computeDelegationFinalReward({
      qualityProxy,
      tokenCost: ctx.cumulativeUsage.totalTokens,
      latencyMs: durationMs,
      errorCount:
        ctx.failedToolCalls + (ctx.stopReason === "completed" ? 0 : 1),
    });
    const estimatedRecallsAvoided = ctx.plannerSummaryState.used
      ? Math.max(
          0,
          ctx.plannerSummaryState.deterministicStepsExecuted -
            Math.max(0, ctx.modelCalls - ctx.plannerSummaryState.plannerCalls),
        )
      : 0;
    const delegatedThisTurn =
      ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true;
    const usefulnessProxy = computeUsefulDelegationProxy({
      delegated: delegatedThisTurn,
      stopReason: ctx.stopReason,
      failedToolCalls: ctx.failedToolCalls,
      estimatedRecallsAvoided,
      verifier: {
        performed: verifierSnapshot.performed,
        overall: verifierSnapshot.overall,
        confidence: verifierSnapshot.confidence,
      },
      reward: rewardSignal,
    });
    const policyReward = delegatedThisTurn
      ? usefulnessProxy.score * 2 - 1
      : 0;

    if (
      ctx.selectedBanditArm &&
      this.delegationBanditTuner &&
      ctx.plannerSummaryState.delegationPolicyTuning.enabled
    ) {
      this.delegationBanditTuner.recordOutcome({
        contextClusterId: ctx.trajectoryContextClusterId,
        armId: ctx.selectedBanditArm.armId,
        reward: policyReward,
      });
      ctx.plannerSummaryState.delegationPolicyTuning = {
        ...ctx.plannerSummaryState.delegationPolicyTuning,
        finalReward: policyReward,
        usefulDelegation: usefulnessProxy.useful,
        usefulDelegationScore: usefulnessProxy.score,
        rewardProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
      };
    }

    if (this.delegationTrajectorySink) {
      const selectedTools = ctx.activeRoutedToolNames.length > 0
        ? [...ctx.activeRoutedToolNames]
        : (this.allowedTools ? [...this.allowedTools] : []);
      this.delegationTrajectorySink.record(
        buildDelegationTrajectoryEntry({
          ctx,
          qualityProxy,
          durationMs,
          rewardSignal,
          usefulnessProxy,
          selectedTools,
          defaultStrategyArmId: this.delegationDefaultStrategyArmId,
          delegationMaxDepth: this.delegationDecisionConfig.maxDepth,
          delegationMaxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
          requestTimeoutMs: this.requestTimeoutMs,
          usefulDelegationProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
        }),
      );
    }

    const plannerSummary = buildPlannerSummary(
      ctx.plannerSummaryState,
      estimatedRecallsAvoided,
    );

    return { plannerSummary, durationMs };
  }

  private async evaluateAndRetryResponse(ctx: ExecutionContext): Promise<void> {
    const minScore = this.evaluator!.minScore ?? 0.7;
    const maxRetries = this.evaluator!.maxRetries ?? 1;
    let retryCount = 0;
    let currentContent = ctx.finalContent;

    while (retryCount <= maxRetries) {
      if (this.checkRequestTimeout(ctx, "response evaluation")) {
        break;
      }
      // Skip evaluation if token budget would be exceeded.
      if (this.sessionTokenBudget !== undefined) {
        const used = this.sessionTokens.get(ctx.sessionId) ?? 0;
        if (used >= this.sessionTokenBudget) break;
      }
      if (!this.hasModelRecallBudget(ctx)) {
        this.setStopReason(
          ctx,
          "budget_exceeded",
          "Max model recalls exceeded during response evaluation",
        );
        break;
      }

      const evalResult = await this.evaluateResponse(
        currentContent,
        ctx.messageText,
        ctx.trace,
        ctx.callIndex + 1,
      );
      ctx.modelCalls++;
      if (evalResult.usedFallback) ctx.usedFallback = true;
      this.accumulateUsage(ctx.cumulativeUsage, evalResult.response.usage);
      this.trackTokenUsage(ctx.sessionId, evalResult.response.usage.totalTokens);
      ctx.callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++ctx.callIndex,
          phase: "evaluator",
          providerName: evalResult.providerName,
          response: evalResult.response,
          beforeBudget: evalResult.beforeBudget,
          afterBudget: evalResult.afterBudget,
          budgetDiagnostics: evalResult.budgetDiagnostics,
        }),
      );

      if (evalResult.score >= minScore || retryCount === maxRetries) {
        ctx.evaluation = {
          score: evalResult.score,
          feedback: evalResult.feedback,
          passed: evalResult.score >= minScore,
          retryCount,
        };
        ctx.finalContent = currentContent;
        break;
      }

      retryCount++;
      this.pushMessage(
        ctx,
        { role: "assistant", content: currentContent, phase: "commentary" },
        "assistant_runtime",
      );
      this.pushMessage(
        ctx,
        {
          role: "system",
          content: `Response scored ${evalResult.score.toFixed(2)}. Feedback: ${evalResult.feedback}\nPlease improve your response.`,
        },
        "system_runtime",
      );

      if (!this.hasModelRecallBudget(ctx)) {
        this.setStopReason(
          ctx,
          "budget_exceeded",
          "Max model recalls exceeded during evaluator retry",
        );
        break;
      }
      if (this.checkRequestTimeout(ctx, "evaluator retry")) {
        break;
      }
      let retry: FallbackResult;
      try {
        retry = await this.callWithFallback(
          ctx.messages,
          ctx.activeStreamCallback,
          ctx.messageSections,
          {
            statefulSessionId: ctx.sessionId,
            statefulResumeAnchor: ctx.stateful?.resumeAnchor,
            statefulHistoryCompacted: ctx.stateful?.historyCompacted,
            reconciliationMessages: ctx.reconciliationMessages,
            ...(ctx.toolRouting
              ? { routedToolNames: ctx.activeRoutedToolNames }
              : {}),
            ...(ctx.trace
              ? {
                trace: ctx.trace,
                callIndex: ctx.callIndex + 1,
                callPhase: "evaluator_retry" as const,
              }
              : {}),
          },
        );
      } catch (error) {
        const annotated = annotateFailureError(
          error,
          "evaluator retry",
        );
        this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
        throw annotated.error;
      }
      ctx.modelCalls++;
      this.accumulateUsage(ctx.cumulativeUsage, retry.response.usage);
      this.trackTokenUsage(ctx.sessionId, retry.response.usage.totalTokens);
      ctx.callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++ctx.callIndex,
          phase: "evaluator_retry",
          providerName: retry.providerName,
          response: retry.response,
          beforeBudget: retry.beforeBudget,
          afterBudget: retry.afterBudget,
          budgetDiagnostics: retry.budgetDiagnostics,
        }),
      );
      ctx.providerName = retry.providerName;
      ctx.responseModel = retry.response.model;
      if (retry.usedFallback) ctx.usedFallback = true;
      currentContent = retry.response.content || currentContent;
    }
  }

  private async executeToolCallLoop(ctx: ExecutionContext): Promise<void> {
    const suppressToolsForDialogueTurn =
      !ctx.plannerDecision.shouldPlan &&
      (ctx.plannerDecision.reason === "exact_response_turn" ||
        ctx.plannerDecision.reason === "dialogue_memory_turn" ||
        ctx.plannerDecision.reason === "dialogue_recall_turn");
    const initialContractGuidance = this.resolveActiveToolContractGuidance(ctx, {
      phase: "initial",
    });
    const dialogueToolSuppressed =
      suppressToolsForDialogueTurn &&
      initialContractGuidance?.routedToolNames === undefined &&
      ctx.initialRoutedToolNames.length > 0;
    if (initialContractGuidance) {
      this.emitExecutionTrace(ctx, {
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
      this.maybePushRuntimeInstruction(
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
    ctx.response = await this.callModelForPhase(ctx, {
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
      await this.enforcePlanOnlyExecutionBeforeCompletion(ctx, "initial");
    if (initialPlanOnlyAction === "failed" && !ctx.finalContent) {
      ctx.finalContent = ctx.response?.content ?? ctx.finalContent;
    }
    if (initialPlanOnlyAction === "failed") {
      return;
    }

    const initialEvidenceAction =
      await this.enforceRequiredToolEvidenceBeforeCompletion(ctx, "initial");
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
        this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
        break;
      }
      if (this.checkRequestTimeout(ctx, "tool loop")) break;
      const activeCircuit = this.toolFailureBreaker.getActiveCircuit(ctx.sessionId);
      if (activeCircuit) {
        this.setStopReason(ctx, "no_progress", activeCircuit.reason);
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

      this.pushMessage(
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
        const action = await this.executeSingleToolCall(ctx, toolCall, loopState);
        if (action === "end_round") {
          break;
        }
        if (action === "abort_loop" || action === "abort_round") {
          abortRound = true;
          break;
        }
      }

      if (ctx.signal?.aborted) {
        this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
        break;
      }
      if (this.checkRequestTimeout(ctx, "tool follow-up")) break;

      const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
      if (abortRound) break;

      // Stuck-loop detection (consecutive failures, semantic duplicates).
      const stuckResult = checkToolLoopStuckDetection(roundCalls, loopState, stuckState);
      if (stuckResult.shouldBreak) {
        const roundFailures = roundCalls.filter((call) =>
          didToolCallFail(call.isError, call.result)
        ).length;
        this.emitExecutionTrace(ctx, {
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
        this.setStopReason(ctx, "no_progress", stuckResult.reason);
        break;
      }

      // Recovery hints.
      const recoveryHints = buildRecoveryHints(roundCalls, new Set<string>());
      this.replaceRuntimeRecoveryHintMessages(ctx, recoveryHints);
      if (recoveryHints.length > 0) {
        this.emitExecutionTrace(ctx, {
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
        this.maxRuntimeSystemHints,
        runtimeHintCount,
      )) {
        this.pushMessage(ctx, msg, "system_runtime");
      }

      // Routing expansion on miss.
      if (loopState.expandAfterRound && ctx.expandedRoutedToolNames.length > 0) {
        const previousRoutedToolNames = [...ctx.activeRoutedToolNames];
        ctx.routedToolsExpanded = true;
        applyActiveRoutedToolNames(ctx, ctx.expandedRoutedToolNames);
        this.emitExecutionTrace(ctx, {
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
          this.maxRuntimeSystemHints,
          updatedHintCount,
        );
        if (expansionMsg) {
          this.pushMessage(ctx, expansionMsg, "system_runtime");
        }
      }

      const followupContractGuidance = this.resolveActiveToolContractGuidance(
        ctx,
        {
          phase: "tool_followup",
        },
      );
      if (followupContractGuidance) {
        this.emitExecutionTrace(ctx, {
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
        this.maybePushRuntimeInstruction(
          ctx,
          followupContractGuidance.runtimeInstruction,
        );
      }

      // Re-call LLM.
      const nextResponse = await this.callModelForPhase(ctx, {
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
        await this.enforcePlanOnlyExecutionBeforeCompletion(
          ctx,
          "tool_followup",
        );
      if (planOnlyAction === "failed") break;
      const evidenceAction =
        await this.enforceRequiredToolEvidenceBeforeCompletion(
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
        const extension = this.evaluateToolRoundBudgetExtension({
          ctx,
          currentLimit: effectiveMaxToolRounds,
          recentRounds: recentRoundProgress,
        });
        this.emitExecutionTrace(ctx, {
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
            remainingRequestMs: this.serializeRemainingRequestMs(
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
          this.emitExecutionTrace(ctx, {
            type: "tool_round_budget_extended",
            phase: "tool_followup",
            callIndex: ctx.callIndex + 1,
            payload: {
              previousLimit,
              newLimit: effectiveMaxToolRounds,
              extensionRounds: extension.extensionRounds,
              remainingRequestMs: this.serializeRemainingRequestMs(
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
      this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
    } else if (
      ctx.response &&
      ctx.response.finishReason === "tool_calls" &&
      rounds >= effectiveMaxToolRounds
    ) {
      const finalized = await this.finalizeDelegatedTurnAfterToolBudgetExhaustion(
        ctx,
        effectiveMaxToolRounds,
      );
      if (!finalized) {
        this.setStopReason(
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

  private async executeSingleToolCall(
    ctx: ExecutionContext,
    toolCall: LLMToolCall,
    loopState: ToolLoopState,
  ): Promise<ToolCallAction> {
    if (this.checkRequestTimeout(ctx, `tool "${toolCall.name}" dispatch`)) {
      return "abort_loop";
    }
    if (ctx.allToolCalls.length >= ctx.effectiveToolBudget) {
      this.setStopReason(
        ctx,
        "budget_exceeded",
        `Tool budget exceeded (${ctx.effectiveToolBudget} per request)`,
      );
      return "abort_loop";
    }

    // Permission check (allowlist, routed subset).
    const permission = checkToolCallPermission(
      toolCall,
      this.allowedTools,
      loopState.activeRoutedToolSet,
      ctx.canExpandOnRoutingMiss,
      ctx.routedToolsExpanded,
    );
    if (permission.errorResult) {
      this.emitExecutionTrace(ctx, {
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
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: permission.errorResult,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
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
      this.emitExecutionTrace(ctx, {
        type: "tool_arguments_invalid",
        phase: "tool_followup",
        callIndex: ctx.callIndex,
        payload: {
          tool: toolCall.name,
          error: parseResult.error,
          rawArguments: toolCall.arguments,
        },
      });
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: parseResult.error,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
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
    this.emitExecutionTrace(ctx, {
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
        toolCallTimeoutMs: this.toolCallTimeoutMs,
        retryPolicyMatrix: this.retryPolicyMatrix,
        signal: ctx.signal,
        requestDeadlineAt: ctx.requestDeadlineAt,
      },
    );

    let { result } = exec;
    let abortRound = false;
    if (exec.timedOut && exec.toolFailed) {
      this.setStopReason(
        ctx,
        "timeout",
        `Tool "${toolCall.name}" timed out after ${exec.finalToolTimeoutMs}ms`,
      );
      abortRound = true;
    }

    if (exec.toolFailed) {
      const failKey = buildSemanticToolCallKey(toolCall.name, args);
      const circuitReason = this.toolFailureBreaker.recordFailure(
        ctx.sessionId,
        failKey,
        toolCall.name,
      );
      if (circuitReason) {
        this.setStopReason(ctx, "no_progress", circuitReason);
        abortRound = true;
        result = enrichToolResultMetadata(result, {
          circuitBreaker: "open",
          circuitBreakerReason: circuitReason,
        });
      }
    }

    this.appendToolRecord(ctx, {
      name: toolCall.name,
      args,
      result,
      isError: exec.toolFailed,
      durationMs: exec.durationMs,
    });
    this.emitExecutionTrace(ctx, {
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
      this.setStopReason(
        ctx,
        "tool_error",
        `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget})`,
      );
      abortRound = true;
    }

    // Track consecutive semantic failures to detect stuck loops.
    const semanticToolKey = buildSemanticToolCallKey(toolCall.name, args);
    if (!exec.toolFailed) {
      this.toolFailureBreaker.clearPattern(ctx.sessionId, semanticToolKey);
    }
    trackToolCallFailureState(exec.toolFailed, semanticToolKey, loopState);

    const promptToolContent = buildPromptToolContent(
      result,
      loopState.remainingToolImageChars,
    );
    loopState.remainingToolImageChars = promptToolContent.remainingImageBudget;
    this.pushMessage(
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

  private async executePlannerPath(ctx: ExecutionContext): Promise<void> {
    ctx.plannerSummaryState.used = true;
    const plannerSections: PromptBudgetSection[] = [
      "system_anchor",
      "history",
      "user",
    ];
    const explicitOrchestrationRequirements =
      extractExplicitSubagentOrchestrationRequirements(ctx.messageText);
    const explicitDeterministicToolRequirements =
      explicitOrchestrationRequirements
        ? undefined
        : extractExplicitDeterministicToolRequirements(
            ctx.messageText,
            mergeExplicitRequirementToolNames(
              ctx.activeRoutedToolNames,
              ctx.expandedRoutedToolNames,
              this.allowedTools ? [...this.allowedTools] : [],
            ),
          );
    const explicitVerificationRequirements =
      extractPlannerVerificationRequirements(ctx.messageText);
    const explicitVerificationCommandRequirements =
      extractPlannerVerificationCommandRequirements(ctx.messageText);
    const explicitPlannerToolNames =
      explicitDeterministicToolRequirements?.orderedToolNames;
    let refinementHint: string | undefined;
    const maxStructuralPlannerRetries = Math.max(
      0,
      DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS - 1,
    );
    const maxPlannerStepContractRetries = Math.max(
      0,
      DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
    );
    const maxRuntimeRepairRetries =
      DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES;
    const maxPlannerDecompositionRetries = 2;
    const maxPlannerAttempts =
      1 +
      maxStructuralPlannerRetries +
      maxPlannerStepContractRetries +
      maxRuntimeRepairRetries +
      maxPlannerDecompositionRetries;
    let structuralPlannerRetriesUsed = 0;
    let plannerStepContractRetriesUsed = 0;
    let decompositionPlannerRetriesUsed = 0;
    const seenStructuralDiagnosticSignatures = new Set<string>();
    const seenRuntimeRepairFailureSignatures = new Set<string>();
    let latestPlannerValidationDiagnostics: readonly PlannerDiagnostic[] = [];

    for (
      let plannerAttempt = 1;
      plannerAttempt <= maxPlannerAttempts;
      plannerAttempt++
    ) {
      const plannerMessages = buildPlannerMessages(
        ctx.messageText,
        ctx.history,
        this.plannerMaxTokens,
        explicitDeterministicToolRequirements,
        refinementHint,
        this.resolveHostToolingProfile?.(),
        {
          maxSubagentFanout: this.delegationDecisionConfig.maxFanoutPerTurn,
          currentDelegationDepth: this.delegationNestingDepth,
          maxDelegationDepth: this.delegationDecisionConfig.maxDepth,
          childCanDelegate: this.delegationNestingDepth + 1 < this.delegationDecisionConfig.maxDepth,
        },
      );
      const plannerResponse = await this.callModelForPhase(ctx, {
        phase: "planner",
        callMessages: plannerMessages,
        callSections: plannerSections,
        ...(explicitPlannerToolNames
          ? { routedToolNames: explicitPlannerToolNames }
          : {}),
        budgetReason:
          "Planner pass blocked by max model recalls per request budget",
      });
      if (!plannerResponse) return;

      ctx.plannerSummaryState.plannerCalls = plannerAttempt;
      ctx.plannerSummaryState.delegationDecision = undefined;
      ctx.plannedSubagentSteps = 0;
      ctx.plannedDeterministicSteps = 0;
      ctx.plannedSynthesisSteps = 0;
      ctx.plannedFanout = 0;
      ctx.plannedDependencyDepth = 0;

      const plannerParse = normalizePlannerResponse({
        content: plannerResponse.content,
        toolCalls: plannerResponse.toolCalls,
        repairRequirements: explicitOrchestrationRequirements,
      });
      ctx.plannerSummaryState.diagnostics.push(...plannerParse.diagnostics);
      const plannerPlan = plannerParse.plan;
      if (!plannerPlan) {
        if (explicitOrchestrationRequirements) {
          if (
            plannerAttempt < maxPlannerAttempts &&
            structuralPlannerRetriesUsed < maxStructuralPlannerRetries
          ) {
            structuralPlannerRetriesUsed++;
            refinementHint = buildExplicitSubagentOrchestrationRefinementHint(
              explicitOrchestrationRequirements,
              plannerParse.diagnostics,
            );
            ctx.plannerSummaryState.diagnostics.push({
              category: "policy",
              code: "planner_required_orchestration_retry",
              message:
                "Planner failed to emit the user-required sub-agent orchestration plan; requesting a refined plan",
              details: {
                attempt: plannerAttempt,
                nextAttempt: plannerAttempt + 1,
                maxAttempts: maxPlannerAttempts,
              },
            });
            this.emitPlannerTrace(ctx, "planner_refinement_requested", {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              reason: "planner_required_orchestration_retry",
              routeReason: "planner_required_orchestration_unmet",
              diagnostics: plannerParse.diagnostics,
            });
            continue;
          }
          ctx.plannerSummaryState.routeReason =
            "planner_required_orchestration_unmet";
          this.setStopReason(
            ctx,
            "validation_error",
            "Planner could not produce the required sub-agent orchestration plan",
          );
          ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
            explicitOrchestrationRequirements,
            plannerParse.diagnostics,
          );
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }
        if (explicitDeterministicToolRequirements) {
          if (
            plannerAttempt < maxPlannerAttempts &&
            structuralPlannerRetriesUsed < maxStructuralPlannerRetries
          ) {
            structuralPlannerRetriesUsed++;
            refinementHint = buildExplicitDeterministicToolRefinementHint(
              explicitDeterministicToolRequirements,
              plannerParse.diagnostics,
            );
            ctx.plannerSummaryState.diagnostics.push({
              category: "policy",
              code: "planner_explicit_tool_parse_retry",
              message:
                "Planner failed to emit the user-required deterministic tool plan; requesting a refined plan",
              details: {
                attempt: plannerAttempt,
                nextAttempt: plannerAttempt + 1,
                maxAttempts: maxPlannerAttempts,
              },
            });
            this.emitPlannerTrace(ctx, "planner_refinement_requested", {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              reason: "planner_explicit_tool_parse_retry",
              routeReason: "planner_explicit_tool_requirements_unmet",
              diagnostics: plannerParse.diagnostics,
            });
            continue;
          }
          ctx.plannerSummaryState.routeReason =
            "planner_explicit_tool_requirements_unmet";
          this.setStopReason(
            ctx,
            "validation_error",
            "Planner could not produce the required deterministic tool plan",
          );
          ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
            explicitDeterministicToolRequirements,
            plannerParse.diagnostics,
          );
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }
        const recoverablePlannerParseDiagnostics =
          extractRecoverablePlannerParseDiagnostics(
            plannerParse.diagnostics,
          );
        if (
          recoverablePlannerParseDiagnostics.length > 0 &&
          recoverablePlannerParseDiagnostics.length ===
            plannerParse.diagnostics.length &&
          plannerAttempt < maxPlannerAttempts &&
          plannerStepContractRetriesUsed < maxPlannerStepContractRetries
        ) {
          plannerStepContractRetriesUsed++;
          refinementHint = buildPlannerParseRefinementHint(
            recoverablePlannerParseDiagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_parse_contract_retry",
            message:
              "Planner emitted recoverable parse issues; requesting a refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_parse_contract_retry",
            routeReason: "planner_parse_failed",
            diagnostics: recoverablePlannerParseDiagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason = "planner_parse_failed";
        this.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: false,
        });
        return;
      }

      const salvagedToolPlanDiagnostics = validateSalvagedPlannerToolPlan({
        plannerPlan,
        messageText: ctx.messageText,
        history: ctx.history,
        explicitDeterministicRequirements: explicitDeterministicToolRequirements,
      });
      if (salvagedToolPlanDiagnostics.length > 0) {
        ctx.plannerSummaryState.diagnostics.push(...salvagedToolPlanDiagnostics);
        if (
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildSalvagedPlannerToolCallRefinementHint(
            salvagedToolPlanDiagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_salvaged_tool_call_retry",
            message:
              "Planner emitted raw tool calls that under-decomposed the request; requesting a refined JSON plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_salvaged_tool_call_retry",
            routeReason: "planner_parse_failed",
            diagnostics: salvagedToolPlanDiagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason = "planner_parse_failed";
        this.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: false,
        });
        return;
      }

      const graphDiagnostics = validatePlannerGraph(
        plannerPlan,
        {
          maxSubagentFanout: this.delegationDecisionConfig.maxFanoutPerTurn,
          maxSubagentDepth: this.delegationDecisionConfig.maxDepth,
        },
      );
      const plannerStepContractDiagnostics = validatePlannerStepContracts(
        plannerPlan,
      );
      const verificationRequirementDiagnostics =
        explicitVerificationRequirements.length > 0 ||
        explicitVerificationCommandRequirements.length > 0
          ? validatePlannerVerificationRequirements(
              plannerPlan,
              explicitVerificationRequirements,
              explicitVerificationCommandRequirements,
            )
          : [];
      const structuralGraphDiagnostics = extractPlannerStructuralDiagnostics(
        [
          ...graphDiagnostics,
          ...verificationRequirementDiagnostics,
        ],
      );
      const decompositionGraphDiagnostics =
        extractPlannerDecompositionDiagnostics(structuralGraphDiagnostics);
      const requiredOrchestrationDiagnostics =
        explicitOrchestrationRequirements
          ? validateExplicitSubagentOrchestrationRequirements(
              plannerPlan,
              explicitOrchestrationRequirements,
            )
          : [];
      const explicitToolDiagnostics =
        explicitDeterministicToolRequirements
          ? validateExplicitDeterministicToolRequirements(
              plannerPlan,
              explicitDeterministicToolRequirements,
            )
          : [];
      const hasStructuralDiagnostics =
        structuralGraphDiagnostics.length > 0 ||
        requiredOrchestrationDiagnostics.length > 0 ||
        explicitToolDiagnostics.length > 0;
      const currentValidationDiagnostics = [
        ...graphDiagnostics,
        ...plannerStepContractDiagnostics,
        ...verificationRequirementDiagnostics,
        ...requiredOrchestrationDiagnostics,
        ...explicitToolDiagnostics,
      ];
      latestPlannerValidationDiagnostics = currentValidationDiagnostics;
      const hasOnlyStepContractDiagnostics =
        !hasStructuralDiagnostics &&
        plannerStepContractDiagnostics.length > 0;
      const structuralDiagnosticSignature =
        hasStructuralDiagnostics
          ? buildPlannerDiagnosticSignature([
              ...structuralGraphDiagnostics,
              ...requiredOrchestrationDiagnostics,
              ...explicitToolDiagnostics,
            ])
          : "";
      const canUseProgressStructuralRetry =
        hasStructuralDiagnostics &&
        structuralPlannerRetriesUsed >= maxStructuralPlannerRetries &&
        plannerAttempt < maxPlannerAttempts &&
        structuralDiagnosticSignature.length > 0 &&
        !seenStructuralDiagnosticSignatures.has(structuralDiagnosticSignature);
      const hasOnlyDecompositionStructuralDiagnostics =
        decompositionGraphDiagnostics.length > 0 &&
        decompositionGraphDiagnostics.length ===
          structuralGraphDiagnostics.length &&
        plannerStepContractDiagnostics.length === 0 &&
        verificationRequirementDiagnostics.length === 0 &&
        requiredOrchestrationDiagnostics.length === 0 &&
        explicitToolDiagnostics.length === 0;
      const canUseDecompositionRetry =
        hasOnlyDecompositionStructuralDiagnostics &&
        decompositionPlannerRetriesUsed < maxPlannerDecompositionRetries &&
        plannerAttempt < maxPlannerAttempts;
      const shouldRefinePlan =
        (
          structuralGraphDiagnostics.length > 0 ||
          plannerStepContractDiagnostics.length > 0 ||
          verificationRequirementDiagnostics.length > 0 ||
          requiredOrchestrationDiagnostics.length > 0 ||
          explicitToolDiagnostics.length > 0
        ) &&
        plannerAttempt < maxPlannerAttempts &&
        (
          (
            hasOnlyStepContractDiagnostics &&
            plannerStepContractRetriesUsed < maxPlannerStepContractRetries
          ) ||
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries ||
          canUseProgressStructuralRetry ||
          canUseDecompositionRetry
        );
      if (
        graphDiagnostics.length > 0 ||
        plannerStepContractDiagnostics.length > 0 ||
        verificationRequirementDiagnostics.length > 0 ||
        requiredOrchestrationDiagnostics.length > 0 ||
        explicitToolDiagnostics.length > 0
      ) {
        ctx.plannerSummaryState.diagnostics.push(...graphDiagnostics);
        ctx.plannerSummaryState.diagnostics.push(
          ...plannerStepContractDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push(
          ...verificationRequirementDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push(
          ...requiredOrchestrationDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push(...explicitToolDiagnostics);
        if (shouldRefinePlan) {
          if (
            hasOnlyStepContractDiagnostics &&
            plannerStepContractRetriesUsed < maxPlannerStepContractRetries
          ) {
            plannerStepContractRetriesUsed++;
          } else if (structuralPlannerRetriesUsed < maxStructuralPlannerRetries) {
            structuralPlannerRetriesUsed++;
          } else if (canUseDecompositionRetry) {
            decompositionPlannerRetriesUsed++;
          }
          if (structuralDiagnosticSignature.length > 0) {
            seenStructuralDiagnosticSignatures.add(
              structuralDiagnosticSignature,
            );
          }
          const refinementHints: string[] = [];
          if (structuralGraphDiagnostics.length > 0) {
            refinementHints.push(
              buildPlannerStructuralRefinementHint(
                structuralGraphDiagnostics,
              ),
            );
          }
          if (plannerStepContractDiagnostics.length > 0) {
            refinementHints.push(
              buildPlannerStepContractRefinementHint(
                plannerStepContractDiagnostics,
              ),
            );
          }
          if (verificationRequirementDiagnostics.length > 0) {
            refinementHints.push(
              buildPlannerVerificationRequirementsRefinementHint(
                explicitVerificationRequirements,
                verificationRequirementDiagnostics,
              ),
            );
          }
          if (requiredOrchestrationDiagnostics.length > 0) {
            refinementHints.push(
              buildExplicitSubagentOrchestrationRefinementHint(
                explicitOrchestrationRequirements!,
                requiredOrchestrationDiagnostics,
              ),
            );
          }
          if (explicitToolDiagnostics.length > 0) {
            refinementHints.push(
              buildExplicitDeterministicToolRefinementHint(
                explicitDeterministicToolRequirements!,
                explicitToolDiagnostics,
              ),
            );
          }
          refinementHint = refinementHints.join(" ");
          const plannerRetryCode =
            requiredOrchestrationDiagnostics.length > 0
              ? "planner_required_orchestration_retry"
              : explicitToolDiagnostics.length > 0
                ? "planner_explicit_tool_retry"
                : verificationRequirementDiagnostics.length > 0
                  ? "planner_verification_requirements_retry"
                : plannerStepContractDiagnostics.length > 0
                  ? "planner_step_contract_retry"
                : "planner_refinement_retry";
          const plannerRetryMessage =
            requiredOrchestrationDiagnostics.length > 0
              ? "Planner did not satisfy the user-required sub-agent orchestration plan; requesting a refined plan"
              : explicitToolDiagnostics.length > 0
                ? "Planner drifted outside the explicitly requested deterministic tool contract; requesting a refined plan"
                : verificationRequirementDiagnostics.length > 0
                  ? "Planner dropped one or more user-requested verification modes; requesting a refined plan"
                : plannerStepContractDiagnostics.length > 0
                  ? "Planner emitted steps that violate runtime tool contracts; requesting a refined plan"
                : "Planner emitted structural delegation violations; requesting a refined plan";
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: plannerRetryCode,
            message: plannerRetryMessage,
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
                maxAttempts: maxPlannerAttempts,
                progressRetry: canUseProgressStructuralRetry ? "true" : "false",
                decompositionRetry: canUseDecompositionRetry ? "true" : "false",
              },
            });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: plannerRetryCode,
            graphDiagnostics,
            decompositionGraphDiagnostics,
            plannerStepContractDiagnostics,
            verificationRequirementDiagnostics,
            requestedVerificationCategories: explicitVerificationRequirements,
            requestedVerificationCommands: explicitVerificationCommandRequirements,
            requiredOrchestrationDiagnostics,
            explicitToolDiagnostics,
            decompositionRetry: canUseDecompositionRetry,
          });
          continue;
        }
        if (requiredOrchestrationDiagnostics.length > 0) {
          ctx.plannerSummaryState.routeReason =
            "planner_required_orchestration_unmet";
          this.setStopReason(
            ctx,
            "validation_error",
            "Planner did not satisfy the user-required sub-agent orchestration plan",
          );
          ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
            explicitOrchestrationRequirements!,
            requiredOrchestrationDiagnostics,
          );
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }
        if (verificationRequirementDiagnostics.length > 0) {
          ctx.plannerSummaryState.routeReason =
            "planner_verification_requirements_unmet";
          this.setStopReason(
            ctx,
            "validation_error",
            "Planner did not preserve the user-requested verification coverage",
          );
          ctx.finalContent =
            buildPlannerVerificationRequirementsFailureMessage(
              explicitVerificationRequirements,
              verificationRequirementDiagnostics,
            );
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }
        if (explicitToolDiagnostics.length > 0) {
          ctx.plannerSummaryState.routeReason =
            "planner_explicit_tool_requirements_unmet";
          this.setStopReason(
            ctx,
            "validation_error",
            "Planner did not satisfy the user-required deterministic tool plan",
          );
          ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
            explicitDeterministicToolRequirements!,
            explicitToolDiagnostics,
          );
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }
        ctx.plannerSummaryState.routeReason =
          explicitToolDiagnostics.length > 0
            ? "planner_explicit_tool_requirements_unmet"
            : "planner_validation_failed";
      } else if (plannerPlan.reason) {
        ctx.plannerSummaryState.routeReason = plannerPlan.reason;
      }

      this.emitPlannerTrace(ctx, "planner_plan_parsed", {
        attempt: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        requiresSynthesis: plannerPlan.requiresSynthesis === true,
        totalSteps: plannerPlan.steps.length,
        deterministicSteps: plannerPlan.steps.filter((step) =>
          step.stepType === "deterministic_tool"
        ).length,
        subagentSteps: plannerPlan.steps.filter((step) =>
          step.stepType === "subagent_task"
        ).length,
        synthesisSteps: plannerPlan.steps.filter((step) =>
          step.stepType === "synthesis"
        ).length,
        graphDiagnostics,
        plannerStepContractDiagnostics,
        verificationRequirementDiagnostics,
        requestedVerificationCategories: explicitVerificationRequirements,
        requiredOrchestrationDiagnostics,
        explicitToolDiagnostics,
        steps: plannerPlan.steps.map((step) => ({ ...step })),
        edges: plannerPlan.edges.map((edge) => ({ ...edge })),
      });

      ctx.plannerSummaryState.plannedSteps = plannerPlan.steps.length;
      ctx.plannedSubagentSteps = plannerPlan.steps.filter(
        (step) => step.stepType === "subagent_task",
      ).length;
      ctx.plannedDeterministicSteps = plannerPlan.steps.filter(
        (step) => step.stepType === "deterministic_tool",
      ).length;
      ctx.plannedSynthesisSteps = plannerPlan.steps.filter(
        (step) => step.stepType === "synthesis",
      ).length;
      ctx.plannedFanout = ctx.plannedSubagentSteps;
      ctx.plannedDependencyDepth = computePlannerGraphDepth(
        plannerPlan.steps.map((step) => step.name),
        plannerPlan.edges,
      ).maxDepth;

      const subagentSteps = plannerPlan.steps.filter(
        (step): step is PlannerSubAgentTaskStepIntent =>
          step.stepType === "subagent_task",
      );
      let delegationDecision: ReturnType<
        typeof assessAndRecordDelegationDecision
      > | undefined;
      if (subagentSteps.length > 0) {
        const highRiskPlan = isHighRiskSubagentPlan(subagentSteps);
        ctx.trajectoryContextClusterId = deriveDelegationContextClusterId({
          complexityScore: ctx.plannerDecision.score,
          subagentStepCount: subagentSteps.length,
          hasHistory: ctx.hasHistory,
          highRiskPlan,
        });

        const banditResult = resolveDelegationBanditArm(
          this.delegationBanditTuner,
          ctx.trajectoryContextClusterId,
          this.delegationDefaultStrategyArmId,
          ctx.baseDelegationThreshold,
        );
        ctx.selectedBanditArm = banditResult.selectedArm;
        ctx.tunedDelegationThreshold = banditResult.tunedThreshold;
        ctx.plannerSummaryState.delegationPolicyTuning = banditResult.policyTuning;

        delegationDecision = assessAndRecordDelegationDecision(
          {
            messageText: ctx.messageText,
            plannerPlan,
            subagentSteps,
            complexityScore: ctx.plannerDecision.score,
            tunedThreshold: ctx.tunedDelegationThreshold,
            delegationConfig: this.delegationDecisionConfig,
          },
          ctx.plannerSummaryState,
        );
        if (
          explicitOrchestrationRequirements &&
          delegationDecision &&
          !delegationDecision.shouldDelegate
        ) {
          delegationDecision = {
            ...delegationDecision,
            shouldDelegate: true,
            reason: "approved",
          };
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "delegation_required_by_user",
            message:
              "User explicitly required sub-agent orchestration; bypassing delegation utility veto",
            details: {
              requiredSteps:
                explicitOrchestrationRequirements.stepNames.join(","),
            },
          });
        }
      }
      const deterministicSteps = plannerPlan.steps.filter(
        (step): step is PlannerDeterministicToolStepIntent =>
          step.stepType === "deterministic_tool",
      );
      const hasSynthesisStep = plannerPlan.steps.some(
        (step) => step.stepType === "synthesis",
      );
      const plannerPipelineSteps = mapPlannerStepsToPipelineSteps(
        plannerPlan.steps,
      );
      const plannerExecutionContext = buildPlannerExecutionContext(
        ctx.messageText,
        ctx.history,
        ctx.messages,
        ctx.messageSections,
        ctx.expandedRoutedToolNames.length > 0
          ? ctx.expandedRoutedToolNames
          : ctx.activeRoutedToolNames.length > 0
          ? ctx.activeRoutedToolNames
          : (this.allowedTools ? [...this.allowedTools] : undefined),
      );
      const hasExecutablePlannerSteps =
        (
          deterministicSteps.length > 0 &&
          (
            subagentSteps.length === 0 ||
            delegationDecision?.shouldDelegate === true
          )
        ) ||
        (
          subagentSteps.length > 0 &&
          delegationDecision?.shouldDelegate === true
        );

      if (
        hasExecutablePlannerSteps &&
        ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
        ctx.plannerSummaryState.routeReason !==
          "planner_explicit_tool_requirements_unmet"
      ) {
        if (deterministicSteps.length > ctx.effectiveToolBudget) {
          this.setStopReason(
            ctx,
            "budget_exceeded",
            `Planner produced ${deterministicSteps.length} deterministic steps but tool budget is ${ctx.effectiveToolBudget}`,
          );
          ctx.finalContent =
            `Planned ${deterministicSteps.length} deterministic steps, ` +
            `but request tool budget is ${ctx.effectiveToolBudget}.`;
          this.emitPlannerTrace(ctx, "planner_path_finished", {
            plannerCalls: plannerAttempt,
            routeReason: ctx.plannerSummaryState.routeReason,
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            diagnostics: ctx.plannerSummaryState.diagnostics,
            handled: true,
          });
          ctx.plannerHandled = true;
          return;
        }

        const pipeline: Pipeline = {
          id: `planner:${ctx.sessionId}:${Date.now()}`,
          createdAt: Date.now(),
          context: { results: {} },
          steps: deterministicSteps.map((step) => ({
            name: step.name,
            tool: step.tool,
            args: step.args,
            onError: step.onError,
            maxRetries: step.maxRetries,
          })),
          plannerSteps: plannerPipelineSteps,
          edges: plannerPlan.edges,
          maxParallelism: this.delegationDecisionConfig.maxFanoutPerTurn,
          plannerContext: plannerExecutionContext,
        };

        this.emitPlannerTrace(ctx, "planner_pipeline_started", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          routeReason: ctx.plannerSummaryState.routeReason,
          deterministicSteps: deterministicSteps.map((step) => ({
            name: step.name,
            tool: step.tool,
            onError: step.onError ?? "abort",
            maxRetries: step.maxRetries ?? 0,
          })),
          delegatedSteps: subagentSteps.map((step) => step.name),
        });

        const shouldRunSubagentVerifier =
          subagentSteps.length > 0 &&
          delegationDecision?.shouldDelegate === true &&
          (
            this.subagentVerifierConfig.enabled ||
            this.subagentVerifierConfig.force
          );
        const {
          verifierRounds,
          verificationDecision,
          pipelineResult,
        } = await executePlannerPipelineWithVerifierLoop({
          pipeline,
          plannerPlan,
          subagentSteps,
          deterministicSteps,
          plannerExecutionContext,
          shouldRunSubagentVerifier,
          verifierConfig: this.subagentVerifierConfig,
          plannerSummaryState: ctx.plannerSummaryState,
          checkRequestTimeout: (stage: string) => this.checkRequestTimeout(ctx, stage),
          runPipelineWithGlobalTimeout: (p: Pipeline) => this.runPipelineWithTimeout(ctx, p),
          runSubagentVerifierRound: (input) =>
            runSubagentVerifierRound({
              systemPrompt: ctx.systemPrompt,
              messageText: ctx.messageText,
              sessionId: ctx.sessionId,
              stateful: ctx.stateful,
              plannerDiagnostics: ctx.plannerSummaryState.diagnostics,
              plannerPlan: input.plannerPlan,
              subagentSteps: input.subagentSteps,
              pipelineResult: input.pipelineResult,
              plannerContext: input.plannerContext,
              round: input.round,
              callModelForPhase: (phaseInput) => this.callModelForPhase(ctx, phaseInput),
            }),
          onVerifierRoundFinished: (payload) =>
            this.emitPlannerTrace(
              ctx,
              "planner_verifier_round_finished",
              payload,
            ),
          onVerifierRetryScheduled: (payload) =>
            this.emitPlannerTrace(
              ctx,
              "planner_verifier_retry_scheduled",
              payload,
            ),
          appendToolRecord: (record: ToolCallRecord) => this.appendToolRecord(ctx, record),
          setStopReason: (reason: LLMPipelineStopReason, detail?: string) => this.setStopReason(ctx, reason, detail),
        });

        if (
          shouldRunSubagentVerifier &&
          verifierRounds === 0 &&
          !ctx.plannerSummaryState.subagentVerification.performed
        ) {
          ctx.plannerSummaryState.subagentVerification = {
            enabled: true,
            performed: false,
            rounds: 0,
            overall: "skipped",
            confidence: 1,
            unresolvedItems: [],
          };
        }

        if (
          pipelineResult?.decomposition &&
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildPipelineDecompositionRefinementHint(
            pipelineResult.decomposition,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_runtime_refinement_retry",
            message:
              "Delegated execution requested parent-side decomposition; replanning with smaller steps",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
            attempt: plannerAttempt,
            pipelineId: pipeline.id,
            status: pipelineResult.status,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            decomposition: pipelineResult.decomposition,
            verificationDecision,
          });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_runtime_refinement_retry",
            decomposition: pipelineResult.decomposition,
          });
          continue;
        }

        const runtimeRepairFailureSignature = pipelineResult
          ? buildPipelineFailureSignature(pipelineResult)
          : undefined;
        const runtimeRepairSignatureSeen =
          runtimeRepairFailureSignature !== undefined &&
          seenRuntimeRepairFailureSignatures.has(runtimeRepairFailureSignature);
        const shouldRetryFailedPipelineWithRepairPlan =
          pipelineResult?.status === "failed" &&
          plannerAttempt < maxPlannerAttempts &&
          pipelineResult.completedSteps > 0 &&
          !runtimeRepairSignatureSeen &&
          (
            pipelineResult.stopReasonHint === "tool_error" ||
            pipelineResult.stopReasonHint === "validation_error" ||
            pipelineResult.stopReasonHint === "no_progress" ||
            pipelineResult.stopReasonHint === undefined
          );

        if (
          pipelineResult &&
          shouldRetryFailedPipelineWithRepairPlan
        ) {
          if (runtimeRepairFailureSignature) {
            seenRuntimeRepairFailureSignatures.add(runtimeRepairFailureSignature);
          }
          refinementHint = buildPipelineFailureRepairRefinementHint({
            pipelineResult,
            plannerPlan,
          });
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_runtime_repair_retry",
            message:
              "Deterministic verification failed after partial planner execution; requesting a repair-focused replan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
              completedSteps: pipelineResult.completedSteps,
              totalSteps: pipelineResult.totalSteps,
              stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
            },
          });
          this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
            attempt: plannerAttempt,
            pipelineId: pipeline.id,
            status: pipelineResult.status,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            error: pipelineResult.error,
            stopReasonHint: pipelineResult.stopReasonHint,
            decomposition: pipelineResult.decomposition,
            verificationDecision,
          });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_runtime_repair_retry",
            stopReasonHint: pipelineResult.stopReasonHint,
            error: pipelineResult.error,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
          });
          continue;
        }

        if (pipelineResult && runtimeRepairSignatureSeen) {
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_runtime_repair_stalled",
            message:
              "Deterministic verification repeated the same failure signature after a repair-focused replan; stopping additional repair retries",
            details: {
              attempt: plannerAttempt,
              completedSteps: pipelineResult.completedSteps,
              totalSteps: pipelineResult.totalSteps,
              stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
            },
          });
        }

        if (pipelineResult) {
          this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
            attempt: plannerAttempt,
            pipelineId: pipeline.id,
            status: pipelineResult.status,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            error: pipelineResult.error,
            stopReasonHint: pipelineResult.stopReasonHint,
            decomposition: pipelineResult.decomposition,
            verificationDecision,
          });
        } else {
          this.emitPlannerTrace(ctx, "planner_pipeline_finished", {
            attempt: plannerAttempt,
            pipelineId: pipeline.id,
            status: "timeout",
            stopReason: ctx.stopReason,
            stopReasonDetail: ctx.stopReasonDetail,
            verificationDecision,
          });
        }

        if (pipelineResult) {
          if (pipelineResult.status === "failed") {
            const hintedStopReason = isPipelineStopReasonHint(
              pipelineResult.stopReasonHint,
            )
              ? pipelineResult.stopReasonHint
              : "tool_error";
            this.setStopReason(
              ctx,
              hintedStopReason,
              pipelineResult.error ??
                "Deterministic pipeline execution failed",
            );
          } else if (pipelineResult.status === "halted") {
            this.setStopReason(
              ctx,
              "tool_calls",
              `Deterministic pipeline halted at step ${
                (pipelineResult.resumeFrom ?? 0) + 1
              } awaiting approval`,
            );
          }
        } else if (ctx.stopReason === "completed") {
          this.setStopReason(
            ctx,
            "timeout",
            this.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
          );
        }

        if (ctx.failedToolCalls > ctx.effectiveFailureBudget) {
          this.setStopReason(
            ctx,
            "tool_error",
            `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget}) during deterministic pipeline execution`,
          );
        }

        let plannerFinalizationStrategy: string | undefined;
        if (
          pipelineResult &&
          !pipelineResult.decomposition &&
          ctx.stopReason === "completed" &&
          explicitDeterministicToolRequirements?.exactResponseLiteral
        ) {
          ctx.finalContent =
            explicitDeterministicToolRequirements.exactResponseLiteral;
          plannerFinalizationStrategy = "exact_response_literal";
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_exact_response_literal_applied",
            message:
              "Completed deterministic plan satisfied the explicit exact-response contract without planner synthesis",
            details: {
              literal:
                explicitDeterministicToolRequirements.exactResponseLiteral,
            },
          });
        }

        if (
          pipelineResult &&
          !pipelineResult.decomposition &&
          !ctx.finalContent &&
          (
            plannerPlan.requiresSynthesis ||
            hasSynthesisStep ||
            explicitOrchestrationRequirements?.requiresSynthesis === true ||
            ctx.stopReason !== "completed"
          )
        ) {
          const synthesisMessages = buildPlannerSynthesisMessages(
            ctx.systemPrompt,
            ctx.messageText,
            plannerPlan,
            pipelineResult,
            verificationDecision,
          );
          const synthesisSections: PromptBudgetSection[] = [
            "system_anchor",
            "system_runtime",
            "user",
          ];
          const stopReasonBeforeSynthesis = ctx.stopReason;
          const stopReasonDetailBeforeSynthesis = ctx.stopReasonDetail;
          try {
            const synthesisResponse = await this.callModelForPhase(ctx, {
              phase: "planner_synthesis",
              callMessages: synthesisMessages,
              callSections: synthesisSections,
              onStreamChunk: ctx.activeStreamCallback,
              statefulSessionId: ctx.sessionId,
              statefulResumeAnchor: ctx.stateful?.resumeAnchor,
              statefulHistoryCompacted: ctx.stateful?.historyCompacted,
              routedToolNames: [],
              toolChoice: "none",
              budgetReason:
                "Planner synthesis blocked by max model recalls per request budget",
            });
            if (synthesisResponse) {
              ctx.response = synthesisResponse;
              ctx.finalContent = ensureSubagentProvenanceCitations(
                synthesisResponse.content,
                plannerPlan,
                pipelineResult,
              );
            }
          } catch (error) {
            if (
              pipelineResult.status === "completed" &&
              stopReasonBeforeSynthesis === "completed"
            ) {
              const failureDetail =
                typeof (error as { stopReasonDetail?: unknown })?.stopReasonDetail === "string"
                  ? String((error as { stopReasonDetail: string }).stopReasonDetail)
                  : error instanceof Error
                    ? error.message
                    : String(error);
              ctx.stopReason = stopReasonBeforeSynthesis;
              ctx.stopReasonDetail = stopReasonDetailBeforeSynthesis;
              ctx.plannerSummaryState.diagnostics.push({
                category: "runtime",
                code: "planner_synthesis_fallback_applied",
                message:
                  "Planner synthesis failed after the pipeline completed; returning a deterministic fallback summary",
                details: {
                  failureDetail,
                },
              });
              this.emitPlannerTrace(ctx, "planner_synthesis_fallback_applied", {
                failureDetail,
                completedSteps: pipelineResult.completedSteps,
                totalSteps: pipelineResult.totalSteps,
              });
              ctx.finalContent = buildPlannerSynthesisFallbackContent(
                plannerPlan,
                pipelineResult,
                verificationDecision,
                verifierRounds,
                failureDetail,
              );
            } else {
              throw error;
            }
          }
        } else if (pipelineResult?.decomposition && !ctx.finalContent) {
          ctx.finalContent =
            pipelineResult.error ??
            pipelineResult.decomposition.reason;
        }

        if (!ctx.finalContent) {
          ctx.finalContent =
            generateFallbackContent(ctx.allToolCalls) ??
            summarizeToolCalls(
              ctx.allToolCalls.filter((call) => !call.isError),
            );
        }
        this.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
          ...(plannerFinalizationStrategy
            ? { finalizationStrategy: plannerFinalizationStrategy }
            : {}),
          deterministicStepsExecuted:
            ctx.plannerSummaryState.deterministicStepsExecuted,
        });
        ctx.plannerHandled = true;
        return;
      }

      if (
        !delegationDecision ||
        delegationDecision.shouldDelegate
      ) {
        if (
          ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
          ctx.plannerSummaryState.routeReason !==
            "planner_explicit_tool_requirements_unmet"
        ) {
          ctx.plannerSummaryState.routeReason = "planner_no_deterministic_steps";
        }
      }
      if (ctx.plannerSummaryState.routeReason === "planner_validation_failed") {
        this.setStopReason(
          ctx,
          "validation_error",
          "Planner emitted a structured plan that failed local validation",
        );
        ctx.finalContent = buildPlannerValidationFailureMessage(
          latestPlannerValidationDiagnostics.length > 0
            ? latestPlannerValidationDiagnostics
            : ctx.plannerSummaryState.diagnostics,
        );
        this.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          latestDiagnostics: latestPlannerValidationDiagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      this.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: false,
      });
      return;
    }
  }

  /** Get accumulated token usage for a session. */
  getSessionTokenUsage(sessionId: string): number {
    return this.sessionTokens.get(sessionId) ?? 0;
  }

  /** Reset token usage for a specific session. */
  resetSessionTokens(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
    this.toolFailureBreaker.clearSession(sessionId);
    for (const provider of this.providers) {
      provider.resetSessionState?.(sessionId);
    }
  }

  /** Clear all session token tracking. */
  clearAllSessionTokens(): void {
    this.sessionTokens.clear();
    this.toolFailureBreaker.clearAll();
    for (const provider of this.providers) {
      provider.clearSessionState?.();
    }
  }

  /** Clear all provider cooldowns. */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async callWithFallback(
    messages: readonly LLMMessage[],
    onStreamChunk?: StreamProgressCallback,
    messageSections?: readonly PromptBudgetSection[],
    options?: {
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
    },
  ): Promise<FallbackResult> {
    const beforeBudget = estimatePromptShape(messages);
    const budgeted = applyPromptBudget(
      messages.map((message, index) => ({
        message,
        section: messageSections?.[index],
      })),
      this.promptBudget,
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
                    onProviderTraceEvent: (event) =>
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

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const now = Date.now();
      const cooldown = this.cooldowns.get(provider.name);

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
          const priorCooldown = this.cooldowns.get(provider.name);
          this.cooldowns.delete(provider.name);
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
          const retryRule = this.retryPolicyMatrix[failureClass];

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
            (this.cooldowns.get(provider.name)?.failures ?? 0) + 1;
          const cooldownDuration = computeProviderCooldownMs(
            failures,
            retryRule,
            lastError,
            this.cooldownMs,
            this.maxCooldownMs,
          );
          const availableAt = Date.now() + cooldownDuration;
          this.cooldowns.set(provider.name, {
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
        providers: buildActiveCooldownSnapshot(this.cooldowns, now),
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





  /** Extract plain-text content from a gateway message. */

  /**
   * Best-effort context injection. Supports both SkillInjector (`.inject()`)
   * and MemoryRetriever (`.retrieve()`) interfaces.
   */
  private async injectContext(
    ctx: ExecutionContext,
    provider: SkillInjector | MemoryRetriever | undefined,
    message: string,
    sessionId: string,
    messages: LLMMessage[],
    sections: PromptBudgetSection[],
    section: PromptBudgetSection,
  ): Promise<void> {
    if (!provider) return;
    const isSkillInjector = "inject" in provider;
    const providerKind = isSkillInjector ? "skill" : "memory";
    try {
      const detailedMemoryResult =
        providerKind === "memory" && isDetailedMemoryRetriever(provider)
          ? await provider.retrieveDetailed(message, sessionId)
          : undefined;
      const context =
        isSkillInjector
          ? await provider.inject(message, sessionId)
          : (detailedMemoryResult?.content ??
            await (provider as MemoryRetriever).retrieve(message, sessionId));
      const sectionMaxChars = this.getContextSectionMaxChars(section);
      const truncatedContext = typeof context === "string" && context.length > 0
        ? truncateText(context, sectionMaxChars)
        : undefined;
      if (truncatedContext) {
        messages.push({
          role: "system",
          content: truncatedContext,
        });
        sections.push(section);
      }
      this.emitExecutionTrace(ctx, {
        type: "context_injected",
        phase: "initial",
        callIndex: ctx.callIndex,
        payload: {
          providerKind,
          section,
          injected: Boolean(truncatedContext),
          originalChars: typeof context === "string" ? context.length : 0,
          injectedChars: typeof truncatedContext === "string"
            ? truncatedContext.length
            : 0,
          ...(detailedMemoryResult
            ? {
                curatedIncluded: detailedMemoryResult.curatedIncluded ?? false,
                estimatedTokens: detailedMemoryResult.estimatedTokens ?? 0,
                entries: (detailedMemoryResult.entries ?? []).slice(0, 8).map(
                  (entry) => ({
                    role: entry.role ?? "unknown",
                    source: entry.source ?? "unknown",
                    provenance: entry.provenance ?? "unknown",
                    score: typeof entry.combinedScore === "number"
                      ? Number(entry.combinedScore.toFixed(4))
                      : undefined,
                  }),
                ),
              }
            : {}),
        },
      });
    } catch {
      this.emitExecutionTrace(ctx, {
        type: "context_injected",
        phase: "initial",
        callIndex: ctx.callIndex,
        payload: {
          providerKind,
          section,
          injected: false,
          error: "context_injection_failed",
        },
      });
    }
  }

  private getContextSectionMaxChars(section: PromptBudgetSection): number {
    const roleContracts = this.promptBudget.memoryRoleContracts;
    const byRole = (role: "working" | "episodic" | "semantic"): number => {
      const maxChars = roleContracts?.[role]?.maxChars;
      if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
        return MAX_CONTEXT_INJECTION_CHARS;
      }
      return Math.max(256, Math.floor(maxChars));
    };

    switch (section) {
      case "memory_working":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("working"));
      case "memory_episodic":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("episodic"));
      case "memory_semantic":
        return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("semantic"));
      default:
        return MAX_CONTEXT_INJECTION_CHARS;
    }
  }

  private accumulateUsage(cumulative: LLMUsage, usage: LLMUsage): void {
    cumulative.promptTokens += usage.promptTokens;
    cumulative.completionTokens += usage.completionTokens;
    cumulative.totalTokens += usage.totalTokens;
  }

  private trackTokenUsage(sessionId: string, tokens: number): void {
    const current = this.sessionTokens.get(sessionId) ?? 0;

    // Delete-then-reinsert to maintain LRU order (most recent at end)
    this.sessionTokens.delete(sessionId);
    this.sessionTokens.set(sessionId, current + tokens);

    // Evict least-recently-used entries if over capacity
    if (this.sessionTokens.size > this.maxTrackedSessions) {
      const oldest = this.sessionTokens.keys().next().value;
      if (oldest !== undefined) {
        this.sessionTokens.delete(oldest);
        this.toolFailureBreaker.clearSession(oldest);
      }
    }
  }

  private createCallUsageRecord(input: {
    callIndex: number;
    phase: ChatCallUsageRecord["phase"];
    providerName: string;
    response: LLMResponse;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
    budgetDiagnostics?: PromptBudgetDiagnostics;
  }): ChatCallUsageRecord {
    return {
      callIndex: input.callIndex,
      phase: input.phase,
      provider: input.providerName,
      model: input.response.model,
      finishReason: input.response.finishReason,
      usage: input.response.usage,
      beforeBudget: input.beforeBudget,
      afterBudget: input.afterBudget,
      providerRequestMetrics: input.response.requestMetrics,
      budgetDiagnostics: input.budgetDiagnostics,
      statefulDiagnostics: input.response.stateful,
      compactionDiagnostics: input.response.compaction,
    };
  }

  // --------------------------------------------------------------------------
  // Response evaluation
  // --------------------------------------------------------------------------


  private async evaluateResponse(
    content: string,
    userMessage: string,
    trace?: ChatExecuteParams["trace"],
    nextCallIndex?: number,
  ): Promise<{
    score: number;
    feedback: string;
    response: LLMResponse;
    providerName: string;
    usedFallback: boolean;
    beforeBudget: ChatPromptShape;
    afterBudget: ChatPromptShape;
    budgetDiagnostics: PromptBudgetDiagnostics;
  }> {
    const rubric = this.evaluator?.rubric ?? DEFAULT_EVAL_RUBRIC;
    let fallbackResult: FallbackResult;
    try {
      fallbackResult = await this.callWithFallback([
        { role: "system", content: rubric },
        {
          role: "user",
          content: `User request: ${userMessage.slice(0, MAX_EVAL_USER_CHARS)}\n\nResponse: ${content.slice(0, MAX_EVAL_RESPONSE_CHARS)}`,
        },
      ], undefined, undefined, {
        ...(trace
          ? {
            trace,
            callIndex: nextCallIndex,
            callPhase: "evaluator" as const,
          }
          : {}),
      });
    } catch (error) {
      throw annotateFailureError(error, "response evaluation").error;
    }
    const {
      response,
      providerName,
      usedFallback,
      beforeBudget,
      afterBudget,
      budgetDiagnostics,
    } = fallbackResult;
    try {
      const parsed = JSON.parse(response.content) as {
        score?: number;
        feedback?: string;
      };
      return {
        score:
          typeof parsed.score === "number"
            ? Math.max(0, Math.min(1, parsed.score))
            : 0.5,
        feedback:
          typeof parsed.feedback === "string" ? parsed.feedback : "",
        response,
        providerName,
        usedFallback,
        beforeBudget,
        afterBudget,
        budgetDiagnostics,
      };
    } catch {
      return {
        score: 1.0,
        feedback: "Evaluation parse failed — accepting response",
        response,
        providerName,
        usedFallback,
        beforeBudget,
        afterBudget,
        budgetDiagnostics,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Context compaction
  // --------------------------------------------------------------------------

  /** Max chars of history text sent to the summarization call. */

  private async compactHistory(
    history: readonly LLMMessage[],
    sessionId: string,
    trace?: ChatExecuteParams["trace"],
  ): Promise<LLMMessage[]> {
    if (history.length <= 5) return [...history];

    const keepCount = 5;
    const toSummarize = history.slice(0, history.length - keepCount);
    const toKeep = history.slice(-keepCount);

    let historyText = toSummarize
      .map((m) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter(
                  (p): p is { type: "text"; text: string } =>
                    p.type === "text",
                )
                .map((p) => p.text)
                .join(" ");
        return `[${m.role}] ${content.slice(0, 500)}`;
      })
      .join("\n");

    if (historyText.length > MAX_COMPACT_INPUT) {
      historyText = historyText.slice(-MAX_COMPACT_INPUT);
    }

    let compactResponse: FallbackResult;
    try {
      compactResponse = await this.callWithFallback([
        {
          role: "system",
          content:
            "Summarize this conversation history concisely. Preserve: key decisions made, " +
            "tool results and their outcomes, unresolved questions, and important context. " +
            "Omit pleasantries and redundant exchanges. Output only the summary.",
        },
        { role: "user", content: historyText },
      ], undefined, undefined, {
        ...(trace
          ? {
            trace,
            callIndex: 0,
            callPhase: "compaction" as const,
          }
          : {}),
      });
    } catch (error) {
      throw annotateFailureError(error, "history compaction").error;
    }

    const { response } = compactResponse;

    const summary = response.content;

    if (this.onCompaction) {
      try {
        this.onCompaction(sessionId, summary);
      } catch {
        /* non-blocking */
      }
    }

    return [
      {
        role: "system" as const,
        content: `[Conversation summary]\n${summary}`,
      },
      ...toKeep,
    ];
  }
}
