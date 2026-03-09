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
  LLMTimeoutError,
  classifyLLMFailure,
} from "./errors.js";
import {
  applyPromptBudget,
  type PromptBudgetConfig,
  type PromptBudgetDiagnostics,
  type PromptBudgetSection,
} from "./prompt-budget.js";
import { toPipelineStopReason } from "./policy.js";
import type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyMatrix,
  LLMRetryPolicyRule,
} from "./policy.js";
import type {
  Pipeline,
  PipelineExecutionEvent,
  PipelinePlannerContext,
  PipelineResult,
} from "../workflow/pipeline.js";
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
  SessionToolFailurePattern,
  SessionToolFailureCircuitState,
  FallbackResult,
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  PlannerPlan,
  SubagentVerifierDecision,
  ResolvedSubagentVerifierConfig,
  PlannerPipelineVerifierLoopInput,
  ToolLoopState,
  ToolCallAction,
  ExecutionContext,
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
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
  DEFAULT_MODEL_RECALLS_PER_REQUEST,
  DEFAULT_FAILURE_BUDGET_PER_REQUEST,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  DEFAULT_EVAL_RUBRIC,
  MAX_COMPACT_INPUT,
} from "./chat-executor-constants.js";
import {
  didToolCallFail,
  resolveRetryPolicyMatrix,
  enrichToolResultMetadata,
  checkToolCallPermission,
  normalizeToolCallArguments,
  parseToolCallArguments,
  executeToolWithRetry,
  trackToolCallFailureState,
  checkToolLoopStuckDetection,
  buildToolLoopRecoveryMessages,
  buildRoutingExpansionMessage,
} from "./chat-executor-tool-utils.js";

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
import type { RoundStuckState } from "./chat-executor-tool-utils.js";
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
  sanitizeToolCallsForReplay,
  buildPromptToolContent,
  appendUserMessage,
  generateFallbackContent,
  summarizeToolCalls,
  buildToolExecutionGroundingMessage,
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
  parsePlannerPlan,
  validatePlannerGraph,
  extractExplicitSubagentOrchestrationRequirements,
  validateExplicitSubagentOrchestrationRequirements,
  extractPlannerDecompositionDiagnostics,
  buildPlannerDecompositionRefinementHint,
  buildPipelineDecompositionRefinementHint,
  buildExplicitSubagentOrchestrationRefinementHint,
  buildExplicitSubagentOrchestrationFailureMessage,
  isHighRiskSubagentPlan,
  computePlannerGraphDepth,
  isPipelineStopReasonHint,
  buildPlannerSynthesisMessages,
  ensureSubagentProvenanceCitations,
  pipelineResultToToolCalls,
  resolveDelegationBanditArm,
  assessAndRecordDelegationDecision,
  mapPlannerStepsToPipelineSteps,
} from "./chat-executor-planner.js";
import {
  evaluateSubagentDeterministicChecks,
  buildSubagentVerifierMessages,
  parseSubagentVerifierDecision,
  mergeSubagentVerifierDecisions,
} from "./chat-executor-verifier.js";
import {
  getMissingSuccessfulToolEvidenceMessage,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import {
  type ToolContractGuidancePhase,
  resolveToolContractGuidance,
} from "./chat-executor-contract-guidance.js";
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
  private readonly toolFailureBreakerEnabled: boolean;
  private readonly toolFailureBreakerThreshold: number;
  private readonly toolFailureBreakerWindowMs: number;
  private readonly toolFailureBreakerCooldownMs: number;

  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly sessionTokens = new Map<string, number>();
  private readonly sessionToolFailureCircuits = new Map<
    string,
    SessionToolFailureCircuitState
  >();

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
    this.pipelineExecutor = config.pipelineExecutor;
    this.delegationDecisionConfig = resolveDelegationDecisionConfig(
      config.delegationDecision,
    );
    this.resolveDelegationScoreThreshold = config.resolveDelegationScoreThreshold;
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
    this.requestTimeoutMs = Math.max(
      1,
      Math.floor(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    );
    this.retryPolicyMatrix = resolveRetryPolicyMatrix(config.retryPolicyMatrix);
    this.toolFailureBreakerEnabled =
      config.toolFailureCircuitBreaker?.enabled ?? true;
    this.toolFailureBreakerThreshold = Math.max(
      2,
      Math.floor(
        config.toolFailureCircuitBreaker?.threshold ??
          DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
      ),
    );
    this.toolFailureBreakerWindowMs = Math.max(
      1_000,
      Math.floor(
        config.toolFailureCircuitBreaker?.windowMs ??
          DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
      ),
    );
    this.toolFailureBreakerCooldownMs = Math.max(
      1_000,
      Math.floor(
        config.toolFailureCircuitBreaker?.cooldownMs ??
          DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
      ),
    );
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
    );
    ctx.finalContent = reconcileStructuredToolOutcome(
      ctx.finalContent,
      ctx.allToolCalls,
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
  ): void {
    ctx.messages.push(nextMessage);
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
    return ctx.modelCalls - 1 < ctx.effectiveMaxModelRecalls;
  }

  private getRemainingRequestMs(ctx: ExecutionContext): number {
    return ctx.requestDeadlineAt - Date.now();
  }

  private getAllowedToolNamesForEvidence(ctx: ExecutionContext): readonly string[] {
    if (ctx.activeRoutedToolNames.length > 0) {
      return ctx.activeRoutedToolNames;
    }
    return this.allowedTools ? [...this.allowedTools] : [];
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
      | "planner_pipeline_started"
      | "planner_plan_parsed"
      | "planner_refinement_requested",
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
          ...(typeof event.error === "string"
            ? { error: event.error }
            : { result: event.result }),
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

  private resolveActiveToolContractGuidance(
    ctx: ExecutionContext,
    input?: {
      readonly phase?: ToolContractGuidancePhase;
      readonly allowedToolNames?: readonly string[];
      readonly validationCode?: DelegationOutputValidationCode;
    },
  ): {
    readonly source: string;
    readonly runtimeInstruction?: string;
    readonly routedToolNames?: readonly string[];
    readonly toolChoice: LLMToolChoice;
  } | undefined {
    return resolveToolContractGuidance({
      phase: input?.phase ?? "tool_followup",
      messageText: ctx.messageText,
      toolCalls: ctx.allToolCalls,
      allowedToolNames:
        input?.allowedToolNames ?? this.getAllowedToolNamesForEvidence(ctx),
      requiredToolEvidence: ctx.requiredToolEvidence,
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
      const responseContent =
        typeof ctx.response?.content === "string" ? ctx.response.content : "";
      const contractValidation = ctx.requiredToolEvidence.delegationSpec
        ? validateDelegatedOutputContract({
          spec: ctx.requiredToolEvidence.delegationSpec,
          output: responseContent,
          toolCalls: ctx.allToolCalls,
          providerEvidence: ctx.providerEvidence,
        })
        : undefined;
      const missingEvidenceMessage = contractValidation?.error ??
        getMissingSuccessfulToolEvidenceMessage(
          ctx.allToolCalls,
          ctx.requiredToolEvidence.delegationSpec,
          ctx.providerEvidence,
        );
      if (!missingEvidenceMessage) {
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

      if (
        ctx.requiredToolEvidenceCorrectionAttempts >=
        ctx.requiredToolEvidence.maxCorrectionAttempts
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
        this.setStopReason(ctx, "validation_error", missingEvidenceMessage);
        ctx.finalContent = missingEvidenceMessage;
        return "failed";
      }

      const correctionAllowedTools = this.allowedTools
        ? [...this.allowedTools]
        : this.getAllowedToolNamesForEvidence(ctx);
      const allowedToolSummary = correctionAllowedTools.length > 0
        ? ` Allowed tools: ${correctionAllowedTools.join(", ")}.`
        : "";
      const correctionLines = [
        "Tool-grounded evidence is required for this delegated task.",
        "Before answering, call one or more allowed tools and base the answer on those results.",
        "Do not answer from memory or restate the plan.",
      ];
      if (
        contractValidation?.code === "low_signal_browser_evidence" ||
        /browser-grounded evidence/i.test(missingEvidenceMessage)
      ) {
        correctionLines.push(
          "Use concrete non-blank URLs or localhost targets with browser navigation plus snapshot/run_code. `browser_tabs` and about:blank state checks do not count.",
        );
      }
      if (
        contractValidation?.code === "expected_json_object" ||
        contractValidation?.code === "empty_structured_payload"
      ) {
        correctionLines.push(
          "Your final answer must be a single JSON object only, with no markdown fences or prose around it.",
        );
      }
      if (
        contractValidation?.code === "missing_file_mutation_evidence" ||
        /file creation\/edit evidence|file mutation tools/i.test(
          missingEvidenceMessage,
        )
      ) {
        correctionLines.push(
          "Create or edit the required files with the allowed file-mutation tools before answering, and name those files in the final output.",
        );
      }
      const retryInstruction =
        "Delegated output validation failed. " +
        `${missingEvidenceMessage}. ` +
        correctionLines.join(" ") +
        allowedToolSummary;

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
        },
      });

      const correctionContractGuidance = this.resolveActiveToolContractGuidance(
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
        toolChoice: correctionContractGuidance?.toolChoice ?? "required",
        ...((correctionContractGuidance?.routedToolNames?.length ?? 0) > 0
          ? {
            routedToolNames: correctionContractGuidance!.routedToolNames,
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

  private async callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: LLMStatefulResumeAnchor;
      routedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined> {
    if (!this.hasModelRecallBudget(ctx)) {
      this.setStopReason(ctx, "budget_exceeded", input.budgetReason);
      return undefined;
    }
    if (this.checkRequestTimeout(ctx, `${input.phase} model call`)) {
      return undefined;
    }
    const effectiveRoutedToolNames = input.routedToolNames !== undefined
      ? input.routedToolNames
      : ctx.toolRouting
      ? ctx.activeRoutedToolNames
      : (this.allowedTools ? [...this.allowedTools] : undefined);
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
        routedToolNames: effectiveRoutedToolNames ?? [],
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
          ...(input.statefulSessionId
            ? {
              statefulSessionId: input.statefulSessionId,
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
      const annotated = this.annotateFailureError(
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
      const annotated = this.annotateFailureError(
        error,
        "planner pipeline execution",
      );
      this.setStopReason(ctx, annotated.stopReason, annotated.stopReasonDetail);
      throw annotated.error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async runSubagentVerifier(
    ctx: ExecutionContext,
    input: {
      plannerPlan: PlannerPlan;
      subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
      pipelineResult: PipelineResult;
      plannerContext: PipelinePlannerContext;
      round: number;
    },
  ): Promise<SubagentVerifierDecision> {
    const deterministic = evaluateSubagentDeterministicChecks(
      input.subagentSteps,
      input.pipelineResult,
      input.plannerContext,
    );
    const verifierMessages = buildSubagentVerifierMessages(
      ctx.systemPrompt,
      ctx.messageText,
      input.plannerPlan,
      input.subagentSteps,
      input.pipelineResult,
      input.plannerContext,
      deterministic,
    );
    const verifierSections: PromptBudgetSection[] = [
      "system_anchor",
      "system_runtime",
      "user",
    ];
    const verifierResponse = await this.callModelForPhase(ctx, {
      phase: "planner_verifier",
      callMessages: verifierMessages,
      callSections: verifierSections,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      budgetReason:
        "Planner verifier blocked by max model recalls per request budget",
    });
    if (!verifierResponse) {
      return deterministic;
    }
    const modelDecision = parseSubagentVerifierDecision(
      verifierResponse.content,
      input.subagentSteps,
    );
    if (!modelDecision) {
      ctx.plannerSummaryState.diagnostics.push({
        category: "parse",
        code: "subagent_verifier_parse_failed",
        message:
          "Sub-agent verifier returned non-JSON or malformed schema; using deterministic verifier fallback",
        details: {
          round: input.round,
        },
      });
      return deterministic;
    }
    return mergeSubagentVerifierDecisions(
      deterministic,
      modelDecision,
    );
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
    const plannerDecision = assessPlannerDecision(this.plannerEnabled, messageText, history);
    const initialRoutedToolNames = params.toolRouting?.routedToolNames
      ? Array.from(new Set(params.toolRouting.routedToolNames))
      : [];
    const expandedRoutedToolNames = params.toolRouting?.expandedToolNames
      ? Array.from(new Set(params.toolRouting.expandedToolNames))
      : [];
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
        requestTimeoutMs: Math.max(
          1,
          Math.floor(params.requestTimeoutMs ?? this.requestTimeoutMs),
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
        this.memoryRetriever,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_semantic",
      );
      await this.injectContext(
        this.learningProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_episodic",
      );
      await this.injectContext(
        this.progressProvider,
        ctx.messageText,
        ctx.sessionId,
        ctx.messages,
        ctx.messageSections,
        "memory_working",
      );
    }

    // Append history and user message
    for (const historicalMessage of normalizeHistory(ctx.history)) {
      this.pushMessage(ctx, historicalMessage, "history");
    }

    appendUserMessage(ctx.messages, ctx.messageSections, ctx.message);

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
        const annotated = this.annotateFailureError(
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
    const initialContractGuidance = this.resolveActiveToolContractGuidance(ctx, {
      phase: "initial",
    });
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
      (ctx.requiredToolEvidence ? "required" : undefined);
    const initialRoutedToolNames =
      initialContractGuidance?.routedToolNames;
    ctx.response = await this.callModelForPhase(ctx, {
      phase: "initial",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      statefulResumeAnchor: ctx.stateful?.resumeAnchor,
      ...((initialToolChoice !== undefined || initialRoutedToolNames !== undefined)
        ? {
          ...(initialToolChoice !== undefined
            ? { toolChoice: initialToolChoice }
            : {}),
          ...(initialRoutedToolNames !== undefined
            ? { routedToolNames: initialRoutedToolNames }
            : {}),
        }
        : {}),
      budgetReason:
        "Initial completion blocked by max model recalls per request budget",
    });
    const initialEvidenceAction =
      await this.enforceRequiredToolEvidenceBeforeCompletion(ctx, "initial");
    if (initialEvidenceAction === "failed" && !ctx.finalContent) {
      ctx.finalContent = ctx.response?.content ?? ctx.finalContent;
    }

    let rounds = 0;
    const emittedRecoveryHints = new Set<string>();
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
      rounds < ctx.effectiveMaxToolRounds
    ) {
      if (ctx.signal?.aborted) {
        this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
        break;
      }
      if (this.checkRequestTimeout(ctx, "tool loop")) break;
      const activeCircuit = this.getActiveToolFailureCircuit(ctx.sessionId);
      if (activeCircuit) {
        this.setStopReason(ctx, "no_progress", activeCircuit.reason);
        break;
      }

      rounds++;
      const roundToolCallStart = ctx.allToolCalls.length;
      loopState.activeRoutedToolSet = ctx.activeRoutedToolNames.length > 0
        ? new Set(ctx.activeRoutedToolNames)
        : null;
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
        this.setStopReason(ctx, "no_progress", stuckResult.reason);
        break;
      }

      // Recovery hints.
      const recoveryHints = buildRecoveryHints(roundCalls, emittedRecoveryHints);
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
        ctx.activeRoutedToolNames = ctx.expandedRoutedToolNames;
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
        ...(followupContractGuidance
          ? {
            toolChoice: followupContractGuidance.toolChoice,
            ...(followupContractGuidance.routedToolNames
              ? { routedToolNames: followupContractGuidance.routedToolNames }
              : {}),
          }
          : {}),
        budgetReason:
          "Max model recalls exceeded while following up after tool calls",
      });
      if (!nextResponse) break;
      ctx.response = nextResponse;
      const evidenceAction =
        await this.enforceRequiredToolEvidenceBeforeCompletion(
          ctx,
          "tool_followup",
        );
      if (evidenceAction === "failed") break;
    }

    if (ctx.signal?.aborted) {
      this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
    } else if (
      ctx.response &&
      ctx.response.finishReason === "tool_calls" &&
      rounds >= ctx.effectiveMaxToolRounds
    ) {
      this.setStopReason(
        ctx,
        "tool_calls",
        `Reached max tool rounds (${ctx.effectiveMaxToolRounds})`,
      );
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
    const args = normalizeToolCallArguments(toolCall.name, parseResult.args);
    this.emitExecutionTrace(ctx, {
      type: "tool_dispatch_started",
      phase: "tool_followup",
      callIndex: ctx.callIndex,
      payload: {
        tool: toolCall.name,
        args,
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

    if (this.toolFailureBreakerEnabled && exec.toolFailed) {
      const failKey = buildSemanticToolCallKey(toolCall.name, args);
      const circuitReason = this.recordToolFailurePattern(
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
    if (!exec.toolFailed && this.toolFailureBreakerEnabled) {
      this.clearToolFailurePattern(ctx.sessionId, semanticToolKey);
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
    let refinementHint: string | undefined;

    for (
      let plannerAttempt = 1;
      plannerAttempt <= DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS;
      plannerAttempt++
    ) {
      const plannerMessages = buildPlannerMessages(
        ctx.messageText,
        ctx.history,
        this.plannerMaxTokens,
        refinementHint,
      );
      const plannerResponse = await this.callModelForPhase(ctx, {
        phase: "planner",
        callMessages: plannerMessages,
        callSections: plannerSections,
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

      const plannerParse = parsePlannerPlan(
        plannerResponse.content,
        explicitOrchestrationRequirements,
      );
      ctx.plannerSummaryState.diagnostics.push(...plannerParse.diagnostics);
      const plannerPlan = plannerParse.plan;
      if (!plannerPlan) {
        if (explicitOrchestrationRequirements) {
          if (plannerAttempt < DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS) {
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
                maxAttempts: DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
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
      const decompositionDiagnostics = extractPlannerDecompositionDiagnostics(
        graphDiagnostics,
      );
      const requiredOrchestrationDiagnostics =
        explicitOrchestrationRequirements
          ? validateExplicitSubagentOrchestrationRequirements(
              plannerPlan,
              explicitOrchestrationRequirements,
            )
          : [];
      const shouldRefinePlan =
        (
          decompositionDiagnostics.length > 0 ||
          requiredOrchestrationDiagnostics.length > 0
        ) &&
        plannerAttempt < DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS;
      if (
        graphDiagnostics.length > 0 ||
        requiredOrchestrationDiagnostics.length > 0
      ) {
        ctx.plannerSummaryState.diagnostics.push(...graphDiagnostics);
        ctx.plannerSummaryState.diagnostics.push(
          ...requiredOrchestrationDiagnostics,
        );
        if (shouldRefinePlan) {
          const refinementHints: string[] = [];
          if (decompositionDiagnostics.length > 0) {
            refinementHints.push(
              buildPlannerDecompositionRefinementHint(
                decompositionDiagnostics,
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
          refinementHint = refinementHints.join(" ");
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code:
              requiredOrchestrationDiagnostics.length > 0
                ? "planner_required_orchestration_retry"
                : "planner_refinement_retry",
            message:
              requiredOrchestrationDiagnostics.length > 0
                ? "Planner did not satisfy the user-required sub-agent orchestration plan; requesting a refined plan"
                : "Planner emitted overloaded delegated steps; requesting a smaller refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
            },
          });
          this.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason:
              requiredOrchestrationDiagnostics.length > 0
                ? "planner_required_orchestration_retry"
                : "planner_refinement_retry",
            graphDiagnostics,
            requiredOrchestrationDiagnostics,
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
        ctx.plannerSummaryState.routeReason = "planner_validation_failed";
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
        requiredOrchestrationDiagnostics,
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
      const plannerPipelineSteps = mapPlannerStepsToPipelineSteps(
        plannerPlan.steps,
      );
      const plannerExecutionContext = buildPlannerExecutionContext(
        ctx.messageText,
        ctx.history,
        ctx.messages,
        ctx.messageSections,
        ctx.activeRoutedToolNames.length > 0
          ? ctx.activeRoutedToolNames
          : (this.allowedTools ? [...this.allowedTools] : undefined),
      );
      const hasExecutablePlannerSteps =
        deterministicSteps.length > 0 ||
        (
          subagentSteps.length > 0 &&
          delegationDecision?.shouldDelegate === true
        );

      if (
        hasExecutablePlannerSteps &&
        ctx.plannerSummaryState.routeReason !== "planner_validation_failed"
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
        } = await this.executePlannerPipelineWithVerifier({
          pipeline,
          plannerPlan,
          subagentSteps,
          deterministicSteps,
          plannerExecutionContext,
          shouldRunSubagentVerifier,
          plannerSummaryState: ctx.plannerSummaryState,
          checkRequestTimeout: (stage: string) => this.checkRequestTimeout(ctx, stage),
          runPipelineWithGlobalTimeout: (p: Pipeline) => this.runPipelineWithTimeout(ctx, p),
          runSubagentVerifierRound: (input) => this.runSubagentVerifier(ctx, input),
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
          plannerAttempt < DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS
        ) {
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
              maxAttempts: DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
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

        if (
          pipelineResult &&
          !pipelineResult.decomposition &&
          (
            plannerPlan.requiresSynthesis ||
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
          const synthesisResponse = await this.callModelForPhase(ctx, {
            phase: "planner_synthesis",
            callMessages: synthesisMessages,
            callSections: synthesisSections,
            onStreamChunk: ctx.activeStreamCallback,
            statefulSessionId: ctx.sessionId,
            statefulResumeAnchor: ctx.stateful?.resumeAnchor,
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
        if (ctx.plannerSummaryState.routeReason !== "planner_validation_failed") {
          ctx.plannerSummaryState.routeReason = "planner_no_deterministic_steps";
        }
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

  private async executePlannerPipelineWithVerifier(
    input: PlannerPipelineVerifierLoopInput,
  ): Promise<{
    verifierRounds: number;
    verificationDecision?: SubagentVerifierDecision;
    pipelineResult?: PipelineResult;
  }> {
    let verifierRounds = 0;
    let verificationDecision: SubagentVerifierDecision | undefined;
    let pipelineResult: PipelineResult | undefined;

    while (true) {
      if (input.checkRequestTimeout("planner pipeline execution")) break;
      const nextPipelineResult = await input.runPipelineWithGlobalTimeout(
        input.pipeline,
      );
      if (!nextPipelineResult) break;
      pipelineResult = nextPipelineResult;

      for (const record of pipelineResultToToolCalls(
        input.plannerPlan.steps,
        nextPipelineResult,
      )) {
        input.appendToolRecord(record);
      }
      input.plannerSummaryState.deterministicStepsExecuted =
        input.deterministicSteps.filter((step) =>
          typeof nextPipelineResult.context.results[step.name] === "string"
        ).length;

      if (
        !input.shouldRunSubagentVerifier ||
        nextPipelineResult.status !== "completed"
      ) {
        break;
      }

      verifierRounds++;
      verificationDecision = await input.runSubagentVerifierRound({
        plannerPlan: input.plannerPlan,
        subagentSteps: input.subagentSteps,
        pipelineResult: nextPipelineResult,
        plannerContext: input.plannerExecutionContext,
        round: verifierRounds,
      });
      input.plannerSummaryState.subagentVerification = {
        enabled: true,
        performed: true,
        rounds: verifierRounds,
        overall: verificationDecision.overall,
        confidence: verificationDecision.confidence,
        unresolvedItems: [...verificationDecision.unresolvedItems],
      };

      const belowConfidence =
        verificationDecision.confidence <
        this.subagentVerifierConfig.minConfidence;
      const retryable =
        verificationDecision.steps.some((step) => step.retryable);
      const canRetry =
        verifierRounds < this.subagentVerifierConfig.maxRounds &&
        (
          verificationDecision.overall === "retry" ||
          belowConfidence
        ) &&
        retryable;

      if (canRetry) {
        input.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "subagent_verifier_retry",
          message:
            "Sub-agent verifier requested retry; rerunning planner pipeline",
          details: {
            round: verifierRounds,
            maxRounds: this.subagentVerifierConfig.maxRounds,
            confidence: Number(verificationDecision.confidence.toFixed(3)),
            minConfidence: Number(
              this.subagentVerifierConfig.minConfidence.toFixed(3),
            ),
          },
        });
        continue;
      }

      if (
        verificationDecision.overall !== "pass" ||
        belowConfidence
      ) {
        const unresolvedPreview =
          verificationDecision.unresolvedItems.slice(0, 3).join("; ");
        input.setStopReason(
          "validation_error",
          unresolvedPreview.length > 0
            ? `Sub-agent verifier rejected child outputs: ${unresolvedPreview}`
            : "Sub-agent verifier rejected child outputs",
        );
      }
      break;
    }

    return {
      verifierRounds,
      verificationDecision,
      pipelineResult,
    };
  }

  /** Get accumulated token usage for a session. */
  getSessionTokenUsage(sessionId: string): number {
    return this.sessionTokens.get(sessionId) ?? 0;
  }

  /** Reset token usage for a specific session. */
  resetSessionTokens(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
    this.sessionToolFailureCircuits.delete(sessionId);
    for (const provider of this.providers) {
      provider.resetSessionState?.(sessionId);
    }
  }

  /** Clear all session token tracking. */
  clearAllSessionTokens(): void {
    this.sessionTokens.clear();
    this.sessionToolFailureCircuits.clear();
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
      routedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      requestDeadlineAt?: number;
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
    const hasRoutedToolNames = Boolean(
      options?.routedToolNames && options.routedToolNames.length > 0,
    );
    const hasToolChoice = options?.toolChoice !== undefined;
    const hasProviderTrace =
      options?.trace?.includeProviderPayloads === true ||
      options?.trace?.onProviderTraceEvent !== undefined;
    const chatOptions: LLMChatOptions | undefined =
      hasStatefulSessionId || hasRoutedToolNames || hasToolChoice || hasProviderTrace
        ? {
          ...(hasStatefulSessionId
            ? {
              stateful: {
                sessionId: String(options?.statefulSessionId),
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
          ...(hasProviderTrace
            ? {
              trace: {
                includeProviderPayloads:
                  options?.trace?.includeProviderPayloads === true,
                ...(options?.trace?.onProviderTraceEvent
                  ? {
                    onProviderTraceEvent: (event) => {
                      options.trace?.onProviderTraceEvent?.({
                        ...event,
                        ...(options.callIndex !== undefined
                          ? { callIndex: options.callIndex }
                          : {}),
                        ...(options.callPhase !== undefined
                          ? { callPhase: options.callPhase }
                          : {}),
                      });
                    },
                  }
                  : {}),
              },
            }
            : {}),
        }
        : undefined;
    let lastError: Error | undefined;
    const now = Date.now();

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const cooldown = this.cooldowns.get(provider.name);

      if (cooldown && cooldown.availableAt > now) {
        continue;
      }

      let attempts = 0;
      while (true) {
        try {
          const providerCall = onStreamChunk
            ? provider.chatStream(
              boundedMessages,
              onStreamChunk,
              chatOptions,
            )
            : provider.chat(boundedMessages, chatOptions);
          const remainingProviderMs = options?.requestDeadlineAt !== undefined
            ? Math.max(1, options.requestDeadlineAt - Date.now())
            : undefined;
          let response: LLMResponse;
          if (remainingProviderMs !== undefined) {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
              response = await Promise.race([
                providerCall,
                new Promise<LLMResponse>((_, reject) => {
                  timeoutHandle = setTimeout(() => {
                    reject(new LLMTimeoutError(provider.name, remainingProviderMs));
                  }, remainingProviderMs);
                }),
              ]);
            } finally {
              if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
              }
            }
          } else {
            response = await providerCall;
          }

          if (response.finishReason === "error") {
            throw (
              response.error ??
              new LLMProviderError(provider.name, "Provider returned error")
            );
          }

          // Success — clear cooldown
          this.cooldowns.delete(provider.name);

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
            this.shouldRetryProviderImmediately(
              failureClass,
              retryRule,
              lastError,
              attempts,
            )
          ) {
            attempts++;
            continue;
          }

          if (!this.shouldFallbackForFailureClass(failureClass, lastError)) {
            throw lastError;
          }

          // Apply cooldown for this provider before trying fallbacks.
          const failures =
            (this.cooldowns.get(provider.name)?.failures ?? 0) + 1;
          const cooldownDuration = this.computeProviderCooldownMs(
            failures,
            retryRule,
            lastError,
          );
          this.cooldowns.set(provider.name, {
            availableAt: Date.now() + cooldownDuration,
            failures,
          });
          break;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    // All providers were skipped (in cooldown) — no provider was attempted
    throw new LLMProviderError(
      "chat-executor",
      "All providers are in cooldown",
    );
  }

  private shouldRetryProviderImmediately(
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

  private shouldFallbackForFailureClass(
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

  private computeProviderCooldownMs(
    failures: number,
    retryRule: LLMRetryPolicyRule,
    error: Error,
  ): number {
    if (error instanceof LLMRateLimitError && error.retryAfterMs) {
      return error.retryAfterMs;
    }
    const linearCooldown = Math.min(
      this.cooldownMs * failures,
      this.maxCooldownMs,
    );
    const policyCooldown = retryRule.baseDelayMs > 0
      ? Math.min(retryRule.baseDelayMs * failures, retryRule.maxDelayMs)
      : 0;
    return Math.max(0, Math.max(linearCooldown, policyCooldown));
  }

  private annotateFailureError(
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

  private getOrCreateToolFailureCircuitState(
    sessionId: string,
  ): SessionToolFailureCircuitState {
    const existing = this.sessionToolFailureCircuits.get(sessionId);
    if (existing) return existing;
    const created: SessionToolFailureCircuitState = {
      openUntil: 0,
      reason: undefined,
      patterns: new Map(),
    };
    this.sessionToolFailureCircuits.set(sessionId, created);
    if (this.sessionToolFailureCircuits.size > this.maxTrackedSessions) {
      const oldest = this.sessionToolFailureCircuits.keys().next().value;
      if (oldest !== undefined) {
        this.sessionToolFailureCircuits.delete(oldest);
      }
    }
    return created;
  }

  private getActiveToolFailureCircuit(
    sessionId: string,
  ): { reason: string; retryAfterMs: number } | null {
    if (!this.toolFailureBreakerEnabled) return null;
    const state = this.sessionToolFailureCircuits.get(sessionId);
    if (!state) return null;
    const now = Date.now();
    if (state.openUntil <= now) {
      state.openUntil = 0;
      state.reason = undefined;
      return null;
    }
    return {
      reason:
        state.reason ??
        "Session tool-failure circuit breaker is open after repeated failing tool patterns",
      retryAfterMs: Math.max(0, state.openUntil - now),
    };
  }

  private recordToolFailurePattern(
    sessionId: string,
    semanticKey: string,
    toolName: string,
  ): string | undefined {
    if (!this.toolFailureBreakerEnabled || semanticKey.length === 0) {
      return undefined;
    }

    const state = this.getOrCreateToolFailureCircuitState(sessionId);
    const now = Date.now();
    for (const [key, pattern] of state.patterns) {
      if (now - pattern.lastAt > this.toolFailureBreakerWindowMs) {
        state.patterns.delete(key);
      }
    }

    const existing = state.patterns.get(semanticKey);
    const next: SessionToolFailurePattern = existing
      ? { count: existing.count + 1, lastAt: now }
      : { count: 1, lastAt: now };
    state.patterns.set(semanticKey, next);

    if (next.count < this.toolFailureBreakerThreshold) {
      return undefined;
    }

    state.openUntil = now + this.toolFailureBreakerCooldownMs;
    state.reason =
      `Session breaker opened after ${next.count} repeated failures for tool "${toolName}" ` +
      `within ${this.toolFailureBreakerWindowMs}ms`;
    return state.reason;
  }

  private clearToolFailurePattern(sessionId: string, semanticKey: string): void {
    if (!this.toolFailureBreakerEnabled || semanticKey.length === 0) return;
    const state = this.sessionToolFailureCircuits.get(sessionId);
    if (!state) return;
    state.patterns.delete(semanticKey);
    if (state.patterns.size === 0 && state.openUntil <= Date.now()) {
      this.sessionToolFailureCircuits.delete(sessionId);
    }
  }




  /** Extract plain-text content from a gateway message. */

  /**
   * Best-effort context injection. Supports both SkillInjector (`.inject()`)
   * and MemoryRetriever (`.retrieve()`) interfaces.
   */
  private async injectContext(
    provider: SkillInjector | MemoryRetriever | undefined,
    message: string,
    sessionId: string,
    messages: LLMMessage[],
    sections: PromptBudgetSection[],
    section: PromptBudgetSection,
  ): Promise<void> {
    if (!provider) return;
    try {
      const context =
        "inject" in provider
          ? await provider.inject(message, sessionId)
          : await provider.retrieve(message, sessionId);
      if (context) {
        const sectionMaxChars = this.getContextSectionMaxChars(section);
        messages.push({
          role: "system",
          content: truncateText(
            context,
            sectionMaxChars,
          ),
        });
        sections.push(section);
      }
    } catch {
      // Context injection failure is non-blocking
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
        this.sessionToolFailureCircuits.delete(oldest);
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
      throw this.annotateFailureError(error, "response evaluation").error;
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
      throw this.annotateFailureError(error, "history compaction").error;
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
