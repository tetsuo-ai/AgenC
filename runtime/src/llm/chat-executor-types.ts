/**
 * Type definitions and error classes for ChatExecutor.
 *
 * @module
 */

import type { GatewayMessage } from "../gateway/message.js";
import type {
  LLMMessage,
  LLMResponse,
  LLMUsage,
  LLMRequestMetrics,
  LLMStatefulDiagnostics,
  LLMStatefulFallbackReason,
  StreamProgressCallback,
  ToolHandler,
  LLMProvider,
} from "./types.js";
import type {
  PromptBudgetConfig,
  PromptBudgetDiagnostics,
  PromptBudgetSection,
} from "./prompt-budget.js";
import type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyRule,
} from "./policy.js";
import type {
  Pipeline,
  PipelinePlannerContext,
  PipelineResult,
  PipelineStep,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type { DelegationDecision, DelegationDecisionConfig } from "./delegation-decision.js";
import type {
  DelegationBanditPolicyTuner,
  DelegationBanditSelection,
  DelegationTrajectorySink,
} from "./delegation-learning.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

// ============================================================================
// Error classes
// ============================================================================

/**
 * Error thrown when a session's token budget is exceeded.
 */
export class ChatBudgetExceededError extends RuntimeError {
  public readonly sessionId: string;
  public readonly used: number;
  public readonly limit: number;

  constructor(sessionId: string, used: number, limit: number) {
    super(
      `Token budget exceeded for session "${sessionId}": ${used}/${limit}`,
      RuntimeErrorCodes.CHAT_BUDGET_EXCEEDED,
    );
    this.name = "ChatBudgetExceededError";
    this.sessionId = sessionId;
    this.used = used;
    this.limit = limit;
  }
}

// ============================================================================
// Injection interfaces
// ============================================================================

/** Injects skill context into a conversation. */
export interface SkillInjector {
  inject(message: string, sessionId: string): Promise<string | undefined>;
}

/** Retrieves memory context for a conversation. */
export interface MemoryRetriever {
  retrieve(message: string, sessionId: string): Promise<string | undefined>;
}

// ============================================================================
// Core types
// ============================================================================

/** Record of a single tool call execution. */
export interface ToolCallRecord {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

/** Parameters for a single ChatExecutor.execute() call. */
export interface ChatExecuteParams {
  readonly message: GatewayMessage;
  readonly history: readonly LLMMessage[];
  readonly systemPrompt: string;
  readonly sessionId: string;
  /** Per-call tool handler — overrides the constructor handler for this call. */
  readonly toolHandler?: ToolHandler;
  /** Per-call stream callback — overrides the constructor callback for this call. */
  readonly onStreamChunk?: StreamProgressCallback;
  /** Abort signal — when aborted, the executor stops after the current tool call. */
  readonly signal?: AbortSignal;
  /** Per-call tool round limit — overrides the constructor default. */
  readonly maxToolRounds?: number;
  /** Optional per-turn tool-routing subset and expansion policy. */
  readonly toolRouting?: {
    /** Initial routed subset for this turn. */
    readonly routedToolNames?: readonly string[];
    /** One-turn expanded subset used on suspected routing misses. */
    readonly expandedToolNames?: readonly string[];
    /** Enable one-turn expansion retry on routed-tool misses. */
    readonly expandOnMiss?: boolean;
  };
}

/** Estimated prompt-shape statistics for one provider call. */
export interface ChatPromptShape {
  readonly messageCount: number;
  readonly systemMessages: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly estimatedChars: number;
  readonly systemPromptChars: number;
}

/** Per-provider-call usage attribution for one ChatExecutor execution. */
export interface ChatCallUsageRecord {
  /** 1-based call index within a single execute() invocation. */
  readonly callIndex: number;
  readonly phase:
    | "initial"
    | "planner"
    | "planner_verifier"
    | "planner_synthesis"
    | "tool_followup"
    | "evaluator"
    | "evaluator_retry";
  readonly provider: string;
  readonly model?: string;
  readonly finishReason: LLMResponse["finishReason"];
  readonly usage: LLMUsage;
  readonly beforeBudget: ChatPromptShape;
  readonly afterBudget: ChatPromptShape;
  /** Provider-specific request metrics (e.g. toolSchemaChars for Grok). */
  readonly providerRequestMetrics?: LLMRequestMetrics;
  /** Prompt-budget diagnostics (sections dropped/truncated, caps, and totals). */
  readonly budgetDiagnostics?: PromptBudgetDiagnostics;
  /** Stateful continuation diagnostics for this provider call (when supported). */
  readonly statefulDiagnostics?: LLMStatefulDiagnostics;
}

/** Planner-routing decision and ROI summary for one execute() invocation. */
export interface ChatPlannerSummary {
  readonly enabled: boolean;
  readonly used: boolean;
  readonly routeReason?: string;
  readonly complexityScore: number;
  readonly plannerCalls: number;
  readonly plannedSteps: number;
  readonly deterministicStepsExecuted: number;
  /** Estimated downstream model recalls avoided by deterministic execution. */
  readonly estimatedRecallsAvoided: number;
  /** Structured planner parse/validation/policy diagnostics for this turn. */
  readonly diagnostics?: readonly PlannerDiagnostic[];
  /** Sub-agent delegation utility decision for planner-emitted subagent tasks. */
  readonly delegationDecision?: DelegationDecision;
  /** Sub-agent verification/critic pass summary. */
  readonly subagentVerification?: {
    readonly enabled: boolean;
    readonly performed: boolean;
    readonly rounds: number;
    readonly overall: "pass" | "retry" | "fail" | "skipped";
    readonly confidence: number;
    readonly unresolvedItems: readonly string[];
  };
  /** Online policy tuning diagnostics for delegation arm selection. */
  readonly delegationPolicyTuning?: {
    readonly enabled: boolean;
    readonly contextClusterId?: string;
    readonly selectedArmId?: string;
    readonly selectedArmReason?: string;
    readonly tunedThreshold?: number;
    readonly exploration: boolean;
    readonly finalReward?: number;
    readonly usefulDelegation?: boolean;
    readonly usefulDelegationScore?: number;
    readonly rewardProxyVersion?: string;
  };
}

export interface PlannerDiagnostic {
  readonly category: "parse" | "validation" | "policy";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/** Aggregated stateful continuation counters for one execute() invocation. */
export interface ChatStatefulSummary {
  readonly enabled: boolean;
  readonly attemptedCalls: number;
  readonly continuedCalls: number;
  readonly fallbackCalls: number;
  readonly fallbackReasons: Readonly<Record<LLMStatefulFallbackReason, number>>;
}

/** Aggregated tool-routing diagnostics for one execute() invocation. */
export interface ChatToolRoutingSummary {
  readonly enabled: boolean;
  readonly initialToolCount: number;
  readonly finalToolCount: number;
  readonly routeMisses: number;
  readonly expanded: boolean;
}

/** Result returned from ChatExecutor.execute(). */
export interface ChatExecutorResult {
  readonly content: string;
  readonly provider: string;
  /** Actual model identifier returned by the provider for the final response. */
  readonly model?: string;
  readonly usedFallback: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  /** Per-call token and prompt-shape attribution for this execution. */
  readonly callUsage: readonly ChatCallUsageRecord[];
  readonly durationMs: number;
  /** True if conversation history was compacted during this execution. */
  readonly compacted: boolean;
  /** Aggregated stateful continuation diagnostics for this execution. */
  readonly statefulSummary?: ChatStatefulSummary;
  /** Per-turn dynamic tool-routing diagnostics for this execution. */
  readonly toolRoutingSummary?: ChatToolRoutingSummary;
  /** Planner/executor routing summary and ROI diagnostics. */
  readonly plannerSummary?: ChatPlannerSummary;
  /** Canonical stop reason for this request execution. */
  readonly stopReason: LLMPipelineStopReason;
  /** Optional detail for non-completed stop reasons. */
  readonly stopReasonDetail?: string;
  /** Result of response evaluation, if evaluator is configured. */
  readonly evaluation?: EvaluationResult;
}

/** Minimal pipeline executor interface required by ChatExecutor planner path. */
export interface DeterministicPipelineExecutor {
  execute(pipeline: Pipeline, startFrom?: number): Promise<PipelineResult>;
}

export type LLMRetryPolicyOverrides = Partial<{
  [K in LLMFailureClass]: Partial<LLMRetryPolicyRule>;
}>;

export interface ToolFailureCircuitBreakerConfig {
  /** Enable per-session tool failure circuit breaker (default: true). */
  readonly enabled?: boolean;
  /** Repeated semantic failure threshold before opening breaker (default: 5). */
  readonly threshold?: number;
  /** Rolling window for counting repeated failures in ms (default: 300_000). */
  readonly windowMs?: number;
  /** Breaker open cooldown in ms (default: 120_000). */
  readonly cooldownMs?: number;
}

/** Configuration for ChatExecutor construction. */
export interface ChatExecutorConfig {
  /** Ordered providers — first is primary, rest are fallbacks. */
  readonly providers: readonly LLMProvider[];
  readonly toolHandler?: ToolHandler;
  readonly maxToolRounds?: number;
  readonly onStreamChunk?: StreamProgressCallback;
  readonly skillInjector?: SkillInjector;
  readonly memoryRetriever?: MemoryRetriever;
  readonly allowedTools?: readonly string[];
  /**
   * Maximum token budget per session. When cumulative usage meets or exceeds
   * this value, the executor attempts to compact conversation history by
   * summarizing older messages. If compaction fails, falls back to
   * `ChatBudgetExceededError`.
   */
  readonly sessionTokenBudget?: number;
  /** Callback when context compaction occurs (budget recovery). */
  readonly onCompaction?: (sessionId: string, summary: string) => void;
  /** Optional response evaluator/critic configuration. */
  readonly evaluator?: EvaluatorConfig;
  /** Optional provider that injects self-learning context per message. */
  readonly learningProvider?: MemoryRetriever;
  /** Optional provider that injects cross-session progress context per message. */
  readonly progressProvider?: MemoryRetriever;
  /** Prompt budget allocator configuration (Phase 2). */
  readonly promptBudget?: PromptBudgetConfig;
  /** Base cooldown period for failed providers in ms (default: 60_000). */
  readonly providerCooldownMs?: number;
  /** Maximum cooldown period in ms (default: 300_000). */
  readonly maxCooldownMs?: number;
  /** Maximum tracked sessions before eviction (default: 10_000). */
  readonly maxTrackedSessions?: number;
  /** Enable planner/executor split for high-complexity turns. */
  readonly plannerEnabled?: boolean;
  /** Max output tokens for the planner pass (bounded planning call). */
  readonly plannerMaxTokens?: number;
  /** Optional deterministic workflow executor used when planner emits executable steps. */
  readonly pipelineExecutor?: DeterministicPipelineExecutor;
  /** Delegation utility scoring controls for planner-emitted subagent tasks. */
  readonly delegationDecision?: DelegationDecisionConfig;
  /** Optional live resolver for delegation threshold overrides. */
  readonly resolveDelegationScoreThreshold?: () => number | undefined;
  /** Optional verifier/critic loop for planner-emitted subagent outputs. */
  readonly subagentVerifier?: {
    /** Enable verifier flow for planner-emitted subagent steps. */
    readonly enabled?: boolean;
    /** Enforce verification whenever subagent steps execute. */
    readonly force?: boolean;
    /** Minimum confidence required to accept child outputs. */
    readonly minConfidence?: number;
    /** Max verification rounds (initial verification included). */
    readonly maxRounds?: number;
  };
  /** Optional delegation learning hooks (trajectory sink + online bandit tuner). */
  readonly delegationLearning?: {
    readonly trajectorySink?: DelegationTrajectorySink;
    readonly banditTuner?: DelegationBanditPolicyTuner;
    readonly defaultStrategyArmId?: string;
  };
  /** Maximum tool calls allowed for a single execute() invocation. */
  readonly toolBudgetPerRequest?: number;
  /** Maximum model recalls (calls after the first) for a single execute() invocation. */
  readonly maxModelRecallsPerRequest?: number;
  /** Maximum total failed tool calls allowed for a single execute() invocation. */
  readonly maxFailureBudgetPerRequest?: number;
  /** Timeout for a single tool execution call in milliseconds. */
  readonly toolCallTimeoutMs?: number;
  /** End-to-end timeout for one execute() invocation in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Failure-class retry policy overrides (merged with defaults). */
  readonly retryPolicyMatrix?: LLMRetryPolicyOverrides;
  /** Session-level breaker for repeated failing tool patterns. */
  readonly toolFailureCircuitBreaker?: ToolFailureCircuitBreakerConfig;
}

// ============================================================================
// Evaluator types
// ============================================================================

/** Configuration for optional response evaluation/critic. */
export interface EvaluatorConfig {
  readonly rubric?: string;
  /** Minimum score (0.0–1.0) to accept the response. Default: 0.7. */
  readonly minScore?: number;
  /** Maximum retry attempts when score is below threshold. Default: 1. */
  readonly maxRetries?: number;
}

/** Result of a response evaluation. */
export interface EvaluationResult {
  readonly score: number;
  readonly feedback: string;
  readonly passed: boolean;
  readonly retryCount: number;
}

// ============================================================================
// Internal types (used by sibling chat-executor-*.ts files)
// ============================================================================

export interface CooldownEntry {
  availableAt: number;
  failures: number;
}

export interface SessionToolFailurePattern {
  count: number;
  lastAt: number;
}

export interface SessionToolFailureCircuitState {
  openUntil: number;
  reason?: string;
  patterns: Map<string, SessionToolFailurePattern>;
}

export interface FallbackResult {
  response: LLMResponse;
  providerName: string;
  usedFallback: boolean;
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
  budgetDiagnostics: PromptBudgetDiagnostics;
}

export interface RecoveryHint {
  key: string;
  message: string;
}

export interface PlannerDecision {
  score: number;
  shouldPlan: boolean;
  reason: string;
}

export type PlannerStepType = "deterministic_tool" | "subagent_task" | "synthesis";

export interface PlannerStepBaseIntent {
  name: string;
  stepType: PlannerStepType;
  dependsOn?: readonly string[];
}

export interface PlannerDeterministicToolStepIntent extends PlannerStepBaseIntent {
  stepType: "deterministic_tool";
  tool: string;
  args: Record<string, unknown>;
  onError?: PipelineStep["onError"];
  maxRetries?: number;
}

export interface PlannerSubAgentTaskStepIntent extends PlannerStepBaseIntent {
  stepType: "subagent_task";
  objective: string;
  inputContract: string;
  acceptanceCriteria: readonly string[];
  requiredToolCapabilities: readonly string[];
  contextRequirements: readonly string[];
  maxBudgetHint: string;
  canRunParallel: boolean;
}

export interface PlannerSynthesisStepIntent extends PlannerStepBaseIntent {
  stepType: "synthesis";
  objective?: string;
}

export type PlannerStepIntent =
  | PlannerDeterministicToolStepIntent
  | PlannerSubAgentTaskStepIntent
  | PlannerSynthesisStepIntent;

export interface PlannerPlan {
  reason?: string;
  requiresSynthesis?: boolean;
  confidence?: number;
  steps: PlannerStepIntent[];
  edges: readonly WorkflowGraphEdge[];
}

export interface PlannerParseResult {
  readonly plan?: PlannerPlan;
  readonly diagnostics: readonly PlannerDiagnostic[];
}

export interface PlannerGraphValidationConfig {
  readonly maxSubagentFanout: number;
  readonly maxSubagentDepth: number;
}

export type SubagentVerifierStepVerdict = "pass" | "retry" | "fail";

export interface SubagentVerifierStepAssessment {
  readonly name: string;
  readonly verdict: SubagentVerifierStepVerdict;
  readonly confidence: number;
  readonly retryable: boolean;
  readonly issues: readonly string[];
  readonly summary: string;
}

export interface SubagentVerifierDecision {
  readonly overall: "pass" | "retry" | "fail";
  readonly confidence: number;
  readonly unresolvedItems: readonly string[];
  readonly steps: readonly SubagentVerifierStepAssessment[];
  readonly source: "deterministic" | "model" | "merged";
}

export interface ResolvedSubagentVerifierConfig {
  readonly enabled: boolean;
  readonly force: boolean;
  readonly minConfidence: number;
  readonly maxRounds: number;
}

export interface MutablePlannerVerificationSummary {
  enabled: boolean;
  performed: boolean;
  rounds: number;
  overall: "pass" | "retry" | "fail" | "skipped";
  confidence: number;
  unresolvedItems: string[];
}

export interface MutablePlannerSummaryState {
  deterministicStepsExecuted: number;
  diagnostics: PlannerDiagnostic[];
  subagentVerification: MutablePlannerVerificationSummary;
}

export interface PlannerPipelineVerifierLoopInput {
  pipeline: Pipeline;
  plannerPlan: PlannerPlan;
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  deterministicSteps: readonly PlannerDeterministicToolStepIntent[];
  plannerExecutionContext: PipelinePlannerContext;
  shouldRunSubagentVerifier: boolean;
  plannerSummaryState: MutablePlannerSummaryState;
  checkRequestTimeout: (stage: string) => boolean;
  runPipelineWithGlobalTimeout: (
    pipeline: Pipeline,
  ) => Promise<PipelineResult | undefined>;
  runSubagentVerifierRound: (input: {
    plannerPlan: PlannerPlan;
    subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
    pipelineResult: PipelineResult;
    plannerContext: PipelinePlannerContext;
    round: number;
  }) => Promise<SubagentVerifierDecision>;
  appendToolRecord: (record: ToolCallRecord) => void;
  setStopReason: (reason: LLMPipelineStopReason, detail?: string) => void;
}

/** Full planner summary state — extends the subset used by executePlannerPipelineWithVerifier. */
export interface FullPlannerSummaryState extends MutablePlannerSummaryState {
  enabled: boolean;
  used: boolean;
  routeReason: string;
  complexityScore: number;
  plannerCalls: number;
  plannedSteps: number;
  estimatedRecallsAvoided: number;
  delegationDecision: DelegationDecision | undefined;
  delegationPolicyTuning: {
    enabled: boolean;
    contextClusterId: string | undefined;
    selectedArmId: string | undefined;
    selectedArmReason: string | undefined;
    tunedThreshold: number | undefined;
    exploration: boolean;
    finalReward: number | undefined;
    usefulDelegation: boolean | undefined;
    usefulDelegationScore: number | undefined;
    rewardProxyVersion: string | undefined;
  };
}

/** Loop-local mutable state shared across tool calls within a single round. */
export interface ToolLoopState {
  sideEffectExecuted: boolean;
  remainingToolImageChars: number;
  activeRoutedToolSet: Set<string> | null;
  expandAfterRound: boolean;
  lastFailKey: string;
  consecutiveFailCount: number;
}

/** Control flow action returned by executeSingleToolCall(). */
export type ToolCallAction = "processed" | "skip" | "abort_round" | "abort_loop";

/** Mutable context threaded through all phases of executeRequest(). */
export interface ExecutionContext {
  // --- Immutable request params (set once in init, never mutated) ---
  readonly message: GatewayMessage;
  readonly messageText: string;
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly activeToolHandler?: ToolHandler;
  readonly activeStreamCallback?: StreamProgressCallback;
  readonly effectiveMaxToolRounds: number;
  readonly effectiveToolBudget: number;
  readonly effectiveMaxModelRecalls: number;
  readonly effectiveFailureBudget: number;
  readonly startTime: number;
  readonly requestDeadlineAt: number;
  readonly parentTurnId: string;
  readonly trajectoryTraceId: string;
  readonly initialRoutedToolNames: readonly string[];
  readonly expandedRoutedToolNames: readonly string[];
  readonly canExpandOnRoutingMiss: boolean;
  readonly hasHistory: boolean;
  readonly plannerDecision: PlannerDecision;
  readonly baseDelegationThreshold: number;
  readonly toolRouting?: ChatExecuteParams["toolRouting"];

  // --- Mutable accumulator state ---
  history: readonly LLMMessage[];
  messages: LLMMessage[];
  messageSections: PromptBudgetSection[];
  cumulativeUsage: LLMUsage;
  callUsage: ChatCallUsageRecord[];
  callIndex: number;
  modelCalls: number;
  allToolCalls: ToolCallRecord[];
  failedToolCalls: number;
  usedFallback: boolean;
  providerName: string;
  responseModel?: string;
  response?: LLMResponse;
  evaluation?: EvaluationResult;
  finalContent: string;
  compacted: boolean;
  stopReason: LLMPipelineStopReason;
  stopReasonDetail?: string;
  activeRoutedToolNames: readonly string[];
  routedToolsExpanded: boolean;
  routedToolMisses: number;
  plannerHandled: boolean;
  plannerSummaryState: FullPlannerSummaryState;
  trajectoryContextClusterId: string;
  selectedBanditArm?: DelegationBanditSelection;
  tunedDelegationThreshold: number;
  plannedSubagentSteps: number;
  plannedDeterministicSteps: number;
  plannedSynthesisSteps: number;
  plannedDependencyDepth: number;
  plannedFanout: number;
}
