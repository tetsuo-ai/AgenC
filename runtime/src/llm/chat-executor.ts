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

import type { GatewayMessage } from "../gateway/message.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMMessage,
  LLMContentPart,
  LLMResponse,
  LLMUsage,
  LLMRequestMetrics,
  LLMStatefulDiagnostics,
  LLMStatefulFallbackReason,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
import {
  LLMProviderError,
  LLMRateLimitError,
  classifyLLMFailure,
} from "./errors.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import { safeStringify } from "../tools/types.js";
import {
  applyPromptBudget,
  type PromptBudgetConfig,
  type PromptBudgetDiagnostics,
  type PromptBudgetSection,
} from "./prompt-budget.js";
import {
  DEFAULT_LLM_RETRY_POLICY_MATRIX,
  toPipelineStopReason,
} from "./policy.js";
import type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyMatrix,
  LLMRetryPolicyRule,
} from "./policy.js";
import type {
  Pipeline,
  PipelinePlannerContext,
  PipelinePlannerContextMemorySource,
  PipelinePlannerStep,
  PipelineResult,
  PipelineStep,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
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
  type DelegationBanditSelection,
  type DelegationTrajectorySink,
} from "./delegation-learning.js";

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

type LLMRetryPolicyOverrides = Partial<{
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
// Internal types
// ============================================================================

interface CooldownEntry {
  availableAt: number;
  failures: number;
}

interface SessionToolFailurePattern {
  count: number;
  lastAt: number;
}

interface SessionToolFailureCircuitState {
  openUntil: number;
  reason?: string;
  patterns: Map<string, SessionToolFailurePattern>;
}

interface FallbackResult {
  response: LLMResponse;
  providerName: string;
  usedFallback: boolean;
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
  budgetDiagnostics: PromptBudgetDiagnostics;
}

interface RecoveryHint {
  key: string;
  message: string;
}

interface PlannerDecision {
  score: number;
  shouldPlan: boolean;
  reason: string;
}

type PlannerStepType = "deterministic_tool" | "subagent_task" | "synthesis";

interface PlannerStepBaseIntent {
  name: string;
  stepType: PlannerStepType;
  dependsOn?: readonly string[];
}

interface PlannerDeterministicToolStepIntent extends PlannerStepBaseIntent {
  stepType: "deterministic_tool";
  tool: string;
  args: Record<string, unknown>;
  onError?: PipelineStep["onError"];
  maxRetries?: number;
}

interface PlannerSubAgentTaskStepIntent extends PlannerStepBaseIntent {
  stepType: "subagent_task";
  objective: string;
  inputContract: string;
  acceptanceCriteria: readonly string[];
  requiredToolCapabilities: readonly string[];
  contextRequirements: readonly string[];
  maxBudgetHint: string;
  canRunParallel: boolean;
}

interface PlannerSynthesisStepIntent extends PlannerStepBaseIntent {
  stepType: "synthesis";
  objective?: string;
}

type PlannerStepIntent =
  | PlannerDeterministicToolStepIntent
  | PlannerSubAgentTaskStepIntent
  | PlannerSynthesisStepIntent;

interface PlannerPlan {
  reason?: string;
  requiresSynthesis?: boolean;
  confidence?: number;
  steps: PlannerStepIntent[];
  edges: readonly WorkflowGraphEdge[];
}

interface PlannerParseResult {
  readonly plan?: PlannerPlan;
  readonly diagnostics: readonly PlannerDiagnostic[];
}

interface PlannerGraphValidationConfig {
  readonly maxSubagentFanout: number;
  readonly maxSubagentDepth: number;
}

type SubagentVerifierStepVerdict = "pass" | "retry" | "fail";

interface SubagentVerifierStepAssessment {
  readonly name: string;
  readonly verdict: SubagentVerifierStepVerdict;
  readonly confidence: number;
  readonly retryable: boolean;
  readonly issues: readonly string[];
  readonly summary: string;
}

interface SubagentVerifierDecision {
  readonly overall: "pass" | "retry" | "fail";
  readonly confidence: number;
  readonly unresolvedItems: readonly string[];
  readonly steps: readonly SubagentVerifierStepAssessment[];
  readonly source: "deterministic" | "model" | "merged";
}

interface ResolvedSubagentVerifierConfig {
  readonly enabled: boolean;
  readonly force: boolean;
  readonly minConfidence: number;
  readonly maxRounds: number;
}

interface MutablePlannerVerificationSummary {
  enabled: boolean;
  performed: boolean;
  rounds: number;
  overall: "pass" | "retry" | "fail" | "skipped";
  confidence: number;
  unresolvedItems: string[];
}

interface MutablePlannerSummaryState {
  deterministicStepsExecuted: number;
  diagnostics: PlannerDiagnostic[];
  subagentVerification: MutablePlannerVerificationSummary;
}

interface PlannerPipelineVerifierLoopInput {
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

// ============================================================================
// Constants
// ============================================================================

/** Max chars for URL preview in tool summaries. */
const MAX_URL_PREVIEW_CHARS = 80;
/** Max chars for bash output in tool summaries. */
const MAX_BASH_OUTPUT_CHARS = 2000;
/** Max chars for command preview in tool summaries. */
const MAX_COMMAND_PREVIEW_CHARS = 60;
/**
 * Max consecutive identical failing tool calls before the loop is broken.
 * When the LLM calls the same tool with the same arguments and gets an error
 * N times in a row, we inject a hint after (N-1) and break after N.
 */
const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3;
/** Break tool loop after N rounds where every tool call failed. */
const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3;
const RECOVERY_HINT_PREFIX = "Tool recovery hint:";
const SHELL_BUILTIN_COMMANDS = new Set([
  "set",
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "unset",
  "shopt",
  "ulimit",
  "umask",
  "readonly",
  "declare",
  "typeset",
  "builtin",
]);
/** Max chars for JSON result previews. */
const MAX_RESULT_PREVIEW_CHARS = 500;
/** Max chars for error message previews. */
const MAX_ERROR_PREVIEW_CHARS = 300;
/** Max chars of user message sent to the evaluator. */
const MAX_EVAL_USER_CHARS = 500;
/** Max chars of response sent to the evaluator. */
const MAX_EVAL_RESPONSE_CHARS = 2000;
/** Cap history depth sent to providers per request. */
const MAX_HISTORY_MESSAGES = 20;
/** Max chars retained per history message. */
const MAX_HISTORY_MESSAGE_CHARS = 2_000;
/** Max chars from a single injected system context block (skills/memory/progress). */
const MAX_CONTEXT_INJECTION_CHARS = 12_000;
/** Hard prompt-size guard (approx chars) to avoid provider context-length errors. */
const MAX_PROMPT_CHARS_BUDGET = 100_000;
/** Max chars kept from a tool result when feeding it back into the LLM. */
const MAX_TOOL_RESULT_CHARS = 12_000;
/** Max chars retained for any single string field inside JSON tool output. */
const MAX_TOOL_RESULT_FIELD_CHARS = 2_000;
/** Max array items retained in JSON tool output summaries. */
const MAX_TOOL_RESULT_ARRAY_ITEMS = 40;
/** Max object keys retained in JSON tool output summaries. */
const MAX_TOOL_RESULT_OBJECT_KEYS = 48;
const TOOL_RESULT_PRIORITY_KEYS = [
  "error",
  "stderr",
  "stdout",
  "exitcode",
  "status",
  "message",
  "result",
  "output",
  "url",
  "title",
  "text",
  "data",
] as const;
/** Global image-data budget (chars) for tool results in a single execution. */
const MAX_TOOL_IMAGE_CHARS_BUDGET = 100_000;
/** Max chars retained from a single user text message. */
const MAX_USER_MESSAGE_CHARS = 8_000;
/** Hard cap for final assistant response size (protects against runaway output). */
const MAX_FINAL_RESPONSE_CHARS = 24_000;
/** Minimum line count before repetitive-output suppression is evaluated. */
const REPETITIVE_LINE_MIN_COUNT = 40;
/** Dominant-line repetition threshold for runaway detection. */
const REPETITIVE_LINE_MIN_REPEATS = 20;
/** Unique-line ratio threshold for runaway detection. */
const REPETITIVE_LINE_MAX_UNIQUE_RATIO = 0.35;
/** Upper bound on additive runtime hint system messages per execution. */
const DEFAULT_MAX_RUNTIME_SYSTEM_HINTS = 4;
/** Default max planner output budget in tokens (soft, prompt-enforced). */
const DEFAULT_PLANNER_MAX_TOKENS = 256;
/** Maximum deterministic steps accepted from a planner pass. */
const MAX_PLANNER_STEPS = 24;
/** Parent history slice candidates retained for per-subagent curation. */
const MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES = 12;
/** Max chars retained for one planner history candidate entry. */
const MAX_PLANNER_CONTEXT_HISTORY_CHARS = 600;
/** Max chars retained for one planner memory candidate entry. */
const MAX_PLANNER_CONTEXT_MEMORY_CHARS = 1_200;
/** Max chars retained for one planner tool-output candidate entry. */
const MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS = 1_200;
/** Default per-request tool-call budget. */
const DEFAULT_TOOL_BUDGET_PER_REQUEST = 24;
/** Default per-request model recall budget (calls after first). */
const DEFAULT_MODEL_RECALLS_PER_REQUEST = 24;
/** Default per-request failed-tool-call budget. */
const DEFAULT_FAILURE_BUDGET_PER_REQUEST = 8;
/** Default timeout for a single tool execution call in ms. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;
/** Default end-to-end timeout for one execute() invocation in ms. */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
/** Default minimum verifier confidence for accepting subagent outputs. */
const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65;
/** Default max rounds for verifier/critique loops (initial round included). */
const DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS = 2;
/** Max chars retained from one subagent output in verifier prompts. */
const MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS = 3_000;
/** Max chars retained from one verifier artifact payload. */
const MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS = 2_000;
/** Break no-progress loops after repeated semantically equivalent rounds. */
const MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS = 2;
/** Default repeated-failure threshold before opening session breaker. */
const DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD = 5;
/** Default rolling window for repeated-failure breaker accounting. */
const DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS = 300_000;
/** Default cooldown once repeated-failure breaker opens. */
const DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS = 120_000;
/** Keep raw tool image payloads out of model replay by default. */
const ENABLE_TOOL_IMAGE_REPLAY = false;
/**
 * macOS native tools that cause visible side-effects (opening apps, running scripts).
 * Once any tool in this set executes, further calls to ANY tool in the set are
 * skipped for the remainder of the request. This prevents the model from e.g.
 * opening 3 YouTube tabs.
 *
 * NOTE: Desktop sandbox tools (`desktop.*`) are intentionally excluded — multi-step
 * desktop automation (click → type → screenshot → verify) needs repeated calls.
 */
const MACOS_SIDE_EFFECT_TOOLS = new Set([
  "system.open",
  "system.applescript",
  "system.notification",
]);

/**
 * High-risk side-effect tools MUST NOT be auto-retried unless an explicit
 * idempotency token is provided in tool args.
 */
const HIGH_RISK_TOOL_PREFIXES = [
  "agenc.",
  "wallet.",
  "solana.",
  "desktop.",
];
const HIGH_RISK_TOOLS = new Set([
  "system.bash",
  "system.writeFile",
  "system.delete",
  "system.applescript",
  "system.open",
  "system.notification",
  "system.execute",
]);
const SAFE_TOOL_RETRY_PREFIXES = [
  "system.http",
  "system.browse",
  "system.extract",
  "system.read",
  "playwright.browser_",
];
const SAFE_TOOL_RETRY_TOOLS = new Set([
  "system.listFiles",
  "system.readFile",
  "system.searchFiles",
  "system.htmlToMarkdown",
]);

function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
  } catch {
    // Non-JSON tool output — treat as non-failure unless isError=true.
  }
  return false;
}

function parseToolResultObject(
  result: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractToolFailureText(record: ToolCallRecord): string {
  const parsed = parseToolResultObject(record.result);
  if (!parsed) return record.result;

  const pieces: string[] = [];
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    pieces.push(parsed.error.trim());
  }
  if (typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0) {
    pieces.push(parsed.stderr.trim());
  }
  if (pieces.length > 0) return pieces.join("\n");
  return record.result;
}

function resolveRetryPolicyMatrix(
  overrides?: LLMRetryPolicyOverrides,
): LLMRetryPolicyMatrix {
  if (!overrides) return DEFAULT_LLM_RETRY_POLICY_MATRIX;
  const merged = {
    ...DEFAULT_LLM_RETRY_POLICY_MATRIX,
  } as Record<LLMFailureClass, LLMRetryPolicyRule>;
  for (const failureClass of Object.keys(
    DEFAULT_LLM_RETRY_POLICY_MATRIX,
  ) as LLMFailureClass[]) {
    const baseRule = merged[failureClass];
    const patch = overrides[failureClass];
    if (!patch) continue;
    merged[failureClass] = {
      ...baseRule,
      ...patch,
    };
  }
  return merged;
}

function hasExplicitIdempotencyKey(args: Record<string, unknown>): boolean {
  const value = args.idempotencyKey;
  return typeof value === "string" && value.trim().length > 0;
}

function isHighRiskToolCall(
  toolName: string,
): boolean {
  if (HIGH_RISK_TOOLS.has(toolName)) return true;
  return HIGH_RISK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isToolRetrySafe(toolName: string): boolean {
  if (SAFE_TOOL_RETRY_TOOLS.has(toolName)) return true;
  return SAFE_TOOL_RETRY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isLikelyToolTransportFailure(
  errorText: string,
): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport") ||
    lower.includes("bridge")
  );
}

