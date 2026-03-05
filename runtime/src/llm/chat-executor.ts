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
  LLMMessage,
  LLMToolCall,
  LLMResponse,
  LLMUsage,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import { safeStringify } from "../tools/types.js";
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
  PipelinePlannerContext,
  PipelinePlannerStep,
  PipelineResult,
} from "../workflow/pipeline.js";
import {
  assessDelegationDecision,
  resolveDelegationDecisionConfig,
  type DelegationDecision,
  type DelegationDecisionConfig,
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
} from "./chat-executor-types.js";
import type {
  SkillInjector,
  MemoryRetriever,
  ToolCallRecord,
  ChatExecuteParams,
  ChatPromptShape,
  ChatCallUsageRecord,
  ChatPlannerSummary,
  PlannerDiagnostic,
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
  MAX_CONSECUTIVE_IDENTICAL_FAILURES,
  MAX_CONSECUTIVE_ALL_FAILED_ROUNDS,
  RECOVERY_HINT_PREFIX,
  MAX_EVAL_USER_CHARS,
  MAX_EVAL_RESPONSE_CHARS,
  MAX_CONTEXT_INJECTION_CHARS,
  MAX_PROMPT_CHARS_BUDGET,
  MAX_TOOL_IMAGE_CHARS_BUDGET,
  DEFAULT_MAX_RUNTIME_SYSTEM_HINTS,
  DEFAULT_PLANNER_MAX_TOKENS,
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
  DEFAULT_MODEL_RECALLS_PER_REQUEST,
  DEFAULT_FAILURE_BUDGET_PER_REQUEST,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
  MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS,
  DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD,
  DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS,
  DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS,
  MACOS_SIDE_EFFECT_TOOLS,
  DEFAULT_EVAL_RUBRIC,
  MAX_COMPACT_INPUT,
} from "./chat-executor-constants.js";
import {
  didToolCallFail,
  extractToolFailureText,
  resolveRetryPolicyMatrix,
  hasExplicitIdempotencyKey,
  isHighRiskToolCall,
  isToolRetrySafe,
  isLikelyToolTransportFailure,
  enrichToolResultMetadata,
} from "./chat-executor-tool-utils.js";
import {
  extractMessageText,
  truncateText,
  sanitizeFinalContent,
  reconcileStructuredToolOutcome,
  estimatePromptShape,
  normalizeHistory,
  sanitizeToolCallsForReplay,
  buildPromptToolContent,
  appendUserMessage,
  generateFallbackContent,
  summarizeToolCalls,
} from "./chat-executor-text.js";
import {
  buildSemanticToolCallKey,
  summarizeStateful,
  buildRecoveryHints,
} from "./chat-executor-recovery.js";
import {
  assessPlannerDecision,
  buildPlannerMessages,
  buildPlannerExecutionContext,
  parsePlannerPlan,
  validatePlannerGraph,
  isHighRiskSubagentPlan,
  computePlannerGraphDepth,
  isPipelineStopReasonHint,
  buildPlannerSynthesisMessages,
  ensureSubagentProvenanceCitations,
  pipelineResultToToolCalls,
} from "./chat-executor-planner.js";
import {
  evaluateSubagentDeterministicChecks,
  buildSubagentVerifierMessages,
  parseSubagentVerifierDecision,
  mergeSubagentVerifierDecisions,
} from "./chat-executor-verifier.js";
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
    ctx.finalContent = reconcileStructuredToolOutcome(
      ctx.finalContent,
      ctx.allToolCalls,
    );

    return {
      content: ctx.finalContent,
      provider: ctx.providerName,
      model: ctx.responseModel,
      usedFallback: ctx.usedFallback,
      toolCalls: ctx.allToolCalls,
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

  private timeoutDetail(stage: string): string {
    return `Request exceeded end-to-end timeout (${this.requestTimeoutMs}ms) during ${stage}`;
  }

  private checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean {
    if (this.getRemainingRequestMs(ctx) > 0) return false;
    this.setStopReason(ctx, "timeout", this.timeoutDetail(stage));
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

  private async callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      routedToolNames?: readonly string[];
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
      : (ctx.toolRouting ? ctx.activeRoutedToolNames : undefined);
    let next: FallbackResult;
    try {
      next = await this.callWithFallback(
        input.callMessages,
        input.onStreamChunk,
        input.callSections,
        {
          ...(input.statefulSessionId
            ? { statefulSessionId: input.statefulSessionId }
            : {}),
          ...(effectiveRoutedToolNames !== undefined
            ? { routedToolNames: effectiveRoutedToolNames }
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
      this.setStopReason(ctx, "timeout", this.timeoutDetail("planner pipeline execution"));
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
        this.pipelineExecutor!.execute(pipeline),
        timeoutPromise,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === timeoutMessage) {
        this.setStopReason(ctx, "timeout", this.timeoutDetail("planner pipeline execution"));
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
    const {
      message,
      systemPrompt,
      sessionId,
      signal,
      maxToolRounds: paramMaxToolRounds,
    } = params;
    let { history } = params;
    const startTime = Date.now();
    const messageText = extractMessageText(message);
    const hasHistory = history.length > 0;
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
          history = await this.compactHistory(history, sessionId);
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

    const ctx: ExecutionContext = {
      // --- Immutable request params ---
      message,
      messageText,
      systemPrompt,
      sessionId,
      signal,
      activeToolHandler: params.toolHandler ?? this.toolHandler,
      activeStreamCallback: params.onStreamChunk ?? this.onStreamChunk,
      effectiveMaxToolRounds: paramMaxToolRounds ?? this.maxToolRounds,
      effectiveToolBudget: this.toolBudgetPerRequest,
      effectiveMaxModelRecalls: this.maxModelRecallsPerRequest,
      effectiveFailureBudget: this.maxFailureBudgetPerRequest,
      startTime,
      requestDeadlineAt: startTime + this.requestTimeoutMs,
      parentTurnId: `parent:${sessionId}:${startTime}`,
      trajectoryTraceId: `trace:${sessionId}:${startTime}`,
      initialRoutedToolNames,
      expandedRoutedToolNames,
      canExpandOnRoutingMiss: Boolean(
        params.toolRouting?.expandOnMiss &&
        expandedRoutedToolNames.length > 0,
      ),
      hasHistory,
      plannerDecision,
      baseDelegationThreshold,
      toolRouting: params.toolRouting,

      // --- Mutable accumulator state ---
      history,
      messages: [],
      messageSections: [],
      cumulativeUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      callUsage: [],
      callIndex: 0,
      modelCalls: 0,
      allToolCalls: [],
      failedToolCalls: 0,
      usedFallback: false,
      providerName: this.providers[0]?.name ?? "unknown",
      responseModel: undefined,
      response: undefined,
      evaluation: undefined,
      finalContent: "",
      compacted,
      stopReason: "completed",
      stopReasonDetail: undefined,
      activeRoutedToolNames: initialRoutedToolNames,
      routedToolsExpanded: false,
      routedToolMisses: 0,
      plannerHandled: false,
      plannerSummaryState: {
        enabled: this.plannerEnabled,
        used: false,
        routeReason: plannerDecision.reason,
        complexityScore: plannerDecision.score,
        plannerCalls: 0,
        plannedSteps: 0,
        deterministicStepsExecuted: 0,
        estimatedRecallsAvoided: 0,
        diagnostics: [] as PlannerDiagnostic[],
        delegationDecision: undefined as DelegationDecision | undefined,
        subagentVerification: {
          enabled: this.subagentVerifierConfig.enabled,
          performed: false,
          rounds: 0,
          overall: "skipped" as "pass" | "retry" | "fail" | "skipped",
          confidence: 1,
          unresolvedItems: [] as string[],
        },
        delegationPolicyTuning: {
          enabled: Boolean(this.delegationBanditTuner),
          contextClusterId: undefined as string | undefined,
          selectedArmId: undefined as string | undefined,
          selectedArmReason: undefined as string | undefined,
          tunedThreshold: undefined as number | undefined,
          exploration: false,
          finalReward: undefined as number | undefined,
          usefulDelegation: undefined as boolean | undefined,
          usefulDelegationScore: undefined as number | undefined,
          rewardProxyVersion: undefined as string | undefined,
        },
      },
      trajectoryContextClusterId: deriveDelegationContextClusterId({
        complexityScore: plannerDecision.score,
        subagentStepCount: 0,
        hasHistory,
        highRiskPlan: false,
      }),
      selectedBanditArm: undefined,
      tunedDelegationThreshold: baseDelegationThreshold,
      plannedSubagentSteps: 0,
      plannedDeterministicSteps: 0,
      plannedSynthesisSteps: 0,
      plannedDependencyDepth: 0,
      plannedFanout: 0,
    };

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
    const stopReasonQualityBase = ctx.stopReason === "completed"
      ? 0.85
      : ctx.stopReason === "tool_calls"
        ? 0.6
        : 0.25;
    const verifierBonus = ctx.plannerSummaryState.subagentVerification.performed
      ? (
        ctx.plannerSummaryState.subagentVerification.overall === "pass"
          ? 0.1
          : ctx.plannerSummaryState.subagentVerification.overall === "retry"
            ? 0
            : -0.15
      )
      : 0;
    const evaluatorBonus = ctx.evaluation
      ? (ctx.evaluation.passed ? 0.1 : -0.1)
      : 0;
    const failurePenalty = Math.min(0.25, ctx.failedToolCalls * 0.05);
    const qualityProxy = Math.max(
      0,
      Math.min(
        1,
        stopReasonQualityBase + verifierBonus + evaluatorBonus - failurePenalty,
      ),
    );
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
    const verifierSnapshot = ctx.plannerSummaryState.subagentVerification;
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
      this.delegationTrajectorySink.record({
        schemaVersion: 1,
        traceId: ctx.trajectoryTraceId,
        turnId: ctx.parentTurnId,
        turnType: "parent",
        timestampMs: Date.now(),
        stateFeatures: {
          sessionId: ctx.sessionId,
          contextClusterId: ctx.trajectoryContextClusterId,
          complexityScore: ctx.plannerDecision.score,
          plannerStepCount: ctx.plannerSummaryState.plannedSteps,
          subagentStepCount: ctx.plannedSubagentSteps,
          deterministicStepCount: ctx.plannedDeterministicSteps,
          synthesisStepCount: ctx.plannedSynthesisSteps,
          dependencyDepth: ctx.plannedDependencyDepth,
          fanout: ctx.plannedFanout,
        },
        action: {
          delegated:
            ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true,
          strategyArmId:
            ctx.selectedBanditArm?.armId ?? this.delegationDefaultStrategyArmId,
          threshold: ctx.tunedDelegationThreshold,
          selectedTools,
          childConfig: {
            maxDepth: this.delegationDecisionConfig.maxDepth,
            maxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
            timeoutMs: this.requestTimeoutMs,
          },
        },
        immediateOutcome: {
          qualityProxy,
          tokenCost: ctx.cumulativeUsage.totalTokens,
          latencyMs: durationMs,
          errorCount:
            ctx.failedToolCalls + (ctx.stopReason === "completed" ? 0 : 1),
          ...(ctx.stopReason !== "completed" ? { errorClass: ctx.stopReason } : {}),
        },
        finalReward: rewardSignal,
        metadata: {
          plannerUsed: ctx.plannerSummaryState.used,
          routeReason: ctx.plannerSummaryState.routeReason ?? "none",
          stopReason: ctx.stopReason,
          usefulDelegation: usefulnessProxy.useful,
          usefulDelegationScore: Number(usefulnessProxy.score.toFixed(4)),
          usefulDelegationProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
        },
      });
    }

    const plannerSummary: ChatPlannerSummary = {
      enabled: ctx.plannerSummaryState.enabled,
      used: ctx.plannerSummaryState.used,
      routeReason: ctx.plannerSummaryState.routeReason,
      complexityScore: ctx.plannerSummaryState.complexityScore,
      plannerCalls: ctx.plannerSummaryState.plannerCalls,
      plannedSteps: ctx.plannerSummaryState.plannedSteps,
      deterministicStepsExecuted: ctx.plannerSummaryState.deterministicStepsExecuted,
      estimatedRecallsAvoided: ctx.plannerSummaryState.used
        ? estimatedRecallsAvoided
        : 0,
      diagnostics: ctx.plannerSummaryState.diagnostics.length > 0
        ? ctx.plannerSummaryState.diagnostics
        : undefined,
      delegationDecision: ctx.plannerSummaryState.delegationDecision,
      subagentVerification: ctx.plannerSummaryState.subagentVerification.enabled
        ? ctx.plannerSummaryState.subagentVerification
        : undefined,
      delegationPolicyTuning: ctx.plannerSummaryState.delegationPolicyTuning.enabled
        ? ctx.plannerSummaryState.delegationPolicyTuning
        : undefined,
    };

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

      const evalResult = await this.evaluateResponse(currentContent, ctx.messageText);
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
        { role: "assistant", content: currentContent },
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
            ...(ctx.toolRouting
              ? { routedToolNames: ctx.activeRoutedToolNames }
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
    ctx.response = await this.callModelForPhase(ctx, {
      phase: "initial",
      callMessages: ctx.messages,
      callSections: ctx.messageSections,
      onStreamChunk: ctx.activeStreamCallback,
      statefulSessionId: ctx.sessionId,
      budgetReason:
        "Initial completion blocked by max model recalls per request budget",
    });

    // Tool call loop — side-effect deduplication prevents the model from
    // repeating desktop actions (e.g. opening 3 YouTube tabs). Once ANY
    // side-effect tool executes, all others are skipped for this request.
    let rounds = 0;
    const emittedRecoveryHints = new Set<string>();
    // Track consecutive identical failing calls to break stuck loops.
    let consecutiveAllFailedRounds = 0;
    let lastRoundSemanticKey = "";
    let consecutiveSemanticDuplicateRounds = 0;
    const loopState: ToolLoopState = {
      sideEffectExecuted: false,
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
      // Check for cancellation before each round.
      if (ctx.signal?.aborted) {
        this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
        break;
      }
      if (this.checkRequestTimeout(ctx, "tool loop")) {
        break;
      }
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

      // Append the assistant message with tool calls.
      this.pushMessage(
        ctx,
        {
          role: "assistant",
          content: ctx.response.content,
          toolCalls: sanitizeToolCallsForReplay(
            ctx.response.toolCalls,
          ),
        },
        "assistant_runtime",
      );

      let abortRound = false;
      for (const toolCall of ctx.response.toolCalls) {
        const action = await this.executeSingleToolCall(ctx, toolCall, loopState);
        if (action === "abort_loop" || action === "abort_round") {
          abortRound = true;
          break;
        }
        // "skip" and "processed" both continue the loop
      }

      // Check for cancellation before re-calling LLM.
      if (ctx.signal?.aborted) {
        this.setStopReason(ctx, "cancelled", "Execution cancelled by caller");
        break;
      }
      if (this.checkRequestTimeout(ctx, "tool follow-up")) {
        break;
      }

      const roundCalls = ctx.allToolCalls.slice(roundToolCallStart);
      if (abortRound) break;

      // Break stuck loops — if semantically equivalent failing call repeats
      // too many times, stop and surface no-progress.
      if (loopState.consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
        this.setStopReason(
          ctx,
          "no_progress",
          "Detected repeated semantically-equivalent failing tool calls",
        );
        break;
      }

      // Break stuck loops — if all tool calls fail for multiple consecutive
      // rounds, stop retrying and let the model respond with what it learned.
      if (roundCalls.length > 0) {
        const roundFailures = roundCalls.filter((call) =>
          didToolCallFail(call.isError, call.result),
        ).length;
        if (roundFailures === roundCalls.length) {
          consecutiveAllFailedRounds++;
        } else {
          consecutiveAllFailedRounds = 0;
          consecutiveSemanticDuplicateRounds = 0;
          lastRoundSemanticKey = "";
        }
        if (consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
          this.setStopReason(
            ctx,
            "no_progress",
            `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
          );
          break;
        }

        if (roundFailures === roundCalls.length) {
          const roundSemanticKey = roundCalls
            .map((call) =>
              buildSemanticToolCallKey(call.name, call.args),
            )
            .sort()
            .join("|");
          if (
            roundSemanticKey.length > 0 &&
            roundSemanticKey === lastRoundSemanticKey
          ) {
            consecutiveSemanticDuplicateRounds++;
          } else {
            consecutiveSemanticDuplicateRounds = 0;
          }
          lastRoundSemanticKey = roundSemanticKey;
          if (
            consecutiveSemanticDuplicateRounds >=
            MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS
          ) {
            this.setStopReason(
              ctx,
              "no_progress",
              "Detected repeated semantically equivalent tool rounds with no material progress",
            );
            break;
          }
        }
      }

      const recoveryHints = buildRecoveryHints(
        roundCalls,
        emittedRecoveryHints,
      );
      for (const hint of recoveryHints) {
        if (this.maxRuntimeSystemHints <= 0) break;
        const runtimeHintCount = ctx.messageSections.filter(
          (section) => section === "system_runtime",
        ).length;
        if (runtimeHintCount >= this.maxRuntimeSystemHints) break;
        this.pushMessage(
          ctx,
          {
            role: "system",
            content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
          },
          "system_runtime",
        );
      }

      if (loopState.expandAfterRound && ctx.expandedRoutedToolNames.length > 0) {
        ctx.routedToolsExpanded = true;
        ctx.activeRoutedToolNames = ctx.expandedRoutedToolNames;
        if (this.maxRuntimeSystemHints > 0) {
          const runtimeHintCount = ctx.messageSections.filter(
            (section) => section === "system_runtime",
          ).length;
          if (runtimeHintCount < this.maxRuntimeSystemHints) {
            this.pushMessage(
              ctx,
              {
                role: "system",
                content:
                  `${RECOVERY_HINT_PREFIX} The previous tool request targeted a tool outside the routed subset. ` +
                  "Tool availability has been expanded for one retry. Choose the best available tool and continue.",
              },
              "system_runtime",
            );
          }
        }
      }

      // Re-call LLM.
      const nextResponse = await this.callModelForPhase(ctx, {
        phase: "tool_followup",
        callMessages: ctx.messages,
        callSections: ctx.messageSections,
        onStreamChunk: ctx.activeStreamCallback,
        statefulSessionId: ctx.sessionId,
        budgetReason:
          "Max model recalls exceeded while following up after tool calls",
      });
      if (!nextResponse) break;
      ctx.response = nextResponse;
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

    // If the LLM returned empty content after tool calls (common when maxToolRounds
    // is hit while the LLM still wanted to make more calls), generate a fallback
    // summary from the last successful tool result.
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

    if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name) && loopState.sideEffectExecuted) {
      const skipResult = safeStringify({
        error: `Skipped "${toolCall.name}" — a desktop action was already performed. Combine actions into a single tool call.`,
      });
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: skipResult,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
        name: toolCall.name,
        args: {},
        result: skipResult,
        isError: true,
        durationMs: 0,
      });
      return "skip";
    }
    if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name)) loopState.sideEffectExecuted = true;

    // Global allowlist check.
    if (this.allowedTools && !this.allowedTools.has(toolCall.name)) {
      const errorResult = safeStringify({
        error: `Tool "${toolCall.name}" is not permitted`,
      });
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: errorResult,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
        name: toolCall.name,
        args: {},
        result: errorResult,
        isError: true,
        durationMs: 0,
      });
      return "skip";
    }
    // Dynamic routed subset check.
    if (loopState.activeRoutedToolSet && !loopState.activeRoutedToolSet.has(toolCall.name)) {
      ctx.routedToolMisses++;
      const errorResult = safeStringify({
        error:
          `Tool "${toolCall.name}" was not available in the routed tool subset for this turn`,
        routingMiss: true,
      });
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: errorResult,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
        name: toolCall.name,
        args: {},
        result: errorResult,
        isError: true,
        durationMs: 0,
      });
      if (ctx.canExpandOnRoutingMiss && !ctx.routedToolsExpanded) {
        loopState.expandAfterRound = true;
      }
      return "skip";
    }

    // Parse arguments.
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(toolCall.arguments) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Tool arguments must be a JSON object");
      }
      args = parsed as Record<string, unknown>;
    } catch (parseErr) {
      const errorResult = safeStringify({
        error: `Invalid tool arguments: ${(parseErr as Error).message}`,
      });
      this.pushMessage(
        ctx,
        {
          role: "tool",
          content: errorResult,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        "tools",
      );
      this.appendToolRecord(ctx, {
        name: toolCall.name,
        args: {},
        result: errorResult,
        isError: true,
        durationMs: 0,
      });
      return "skip";
    }

    // Execute tool.
    const toolStart = Date.now();
    let result = safeStringify({ error: "Tool execution failed" });
    let isError = false;
    let toolFailed = false;
    let transportFailure = false;
    let timedOut = false;
    let finalToolTimeoutMs = this.toolCallTimeoutMs;
    let retrySuppressedReason: string | undefined;
    let retryCount = 0;
    const maxToolRetries = Math.max(
      0,
      this.retryPolicyMatrix.tool_error.maxRetries,
    );

    for (let attempt = 0; attempt <= maxToolRetries; attempt++) {
      const remainingRequestMs = this.getRemainingRequestMs(ctx);
      const toolTimeoutMs = Math.min(
        this.toolCallTimeoutMs,
        Math.max(1, remainingRequestMs),
      );
      finalToolTimeoutMs = toolTimeoutMs;
      let toolTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const toolCallPromise = (async (): Promise<{
        result: string;
        isError: boolean;
        timedOut: boolean;
        threw: boolean;
      }> => {
        try {
          const value = await ctx.activeToolHandler!(toolCall.name, args);
          return {
            result: value,
            isError: false,
            timedOut: false,
            threw: false,
          };
        } catch (toolErr) {
          return {
            result: safeStringify({ error: (toolErr as Error).message }),
            isError: true,
            timedOut: false,
            threw: true,
          };
        }
      })();
      const timeoutPromise = new Promise<{
        result: string;
        isError: boolean;
        timedOut: boolean;
        threw: boolean;
      }>((resolve) => {
        toolTimeoutHandle = setTimeout(() => {
          resolve({
            result: safeStringify({
              error: `Tool "${toolCall.name}" timed out after ${toolTimeoutMs}ms`,
            }),
            isError: true,
            timedOut: true,
            threw: false,
          });
        }, toolTimeoutMs);
      });
      const toolOutcome = await Promise.race([
        toolCallPromise,
        timeoutPromise,
      ]);
      if (toolTimeoutHandle !== undefined) {
        clearTimeout(toolTimeoutHandle);
      }

      result = toolOutcome.result;
      isError = toolOutcome.isError;
      timedOut = toolOutcome.timedOut;

      toolFailed = didToolCallFail(isError, result);
      const failureText = toolFailed
        ? extractToolFailureText({
          name: toolCall.name,
          args,
          result,
          isError: toolFailed,
          durationMs: 0,
        })
        : "";
      transportFailure =
        timedOut ||
        toolOutcome.threw ||
        isLikelyToolTransportFailure(failureText);
      if (!toolFailed) break;

      const canRetryTransportFailure =
        transportFailure &&
        attempt < maxToolRetries &&
        !ctx.signal?.aborted &&
        this.getRemainingRequestMs(ctx) > 0;
      if (!canRetryTransportFailure) break;

      const highRiskTool = isHighRiskToolCall(toolCall.name);
      const hasIdempotencyKey = hasExplicitIdempotencyKey(args);
      const retrySafe = highRiskTool
        ? hasIdempotencyKey
        : isToolRetrySafe(toolCall.name);
      if (!retrySafe) {
        retrySuppressedReason = highRiskTool && !hasIdempotencyKey
          ? `Suppressed auto-retry for high-risk tool "${toolCall.name}" without idempotencyKey`
          : `Suppressed auto-retry for potentially side-effecting tool "${toolCall.name}"`;
        break;
      }

      retryCount++;
    }
    const toolDuration = Date.now() - toolStart;
    if (retryCount > 0) {
      result = enrichToolResultMetadata(result, { retryAttempts: retryCount });
    }
    if (retrySuppressedReason) {
      result = enrichToolResultMetadata(result, {
        retrySuppressedReason,
      });
    }

    let abortRound = false;
    if (timedOut && toolFailed) {
      this.setStopReason(
        ctx,
        "timeout",
        `Tool "${toolCall.name}" timed out after ${finalToolTimeoutMs}ms`,
      );
      abortRound = true;
    }

    if (
      this.toolFailureBreakerEnabled &&
      toolFailed
    ) {
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
      isError: toolFailed,
      durationMs: toolDuration,
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
    const failDetected = toolFailed;
    const semanticToolKey = buildSemanticToolCallKey(
      toolCall.name,
      args,
    );
    const failKey = failDetected ? semanticToolKey : "";
    if (!failDetected && this.toolFailureBreakerEnabled) {
      this.clearToolFailurePattern(ctx.sessionId, semanticToolKey);
    }
    if (failDetected && failKey === loopState.lastFailKey) {
      loopState.consecutiveFailCount++;
    } else {
      loopState.lastFailKey = failKey;
      loopState.consecutiveFailCount = failDetected ? 1 : 0;
    }

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
    return "processed";
  }

  private async executePlannerPath(ctx: ExecutionContext): Promise<void> {
    ctx.plannerSummaryState.used = true;
    const plannerMessages = buildPlannerMessages(
      ctx.messageText,
      ctx.history,
      this.plannerMaxTokens,
    );
    const plannerSections: PromptBudgetSection[] = [
      "system_anchor",
      "history",
      "user",
    ];
    const plannerResponse = await this.callModelForPhase(ctx, {
      phase: "planner",
      callMessages: plannerMessages,
      callSections: plannerSections,
      budgetReason:
        "Planner pass blocked by max model recalls per request budget",
    });

    if (plannerResponse) {
      ctx.plannerSummaryState.plannerCalls = 1;
      const plannerParse = parsePlannerPlan(plannerResponse.content);
      ctx.plannerSummaryState.diagnostics.push(...plannerParse.diagnostics);
      const plannerPlan = plannerParse.plan;
      if (plannerPlan) {
        const graphDiagnostics = validatePlannerGraph(
          plannerPlan,
          {
            maxSubagentFanout: this.delegationDecisionConfig.maxFanoutPerTurn,
            maxSubagentDepth: this.delegationDecisionConfig.maxDepth,
          },
        );
        if (graphDiagnostics.length > 0) {
          ctx.plannerSummaryState.diagnostics.push(...graphDiagnostics);
          ctx.plannerSummaryState.routeReason = "planner_validation_failed";
        } else if (plannerPlan.reason) {
          ctx.plannerSummaryState.routeReason = plannerPlan.reason;
        }
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
        if (subagentSteps.length > 0) {
          const synthesisSteps = plannerPlan.steps.filter(
            (step) => step.stepType === "synthesis",
          ).length;
          const highRiskPlan = isHighRiskSubagentPlan(
            subagentSteps,
          );
          ctx.trajectoryContextClusterId = deriveDelegationContextClusterId({
            complexityScore: ctx.plannerDecision.score,
            subagentStepCount: subagentSteps.length,
            hasHistory: ctx.hasHistory,
            highRiskPlan,
          });

          if (this.delegationBanditTuner) {
            ctx.selectedBanditArm = this.delegationBanditTuner.selectArm({
              contextClusterId: ctx.trajectoryContextClusterId,
              preferredArmId: this.delegationDefaultStrategyArmId,
            });
            ctx.tunedDelegationThreshold =
              this.delegationBanditTuner.applyThresholdOffset(
                ctx.baseDelegationThreshold,
                ctx.selectedBanditArm.armId,
              );
            ctx.plannerSummaryState.delegationPolicyTuning = {
              enabled: true,
              contextClusterId: ctx.trajectoryContextClusterId,
              selectedArmId: ctx.selectedBanditArm.armId,
              selectedArmReason: ctx.selectedBanditArm.reason,
              tunedThreshold: ctx.tunedDelegationThreshold,
              exploration: ctx.selectedBanditArm.exploration,
              finalReward: undefined,
              usefulDelegation: undefined,
              usefulDelegationScore: undefined,
              rewardProxyVersion: undefined,
            };
          } else {
            ctx.plannerSummaryState.delegationPolicyTuning = {
              enabled: false,
              contextClusterId: ctx.trajectoryContextClusterId,
              selectedArmId: this.delegationDefaultStrategyArmId,
              selectedArmReason: "fallback",
              tunedThreshold: ctx.baseDelegationThreshold,
              exploration: false,
              finalReward: undefined,
              usefulDelegation: undefined,
              usefulDelegationScore: undefined,
              rewardProxyVersion: undefined,
            };
          }

          const tunedDecisionConfig: DelegationDecisionConfig = {
            enabled: this.delegationDecisionConfig.enabled,
            mode: this.delegationDecisionConfig.mode,
            scoreThreshold: ctx.tunedDelegationThreshold,
            maxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
            maxDepth: this.delegationDecisionConfig.maxDepth,
            handoffMinPlannerConfidence:
              this.delegationDecisionConfig.handoffMinPlannerConfidence,
            hardBlockedTaskClasses: [
              ...this.delegationDecisionConfig.hardBlockedTaskClasses,
            ],
          };
          const delegationDecision = assessDelegationDecision({
            messageText: ctx.messageText,
            plannerConfidence: plannerPlan.confidence,
            complexityScore: ctx.plannerDecision.score,
            totalSteps: plannerPlan.steps.length,
            synthesisSteps,
            edges: plannerPlan.edges,
            subagentSteps: subagentSteps.map((step) => ({
              name: step.name,
              dependsOn: step.dependsOn,
              acceptanceCriteria: step.acceptanceCriteria,
              requiredToolCapabilities: step.requiredToolCapabilities,
              contextRequirements: step.contextRequirements,
              maxBudgetHint: step.maxBudgetHint,
              canRunParallel: step.canRunParallel,
            })),
            config: tunedDecisionConfig,
          });
          ctx.plannerSummaryState.delegationDecision = delegationDecision;
          if (!delegationDecision.shouldDelegate) {
            ctx.plannerSummaryState.routeReason =
              `delegation_veto_${delegationDecision.reason}`;
            ctx.plannerSummaryState.diagnostics.push({
              category: "policy",
              code: "delegation_veto",
              message:
                `Delegation vetoed by policy scorer: ${delegationDecision.reason}`,
              details: {
                reason: delegationDecision.reason,
                threshold: delegationDecision.threshold,
                utilityScore: Number(
                  delegationDecision.utilityScore.toFixed(4),
                ),
                safetyRisk: Number(delegationDecision.safetyRisk.toFixed(4)),
              },
            });
          }
        }
        const deterministicSteps = plannerPlan.steps.filter(
          (step): step is PlannerDeterministicToolStepIntent =>
            step.stepType === "deterministic_tool",
        );
        const plannerPipelineSteps: PipelinePlannerStep[] = plannerPlan.steps.map(
          (step) => {
            if (step.stepType === "deterministic_tool") {
              return {
                name: step.name,
                stepType: step.stepType,
                dependsOn: step.dependsOn,
                tool: step.tool,
                args: step.args,
                onError: step.onError,
                maxRetries: step.maxRetries,
              };
            }
            if (step.stepType === "subagent_task") {
              return {
                name: step.name,
                stepType: step.stepType,
                dependsOn: step.dependsOn,
                objective: step.objective,
                inputContract: step.inputContract,
                acceptanceCriteria: step.acceptanceCriteria,
                requiredToolCapabilities: step.requiredToolCapabilities,
                contextRequirements: step.contextRequirements,
                maxBudgetHint: step.maxBudgetHint,
                canRunParallel: step.canRunParallel,
              };
            }
            return {
              name: step.name,
              stepType: step.stepType,
              dependsOn: step.dependsOn,
              objective: step.objective,
            };
          },
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
            ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true
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
            ctx.plannerHandled = true;
          } else {
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

            const shouldRunSubagentVerifier =
              subagentSteps.length > 0 &&
              ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true &&
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
                this.timeoutDetail("planner pipeline execution"),
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
              (plannerPlan.requiresSynthesis || ctx.stopReason !== "completed")
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
            }

            if (!ctx.finalContent) {
              ctx.finalContent =
                generateFallbackContent(ctx.allToolCalls) ??
                summarizeToolCalls(
                  ctx.allToolCalls.filter((call) => !call.isError),
                );
            }
            ctx.plannerHandled = true;
          }
        } else {
          if (
            !ctx.plannerSummaryState.delegationDecision ||
            ctx.plannerSummaryState.delegationDecision.shouldDelegate
          ) {
            if (ctx.plannerSummaryState.routeReason !== "planner_validation_failed") {
              ctx.plannerSummaryState.routeReason = "planner_no_deterministic_steps";
            }
          }
        }
      } else {
        ctx.plannerSummaryState.routeReason = "planner_parse_failed";
      }
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
      routedToolNames?: readonly string[];
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
    const hasRoutedToolNames = Boolean(
      options?.routedToolNames && options.routedToolNames.length > 0,
    );
    const chatOptions: LLMChatOptions | undefined =
      hasStatefulSessionId || hasRoutedToolNames
        ? {
          ...(hasStatefulSessionId
            ? { stateful: { sessionId: String(options?.statefulSessionId) } }
            : {}),
          ...(hasRoutedToolNames
            ? { toolRouting: { allowedToolNames: options?.routedToolNames } }
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
          let response: LLMResponse;
          if (onStreamChunk) {
            response = await provider.chatStream(
              boundedMessages,
              onStreamChunk,
              chatOptions,
            );
          } else {
            response = await provider.chat(boundedMessages, chatOptions);
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
    };
  }

  // --------------------------------------------------------------------------
  // Response evaluation
  // --------------------------------------------------------------------------


  private async evaluateResponse(
    content: string,
    userMessage: string,
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
      ]);
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
      ]);
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