function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
  const parsed = parseToolResultObject(result);
  if (!parsed) return result;
  return safeStringify({
    ...parsed,
    ...metadata,
  });
}

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
    const {
      message,
      systemPrompt,
      sessionId,
      signal,
      maxToolRounds: paramMaxToolRounds,
    } = params;
    let { history } = params;
    const activeToolHandler = params.toolHandler ?? this.toolHandler;
    const activeStreamCallback = params.onStreamChunk ?? this.onStreamChunk;
    const effectiveMaxToolRounds = paramMaxToolRounds ?? this.maxToolRounds;
    const effectiveToolBudget = this.toolBudgetPerRequest;
    const effectiveMaxModelRecalls = this.maxModelRecallsPerRequest;
    const effectiveFailureBudget = this.maxFailureBudgetPerRequest;
    const startTime = Date.now();
    const parentTurnId = `parent:${sessionId}:${startTime}`;
    const trajectoryTraceId = `trace:${sessionId}:${startTime}`;
    const requestDeadlineAt = startTime + this.requestTimeoutMs;
    const getRemainingRequestMs = (): number => requestDeadlineAt - Date.now();

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

    // Build messages array with explicit section tags for prompt budgeting.
    const messages: LLMMessage[] = [];
    const messageSections: PromptBudgetSection[] = [];
    const pushMessage = (
      nextMessage: LLMMessage,
      section: PromptBudgetSection,
    ): void => {
      messages.push(nextMessage);
      messageSections.push(section);
    };
    pushMessage({ role: "system", content: systemPrompt }, "system_anchor");

    // Context injection — skill, memory, and learning (all best-effort)
    const messageText = ChatExecutor.extractMessageText(message);
    const hasHistory = history.length > 0;
    await this.injectContext(
      this.skillInjector,
      messageText,
      sessionId,
      messages,
      messageSections,
      "system_runtime",
    );
    // Session-scoped persistence should not bleed into truly fresh chats.
    // For the first turn, only inject static skill context.
    if (hasHistory) {
      await this.injectContext(
        this.memoryRetriever,
        messageText,
        sessionId,
        messages,
        messageSections,
        "memory_semantic",
      );
      await this.injectContext(
        this.learningProvider,
        messageText,
        sessionId,
        messages,
        messageSections,
        "memory_episodic",
      );
      await this.injectContext(
        this.progressProvider,
        messageText,
        sessionId,
        messages,
        messageSections,
        "memory_working",
      );
    }

    // Append history and user message
    for (const historicalMessage of ChatExecutor.normalizeHistory(history)) {
      pushMessage(historicalMessage, "history");
    }

    ChatExecutor.appendUserMessage(messages, messageSections, message);

    // First LLM call
    const cumulativeUsage: LLMUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const callUsage: ChatCallUsageRecord[] = [];
    let callIndex = 0;
    let modelCalls = 0;
    const allToolCalls: ToolCallRecord[] = [];
    let failedToolCalls = 0;
    let usedFallback = false;
    let providerName = this.providers[0]?.name ?? "unknown";
    let responseModel: string | undefined;
    let response: LLMResponse | undefined;
    let evaluation: EvaluationResult | undefined;
    let finalContent = "";
    let stopReason: LLMPipelineStopReason = "completed";
    let stopReasonDetail: string | undefined;
    const initialRoutedToolNames = params.toolRouting?.routedToolNames
      ? Array.from(new Set(params.toolRouting.routedToolNames))
      : [];
    const expandedRoutedToolNames = params.toolRouting?.expandedToolNames
      ? Array.from(new Set(params.toolRouting.expandedToolNames))
      : [];
    const canExpandOnRoutingMiss = Boolean(
      params.toolRouting?.expandOnMiss &&
      expandedRoutedToolNames.length > 0,
    );
    let activeRoutedToolNames = initialRoutedToolNames;
    let routedToolsExpanded = false;
    let routedToolMisses = 0;

    const plannerDecision = this.assessPlannerDecision(messageText, history);
    let trajectoryContextClusterId = deriveDelegationContextClusterId({
      complexityScore: plannerDecision.score,
      subagentStepCount: 0,
      hasHistory,
      highRiskPlan: false,
    });
    let selectedBanditArm: DelegationBanditSelection | undefined;
    const resolvedThresholdOverride = this.resolveDelegationScoreThreshold?.();
    const baseDelegationThreshold =
      typeof resolvedThresholdOverride === "number" &&
        Number.isFinite(resolvedThresholdOverride)
        ? Math.max(0, Math.min(1, resolvedThresholdOverride))
        : this.delegationDecisionConfig.scoreThreshold;
    let tunedDelegationThreshold = baseDelegationThreshold;
    let plannedSubagentSteps = 0;
    let plannedDeterministicSteps = 0;
    let plannedSynthesisSteps = 0;
    let plannedDependencyDepth = 0;
    let plannedFanout = 0;
    const plannerSummaryState = {
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
    };

    const setStopReason = (
      reason: LLMPipelineStopReason,
      detail?: string,
    ): void => {
      if (stopReason === "completed") {
        stopReason = reason;
        stopReasonDetail = detail;
      }
    };

    const timeoutDetail = (stage: string): string =>
      `Request exceeded end-to-end timeout (${this.requestTimeoutMs}ms) during ${stage}`;

    const checkRequestTimeout = (stage: string): boolean => {
      if (getRemainingRequestMs() > 0) return false;
      setStopReason("timeout", timeoutDetail(stage));
      return true;
    };

    const appendToolRecord = (record: ToolCallRecord): void => {
      allToolCalls.push(record);
      if (didToolCallFail(record.isError, record.result)) {
        failedToolCalls++;
      }
    };

    const hasModelRecallBudget = (): boolean => {
      if (modelCalls === 0) return true; // first model call
      return modelCalls - 1 < effectiveMaxModelRecalls;
    };

    const callModel = async (input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: StreamProgressCallback;
      statefulSessionId?: string;
      routedToolNames?: readonly string[];
      budgetReason: string;
    }): Promise<LLMResponse | undefined> => {
      if (!hasModelRecallBudget()) {
        setStopReason("budget_exceeded", input.budgetReason);
        return undefined;
      }
      if (checkRequestTimeout(`${input.phase} model call`)) {
        return undefined;
      }
      const effectiveRoutedToolNames = input.routedToolNames !== undefined
        ? input.routedToolNames
        : (params.toolRouting ? activeRoutedToolNames : undefined);
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
        setStopReason(annotated.stopReason, annotated.stopReasonDetail);
        throw annotated.error;
      }
      modelCalls++;
      providerName = next.providerName;
      responseModel = next.response.model;
      if (next.usedFallback) usedFallback = true;
      this.accumulateUsage(cumulativeUsage, next.response.usage);
      callUsage.push(
        this.createCallUsageRecord({
          callIndex: ++callIndex,
          phase: input.phase,
          providerName: next.providerName,
          response: next.response,
          beforeBudget: next.beforeBudget,
          afterBudget: next.afterBudget,
          budgetDiagnostics: next.budgetDiagnostics,
        }),
      );
      return next.response;
    };

    const runPipelineWithGlobalTimeout = async (
      pipeline: Pipeline,
    ): Promise<PipelineResult | undefined> => {
      const remainingMs = getRemainingRequestMs();
      if (remainingMs <= 0) {
        setStopReason("timeout", timeoutDetail("planner pipeline execution"));
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
          setStopReason("timeout", timeoutDetail("planner pipeline execution"));
          return undefined;
        }
        const annotated = this.annotateFailureError(
          error,
          "planner pipeline execution",
        );
        setStopReason(annotated.stopReason, annotated.stopReasonDetail);
        throw annotated.error;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };

    const runSubagentVerifierRound = async (input: {
      plannerPlan: PlannerPlan;
      subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
      pipelineResult: PipelineResult;
      plannerContext: PipelinePlannerContext;
      round: number;
    }): Promise<SubagentVerifierDecision> => {
      const deterministic = ChatExecutor.evaluateSubagentDeterministicChecks(
        input.subagentSteps,
        input.pipelineResult,
        input.plannerContext,
      );
      const verifierMessages = ChatExecutor.buildSubagentVerifierMessages(
        systemPrompt,
        messageText,
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
      const verifierResponse = await callModel({
        phase: "planner_verifier",
        callMessages: verifierMessages,
        callSections: verifierSections,
        statefulSessionId: sessionId,
        budgetReason:
          "Planner verifier blocked by max model recalls per request budget",
      });
      if (!verifierResponse) {
        return deterministic;
      }
      const modelDecision = ChatExecutor.parseSubagentVerifierDecision(
        verifierResponse.content,
        input.subagentSteps,
      );
      if (!modelDecision) {
        plannerSummaryState.diagnostics.push({
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
      return ChatExecutor.mergeSubagentVerifierDecisions(
        deterministic,
        modelDecision,
      );
    };

    let plannerHandled = false;
    if (
      this.plannerEnabled &&
      plannerDecision.shouldPlan &&
      this.pipelineExecutor &&
      activeToolHandler
    ) {
      plannerSummaryState.used = true;
      const plannerMessages = ChatExecutor.buildPlannerMessages(
        messageText,
        history,
        this.plannerMaxTokens,
      );
      const plannerSections: PromptBudgetSection[] = [
        "system_anchor",
        "history",
        "user",
      ];
      const plannerResponse = await callModel({
        phase: "planner",
        callMessages: plannerMessages,
        callSections: plannerSections,
        budgetReason:
          "Planner pass blocked by max model recalls per request budget",
      });

      if (plannerResponse) {
        plannerSummaryState.plannerCalls = 1;
        const plannerParse = ChatExecutor.parsePlannerPlan(plannerResponse.content);
        plannerSummaryState.diagnostics.push(...plannerParse.diagnostics);
        const plannerPlan = plannerParse.plan;
        if (plannerPlan) {
          const graphDiagnostics = ChatExecutor.validatePlannerGraph(
            plannerPlan,
            {
              maxSubagentFanout: this.delegationDecisionConfig.maxFanoutPerTurn,
              maxSubagentDepth: this.delegationDecisionConfig.maxDepth,
            },
          );
          if (graphDiagnostics.length > 0) {
            plannerSummaryState.diagnostics.push(...graphDiagnostics);
            plannerSummaryState.routeReason = "planner_validation_failed";
          } else if (plannerPlan.reason) {
            plannerSummaryState.routeReason = plannerPlan.reason;
          }
          plannerSummaryState.plannedSteps = plannerPlan.steps.length;
          plannedSubagentSteps = plannerPlan.steps.filter(
            (step) => step.stepType === "subagent_task",
          ).length;
          plannedDeterministicSteps = plannerPlan.steps.filter(
            (step) => step.stepType === "deterministic_tool",
          ).length;
          plannedSynthesisSteps = plannerPlan.steps.filter(
            (step) => step.stepType === "synthesis",
          ).length;
          plannedFanout = plannedSubagentSteps;
          plannedDependencyDepth = ChatExecutor.computePlannerGraphDepth(
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
            const highRiskPlan = ChatExecutor.isHighRiskSubagentPlan(
              subagentSteps,
            );
            trajectoryContextClusterId = deriveDelegationContextClusterId({
              complexityScore: plannerDecision.score,
              subagentStepCount: subagentSteps.length,
              hasHistory,
              highRiskPlan,
            });

            if (this.delegationBanditTuner) {
              selectedBanditArm = this.delegationBanditTuner.selectArm({
                contextClusterId: trajectoryContextClusterId,
                preferredArmId: this.delegationDefaultStrategyArmId,
              });
              tunedDelegationThreshold =
                this.delegationBanditTuner.applyThresholdOffset(
                  baseDelegationThreshold,
                  selectedBanditArm.armId,
                );
              plannerSummaryState.delegationPolicyTuning = {
                enabled: true,
                contextClusterId: trajectoryContextClusterId,
                selectedArmId: selectedBanditArm.armId,
                selectedArmReason: selectedBanditArm.reason,
                tunedThreshold: tunedDelegationThreshold,
                exploration: selectedBanditArm.exploration,
                finalReward: undefined,
                usefulDelegation: undefined,
                usefulDelegationScore: undefined,
                rewardProxyVersion: undefined,
              };
            } else {
              plannerSummaryState.delegationPolicyTuning = {
                enabled: false,
                contextClusterId: trajectoryContextClusterId,
                selectedArmId: this.delegationDefaultStrategyArmId,
                selectedArmReason: "fallback",
                tunedThreshold: baseDelegationThreshold,
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
              scoreThreshold: tunedDelegationThreshold,
              maxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
              maxDepth: this.delegationDecisionConfig.maxDepth,
              handoffMinPlannerConfidence:
                this.delegationDecisionConfig.handoffMinPlannerConfidence,
              hardBlockedTaskClasses: [
                ...this.delegationDecisionConfig.hardBlockedTaskClasses,
              ],
            };
            const delegationDecision = assessDelegationDecision({
              messageText,
              plannerConfidence: plannerPlan.confidence,
              complexityScore: plannerDecision.score,
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
            plannerSummaryState.delegationDecision = delegationDecision;
            if (!delegationDecision.shouldDelegate) {
              plannerSummaryState.routeReason =
                `delegation_veto_${delegationDecision.reason}`;
              plannerSummaryState.diagnostics.push({
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
          const plannerExecutionContext = ChatExecutor.buildPlannerExecutionContext(
            messageText,
            history,
            messages,
            messageSections,
            activeRoutedToolNames.length > 0
              ? activeRoutedToolNames
              : (this.allowedTools ? [...this.allowedTools] : undefined),
          );
          const hasExecutablePlannerSteps =
            deterministicSteps.length > 0 ||
            (
              subagentSteps.length > 0 &&
              plannerSummaryState.delegationDecision?.shouldDelegate === true
            );

          if (
            hasExecutablePlannerSteps &&
            plannerSummaryState.routeReason !== "planner_validation_failed"
          ) {
            if (deterministicSteps.length > effectiveToolBudget) {
              setStopReason(
                "budget_exceeded",
                `Planner produced ${deterministicSteps.length} deterministic steps but tool budget is ${effectiveToolBudget}`,
              );
              finalContent =
                `Planned ${deterministicSteps.length} deterministic steps, ` +
                `but request tool budget is ${effectiveToolBudget}.`;
              plannerHandled = true;
            } else {
              const pipeline: Pipeline = {
                id: `planner:${sessionId}:${Date.now()}`,
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
                plannerSummaryState.delegationDecision?.shouldDelegate === true &&
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
                plannerSummaryState,
                checkRequestTimeout,
                runPipelineWithGlobalTimeout,
                runSubagentVerifierRound,
                appendToolRecord,
                setStopReason,
              });

              if (
                shouldRunSubagentVerifier &&
                verifierRounds === 0 &&
                !plannerSummaryState.subagentVerification.performed
              ) {
                plannerSummaryState.subagentVerification = {
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
                  const hintedStopReason = ChatExecutor.isPipelineStopReasonHint(
                    pipelineResult.stopReasonHint,
                  )
                    ? pipelineResult.stopReasonHint
                    : "tool_error";
                  setStopReason(
                    hintedStopReason,
                    pipelineResult.error ??
                      "Deterministic pipeline execution failed",
                  );
                } else if (pipelineResult.status === "halted") {
                  setStopReason(
                    "tool_calls",
                    `Deterministic pipeline halted at step ${
                      (pipelineResult.resumeFrom ?? 0) + 1
                    } awaiting approval`,
                  );
                }
              } else if (stopReason === "completed") {
                setStopReason(
                  "timeout",
                  timeoutDetail("planner pipeline execution"),
                );
              }

              if (failedToolCalls > effectiveFailureBudget) {
                setStopReason(
                  "tool_error",
                  `Failure budget exceeded (${failedToolCalls}/${effectiveFailureBudget}) during deterministic pipeline execution`,
                );
              }

              if (
                pipelineResult &&
                (plannerPlan.requiresSynthesis || stopReason !== "completed")
              ) {
                const synthesisMessages = ChatExecutor.buildPlannerSynthesisMessages(
                  systemPrompt,
                  messageText,
                  plannerPlan,
                  pipelineResult,
                  verificationDecision,
                );
                const synthesisSections: PromptBudgetSection[] = [
                  "system_anchor",
                  "system_runtime",
                  "user",
                ];
                const synthesisResponse = await callModel({
                  phase: "planner_synthesis",
                  callMessages: synthesisMessages,
                  callSections: synthesisSections,
                  onStreamChunk: activeStreamCallback,
                  statefulSessionId: sessionId,
                  budgetReason:
                    "Planner synthesis blocked by max model recalls per request budget",
                });
                if (synthesisResponse) {
                  response = synthesisResponse;
                  finalContent = ChatExecutor.ensureSubagentProvenanceCitations(
                    synthesisResponse.content,
                    plannerPlan,
                    pipelineResult,
                  );
                }
              }

              if (!finalContent) {
                finalContent =
                  ChatExecutor.generateFallbackContent(allToolCalls) ??
                  ChatExecutor.summarizeToolCalls(
                    allToolCalls.filter((call) => !call.isError),
                  );
              }
              plannerHandled = true;
            }
          } else {
            if (
              !plannerSummaryState.delegationDecision ||
              plannerSummaryState.delegationDecision.shouldDelegate
            ) {
              if (plannerSummaryState.routeReason !== "planner_validation_failed") {
                plannerSummaryState.routeReason = "planner_no_deterministic_steps";
              }
            }
          }
        } else {
          plannerSummaryState.routeReason = "planner_parse_failed";
        }
      }
    }

    if (!plannerHandled) {
      response = await callModel({
        phase: "initial",
        callMessages: messages,
        callSections: messageSections,
        onStreamChunk: activeStreamCallback,
        statefulSessionId: sessionId,
        budgetReason:
          "Initial completion blocked by max model recalls per request budget",
      });

      // Tool call loop — side-effect deduplication prevents the model from
      // repeating desktop actions (e.g. opening 3 YouTube tabs). Once ANY
      // side-effect tool executes, all others are skipped for this request.
      let rounds = 0;
      let sideEffectExecuted = false;
      let remainingToolImageChars = MAX_TOOL_IMAGE_CHARS_BUDGET;
      const emittedRecoveryHints = new Set<string>();
      // Track consecutive identical failing calls to break stuck loops.
      let lastFailKey = "";
      let consecutiveFailCount = 0;
      let consecutiveAllFailedRounds = 0;
      let lastRoundSemanticKey = "";
      let consecutiveSemanticDuplicateRounds = 0;

      while (
        response &&
        response.finishReason === "tool_calls" &&
        response.toolCalls.length > 0 &&
        activeToolHandler &&
        rounds < effectiveMaxToolRounds
      ) {
        // Check for cancellation before each round.
        if (signal?.aborted) {
          setStopReason("cancelled", "Execution cancelled by caller");
          break;
        }
        if (checkRequestTimeout("tool loop")) {
          break;
        }
        const activeCircuit = this.getActiveToolFailureCircuit(sessionId);
        if (activeCircuit) {
          setStopReason("no_progress", activeCircuit.reason);
          break;
        }

        rounds++;
        const roundToolCallStart = allToolCalls.length;
        const activeRoutedToolSet = activeRoutedToolNames.length > 0
          ? new Set(activeRoutedToolNames)
          : null;
        let expandAfterRound = false;

        // Append the assistant message with tool calls.
        pushMessage(
          {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls,
          },
          "assistant_runtime",
        );

        let abortRound = false;
        for (const toolCall of response.toolCalls) {
          if (checkRequestTimeout(`tool "${toolCall.name}" dispatch`)) {
            abortRound = true;
            break;
          }
          if (allToolCalls.length >= effectiveToolBudget) {
            setStopReason(
              "budget_exceeded",
              `Tool budget exceeded (${effectiveToolBudget} per request)`,
            );
            abortRound = true;
            break;
          }

          if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name) && sideEffectExecuted) {
            const skipResult = safeStringify({
              error: `Skipped "${toolCall.name}" — a desktop action was already performed. Combine actions into a single tool call.`,
            });
            pushMessage(
              {
                role: "tool",
                content: skipResult,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              "tools",
            );
            appendToolRecord({
              name: toolCall.name,
              args: {},
              result: skipResult,
              isError: true,
              durationMs: 0,
            });
            continue;
          }
          if (MACOS_SIDE_EFFECT_TOOLS.has(toolCall.name)) sideEffectExecuted = true;

          // Global allowlist check.
          if (this.allowedTools && !this.allowedTools.has(toolCall.name)) {
            const errorResult = safeStringify({
              error: `Tool "${toolCall.name}" is not permitted`,
            });
            pushMessage(
              {
                role: "tool",
                content: errorResult,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              "tools",
            );
            appendToolRecord({
              name: toolCall.name,
              args: {},
              result: errorResult,
              isError: true,
              durationMs: 0,
            });
            continue;
          }
          // Dynamic routed subset check.
          if (activeRoutedToolSet && !activeRoutedToolSet.has(toolCall.name)) {
            routedToolMisses++;
            const errorResult = safeStringify({
              error:
                `Tool "${toolCall.name}" was not available in the routed tool subset for this turn`,
              routingMiss: true,
            });
            pushMessage(
              {
                role: "tool",
                content: errorResult,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              "tools",
            );
            appendToolRecord({
              name: toolCall.name,
              args: {},
              result: errorResult,
              isError: true,
              durationMs: 0,
            });
            if (canExpandOnRoutingMiss && !routedToolsExpanded) {
              expandAfterRound = true;
            }
            continue;
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
            pushMessage(
              {
                role: "tool",
                content: errorResult,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              "tools",
            );
            appendToolRecord({
              name: toolCall.name,
              args: {},
              result: errorResult,
              isError: true,
              durationMs: 0,
            });
            continue;
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
            const remainingRequestMs = getRemainingRequestMs();
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
                const value = await activeToolHandler(toolCall.name, args);
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
              !signal?.aborted &&
              getRemainingRequestMs() > 0;
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
          if (timedOut && toolFailed) {
            setStopReason(
              "timeout",
              `Tool "${toolCall.name}" timed out after ${finalToolTimeoutMs}ms`,
            );
            abortRound = true;
          }

          if (
            this.toolFailureBreakerEnabled &&
            toolFailed
          ) {
            const failKey = ChatExecutor.buildSemanticToolCallKey(toolCall.name, args);
            const circuitReason = this.recordToolFailurePattern(
              sessionId,
              failKey,
              toolCall.name,
            );
            if (circuitReason) {
              setStopReason("no_progress", circuitReason);
              abortRound = true;
              result = enrichToolResultMetadata(result, {
                circuitBreaker: "open",
                circuitBreakerReason: circuitReason,
              });
            }
          }

          appendToolRecord({
            name: toolCall.name,
            args,
            result,
            isError: toolFailed,
            durationMs: toolDuration,
          });

          if (failedToolCalls > effectiveFailureBudget) {
            setStopReason(
              "tool_error",
              `Failure budget exceeded (${failedToolCalls}/${effectiveFailureBudget})`,
            );
            abortRound = true;
          }

          // Track consecutive semantic failures to detect stuck loops.
          const failDetected = toolFailed;
          const semanticToolKey = ChatExecutor.buildSemanticToolCallKey(
            toolCall.name,
            args,
          );
          const failKey = failDetected ? semanticToolKey : "";
          if (!failDetected && this.toolFailureBreakerEnabled) {
            this.clearToolFailurePattern(sessionId, semanticToolKey);
          }
          if (failDetected && failKey === lastFailKey) {
            consecutiveFailCount++;
          } else {
            lastFailKey = failKey;
            consecutiveFailCount = failDetected ? 1 : 0;
          }

          const promptToolContent = ChatExecutor.buildPromptToolContent(
            result,
            remainingToolImageChars,
          );
          remainingToolImageChars = promptToolContent.remainingImageBudget;
          pushMessage(
            {
              role: "tool",
              content: promptToolContent.content,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            },
            "tools",
          );

          if (abortRound) break;
        }

        // Check for cancellation before re-calling LLM.
        if (signal?.aborted) {
          setStopReason("cancelled", "Execution cancelled by caller");
          break;
        }
        if (checkRequestTimeout("tool follow-up")) {
          break;
        }

        const roundCalls = allToolCalls.slice(roundToolCallStart);
        if (abortRound) break;

        // Break stuck loops — if semantically equivalent failing call repeats
        // too many times, stop and surface no-progress.
        if (consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
          setStopReason(
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
            setStopReason(
              "no_progress",
              `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
            );
            break;
          }

          if (roundFailures === roundCalls.length) {
            const roundSemanticKey = roundCalls
              .map((call) =>
                ChatExecutor.buildSemanticToolCallKey(call.name, call.args),
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
              setStopReason(
                "no_progress",
                "Detected repeated semantically equivalent tool rounds with no material progress",
              );
              break;
            }
          }
        }

        const recoveryHints = ChatExecutor.buildRecoveryHints(
          roundCalls,
          emittedRecoveryHints,
        );
        for (const hint of recoveryHints) {
          if (this.maxRuntimeSystemHints <= 0) break;
          const runtimeHintCount = messageSections.filter(
            (section) => section === "system_runtime",
          ).length;
          if (runtimeHintCount >= this.maxRuntimeSystemHints) break;
          pushMessage(
            {
              role: "system",
              content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
            },
            "system_runtime",
          );
        }

        if (expandAfterRound && expandedRoutedToolNames.length > 0) {
          routedToolsExpanded = true;
          activeRoutedToolNames = expandedRoutedToolNames;
          if (this.maxRuntimeSystemHints > 0) {
            const runtimeHintCount = messageSections.filter(
              (section) => section === "system_runtime",
            ).length;
            if (runtimeHintCount < this.maxRuntimeSystemHints) {
              pushMessage(
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
        const nextResponse = await callModel({
          phase: "tool_followup",
          callMessages: messages,
          callSections: messageSections,
          onStreamChunk: activeStreamCallback,
          statefulSessionId: sessionId,
          budgetReason:
            "Max model recalls exceeded while following up after tool calls",
        });
        if (!nextResponse) break;
        response = nextResponse;
      }

      if (signal?.aborted) {
        setStopReason("cancelled", "Execution cancelled by caller");
      } else if (
        response &&
        response.finishReason === "tool_calls" &&
        rounds >= effectiveMaxToolRounds
      ) {
        setStopReason(
          "tool_calls",
          `Reached max tool rounds (${effectiveMaxToolRounds})`,
        );
      }

      // If the LLM returned empty content after tool calls (common when maxToolRounds
      // is hit while the LLM still wanted to make more calls), generate a fallback
      // summary from the last successful tool result.
      finalContent = response?.content ?? "";
      if (!finalContent && allToolCalls.length > 0) {
        finalContent =
          ChatExecutor.generateFallbackContent(allToolCalls) ?? finalContent;
      }
      if (!finalContent && stopReason !== "completed" && stopReasonDetail) {
        finalContent = stopReasonDetail;
      }
    }

    checkRequestTimeout("finalization");

    // Update session token budget with all model calls so far.
    this.trackTokenUsage(sessionId, cumulativeUsage.totalTokens);

    // Response evaluation (optional critic)
    if (this.evaluator && finalContent && stopReason === "completed") {
      const minScore = this.evaluator.minScore ?? 0.7;
      const maxRetries = this.evaluator.maxRetries ?? 1;
      let retryCount = 0;
      let currentContent = finalContent;

      while (retryCount <= maxRetries) {
        if (checkRequestTimeout("response evaluation")) {
          break;
        }
        // Skip evaluation if token budget would be exceeded.
        if (this.sessionTokenBudget !== undefined) {
          const used = this.sessionTokens.get(sessionId) ?? 0;
          if (used >= this.sessionTokenBudget) break;
        }
        if (!hasModelRecallBudget()) {
          setStopReason(
            "budget_exceeded",
            "Max model recalls exceeded during response evaluation",
          );
          break;
        }

        const evalResult = await this.evaluateResponse(currentContent, messageText);
        modelCalls++;
        if (evalResult.usedFallback) usedFallback = true;
        this.accumulateUsage(cumulativeUsage, evalResult.response.usage);
        this.trackTokenUsage(sessionId, evalResult.response.usage.totalTokens);
        callUsage.push(
          this.createCallUsageRecord({
            callIndex: ++callIndex,
            phase: "evaluator",
            providerName: evalResult.providerName,
            response: evalResult.response,
            beforeBudget: evalResult.beforeBudget,
            afterBudget: evalResult.afterBudget,
            budgetDiagnostics: evalResult.budgetDiagnostics,
          }),
        );

        if (evalResult.score >= minScore || retryCount === maxRetries) {
          evaluation = {
            score: evalResult.score,
            feedback: evalResult.feedback,
            passed: evalResult.score >= minScore,
            retryCount,
          };
          finalContent = currentContent;
          break;
        }

        retryCount++;
        pushMessage(
          { role: "assistant", content: currentContent },
          "assistant_runtime",
        );
        pushMessage(
          {
            role: "system",
            content: `Response scored ${evalResult.score.toFixed(2)}. Feedback: ${evalResult.feedback}\nPlease improve your response.`,
          },
          "system_runtime",
        );

        if (!hasModelRecallBudget()) {
          setStopReason(
            "budget_exceeded",
            "Max model recalls exceeded during evaluator retry",
          );
          break;
        }
        if (checkRequestTimeout("evaluator retry")) {
          break;
        }
        let retry: FallbackResult;
        try {
          retry = await this.callWithFallback(
            messages,
            activeStreamCallback,
            messageSections,
            {
              statefulSessionId: sessionId,
              ...(params.toolRouting
                ? { routedToolNames: activeRoutedToolNames }
                : {}),
            },
          );
        } catch (error) {
          const annotated = this.annotateFailureError(
            error,
            "evaluator retry",
          );
          setStopReason(annotated.stopReason, annotated.stopReasonDetail);
          throw annotated.error;
        }
        modelCalls++;
        this.accumulateUsage(cumulativeUsage, retry.response.usage);
        this.trackTokenUsage(sessionId, retry.response.usage.totalTokens);
        callUsage.push(
          this.createCallUsageRecord({
            callIndex: ++callIndex,
            phase: "evaluator_retry",
            providerName: retry.providerName,
            response: retry.response,
            beforeBudget: retry.beforeBudget,
            afterBudget: retry.afterBudget,
            budgetDiagnostics: retry.budgetDiagnostics,
          }),
        );
        providerName = retry.providerName;
        responseModel = retry.response.model;
        if (retry.usedFallback) usedFallback = true;
        currentContent = retry.response.content || currentContent;
      }
    }

    const durationMs = Date.now() - startTime;
    const stopReasonQualityBase = stopReason === "completed"
      ? 0.85
      : stopReason === "tool_calls"
        ? 0.6
        : 0.25;
    const verifierBonus = plannerSummaryState.subagentVerification.performed
      ? (
        plannerSummaryState.subagentVerification.overall === "pass"
          ? 0.1
          : plannerSummaryState.subagentVerification.overall === "retry"
            ? 0
            : -0.15
      )
      : 0;
    const evaluatorBonus = evaluation
      ? (evaluation.passed ? 0.1 : -0.1)
      : 0;
    const failurePenalty = Math.min(0.25, failedToolCalls * 0.05);
    const qualityProxy = Math.max(
      0,
      Math.min(
        1,
        stopReasonQualityBase + verifierBonus + evaluatorBonus - failurePenalty,
      ),
    );
    const rewardSignal = computeDelegationFinalReward({
      qualityProxy,
      tokenCost: cumulativeUsage.totalTokens,
      latencyMs: durationMs,
      errorCount:
        failedToolCalls + (stopReason === "completed" ? 0 : 1),
    });
    const estimatedRecallsAvoided = plannerSummaryState.used
      ? Math.max(
          0,
          plannerSummaryState.deterministicStepsExecuted -
            Math.max(0, modelCalls - plannerSummaryState.plannerCalls),
        )
      : 0;
    const delegatedThisTurn =
      plannerSummaryState.delegationDecision?.shouldDelegate === true;
    const verifierSnapshot = plannerSummaryState.subagentVerification;
    const usefulnessProxy = computeUsefulDelegationProxy({
      delegated: delegatedThisTurn,
      stopReason,
      failedToolCalls,
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
      selectedBanditArm &&
      this.delegationBanditTuner &&
      plannerSummaryState.delegationPolicyTuning.enabled
    ) {
      this.delegationBanditTuner.recordOutcome({
        contextClusterId: trajectoryContextClusterId,
        armId: selectedBanditArm.armId,
        reward: policyReward,
      });
      plannerSummaryState.delegationPolicyTuning = {
        ...plannerSummaryState.delegationPolicyTuning,
        finalReward: policyReward,
        usefulDelegation: usefulnessProxy.useful,
        usefulDelegationScore: usefulnessProxy.score,
        rewardProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
      };
    }

    if (this.delegationTrajectorySink) {
      const selectedTools = activeRoutedToolNames.length > 0
        ? [...activeRoutedToolNames]
        : (this.allowedTools ? [...this.allowedTools] : []);
      this.delegationTrajectorySink.record({
        schemaVersion: 1,
        traceId: trajectoryTraceId,
        turnId: parentTurnId,
        turnType: "parent",
        timestampMs: Date.now(),
        stateFeatures: {
          sessionId,
          contextClusterId: trajectoryContextClusterId,
          complexityScore: plannerDecision.score,
          plannerStepCount: plannerSummaryState.plannedSteps,
          subagentStepCount: plannedSubagentSteps,
          deterministicStepCount: plannedDeterministicSteps,
          synthesisStepCount: plannedSynthesisSteps,
          dependencyDepth: plannedDependencyDepth,
          fanout: plannedFanout,
        },
        action: {
          delegated:
            plannerSummaryState.delegationDecision?.shouldDelegate === true,
          strategyArmId:
            selectedBanditArm?.armId ?? this.delegationDefaultStrategyArmId,
          threshold: tunedDelegationThreshold,
          selectedTools,
          childConfig: {
            maxDepth: this.delegationDecisionConfig.maxDepth,
            maxFanoutPerTurn: this.delegationDecisionConfig.maxFanoutPerTurn,
            timeoutMs: this.requestTimeoutMs,
          },
        },
        immediateOutcome: {
          qualityProxy,
          tokenCost: cumulativeUsage.totalTokens,
          latencyMs: durationMs,
          errorCount:
            failedToolCalls + (stopReason === "completed" ? 0 : 1),
          ...(stopReason !== "completed" ? { errorClass: stopReason } : {}),
        },
        finalReward: rewardSignal,
        metadata: {
          plannerUsed: plannerSummaryState.used,
          routeReason: plannerSummaryState.routeReason ?? "none",
          stopReason,
          usefulDelegation: usefulnessProxy.useful,
          usefulDelegationScore: Number(usefulnessProxy.score.toFixed(4)),
          usefulDelegationProxyVersion: DELEGATION_USEFULNESS_PROXY_VERSION,
        },
      });
    }

    const plannerSummary: ChatPlannerSummary = {
      enabled: plannerSummaryState.enabled,
      used: plannerSummaryState.used,
      routeReason: plannerSummaryState.routeReason,
      complexityScore: plannerSummaryState.complexityScore,
      plannerCalls: plannerSummaryState.plannerCalls,
      plannedSteps: plannerSummaryState.plannedSteps,
      deterministicStepsExecuted: plannerSummaryState.deterministicStepsExecuted,
      estimatedRecallsAvoided: plannerSummaryState.used
        ? estimatedRecallsAvoided
        : 0,
      diagnostics: plannerSummaryState.diagnostics.length > 0
        ? plannerSummaryState.diagnostics
        : undefined,
      delegationDecision: plannerSummaryState.delegationDecision,
      subagentVerification: plannerSummaryState.subagentVerification.enabled
        ? plannerSummaryState.subagentVerification
        : undefined,
      delegationPolicyTuning: plannerSummaryState.delegationPolicyTuning.enabled
        ? plannerSummaryState.delegationPolicyTuning
        : undefined,
    };

    finalContent = ChatExecutor.sanitizeFinalContent(finalContent);
    finalContent = ChatExecutor.reconcileStructuredToolOutcome(
      finalContent,
      allToolCalls,
    );
    const statefulSummary = ChatExecutor.summarizeStateful(callUsage);
    const toolRoutingSummary = params.toolRouting
      ? {
        enabled: true,
        initialToolCount: initialRoutedToolNames.length,
        finalToolCount: activeRoutedToolNames.length,
        routeMisses: routedToolMisses,
        expanded: routedToolsExpanded,
      }
      : undefined;

    return {
      content: finalContent,
      provider: providerName,
      model: responseModel,
      usedFallback,
      toolCalls: allToolCalls,
      tokenUsage: cumulativeUsage,
      callUsage,
      durationMs,
      compacted,
      statefulSummary,
      toolRoutingSummary,
      plannerSummary,
      stopReason,
      stopReasonDetail,
      evaluation,
    };
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

      for (const record of ChatExecutor.pipelineResultToToolCalls(
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
    const beforeBudget = ChatExecutor.estimatePromptShape(messages);
    const budgeted = applyPromptBudget(
      messages.map((message, index) => ({
        message,
        section: messageSections?.[index],
      })),
      this.promptBudget,
    );
    const boundedMessages = budgeted.messages;
    const afterBudget = ChatExecutor.estimatePromptShape(boundedMessages);
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

  private assessPlannerDecision(
    messageText: string,
    history: readonly LLMMessage[],
  ): PlannerDecision {
    if (!this.plannerEnabled) {
      return {
        score: 0,
        shouldPlan: false,
        reason: "planner_disabled",
      };
    }

    let score = 0;
    const reasons: string[] = [];
    const normalized = messageText.toLowerCase();

    const hasMultiStepCue =
      /\b(first|second|third|then|after that|next|finally|step\b|in order|checklist|pipeline)\b/i.test(
        messageText,
      ) ||
      /\b1[\).:]\s+.+\b2[\).:]/s.test(messageText);
    if (hasMultiStepCue) {
      score += 3;
      reasons.push("multi_step_cues");
    }

    const hasToolDiversityCue =
      /\b(browser|http|curl|bash|command|container|playwright|open|navigate|teardown|verify)\b/i.test(
        messageText,
      );
    if (hasToolDiversityCue) {
      score += 1;
      reasons.push("multi_tool_candidates");
    }

    const longTask = messageText.length >= 320 || messageText.split(/\n/).length >= 4;
    if (longTask) {
      score += 1;
      reasons.push("long_or_structured_request");
    }

    const historyTail = history.slice(-10);
    const priorToolMessages = historyTail.filter(
      (entry) => entry.role === "tool",
    ).length;
    if (priorToolMessages >= 4) {
      score += 2;
      reasons.push("prior_tool_loop_activity");
    }
    if (historyTail.some((entry) => typeof entry.content === "string" && entry.content.includes(RECOVERY_HINT_PREFIX))) {
      score += 2;
      reasons.push("prior_no_progress_signal");
    }

    const directFastPath =
      score < 3 ||
      normalized.trim().length < 20 ||
      /\b(hi|hello|thanks|thank you)\b/.test(normalized);

    return {
      score,
      shouldPlan: !directFastPath,
      reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
    };
  }

  private static buildPlannerMessages(
    messageText: string,
    history: readonly LLMMessage[],
    plannerMaxTokens: number,
  ): readonly LLMMessage[] {
    const historyPreview = history
      .slice(-6)
      .map((entry) => {
        const raw =
          typeof entry.content === "string"
            ? entry.content
            : entry.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(" ");
        return `[${entry.role}] ${ChatExecutor.truncateText(raw, 300)}`;
      })
      .join("\n");
    const maxSteps = Math.min(
      MAX_PLANNER_STEPS,
      Math.max(1, Math.floor(plannerMaxTokens / 8)),
    );

    return [
      {
        role: "system",
        content:
          "Plan this request into executable intents. Respond with strict JSON only.\n" +
          "Schema:\n" +
          "{\n" +
          '  "reason": "short routing reason",\n' +
          '  "requiresSynthesis": boolean,\n' +
          '  "steps": [\n' +
          "    {\n" +
          '      "name": "step_name",\n' +
          '      "step_type": "deterministic_tool|subagent_task|synthesis",\n' +
          '      "depends_on": ["step_name"],\n' +
          '      "tool": "tool.name",\n' +
          '      "args": { "key": "value" },\n' +
          '      "onError": "abort|retry|skip",\n' +
          '      "maxRetries": number,\n' +
          '      "objective": "required for subagent_task",\n' +
          '      "input_contract": "required for subagent_task",\n' +
          '      "acceptance_criteria": ["required for subagent_task"],\n' +
          '      "required_tool_capabilities": ["required for subagent_task"],\n' +
          '      "context_requirements": ["required for subagent_task"],\n' +
          '      "max_budget_hint": "required for subagent_task",\n' +
          '      "can_run_parallel": true\n' +
          "    }\n" +
          "  ]\n" +
          "}\n" +
          "Rules:\n" +
          "- deterministic_tool steps are executable by the deterministic pipeline.\n" +
          "- subagent_task steps MUST include all subagent fields.\n" +
          "- synthesis steps describe final merge/synthesis intent and do not call tools.\n" +
          `Keep output concise and below approximately ${plannerMaxTokens} tokens. ` +
          `Never emit more than ${maxSteps} steps.`,
      },
      {
        role: "user",
        content:
          `User request:\n${messageText}\n\n` +
          (historyPreview.length > 0
            ? `Recent conversation context:\n${historyPreview}\n\n`
            : "") +
          "Return JSON only.",
      },
    ];
  }

  private static buildPlannerExecutionContext(
    messageText: string,
    history: readonly LLMMessage[],
    messages: readonly LLMMessage[],
    sections: readonly PromptBudgetSection[],
    parentAllowedTools?: readonly string[],
  ): PipelinePlannerContext {
    const normalizedHistory = ChatExecutor.normalizeHistory(history);
    const historySlice = normalizedHistory
      .slice(-MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES)
      .map((entry) => ({
        role: entry.role,
        content: ChatExecutor.truncateText(
          ChatExecutor.extractLLMMessageText(entry),
          MAX_PLANNER_CONTEXT_HISTORY_CHARS,
        ),
        ...(entry.role === "tool" && entry.toolName
          ? { toolName: entry.toolName }
          : {}),
      }))
      .filter((entry) => entry.content.trim().length > 0);

    const memory: Array<{
      source: PipelinePlannerContextMemorySource;
      content: string;
    }> = [];
    const bySection = (
      section: PromptBudgetSection,
    ): PipelinePlannerContextMemorySource | null => {
      if (section === "memory_semantic") return "memory_semantic";
      if (section === "memory_episodic") return "memory_episodic";
      if (section === "memory_working") return "memory_working";
      return null;
    };
    for (let i = 0; i < messages.length; i++) {
      const source = bySection(sections[i] ?? "history");
      if (!source) continue;
      const message = messages[i];
      if (!message || message.role !== "system") continue;
      const content = ChatExecutor.truncateText(
        ChatExecutor.extractLLMMessageText(message),
        MAX_PLANNER_CONTEXT_MEMORY_CHARS,
      );
      if (content.trim().length === 0) continue;
      memory.push({ source, content });
    }

    const toolOutputs = normalizedHistory
      .filter((entry) => entry.role === "tool")
      .map((entry) => ({
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        content: ChatExecutor.truncateText(
          ChatExecutor.extractLLMMessageText(entry),
          MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS,
        ),
      }))
      .filter((entry) => entry.content.trim().length > 0);

    return {
      parentRequest: ChatExecutor.truncateText(
        messageText,
        MAX_USER_MESSAGE_CHARS,
      ),
      history: historySlice,
      memory,
      toolOutputs,
      ...(parentAllowedTools && parentAllowedTools.length > 0
        ? { parentAllowedTools: [...new Set(parentAllowedTools)] }
        : {}),
    };
  }

  private static parsePlannerPlan(content: string): PlannerParseResult {
    const diagnostics: PlannerDiagnostic[] = [];
    const parsed = ChatExecutor.parseJsonObjectFromText(content);
    if (!parsed) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "parse",
          "invalid_json",
          "Planner output is not parseable JSON object",
        ),
      );
      return { diagnostics };
    }
    if (!Array.isArray(parsed.steps)) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "parse",
          "missing_steps_array",
          'Planner output must include a "steps" array',
        ),
      );
      return { diagnostics };
    }

    const steps: PlannerStepIntent[] = [];
    const unresolvedDependencies = new Map<string, readonly string[]>();
    const nameAliases = new Map<string, string>();
    const usedStepNames = new Set<string>();
    const maxSteps = Math.min(MAX_PLANNER_STEPS, parsed.steps.length);

    for (const [index, rawStep] of parsed.steps.slice(0, maxSteps).entries()) {
      if (
        typeof rawStep !== "object" ||
        rawStep === null ||
        Array.isArray(rawStep)
      ) {
        diagnostics.push(
          ChatExecutor.createPlannerDiagnostic(
            "parse",
            "invalid_step_object",
            `Planner step at index ${index} must be an object`,
            { stepIndex: index },
          ),
        );
        return { diagnostics };
      }
      const step = rawStep as Record<string, unknown>;
      const stepType = ChatExecutor.parsePlannerStepType(step.step_type);
      if (!stepType) {
        diagnostics.push(
          ChatExecutor.createPlannerDiagnostic(
            "parse",
            "invalid_step_type",
            `Planner step at index ${index} has invalid step_type`,
            { stepIndex: index },
          ),
        );
        return { diagnostics };
      }

      const rawName =
        typeof step.name === "string" ? step.name.trim() : "";
      const sanitizedName = ChatExecutor.sanitizePlannerStepName(
        rawName.length > 0 ? rawName : `step_${steps.length + 1}`,
      );
      const safeName = ChatExecutor.dedupePlannerStepName(
        sanitizedName,
        usedStepNames,
      );
      usedStepNames.add(safeName);

      if (rawName.length > 0) {
        if (nameAliases.has(rawName)) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "duplicate_step_name",
              `Planner step name "${rawName}" is duplicated`,
              { stepIndex: index, stepName: rawName },
            ),
          );
          return { diagnostics };
        }
        nameAliases.set(rawName, safeName);
      }
      nameAliases.set(safeName, safeName);

      const dependsOn = ChatExecutor.parsePlannerDependsOn(step.depends_on);
      if (!dependsOn) {
        diagnostics.push(
          ChatExecutor.createPlannerDiagnostic(
            "parse",
            "invalid_depends_on",
            `Planner step "${safeName}" has invalid depends_on`,
            { stepIndex: index, stepName: safeName },
          ),
        );
        return { diagnostics };
      }
      unresolvedDependencies.set(safeName, dependsOn);

      if (stepType === "deterministic_tool") {
        if (typeof step.tool !== "string" || step.tool.trim().length === 0) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_tool_name",
              `Deterministic planner step "${safeName}" must include a non-empty tool name`,
              { stepIndex: index, stepName: safeName },
            ),
          );
          return { diagnostics };
        }
        if (
          step.args !== undefined &&
          (
            typeof step.args !== "object" ||
            step.args === null ||
            Array.isArray(step.args)
          )
        ) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "invalid_tool_args",
              `Planner step "${safeName}" has invalid args; expected JSON object`,
              { stepIndex: index, stepName: safeName },
            ),
          );
          return { diagnostics };
        }
        const args =
          typeof step.args === "object" &&
          step.args !== null &&
          !Array.isArray(step.args)
            ? (step.args as Record<string, unknown>)
            : {};
        const onError =
          step.onError === "retry" ||
          step.onError === "skip" ||
          step.onError === "abort"
            ? step.onError
            : undefined;
        const maxRetries =
          typeof step.maxRetries === "number" && Number.isFinite(step.maxRetries)
            ? Math.max(0, Math.min(5, Math.floor(step.maxRetries)))
            : undefined;
        steps.push({
          name: safeName,
          stepType,
          tool: step.tool.trim(),
          args,
          onError,
          maxRetries,
        });
        continue;
      }

      if (stepType === "subagent_task") {
        const objective = ChatExecutor.parsePlannerRequiredString(step.objective);
        const inputContract = ChatExecutor.parsePlannerRequiredString(
          step.input_contract,
        );
        const acceptanceCriteria = ChatExecutor.parsePlannerStringArray(
          step.acceptance_criteria,
        );
        const requiredToolCapabilities = ChatExecutor.parsePlannerStringArray(
          step.required_tool_capabilities,
        );
        const contextRequirements = ChatExecutor.parsePlannerStringArray(
          step.context_requirements,
        );
        const maxBudgetHint = ChatExecutor.parsePlannerRequiredString(
          step.max_budget_hint,
        );
        const canRunParallel =
          typeof step.can_run_parallel === "boolean"
            ? step.can_run_parallel
            : undefined;
        if (!objective) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing objective`,
              { stepIndex: index, stepName: safeName, field: "objective" },
            ),
          );
          return { diagnostics };
        }
        if (!inputContract) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing input_contract`,
              { stepIndex: index, stepName: safeName, field: "input_contract" },
            ),
          );
          return { diagnostics };
        }
        if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing acceptance_criteria`,
              {
                stepIndex: index,
                stepName: safeName,
                field: "acceptance_criteria",
              },
            ),
          );
          return { diagnostics };
        }
        if (!requiredToolCapabilities || requiredToolCapabilities.length === 0) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing required_tool_capabilities`,
              {
                stepIndex: index,
                stepName: safeName,
                field: "required_tool_capabilities",
              },
            ),
          );
          return { diagnostics };
        }
        if (!contextRequirements || contextRequirements.length === 0) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing context_requirements`,
              {
                stepIndex: index,
                stepName: safeName,
                field: "context_requirements",
              },
            ),
          );
          return { diagnostics };
        }
        if (!maxBudgetHint) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing max_budget_hint`,
              {
                stepIndex: index,
                stepName: safeName,
                field: "max_budget_hint",
              },
            ),
          );
          return { diagnostics };
        }
        if (canRunParallel === undefined) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "missing_subagent_field",
              `Planner subagent step "${safeName}" is missing can_run_parallel`,
              {
                stepIndex: index,
                stepName: safeName,
                field: "can_run_parallel",
              },
            ),
          );
          return { diagnostics };
        }

        steps.push({
          name: safeName,
          stepType,
          objective,
          inputContract,
          acceptanceCriteria,
          requiredToolCapabilities,
          contextRequirements,
          maxBudgetHint,
          canRunParallel,
        });
        continue;
      }

      const objective = ChatExecutor.parsePlannerOptionalString(step.objective);
      steps.push({
        name: safeName,
        stepType,
        ...(objective ? { objective } : {}),
      });
    }

    const knownStepNames = new Set(steps.map((step) => step.name));
    const edges: WorkflowGraphEdge[] = [];
    for (const step of steps) {
      const rawDepends = unresolvedDependencies.get(step.name) ?? [];
      if (rawDepends.length === 0) continue;
      const resolved = new Set<string>();
      for (const dependencyName of rawDepends) {
        const alias = nameAliases.get(dependencyName) ?? dependencyName;
        if (!knownStepNames.has(alias)) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "unknown_dependency",
              `Planner step "${step.name}" depends on unknown step "${dependencyName}"`,
              { stepName: step.name, dependencyName },
            ),
          );
          return { diagnostics };
        }
        if (alias === step.name) {
          diagnostics.push(
            ChatExecutor.createPlannerDiagnostic(
              "parse",
              "self_dependency",
              `Planner step "${step.name}" cannot depend on itself`,
              { stepName: step.name },
            ),
          );
          return { diagnostics };
        }
        if (resolved.has(alias)) continue;
        resolved.add(alias);
        edges.push({ from: alias, to: step.name });
      }
      if (resolved.size > 0) {
        step.dependsOn = [...resolved];
      }
    }

    const cyclePath = ChatExecutor.detectPlannerCycle(
      steps.map((step) => step.name),
      edges,
    );
    if (cyclePath) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "validation",
          "cyclic_dependency",
          "Planner dependency graph contains a cycle",
          {
            cycle: cyclePath.join("->"),
          },
        ),
      );
      return { diagnostics };
    }

    const containsSynthesisStep = steps.some(
      (step) => step.stepType === "synthesis",
    );

    return {
      plan: {
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        confidence: ChatExecutor.parsePlannerConfidence(parsed.confidence),
        requiresSynthesis:
          typeof parsed.requiresSynthesis === "boolean"
            ? parsed.requiresSynthesis || containsSynthesisStep
            : containsSynthesisStep || undefined,
        steps,
        edges,
      },
      diagnostics,
    };
  }

  private static validatePlannerGraph(
    plannerPlan: PlannerPlan,
    config: PlannerGraphValidationConfig,
  ): readonly PlannerDiagnostic[] {
    const diagnostics: PlannerDiagnostic[] = [];
    const subagentSteps = plannerPlan.steps.filter(
      (step): step is PlannerSubAgentTaskStepIntent =>
        step.stepType === "subagent_task",
    );
    if (subagentSteps.length === 0) return diagnostics;

    if (subagentSteps.length > config.maxSubagentFanout) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "validation",
          "subagent_fanout_exceeded",
          `Planner emitted ${subagentSteps.length} subagent tasks but maxFanoutPerTurn is ${config.maxSubagentFanout}`,
          {
            subagentSteps: subagentSteps.length,
            maxFanoutPerTurn: config.maxSubagentFanout,
          },
        ),
      );
    }

    const subagentStepNames = new Set(subagentSteps.map((step) => step.name));
    const subagentEdges = plannerPlan.edges.filter((edge) =>
      subagentStepNames.has(edge.from) && subagentStepNames.has(edge.to)
    );
    const graphDepth = ChatExecutor.computePlannerGraphDepth(
      [...subagentStepNames],
      subagentEdges,
    );
    if (graphDepth.cyclic) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "validation",
          "cyclic_dependency",
          "Planner dependency graph contains a cycle",
        ),
      );
      return diagnostics;
    }
    if (graphDepth.maxDepth > config.maxSubagentDepth) {
      diagnostics.push(
        ChatExecutor.createPlannerDiagnostic(
          "validation",
          "subagent_depth_exceeded",
          `Planner subagent dependency depth ${graphDepth.maxDepth} exceeds maxDepth ${config.maxSubagentDepth}`,
          {
            depth: graphDepth.maxDepth,
            maxDepth: config.maxSubagentDepth,
          },
        ),
      );
    }

    return diagnostics;
  }

  private static createPlannerDiagnostic(
    category: PlannerDiagnostic["category"],
    code: string,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ): PlannerDiagnostic {
    return { category, code, message, ...(details ? { details } : {}) };
  }

  private static isHighRiskSubagentPlan(
    steps: readonly PlannerSubAgentTaskStepIntent[],
  ): boolean {
    for (const step of steps) {
      for (const capability of step.requiredToolCapabilities) {
        const normalized = capability.trim().toLowerCase();
        if (!normalized) continue;
        if (
          normalized.startsWith("wallet.") ||
          normalized.startsWith("solana.") ||
          normalized.startsWith("agenc.") ||
          normalized.startsWith("desktop.") ||
          normalized === "system.delete" ||
          normalized === "system.writefile" ||
          normalized === "system.execute" ||
          normalized === "system.open" ||
          normalized === "system.applescript" ||
          normalized === "system.notification"
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private static detectPlannerCycle(
    nodes: readonly string[],
    edges: readonly WorkflowGraphEdge[],
  ): string[] | null {
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node, []);
    }
    for (const edge of edges) {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
      adjacency.get(edge.from)!.push(edge.to);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const walk = (node: string): string[] | null => {
      if (visiting.has(node)) {
        const loopStart = stack.indexOf(node);
        return loopStart >= 0
          ? [...stack.slice(loopStart), node]
          : [node, node];
      }
      if (visited.has(node)) return null;
      visiting.add(node);
      stack.push(node);
      for (const next of adjacency.get(node) ?? []) {
        const cycle = walk(next);
        if (cycle) return cycle;
      }
      stack.pop();
      visiting.delete(node);
      visited.add(node);
      return null;
    };

    for (const node of nodes) {
      const cycle = walk(node);
      if (cycle) return cycle;
    }
    return null;
  }

  private static computePlannerGraphDepth(
    nodes: readonly string[],
    edges: readonly WorkflowGraphEdge[],
  ): { maxDepth: number; cyclic: boolean } {
    if (nodes.length === 0) return { maxDepth: 0, cyclic: false };
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const depth = new Map<string, number>();

    for (const node of nodes) {
      inDegree.set(node, 0);
      outgoing.set(node, []);
      depth.set(node, 1);
    }
    for (const edge of edges) {
      if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
      outgoing.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [node, nodeInDegree] of inDegree.entries()) {
      if (nodeInDegree === 0) queue.push(node);
    }

    let visited = 0;
    let maxDepth = 1;
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      const nodeDepth = depth.get(node) ?? 1;
      maxDepth = Math.max(maxDepth, nodeDepth);
      for (const next of outgoing.get(node) ?? []) {
        const nextDepth = Math.max(depth.get(next) ?? 1, nodeDepth + 1);
        depth.set(next, nextDepth);
        const nextInDegree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, nextInDegree);
        if (nextInDegree === 0) queue.push(next);
      }
    }

    return {
      maxDepth,
      cyclic: visited !== nodes.length,
    };
  }

  private static parsePlannerStepType(
    value: unknown,
  ): PlannerStepType | undefined {
    return value === "deterministic_tool" ||
      value === "subagent_task" ||
      value === "synthesis"
      ? value
      : undefined;
  }

  private static parsePlannerRequiredString(
    value: unknown,
  ): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private static parsePlannerOptionalString(
    value: unknown,
  ): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private static parsePlannerStringArray(
    value: unknown,
  ): readonly string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return undefined;
      const trimmed = entry.trim();
      if (trimmed.length === 0) return undefined;
      items.push(trimmed);
    }
    return items;
  }

  private static parsePlannerDependsOn(
    value: unknown,
  ): readonly string[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return undefined;
    const items: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return undefined;
      const trimmed = entry.trim();
      if (trimmed.length === 0) return undefined;
      items.push(trimmed);
    }
    return items;
  }

  private static parsePlannerConfidence(
    value: unknown,
  ): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value >= 0 && value <= 1) return value;
    if (value >= 0 && value <= 100) return value / 100;
    return undefined;
  }

  private static sanitizePlannerStepName(name: string): string {
    const trimmed = name.trim();
    const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
    return normalized.length > 0 ? normalized : "step";
  }

  private static dedupePlannerStepName(
    name: string,
    used: ReadonlySet<string>,
  ): string {
    if (!used.has(name)) return name;
    for (let i = 2; i <= 999; i++) {
      const candidate = `${name}_${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${name}_${Date.now().toString(36)}`;
  }

  private static parseJsonObjectFromText(
    content: string,
  ): Record<string, unknown> | undefined {
    const trimmed = content.trim();
    const direct = ChatExecutor.tryParseObject(trimmed);
    if (direct) return direct;

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      return ChatExecutor.tryParseObject(candidate);
    }
    return undefined;
  }

  private static tryParseObject(
    candidate: string,
  ): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  private static isPipelineStopReasonHint(
    value: unknown,
  ): value is Exclude<LLMPipelineStopReason, "completed" | "tool_calls"> {
    return (
      value === "validation_error" ||
      value === "provider_error" ||
      value === "authentication_error" ||
      value === "rate_limited" ||
      value === "timeout" ||
      value === "tool_error" ||
      value === "budget_exceeded" ||
      value === "no_progress" ||
      value === "cancelled"
    );
  }

  private static evaluateSubagentDeterministicChecks(
    subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
    pipelineResult: PipelineResult,
    plannerContext: PipelinePlannerContext,
  ): SubagentVerifierDecision {
    const stepAssessments: SubagentVerifierStepAssessment[] = [];
    const unresolvedItems: string[] = [];
    const artifactCorpus = ChatExecutor.collectVerifierArtifacts(
      pipelineResult,
      plannerContext,
    );
    const artifactText = artifactCorpus.join(" ").toLowerCase();

    for (const step of subagentSteps) {
      const raw = pipelineResult.context.results[step.name];
      const issues: string[] = [];
      let verdict: SubagentVerifierStepVerdict = "pass";
      let retryable = true;
      let output = "";
      let status = "unknown";
      let toolCallsCount = 0;

      if (typeof raw !== "string") {
        issues.push("missing_subagent_result");
        verdict = "retry";
      } else {
        const parsed = ChatExecutor.parseJsonObjectFromText(raw);
        if (!parsed) {
          issues.push("malformed_subagent_result_payload");
          verdict = "retry";
          output = raw;
        } else {
          status = typeof parsed.status === "string"
            ? parsed.status.toLowerCase()
            : "unknown";
          output = typeof parsed.output === "string"
            ? parsed.output
            : safeStringify(parsed.output ?? "");
          toolCallsCount = Array.isArray(parsed.toolCalls)
            ? parsed.toolCalls.length
            : 0;
          if (parsed.success === false || status === "failed") {
            issues.push("child_reported_failure");
            verdict = "retry";
          }
          if (status === "cancelled") {
            issues.push("child_cancelled");
            verdict = "fail";
            retryable = false;
          }
          if (status === "delegation_fallback") {
            issues.push("child_used_parent_fallback");
            verdict = "fail";
            retryable = false;
          }
        }
      }

      const trimmedOutput = output.trim();
      if (trimmedOutput.length === 0) {
        issues.push("empty_child_output");
        verdict = ChatExecutor.moreSevereVerifierVerdict(verdict, "retry");
      }

      const expectsJson = step.inputContract.toLowerCase().includes("json");
      if (expectsJson && trimmedOutput.length > 0) {
        const parsedOutput = ChatExecutor.parseJsonObjectFromText(trimmedOutput);
        if (!parsedOutput) {
          issues.push("contract_violation_expected_json_output");
          verdict = ChatExecutor.moreSevereVerifierVerdict(verdict, "retry");
        }
      }

      const outputLower = trimmedOutput.toLowerCase();
      const likelyEvidence =
        /(line|file|log|trace|stderr|stdout|stack|error|\d)/.test(outputLower);
      if (trimmedOutput.length > 0 && !likelyEvidence) {
        issues.push("weak_evidence_density");
      }

      const expectationTokens = step.acceptanceCriteria
        .flatMap((criterion) =>
          ChatExecutor.extractVerifierTokens(criterion)
        )
        .slice(0, 24);
      if (expectationTokens.length > 0 && trimmedOutput.length > 0) {
        const matched = expectationTokens.some((token) =>
          outputLower.includes(token)
        );
        if (!matched) {
          issues.push("acceptance_criteria_not_evidenced");
        }
      }

      if (
        trimmedOutput.length > 0 &&
        /(according to|as seen in|from the logs|based on)/.test(outputLower) &&
        artifactText.length > 0 &&
        !ChatExecutor.outputIntersectsArtifacts(outputLower, artifactText)
      ) {
        issues.push("hallucination_risk_artifact_mismatch");
        verdict = ChatExecutor.moreSevereVerifierVerdict(verdict, "retry");
      }

      if (step.requiredToolCapabilities.length > 0 && toolCallsCount === 0) {
        issues.push("missing_tool_result_consistency_signal");
      }

      const confidence = Math.max(0, 1 - Math.min(0.9, issues.length * 0.18));
      if (verdict !== "pass" || confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE) {
        unresolvedItems.push(
          `${step.name}:${issues.length > 0 ? issues.join(",") : "low_confidence"}`,
        );
      }
      stepAssessments.push({
        name: step.name,
        verdict,
        confidence,
        retryable,
        issues,
        summary:
          issues.length > 0
            ? issues.join("; ")
            : "deterministic verifier checks passed",
      });
    }

    const overall = ChatExecutor.resolveVerifierOverall(stepAssessments);
    const confidence = stepAssessments.length > 0
      ? Number(
          (
            stepAssessments.reduce((sum, step) => sum + step.confidence, 0) /
            stepAssessments.length
          ).toFixed(4),
        )
      : 1;
    return {
      overall,
      confidence,
      unresolvedItems,
      steps: stepAssessments,
      source: "deterministic",
    };
  }

  private static buildSubagentVerifierMessages(
    systemPrompt: string,
    messageText: string,
    plannerPlan: PlannerPlan,
    subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
    pipelineResult: PipelineResult,
    plannerContext: PipelinePlannerContext,
    deterministicDecision: SubagentVerifierDecision,
  ): readonly LLMMessage[] {
    const artifactBundle = ChatExecutor.collectVerifierArtifacts(
      pipelineResult,
      plannerContext,
    );
    const childBundle = subagentSteps.map((step) => ({
      name: step.name,
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: step.acceptanceCriteria,
      requiredToolCapabilities: step.requiredToolCapabilities,
      rawResult: ChatExecutor.truncateText(
        pipelineResult.context.results[step.name] ?? "missing",
        MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
      ),
    }));
    return [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content:
          "You are a strict verifier for delegated child outputs. " +
          "Assess contract adherence, evidence quality, hallucination risk against provided artifacts, and tool-result consistency. " +
          "Return JSON only with schema: " +
          '{"overall":"pass|retry|fail","confidence":0..1,"unresolved":[string],"steps":[{"name":string,"verdict":"pass|retry|fail","confidence":0..1,"retryable":boolean,"issues":[string],"summary":string}]}.',
      },
      {
        role: "user",
        content: safeStringify({
          request: messageText,
          plannerReason: plannerPlan.reason,
          deterministicVerifier: deterministicDecision,
          childBundle,
          artifacts: artifactBundle.map((entry) =>
            ChatExecutor.truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS)
          ),
        }),
      },
    ];
  }

  private static parseSubagentVerifierDecision(
    content: string,
    subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
  ): SubagentVerifierDecision | undefined {
    const parsed = ChatExecutor.parseJsonObjectFromText(content);
    if (!parsed) return undefined;
    const overallRaw = parsed.overall;
    if (
      overallRaw !== "pass" &&
      overallRaw !== "retry" &&
      overallRaw !== "fail"
    ) {
      return undefined;
    }
    const confidenceRaw = parsed.confidence;
    const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;
    const unresolvedItems = Array.isArray(parsed.unresolved)
      ? parsed.unresolved
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const stepsByName = new Map(subagentSteps.map((step) => [step.name, step]));
    const parsedSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const assessments: SubagentVerifierStepAssessment[] = [];
    for (const entry of parsedSteps) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        continue;
      }
      const obj = entry as Record<string, unknown>;
      const name = ChatExecutor.parsePlannerRequiredString(obj.name);
      if (!name || !stepsByName.has(name)) continue;
      const verdictRaw = obj.verdict;
      if (
        verdictRaw !== "pass" &&
        verdictRaw !== "retry" &&
        verdictRaw !== "fail"
      ) {
        continue;
      }
      const stepConfidenceRaw = obj.confidence;
      const stepConfidence =
        typeof stepConfidenceRaw === "number" && Number.isFinite(stepConfidenceRaw)
          ? Math.max(0, Math.min(1, stepConfidenceRaw))
          : confidence;
      const retryable =
        typeof obj.retryable === "boolean" ? obj.retryable : true;
      const issues = Array.isArray(obj.issues)
        ? obj.issues
            .filter((issue): issue is string => typeof issue === "string")
            .map((issue) => issue.trim())
            .filter((issue) => issue.length > 0)
        : [];
      const summary = ChatExecutor.parsePlannerOptionalString(obj.summary) ??
        (issues.length > 0 ? issues.join("; ") : "verifier assessment");
      assessments.push({
        name,
        verdict: verdictRaw,
        confidence: stepConfidence,
        retryable,
        issues,
        summary,
      });
    }
    if (assessments.length === 0) return undefined;
    return {
      overall: overallRaw,
      confidence,
      unresolvedItems,
      steps: assessments,
      source: "model",
    };
  }

  private static mergeSubagentVerifierDecisions(
    deterministic: SubagentVerifierDecision,
    model: SubagentVerifierDecision,
  ): SubagentVerifierDecision {
    const byName = new Map<string, SubagentVerifierStepAssessment>();
    for (const step of deterministic.steps) {
      byName.set(step.name, step);
    }
    for (const step of model.steps) {
      const existing = byName.get(step.name);
      if (!existing) {
        byName.set(step.name, step);
        continue;
      }
      const mergedVerdict = ChatExecutor.moreSevereVerifierVerdict(
        existing.verdict,
        step.verdict,
      );
      const mergedIssues = [...new Set([...existing.issues, ...step.issues])];
      byName.set(step.name, {
        name: step.name,
        verdict: mergedVerdict,
        confidence: Math.min(existing.confidence, step.confidence),
        retryable: existing.retryable && step.retryable,
        issues: mergedIssues,
        summary:
          mergedIssues.length > 0
            ? mergedIssues.join("; ")
            : "merged verifier checks passed",
      });
    }
    const steps = [...byName.values()];
    const overall = ChatExecutor.resolveVerifierOverall(steps);
    const unresolvedItems = [
      ...new Set([
        ...deterministic.unresolvedItems,
        ...model.unresolvedItems,
        ...steps
          .filter((step) => step.verdict !== "pass")
          .map((step) => `${step.name}:${step.summary}`),
      ]),
    ];
    return {
      overall,
      confidence: Math.min(deterministic.confidence, model.confidence),
      unresolvedItems,
      steps,
      source: "merged",
    };
  }

  private static resolveVerifierOverall(
    steps: readonly SubagentVerifierStepAssessment[],
  ): "pass" | "retry" | "fail" {
    let overall: "pass" | "retry" | "fail" = "pass";
    for (const step of steps) {
      overall = ChatExecutor.moreSevereVerifierVerdict(overall, step.verdict);
      if (overall === "fail") return "fail";
    }
    return overall;
  }

  private static moreSevereVerifierVerdict(
    a: SubagentVerifierStepVerdict,
    b: SubagentVerifierStepVerdict,
  ): SubagentVerifierStepVerdict {
    const weight: Record<SubagentVerifierStepVerdict, number> = {
      pass: 0,
      retry: 1,
      fail: 2,
    };
    return weight[a] >= weight[b] ? a : b;
  }

  private static extractVerifierTokens(value: string): string[] {
    const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
    const deduped = new Set<string>();
    for (const match of matches) {
      if (match.length < 4) continue;
      deduped.add(match);
    }
    return [...deduped];
  }

  private static collectVerifierArtifacts(
    pipelineResult: PipelineResult,
    plannerContext: PipelinePlannerContext,
  ): readonly string[] {
    const artifacts: string[] = [];
    for (const item of plannerContext.toolOutputs ?? []) {
      artifacts.push(item.content);
    }
    for (const item of plannerContext.memory ?? []) {
      artifacts.push(item.content);
    }
    for (const item of Object.values(pipelineResult.context.results)) {
      if (typeof item !== "string") continue;
      artifacts.push(item);
    }
    return artifacts
      .map((entry) => ChatExecutor.truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS))
      .filter((entry) => entry.length > 0)
      .slice(0, 24);
  }

  private static outputIntersectsArtifacts(
    outputLower: string,
    artifactLower: string,
  ): boolean {
    const tokens = ChatExecutor.extractVerifierTokens(outputLower).slice(0, 24);
    return tokens.some((token) =>
      token.length >= 5 && artifactLower.includes(token)
    );
  }

  private static buildPlannerSynthesisMessages(
    systemPrompt: string,
    messageText: string,
    plannerPlan: PlannerPlan,
    pipelineResult: PipelineResult,
    verificationDecision?: SubagentVerifierDecision,
  ): readonly LLMMessage[] {
    const plannerSteps = plannerPlan.steps.map((step) => {
      if (step.stepType === "deterministic_tool") {
        return {
          name: step.name,
          stepType: step.stepType,
          tool: step.tool,
          dependsOn: step.dependsOn,
        };
      }
      if (step.stepType === "subagent_task") {
        return {
          name: step.name,
          stepType: step.stepType,
          objective: step.objective,
          dependsOn: step.dependsOn,
          canRunParallel: step.canRunParallel,
        };
      }
      return {
        name: step.name,
        stepType: step.stepType,
        objective: step.objective,
        dependsOn: step.dependsOn,
      };
    });
    const subagentStepMap = new Map<
      string,
      SubagentVerifierStepAssessment
    >(
      (verificationDecision?.steps ?? []).map((step) => [step.name, step]),
    );
    const childOutputs = plannerPlan.steps
      .filter((step): step is PlannerSubAgentTaskStepIntent => step.stepType === "subagent_task")
      .map((step) => {
        const raw = pipelineResult.context.results[step.name];
        const parsed = typeof raw === "string"
          ? ChatExecutor.parseJsonObjectFromText(raw)
          : undefined;
        const status =
          typeof parsed?.status === "string" ? parsed.status : "unknown";
        const output = typeof parsed?.output === "string"
          ? parsed.output
          : (typeof raw === "string" ? raw : "");
        const marker =
          status === "failed" || status === "cancelled"
            ? status
            : (
                status === "delegation_fallback" ? "unresolved" : "completed"
              );
        const verification = subagentStepMap.get(step.name);
        return {
          name: step.name,
          objective: step.objective,
          status,
          marker,
          confidence: verification?.confidence ?? null,
          verifierVerdict: verification?.verdict ?? null,
          unresolvedIssues: verification?.issues ?? [],
          output: ChatExecutor.truncateText(
            output,
            MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
          ),
          provenanceTag: `[source:${step.name}]`,
        };
      });
    const unresolvedItems = [
      ...(verificationDecision?.unresolvedItems ?? []),
      ...childOutputs
        .filter((child) => child.marker !== "completed")
        .map((child) => `${child.name}:${child.marker}`),
    ];
    const renderedResults = safeStringify({
      plannerReason: plannerPlan.reason,
      status: pipelineResult.status,
      completedSteps: pipelineResult.completedSteps,
      totalSteps: pipelineResult.totalSteps,
      resumeFrom: pipelineResult.resumeFrom,
      error: pipelineResult.error,
      plannerSteps,
      plannerEdges: plannerPlan.edges,
      results: pipelineResult.context.results,
      childOutputs,
      verifier: verificationDecision ?? null,
      unresolvedItems,
    });
    return [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content:
          "Synthesize the final user-facing answer from deterministic workflow and delegated child results. " +
          "Do not invent unexecuted steps and do not call any tools. " +
          "When a major claim is derived from child output, append provenance tags like [source:<step_name>]. " +
          "Explicitly surface unresolved items or failed/cancelled child outputs.",
      },
      {
        role: "user",
        content:
          `Original request:\n${messageText}\n\n` +
          `Workflow execution bundle (with child confidence/provenance markers):\n${renderedResults}`,
      },
    ];
  }

  private static ensureSubagentProvenanceCitations(
    content: string,
    plannerPlan: PlannerPlan,
    pipelineResult: PipelineResult,
  ): string {
    const trimmed = content.trim();
    const subagentStepNames = plannerPlan.steps
      .filter((step): step is PlannerSubAgentTaskStepIntent => step.stepType === "subagent_task")
      .map((step) => step.name)
      .filter((name) =>
        typeof pipelineResult.context.results[name] === "string"
      );
    if (subagentStepNames.length === 0) return content;
    if (/\[source:[^\]]+\]/.test(trimmed)) return content;
    const citationLine = `Sources: ${subagentStepNames
      .map((name) => `[source:${name}]`)
      .join(" ")}`;
    if (trimmed.length === 0) return citationLine;
    return `${content}\n\n${citationLine}`;
  }

  private static pipelineResultToToolCalls(
    steps: readonly PlannerStepIntent[],
    pipelineResult: PipelineResult,
  ): ToolCallRecord[] {
    const records: ToolCallRecord[] = [];
    for (const step of steps) {
      const result = pipelineResult.context.results[step.name];
      if (typeof result !== "string") continue;
      if (step.stepType === "deterministic_tool") {
        const inferredFailure =
          result.startsWith("SKIPPED:") || didToolCallFail(false, result);
        records.push({
          name: step.tool,
          args: step.args,
          result,
          isError: inferredFailure,
          durationMs: 0,
        });
        continue;
      }
      if (step.stepType === "subagent_task") {
        const inferredFailure = ChatExecutor.didSubagentStepFail(result);
        records.push({
          name: "execute_with_agent",
          args: {
            objective: step.objective,
            requiredToolCapabilities: step.requiredToolCapabilities,
            stepName: step.name,
          },
          result,
          isError: inferredFailure,
          durationMs: 0,
        });
      }
    }
    return records;
  }

  private static didSubagentStepFail(result: string): boolean {
    if (result.startsWith("SKIPPED:")) return true;
    try {
      const parsed = JSON.parse(result) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return didToolCallFail(false, result);
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.success === false) return true;
      if (obj.status === "failed" || obj.status === "cancelled") return true;
      if (typeof obj.error === "string" && obj.error.trim().length > 0) {
        return true;
      }
      return false;
    } catch {
      return didToolCallFail(false, result);
    }
  }

  private static buildSemanticToolCallKey(
    name: string,
    args: Record<string, unknown>,
  ): string {
    return `${name}:${ChatExecutor.normalizeSemanticValue(args)}`;
  }

  private static normalizeSemanticValue(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") {
      return value.trim().replace(/\s+/g, " ").toLowerCase();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => ChatExecutor.normalizeSemanticValue(item)).join(",")}]`;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map(
          (key) =>
            `${key}:${ChatExecutor.normalizeSemanticValue(obj[key])}`,
        )
        .join(",")}}`;
    }
    return String(value);
  }

  private static summarizeStateful(
    callUsage: readonly ChatCallUsageRecord[],
  ): ChatStatefulSummary | undefined {
    const entries = callUsage
      .map((entry) => entry.statefulDiagnostics)
      .filter(
        (entry): entry is LLMStatefulDiagnostics =>
          entry !== undefined && entry.enabled,
      );
    if (entries.length === 0) return undefined;

    const fallbackReasons: Record<LLMStatefulFallbackReason, number> = {
      missing_previous_response_id: 0,
      provider_retrieval_failure: 0,
      state_reconciliation_mismatch: 0,
    };
    let attemptedCalls = 0;
    let continuedCalls = 0;
    let fallbackCalls = 0;

    for (const entry of entries) {
      if (entry.attempted) attemptedCalls++;
      if (entry.continued) continuedCalls++;
      if (entry.fallbackReason) {
        fallbackCalls++;
        fallbackReasons[entry.fallbackReason] += 1;
      }
    }

    return {
      enabled: true,
      attemptedCalls,
      continuedCalls,
      fallbackCalls,
      fallbackReasons,
    };
  }

  private static buildRecoveryHints(
    roundCalls: readonly ToolCallRecord[],
    emittedHints: Set<string>,
  ): RecoveryHint[] {
    const hints: RecoveryHint[] = [];
    for (const call of roundCalls) {
      const hint = ChatExecutor.inferRecoveryHint(call);
      if (!hint) continue;
      if (emittedHints.has(hint.key)) continue;
      emittedHints.add(hint.key);
      hints.push(hint);
    }
    return hints;
  }

  private static inferRecoveryHint(
    call: ToolCallRecord,
  ): RecoveryHint | undefined {
    if (!didToolCallFail(call.isError, call.result)) return undefined;

    const failureText = extractToolFailureText(call);
    const failureTextLower = failureText.toLowerCase();

    if (call.name === "system.bash") {
      const command = String(call.args?.command ?? "").trim().toLowerCase();
      const isBuiltin = command.length > 0 && SHELL_BUILTIN_COMMANDS.has(command);
      if (
        isBuiltin ||
        failureTextLower.includes("shell builtin") ||
        /spawn\s+\S+\s+enoent/i.test(failureText)
      ) {
        return {
          key: "system-bash-shell-builtin",
          message:
            "system.bash executes one real binary only. Shell builtins (for example `set`, `cd`, `export`) " +
            "and script-style command chains do not work there. Use executable + args, or move multi-line/chained logic to `desktop.bash`.",
        };
      }
      if (
        failureTextLower.includes("one executable token") ||
        failureTextLower.includes("shell operators/newlines")
      ) {
        return {
          key: "system-bash-command-shape",
          message:
            "system.bash `command` must be a single executable token. Put flags/operands in `args`. " +
            "For pipes/redirection/heredocs or multi-line shell scripts, use `desktop.bash`.",
        };
      }
      if (failureTextLower.includes("nested shell invocation")) {
        return {
          key: "system-bash-shell-reinvocation",
          message:
            "system.bash already runs commands in a shell. Do NOT wrap with `bash -c` or `sh -c`. " +
            "Pass the inner command directly as `command` (omit `args` for shell mode). " +
            'Example: instead of command="bash -c \'curl http://...\'" use command="curl http://...".',
        };
      }
    }

    if (
      call.name === "system.browse" ||
      call.name === "system.httpGet" ||
      call.name === "system.httpPost" ||
      call.name === "system.httpFetch"
    ) {
      if (
        failureTextLower.includes("private/loopback address blocked") ||
        failureTextLower.includes("ssrf target blocked")
      ) {
        return {
          key: "localhost-ssrf-blocked",
          message:
            "system.browse/system.http* block localhost/private/internal addresses by design. " +
            "For local service checks on the HOST, use system.bash with curl (e.g. command=\"curl -sSf http://127.0.0.1:PORT\"). " +
            "Desktop tools run inside Docker and CANNOT reach the host's localhost.",
        };
      }
    }

    return undefined;
  }

  /** Extract plain-text content from a gateway message. */
  private static extractMessageText(message: GatewayMessage): string {
    return typeof message.content === "string" ? message.content : "";
  }

  /** Extract plain-text content from an LLM message. */
  private static extractLLMMessageText(message: LLMMessage): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
  }

  private static truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
    return value.slice(0, maxChars - 3) + "...";
  }

  private static sanitizeFinalContent(content: string): string {
    if (!content) return content;
    const collapsed = ChatExecutor.collapseRunawayRepetition(content);
    if (collapsed.length <= MAX_FINAL_RESPONSE_CHARS) return collapsed;
    return (
      ChatExecutor.truncateText(collapsed, MAX_FINAL_RESPONSE_CHARS) +
      "\n\n[response truncated: oversized model output suppressed]"
    );
  }

  private static reconcileStructuredToolOutcome(
    content: string,
    toolCalls: readonly ToolCallRecord[],
  ): string {
    if (!content || toolCalls.length === 0) return content;
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return content;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return content;
    }

    const payload = parsed as Record<string, unknown>;
    if (typeof payload.overall !== "string" || !Array.isArray(payload.steps)) {
      return content;
    }

    const normalizedOverall = payload.overall.trim().toLowerCase();
    if (normalizedOverall !== "pass") {
      return content;
    }

    const hasToolFailure = toolCalls.some((toolCall) =>
      didToolCallFail(toolCall.isError, toolCall.result),
    );

    const executedTools = new Set(
      toolCalls
        .map((toolCall) => toolCall.name?.trim())
        .filter((name): name is string => Boolean(name)),
    );
    const claimedTools = new Set<string>();
    for (const step of payload.steps) {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        continue;
      }
      const toolName = (step as { tool?: unknown }).tool;
      if (typeof toolName === "string" && toolName.trim().length > 0) {
        claimedTools.add(toolName.trim());
      }
    }

    const claimsUnexecutedTool = Array.from(claimedTools).some(
      (toolName) => !executedTools.has(toolName),
    );

    if (!hasToolFailure && !claimsUnexecutedTool) {
      return content;
    }

    payload.overall = "fail";
    return safeStringify(payload);
  }

  private static collapseRunawayRepetition(content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.length < REPETITIVE_LINE_MIN_COUNT) return content;

    const normalized = lines.map((line) =>
      line.trim().replace(/\s+/g, " ").toLowerCase(),
    );
    const nonEmpty = normalized.filter((line) => line.length > 0);
    if (nonEmpty.length < REPETITIVE_LINE_MIN_COUNT) return content;

    const freq = new Map<string, number>();
    for (const line of nonEmpty) {
      if (line.length > 80) continue;
      freq.set(line, (freq.get(line) ?? 0) + 1);
    }

    let topCount = 0;
    for (const count of freq.values()) {
      if (count > topCount) topCount = count;
    }

    const uniqueRatio = new Set(nonEmpty).size / nonEmpty.length;
    if (
      topCount < REPETITIVE_LINE_MIN_REPEATS ||
      uniqueRatio > REPETITIVE_LINE_MAX_UNIQUE_RATIO
    ) {
      return content;
    }

    const preview = lines.slice(0, 24).join("\n");
    return `${preview}\n\n[response truncated: repetitive model output suppressed]`;
  }

  private static isBase64Like(value: string): boolean {
    if (value.length < 128) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
  }

  private static estimateContentChars(
    content: string | LLMContentPart[],
  ): number {
    if (typeof content === "string") return content.length;
    return content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + part.image_url.url.length;
    }, 0);
  }

  private static estimateMessageChars(message: LLMMessage): number {
    // Small role/metadata overhead for rough token approximation.
    return ChatExecutor.estimateContentChars(message.content) + 64;
  }

  private static estimatePromptShape(
    messages: readonly LLMMessage[],
  ): ChatPromptShape {
    let systemMessages = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolMessages = 0;
    let estimatedChars = 0;
    let systemPromptChars = 0;

    for (const message of messages) {
      estimatedChars += ChatExecutor.estimateMessageChars(message);
      if (message.role === "system") {
        systemMessages++;
        systemPromptChars += ChatExecutor.estimateContentChars(message.content);
      } else if (message.role === "user") {
        userMessages++;
      } else if (message.role === "assistant") {
        assistantMessages++;
      } else if (message.role === "tool") {
        toolMessages++;
      }
    }

    return {
      messageCount: messages.length,
      systemMessages,
      userMessages,
      assistantMessages,
      toolMessages,
      estimatedChars,
      systemPromptChars,
    };
  }

  private static normalizeHistory(history: readonly LLMMessage[]): LLMMessage[] {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    return recent.map((entry) => {
      if (typeof entry.content === "string") {
        if (entry.role === "tool") {
          const prepared = ChatExecutor.prepareToolResultForPrompt(entry.content);
          return { ...entry, content: prepared.text };
        }
        return {
          ...entry,
          content: ChatExecutor.truncateText(
            entry.content,
            MAX_HISTORY_MESSAGE_CHARS,
          ),
        };
      }

      const parts: LLMContentPart[] = entry.content.map((part) => {
        if (part.type === "text") {
          return {
            type: "text" as const,
            text: ChatExecutor.truncateText(
              part.text,
              MAX_HISTORY_MESSAGE_CHARS,
            ),
          };
        }
        // Never replay historical inline images into future prompts.
        return {
          type: "text" as const,
          text: "[prior image omitted]",
        };
      });
      return { ...entry, content: parts };
    });
  }

  private static sanitizeJsonForPrompt(
    value: unknown,
    captureDataUrl: (url: string) => void,
  ): unknown {
    const keyPriority = (key: string): number => {
      const normalized = key.toLowerCase();
      const idx = TOOL_RESULT_PRIORITY_KEYS.indexOf(
        normalized as (typeof TOOL_RESULT_PRIORITY_KEYS)[number],
      );
      return idx >= 0 ? idx : TOOL_RESULT_PRIORITY_KEYS.length + 1;
    };

    if (typeof value === "string") {
      if (value.startsWith("data:image/")) {
        captureDataUrl(value);
        return "(see image)";
      }
      if (ChatExecutor.isBase64Like(value)) {
        return "(base64 omitted)";
      }
      return ChatExecutor.truncateText(value, MAX_TOOL_RESULT_FIELD_CHARS);
    }
    if (Array.isArray(value)) {
      const sanitizedItems = value
        .slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS)
        .map((item) => ChatExecutor.sanitizeJsonForPrompt(item, captureDataUrl));
      const omitted = value.length - sanitizedItems.length;
      if (omitted > 0) {
        sanitizedItems.push(`[${omitted} items omitted]`);
      }
      return sanitizedItems;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const orderedEntries = Object.entries(obj)
        .sort(([a], [b]) => {
          const priorityDelta = keyPriority(a) - keyPriority(b);
          if (priorityDelta !== 0) return priorityDelta;
          return a.localeCompare(b);
        })
        .slice(0, MAX_TOOL_RESULT_OBJECT_KEYS);
      for (const [key, field] of orderedEntries) {
        const keyLower = key.toLowerCase();
        if (typeof field === "string") {
          if (field.startsWith("data:image/")) {
            captureDataUrl(field);
            out[key] = "(see image)";
            continue;
          }
          if (
            keyLower === "image" ||
            keyLower === "dataurl" ||
            keyLower.endsWith("base64")
          ) {
            if (ChatExecutor.isBase64Like(field)) {
              out[key] = "(base64 omitted)";
              continue;
            }
          }
          out[key] = ChatExecutor.truncateText(
            field,
            MAX_TOOL_RESULT_FIELD_CHARS,
          );
          continue;
        }
        out[key] = ChatExecutor.sanitizeJsonForPrompt(field, captureDataUrl);
      }
      const omittedKeys = Object.keys(obj).length - orderedEntries.length;
      if (omittedKeys > 0) {
        out.__truncatedKeys = omittedKeys;
      }
      return out;
    }
    return value;
  }

  private static prepareToolResultForPrompt(result: string): {
    text: string;
    dataUrl?: string;
  } {
    let capturedDataUrl: string | undefined;
    const setDataUrl = (url: string): void => {
      if (!capturedDataUrl) capturedDataUrl = url;
    };

    try {
      const parsed = JSON.parse(result) as unknown;
      const sanitized = ChatExecutor.sanitizeJsonForPrompt(parsed, setDataUrl);
      return {
        text: ChatExecutor.truncateText(
          safeStringify(sanitized),
          MAX_TOOL_RESULT_CHARS,
        ),
        ...(capturedDataUrl ? { dataUrl: capturedDataUrl } : {}),
      };
    } catch {
      const dataUrlMatch = result.match(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/,
      );
      const text = result
        .replace(
          /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
          "(see image)",
        )
        .replace(/"[Ii]mage"\s*:\s*"[A-Za-z0-9+/=\r\n]{128,}"/g, '"image":"(base64 omitted)"')
        .trim();
      return {
        text: ChatExecutor.truncateText(text, MAX_TOOL_RESULT_CHARS),
        ...(dataUrlMatch ? { dataUrl: dataUrlMatch[0] } : {}),
      };
    }
  }

  private static buildPromptToolContent(
    result: string,
    remainingImageBudget: number,
  ): {
    content: string | import("./types.js").LLMContentPart[];
    remainingImageBudget: number;
  } {
    const prepared = ChatExecutor.prepareToolResultForPrompt(result);
    if (!prepared.dataUrl) {
      return { content: prepared.text, remainingImageBudget };
    }

    if (!ENABLE_TOOL_IMAGE_REPLAY) {
      const note = ChatExecutor.truncateText(
        `${prepared.text}\n\n[Image artifact kept out-of-band by default; prefer URL/DOM/text/process checks before visual verification.]`,
        MAX_TOOL_RESULT_CHARS,
      );
      return { content: note, remainingImageBudget };
    }

    // Prevent huge inline screenshots from blowing up prompt size.
    if (prepared.dataUrl.length > remainingImageBudget) {
      const note =
        prepared.text +
        "\n\n[Screenshot omitted from prompt due image context budget]";
      return {
        content: ChatExecutor.truncateText(note, MAX_TOOL_RESULT_CHARS),
        remainingImageBudget,
      };
    }

    return {
      content: [
        { type: "image_url" as const, image_url: { url: prepared.dataUrl } },
        { type: "text" as const, text: prepared.text },
      ],
      remainingImageBudget: remainingImageBudget - prepared.dataUrl.length,
    };
  }

  /** Append a user message, handling multimodal (image) attachments. */
  private static appendUserMessage(
    messages: LLMMessage[],
    sections: PromptBudgetSection[],
    message: GatewayMessage,
  ): void {
    const imageAttachments = (message.attachments ?? []).filter(
      (a) => a.data && a.mimeType.startsWith("image/"),
    );
    const trimmedUserText = ChatExecutor.truncateText(
      message.content,
      MAX_USER_MESSAGE_CHARS,
    );
    if (imageAttachments.length > 0) {
      const contentParts: LLMContentPart[] = [];
      if (trimmedUserText) {
        contentParts.push({ type: "text", text: trimmedUserText });
      }
      for (const att of imageAttachments) {
        const base64 = Buffer.from(att.data!).toString("base64");
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${att.mimeType};base64,${base64}` },
        });
      }
      messages.push({ role: "user", content: contentParts });
      sections.push("user");
    } else {
      messages.push({ role: "user", content: trimmedUserText });
      sections.push("user");
    }
  }

  /**
   * Build a human-readable fallback when the LLM returned empty content
   * after tool calls (e.g. when maxToolRounds is hit mid-loop).
   */
  private static generateFallbackContent(
    allToolCalls: readonly ToolCallRecord[],
  ): string | undefined {
    const successes = allToolCalls.filter((tc) => !tc.isError);
    const lastSuccess = successes[successes.length - 1];
    if (!lastSuccess) return undefined;

    try {
      const parsed = JSON.parse(lastSuccess.result);
      if (parsed.taskPda) {
        return `Task created successfully.\n\n**Task PDA:** ${parsed.taskPda}\n**Transaction:** ${parsed.transactionSignature ?? "confirmed"}`;
      }
      if (parsed.agentPda) {
        return `Agent registered successfully.\n\n**Agent PDA:** ${parsed.agentPda}\n**Transaction:** ${parsed.transactionSignature ?? "confirmed"}`;
      }
      if (
        parsed.success === true ||
        parsed.exitCode === 0 ||
        parsed.output !== undefined
      ) {
        return ChatExecutor.summarizeToolCalls(successes);
      }
      if (parsed.error) {
        return `Something went wrong: ${String(parsed.error).slice(0, MAX_ERROR_PREVIEW_CHARS)}`;
      }
      if (parsed.exitCode != null && parsed.exitCode !== 0) {
        const errOutput = parsed.stderr || parsed.stdout || "";
        return errOutput.trim()
          ? `Command failed: ${String(errOutput).slice(0, MAX_ERROR_PREVIEW_CHARS)}`
          : "The command failed. Let me try a different approach.";
      }
      return `Operation completed. Result:\n\`\`\`json\n${lastSuccess.result.slice(0, MAX_RESULT_PREVIEW_CHARS)}\n\`\`\``;
    } catch {
      return `Operation completed. Result: ${lastSuccess.result.slice(0, MAX_RESULT_PREVIEW_CHARS)}`;
    }
  }

  /** Build a human-readable summary from successful tool calls. */
  private static summarizeToolCalls(
    successes: readonly ToolCallRecord[],
  ): string {
    const summaries: string[] = [];
    for (const tc of successes) {
      if (tc.name === "system.open") {
        const target = String(tc.args?.target ?? "");
        if (target.includes("youtube.com/watch")) {
          summaries.push("Opened YouTube video");
        } else if (target.includes("youtube.com")) {
          summaries.push("Opened YouTube");
        } else if (target) {
          summaries.push(
            `Opened ${target.slice(0, MAX_URL_PREVIEW_CHARS)}`,
          );
        }
      } else if (tc.name === "system.bash") {
        try {
          const bashResult = JSON.parse(tc.result);
          const bashOutput = bashResult.stdout || bashResult.output || "";
          if (bashOutput.trim()) {
            summaries.push(
              bashOutput.trim().slice(0, MAX_BASH_OUTPUT_CHARS),
            );
          } else {
            const cmd = String(tc.args?.command ?? "").slice(
              0,
              MAX_COMMAND_PREVIEW_CHARS,
            );
            if (cmd) summaries.push(`Ran: ${cmd}`);
          }
        } catch {
          const cmd = String(tc.args?.command ?? "").slice(
            0,
            MAX_COMMAND_PREVIEW_CHARS,
          );
          if (cmd) summaries.push(`Ran: ${cmd}`);
        }
      } else if (tc.name === "system.applescript") {
        const script = String(tc.args?.script ?? "");
        if (script.includes("do script")) {
          summaries.push("Opened Terminal and ran the command");
        } else if (script.includes("activate")) {
          summaries.push("Brought app to front");
        } else if (script.includes("quit")) {
          summaries.push("Closed the app");
        } else {
          summaries.push("Done");
        }
      } else if (tc.name === "system.notification") {
        summaries.push("Notification sent");
      } else {
        summaries.push("Done");
      }
    }
    return summaries.length > 0 ? summaries.join("\n") : "Done!";
  }

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
          content: ChatExecutor.truncateText(
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

  private static readonly DEFAULT_EVAL_RUBRIC =
    "Rate this AI response 0.0-1.0. Consider accuracy, completeness, clarity, " +
    "and appropriate use of tool results.\n" +
    'Return ONLY JSON: {"score": 0.0-1.0, "feedback": "brief explanation"}';

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
    const rubric = this.evaluator?.rubric ?? ChatExecutor.DEFAULT_EVAL_RUBRIC;
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
  private static readonly MAX_COMPACT_INPUT = 20_000;

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

    if (historyText.length > ChatExecutor.MAX_COMPACT_INPUT) {
      historyText = historyText.slice(-ChatExecutor.MAX_COMPACT_INPUT);
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
