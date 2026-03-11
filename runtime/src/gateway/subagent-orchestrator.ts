/**
 * SubAgentOrchestrator — planner DAG execution with sub-agent scheduling.
 *
 * Executes planner-emitted DAGs through the existing pipeline executor contract.
 * Supports deterministic tool nodes, subagent task nodes, and synthesis no-op
 * nodes while preserving PipelineResult semantics.
 *
 * @module
 */

import type { DeterministicPipelineExecutor } from "../llm/chat-executor.js";
import type {
  Pipeline,
  PipelineExecutionOptions,
  PipelinePlannerContextHistoryEntry,
  PipelinePlannerContextMemorySource,
  PipelinePlannerContextMemoryEntry,
  PipelinePlannerContextToolOutputEntry,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
  PipelineResult,
  PipelineStopReasonHint,
  PipelineStep,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type {
  SubAgentConfig,
  SubAgentResult,
} from "./sub-agent.js";
import type { HostToolingProfile } from "./host-tooling.js";
import {
  derivePromptBudgetPlan,
  type PromptBudgetConfig,
} from "../llm/prompt-budget.js";
import { resolveDelegatedWorkingDirectory } from "./delegation-tool.js";
import {
  resolveDelegationBudgetHintMs,
} from "./delegation-timeout.js";
import type { LLMUsage } from "../llm/types.js";
import { DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS } from "../llm/chat-executor-constants.js";
import type {
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import {
  assessDelegationScope,
  type DelegationDecompositionSignal,
} from "./delegation-scope.js";
import { sleep } from "../utils/async.js";
import {
  type DelegationOutputValidationCode,
  resolveDelegatedChildToolScope,
  specRequiresSuccessfulToolEvidence,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import {
  didToolCallFail,
  extractToolFailureTextFromResult,
} from "../llm/chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";
import {
  computeDelegationFinalReward,
  deriveDelegationContextClusterId,
  type DelegationTrajectorySink,
} from "../llm/delegation-learning.js";

interface SubAgentExecutionManager {
  spawn(config: SubAgentConfig): Promise<string>;
  getResult(sessionId: string): SubAgentResult | null;
}

export interface SubAgentOrchestratorConfig {
  readonly fallbackExecutor: DeterministicPipelineExecutor;
  readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  readonly resolveLifecycleEmitter?: () => SubAgentLifecycleEmitter | null;
  readonly resolveTrajectorySink?: () => DelegationTrajectorySink | null;
  readonly resolveAvailableToolNames?: () => readonly string[] | null;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  readonly childPromptBudget?: PromptBudgetConfig;
  readonly allowParallelSubtasks?: boolean;
  readonly maxParallelSubtasks?: number;
  readonly pollIntervalMs?: number;
  readonly defaultSubagentTimeoutMs?: number;
  readonly maxDepth?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxTotalSubagentsPerRequest?: number;
  readonly maxCumulativeToolCallsPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured?: boolean;
  readonly childToolAllowlistStrategy?: "inherit_intersection" | "explicit_only";
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior?: "continue_without_delegation" | "fail_request";
}

type SubagentFailureClass =
  | "timeout"
  | "tool_misuse"
  | "malformed_result_contract"
  | "needs_decomposition"
  | "invalid_input"
  | "transient_provider_error"
  | "cancelled"
  | "spawn_error"
  | "unknown";

interface SubagentRetryRule {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

type SubagentFailureOutcome = {
  readonly failureClass: SubagentFailureClass;
  readonly message: string;
  readonly stopReasonHint: PipelineStopReasonHint;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly decomposition?: DelegationDecompositionSignal;
  readonly childSessionId?: string;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly tokenUsage?: LLMUsage;
};

interface ExecuteSubagentAttemptParams {
  readonly subAgentManager: SubAgentExecutionManager;
  readonly step: PipelinePlannerSubagentStep;
  readonly parentSessionId: string;
  readonly parentRequest?: string;
  readonly lastValidationCode?: DelegationOutputValidationCode;
  readonly timeoutMs: number;
  readonly taskPrompt: string;
  readonly diagnostics: SubagentContextDiagnostics;
  readonly tools: readonly string[];
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
}

type ExecuteSubagentAttemptOutcome =
  | {
    readonly status: "completed";
    readonly subagentSessionId: string;
    readonly output: string;
    readonly durationMs: number;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly providerName?: string;
  }
  | {
    readonly status: "failed";
    readonly failure: SubagentFailureOutcome;
  };

type NodeExecutionOutcome =
  | { readonly status: "completed"; readonly result: string }
  | {
    readonly status: "failed";
    readonly error: string;
    readonly stopReasonHint?: PipelineStopReasonHint;
    readonly decomposition?: DelegationDecompositionSignal;
    readonly result?: string;
  }
  | { readonly status: "halted"; readonly error?: string };

interface RuntimeNode {
  readonly step: PipelinePlannerStep;
  readonly dependencies: ReadonlySet<string>;
  readonly orderIndex: number;
}

interface RunningNode {
  readonly promise: Promise<NodeExecutionOutcome>;
  readonly exclusive: boolean;
}

interface DependencySatisfactionState {
  readonly satisfied: boolean;
  readonly reason?: string;
  readonly stopReasonHint?: PipelineStopReasonHint;
}

interface BlockedDependencyDetail {
  readonly stepName: string;
  readonly reason: string;
  readonly stopReasonHint: PipelineStopReasonHint;
}

interface CuratedSection {
  readonly lines: readonly string[];
  readonly selected: number;
  readonly available: number;
  readonly omitted: number;
  readonly truncated: boolean;
}

interface DependencyArtifactCandidate {
  readonly dependencyName: string;
  readonly path: string;
  readonly content: string;
  readonly score: number;
  readonly order: number;
  readonly depth: number;
}

interface DependencyContextEntry {
  readonly dependencyName: string;
  readonly result: string | null;
  readonly depth: number;
  readonly orderIndex: number;
}

interface SubagentPromptBudgetCaps {
  readonly historyChars: number;
  readonly memoryChars: number;
  readonly toolOutputChars: number;
  readonly totalPromptChars: number;
}

interface SubagentContextDiagnostics {
  readonly history: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly memory: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly toolOutputs: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly dependencyArtifacts: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly hostTooling: {
    readonly included: boolean;
    readonly reason: "node_package_tooling" | "not_relevant" | "profile_unavailable";
    readonly nodeVersion?: string;
    readonly npmVersion?: string;
    readonly npmWorkspaceProtocolSupport?: "supported" | "unsupported" | "unknown";
    readonly npmWorkspaceProtocolEvidence?: string;
  };
  readonly promptTruncated: boolean;
  readonly toolScope: {
    readonly strategy: "inherit_intersection" | "explicit_only";
    readonly required: readonly string[];
    readonly parentPolicyAllowed: readonly string[];
    readonly parentPolicyForbidden: readonly string[];
    readonly resolved: readonly string[];
    readonly allowsToollessExecution: boolean;
    readonly semanticFallback: readonly string[];
    readonly removedLowSignalBrowserTools: readonly string[];
    readonly removedByPolicy: readonly string[];
    readonly removedAsDelegationTools: readonly string[];
    readonly removedAsUnknownTools: readonly string[];
  };
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_PARALLEL_SUBTASKS = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
const DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST = 32;
const DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE = 256;
const DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE = 250_000;
const DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP = 150_000;
const DEFAULT_REQUEST_TREE_SUBAGENT_PASSES = Math.max(
  1,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
);
const CONTEXT_TERM_MIN_LENGTH = 3;
const CONTEXT_HISTORY_TAIL_PIN = 2;
const FALLBACK_CONTEXT_HISTORY_CHARS = 2_000;
const FALLBACK_CONTEXT_MEMORY_CHARS = 2_800;
const FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS = 3_200;
const FALLBACK_SUBAGENT_TASK_PROMPT_CHARS = 14_000;
const DEFAULT_FALLBACK_BEHAVIOR = "fail_request" as const;
const REDACTED_IMAGE_DATA_URL = "[REDACTED_IMAGE_DATA_URL]";
const REDACTED_PRIVATE_KEY_BLOCK = "[REDACTED_PRIVATE_KEY_BLOCK]";
const REDACTED_INTERNAL_URL = "[REDACTED_INTERNAL_URL]";
const REDACTED_FILE_URL = "[REDACTED_FILE_URL]";
const REDACTED_BEARER_TOKEN = "Bearer [REDACTED_TOKEN]";
const REDACTED_API_KEY = "[REDACTED_API_KEY]";
const REDACTED_ABSOLUTE_PATH = "[REDACTED_ABSOLUTE_PATH]";
const NODE_PACKAGE_TOOLING_RE =
  /\b(?:node(?:\.js)?|npm|npx|package\.json|package-lock\.json|pnpm|pnpm-workspace\.yaml|yarn|bun|workspaces?|typescript|tsconfig(?:\.[a-z]+)?\.json|tsx|vitest|commander)\b/i;
const NODE_PACKAGE_MANIFEST_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[a-z]+)?\.json)$/i;
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g;
const IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const API_KEY_ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;
const INTERNAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]+\.)*internal)(?::\d+)?(?:\/[^\s"'`)]*)?/gi;
const FILE_URL_RE = /\bfile:\/\/[^\s"'`)]+/gi;
const ABSOLUTE_PATH_RE =
  /(^|[\s"'`])((?:\/home|\/Users|\/root|\/etc|\/var|\/opt|\/srv|\/tmp)\/[^\s"'`]+)/g;
const SUBAGENT_ORCHESTRATION_SECTION_RE =
  /\bsub-agent orchestration plan(?:\s*\((?:required|mandatory)\)|\s+(?:required|mandatory))\s*:[\s\S]*$/i;

function isPipelineStopReasonHint(
  value: unknown,
): value is PipelineStopReasonHint {
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

const SUBAGENT_RETRY_POLICY: Readonly<
  Record<SubagentFailureClass, SubagentRetryRule>
> = {
  timeout: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  tool_misuse: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  malformed_result_contract: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
  needs_decomposition: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  invalid_input: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  transient_provider_error: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 300 },
  cancelled: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  spawn_error: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  unknown: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
};

const SUBAGENT_FAILURE_STOP_REASON: Readonly<
  Record<SubagentFailureClass, PipelineStopReasonHint>
> = {
  timeout: "timeout",
  tool_misuse: "tool_error",
  malformed_result_contract: "validation_error",
  needs_decomposition: "validation_error",
  invalid_input: "validation_error",
  transient_provider_error: "provider_error",
  cancelled: "cancelled",
  spawn_error: "tool_error",
  unknown: "tool_error",
};

function summarizeSubagentFailureHistory(
  stepName: string,
  failures: readonly SubagentFailureOutcome[],
): string {
  if (failures.length === 0) {
    return `Sub-agent step "${stepName}" failed`;
  }

  const uniqueReasons = [
    ...new Set(
      failures
        .map((failure) => failure.message.trim())
        .filter((message) => message.length > 0),
    ),
  ];
  const summarizedReasons = uniqueReasons.slice(0, 4).join("; ");
  const moreCount = uniqueReasons.length - Math.min(uniqueReasons.length, 4);
  const suffix = moreCount > 0 ? `; +${moreCount} more` : "";
  return `Sub-agent step "${stepName}" failed after ${failures.length} attempt${failures.length === 1 ? "" : "s"}: ${summarizedReasons}${suffix}`;
}

function toPipelineStopReasonHint(
  value: unknown,
): PipelineStopReasonHint | undefined {
  switch (value) {
    case "validation_error":
    case "provider_error":
    case "authentication_error":
    case "rate_limited":
    case "timeout":
    case "tool_error":
    case "budget_exceeded":
    case "no_progress":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

class RequestTreeBudgetTracker {
  private spawnedChildren = 0;
  private reservedSpawns = 0;
  private cumulativeToolCalls = 0;
  private cumulativeTokens = 0;
  private circuitBreakerReason: string | null = null;

  constructor(
    private readonly maxTotalSubagentsPerRequest: number,
    private readonly maxCumulativeToolCallsPerRequestTree: number,
    private readonly maxCumulativeTokensPerRequestTree: number,
  ) {}

  reserveSpawn(): string | null {
    if (this.circuitBreakerReason) return this.circuitBreakerReason;
    const projected = this.spawnedChildren + this.reservedSpawns + 1;
    if (projected > this.maxTotalSubagentsPerRequest) {
      this.circuitBreakerReason =
        `max spawned children per request exceeded (${this.maxTotalSubagentsPerRequest})`;
      return this.circuitBreakerReason;
    }
    this.reservedSpawns += 1;
    return null;
  }

  commitSpawnResult(spawned: boolean): void {
    this.reservedSpawns = Math.max(0, this.reservedSpawns - 1);
    if (spawned) this.spawnedChildren += 1;
  }

  recordUsage(toolCallCount: number, tokenCount: number): string | null {
    if (this.circuitBreakerReason) return this.circuitBreakerReason;
    this.cumulativeToolCalls += Math.max(0, Math.floor(toolCallCount));
    this.cumulativeTokens += Math.max(0, Math.floor(tokenCount));
    if (
      this.cumulativeToolCalls > this.maxCumulativeToolCallsPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tool calls per request tree exceeded (${this.maxCumulativeToolCallsPerRequestTree})`;
      return this.circuitBreakerReason;
    }
    if (
      this.cumulativeTokens > this.maxCumulativeTokensPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tokens per request tree exceeded (${this.maxCumulativeTokensPerRequestTree})`;
      return this.circuitBreakerReason;
    }
    return null;
  }
}

export class SubAgentOrchestrator implements DeterministicPipelineExecutor {
  private readonly fallbackExecutor: DeterministicPipelineExecutor;
  private readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  private readonly resolveLifecycleEmitter: () => SubAgentLifecycleEmitter | null;
  private readonly resolveTrajectorySink: () => DelegationTrajectorySink | null;
  private readonly resolveAvailableToolNames: () => readonly string[] | null;
  private readonly resolveHostToolingProfile: () => HostToolingProfile | null;
  private readonly childPromptBudget?: PromptBudgetConfig;
  private readonly allowParallelSubtasks: boolean;
  private readonly maxParallelSubtasks: number;
  private readonly pollIntervalMs: number;
  private readonly defaultSubagentTimeoutMs: number;
  private readonly maxDepth: number;
  private readonly maxFanoutPerTurn: number;
  private readonly maxTotalSubagentsPerRequest: number;
  private readonly maxCumulativeToolCallsPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTreeExplicitlyConfigured: boolean;
  private readonly childToolAllowlistStrategy:
    | "inherit_intersection"
    | "explicit_only";
  private readonly allowedParentTools: ReadonlySet<string>;
  private readonly forbiddenParentTools: ReadonlySet<string>;
  private readonly fallbackBehavior:
    | "continue_without_delegation"
    | "fail_request";

  constructor(config: SubAgentOrchestratorConfig) {
    this.fallbackExecutor = config.fallbackExecutor;
    this.resolveSubAgentManager = config.resolveSubAgentManager;
    this.resolveLifecycleEmitter =
      config.resolveLifecycleEmitter ?? (() => null);
    this.resolveTrajectorySink = config.resolveTrajectorySink ?? (() => null);
    this.resolveAvailableToolNames = config.resolveAvailableToolNames ?? (() => null);
    this.resolveHostToolingProfile =
      config.resolveHostToolingProfile ?? (() => null);
    this.childPromptBudget = config.childPromptBudget;
    this.allowParallelSubtasks = config.allowParallelSubtasks !== false;
    this.maxParallelSubtasks = Math.max(
      1,
      Math.floor(config.maxParallelSubtasks ?? DEFAULT_MAX_PARALLEL_SUBTASKS),
    );
    this.pollIntervalMs = Math.max(
      25,
      Math.floor(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    );
    this.defaultSubagentTimeoutMs = Math.max(
      1_000,
      Math.floor(config.defaultSubagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS),
    );
    this.maxDepth = Math.max(
      1,
      Math.floor(config.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH),
    );
    this.maxFanoutPerTurn = Math.max(
      1,
      Math.floor(config.maxFanoutPerTurn ?? DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN),
    );
    this.maxTotalSubagentsPerRequest = Math.max(
      1,
      Math.floor(
        config.maxTotalSubagentsPerRequest ??
          DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST,
      ),
    );
    this.maxCumulativeToolCallsPerRequestTree = Math.max(
      1,
      Math.floor(
        config.maxCumulativeToolCallsPerRequestTree ??
          DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE,
      ),
    );
    this.maxCumulativeTokensPerRequestTree = Math.max(
      1,
      Math.floor(
        config.maxCumulativeTokensPerRequestTree ??
          DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE,
      ),
    );
    this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured =
      config.maxCumulativeTokensPerRequestTreeExplicitlyConfigured === true;
    this.childToolAllowlistStrategy =
      config.childToolAllowlistStrategy ?? "inherit_intersection";
    this.allowedParentTools = new Set(
      (config.allowedParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.forbiddenParentTools = new Set(
      (config.forbiddenParentTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
    );
    this.fallbackBehavior = config.fallbackBehavior ?? DEFAULT_FALLBACK_BEHAVIOR;
  }

  async execute(
    pipeline: Pipeline,
    startFrom = 0,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    const plannerSteps = pipeline.plannerSteps;
    if (!plannerSteps || plannerSteps.length === 0) {
      return this.fallbackExecutor.execute(pipeline, startFrom, options);
    }

    if (startFrom > 0) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error:
          "SubAgentOrchestrator does not support DAG resume offsets yet (startFrom > 0)",
        stopReasonHint: "validation_error",
      };
    }

    const hardCapError = this.validateSubagentHardCaps(
      plannerSteps,
      pipeline.edges ?? [],
    );
    if (hardCapError) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: hardCapError,
        stopReasonHint: "validation_error",
      };
    }

    const materialized = this.materializeDag(plannerSteps, pipeline.edges ?? []);
    if (materialized.error) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: plannerSteps.length,
        error: materialized.error,
        stopReasonHint: "validation_error",
      };
    }

    const nodes = materialized.nodes;
    const executionOrder = materialized.order;
    const stepByName = new Map(nodes.map((node) => [node.step.name, node]));
    const pending = new Set(executionOrder);
    const satisfied = new Set<string>();
    const unsatisfied = new Map<string, DependencySatisfactionState>();
    const running = new Map<string, RunningNode>();
    const mutableResults: Record<string, string> = { ...pipeline.context.results };
    const totalSteps = plannerSteps.length;
    let completedSteps = 0;
    const blockedStepNames: string[] = [];
    const parentSessionId = this.resolveParentSessionId(pipeline.id);
    const lifecycleEmitter = this.resolveLifecycleEmitter();
    const effectiveMaxCumulativeTokensPerRequestTree =
      this.resolveEffectiveMaxCumulativeTokensPerRequestTree(plannerSteps);
    const budgetTracker = new RequestTreeBudgetTracker(
      this.maxTotalSubagentsPerRequest,
      this.maxCumulativeToolCallsPerRequestTree,
      effectiveMaxCumulativeTokensPerRequestTree,
    );

    const maxParallel = this.resolveMaxParallelism(pipeline.maxParallelism);

    while (pending.size > 0 || running.size > 0) {
      let scheduledAny = false;
      const exclusiveRunning = Array.from(running.values()).some((r) => r.exclusive);

      for (const nodeName of executionOrder) {
        if (!pending.has(nodeName)) continue;
        if (running.size >= maxParallel) break;
        const node = stepByName.get(nodeName);
        if (!node) continue;
        const blockedDependencies = this.collectBlockedDependencies(
          node,
          unsatisfied,
        );
        if (blockedDependencies.length > 0) {
          pending.delete(nodeName);
          blockedStepNames.push(node.step.name);
          const stopReasonHint =
            blockedDependencies[0]?.stopReasonHint ?? "validation_error";
          const error = this.buildDependencyBlockedError(
            node.step.name,
            blockedDependencies,
          );
          mutableResults[node.step.name] = this.buildDependencyBlockedResult(
            node.step.name,
            blockedDependencies,
            error,
            stopReasonHint,
          );
          unsatisfied.set(node.step.name, {
            satisfied: false,
            reason: error,
            stopReasonHint,
          });
          if (node.step.stepType === "subagent_task") {
            lifecycleEmitter?.emit({
              type: "subagents.failed",
              timestamp: Date.now(),
              sessionId: parentSessionId,
              parentSessionId,
              toolName: "execute_with_agent",
              payload: {
                stepName: node.step.name,
                stage: "dependency_blocked",
                reason: error,
                unmetDependencies: blockedDependencies.map((dependency) => ({
                  stepName: dependency.stepName,
                  reason: dependency.reason,
                  stopReasonHint: dependency.stopReasonHint,
                })),
              },
            });
          }
          continue;
        }
        if (!this.dependenciesSatisfied(node, satisfied)) continue;

        const exclusiveNode = this.isExclusiveNode(node.step);
        if (exclusiveRunning) break;
        if (exclusiveNode && running.size > 0) continue;

        const promise = this.executeNode(
          node.step,
          pipeline,
          mutableResults,
          budgetTracker,
          options,
        );
        running.set(node.step.name, { promise, exclusive: exclusiveNode });
        pending.delete(node.step.name);
        scheduledAny = true;

        if (exclusiveNode) break;
      }

      if (running.size === 0) {
        if (pending.size === 0) {
          break;
        }
        return {
          status: "failed",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error:
            "Planner DAG has no runnable nodes; dependency graph may be invalid",
          stopReasonHint: "validation_error",
        };
      }

      if (!scheduledAny && running.size > 0) {
        // No-op; await active nodes below.
      }

      const completion = await Promise.race(
        Array.from(running.entries()).map(([name, handle]) =>
          handle.promise.then((outcome) => ({ name, outcome }))
        ),
      );

      running.delete(completion.name);
      const node = stepByName.get(completion.name);
      if (!node) {
        return {
          status: "failed",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          error: `Unknown node "${completion.name}" completed`,
        };
      }

      if (completion.outcome.status === "completed") {
        mutableResults[node.step.name] = completion.outcome.result;
        const satisfaction = this.assessDependencySatisfaction(
          node.step,
          completion.outcome.result,
        );
        if (satisfaction.satisfied) {
          satisfied.add(node.step.name);
        } else {
          unsatisfied.set(node.step.name, satisfaction);
        }
        completedSteps++;
        continue;
      }

      if (completion.outcome.status === "halted") {
        return {
          status: "halted",
          context: { results: { ...mutableResults } },
          completedSteps,
          totalSteps,
          resumeFrom: node.orderIndex,
          error: completion.outcome.error,
        };
      }

      if (typeof completion.outcome.result === "string") {
        mutableResults[node.step.name] = completion.outcome.result;
      }
      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error: completion.outcome.error,
        decomposition: completion.outcome.decomposition,
        stopReasonHint: completion.outcome.stopReasonHint,
      };
    }

    if (blockedStepNames.length > 0) {
      const primaryBlockedStep = blockedStepNames[0];
      const primaryAssessment = primaryBlockedStep
        ? unsatisfied.get(primaryBlockedStep)
        : undefined;
      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error:
          blockedStepNames.length === 1
            ? (primaryAssessment?.reason ??
              `Planner step "${primaryBlockedStep}" was blocked by an unmet dependency`)
            : (
                `Planner DAG blocked ${blockedStepNames.length} step(s) after unmet dependency ` +
                `contracts: ${blockedStepNames.join(", ")}`
              ),
        stopReasonHint: primaryAssessment?.stopReasonHint ?? "validation_error",
      };
    }

    return {
      status: "completed",
      context: { results: { ...mutableResults } },
      completedSteps,
      totalSteps,
    };
  }

  private resolveMaxParallelism(pipelineMaxParallelism?: number): number {
    if (!this.allowParallelSubtasks) return 1;
    const pipelineCap =
      typeof pipelineMaxParallelism === "number" &&
      Number.isFinite(pipelineMaxParallelism)
        ? Math.max(1, Math.floor(pipelineMaxParallelism))
        : this.maxParallelSubtasks;
    return Math.max(1, Math.min(this.maxParallelSubtasks, pipelineCap));
  }

  private validateSubagentHardCaps(
    steps: readonly PipelinePlannerStep[],
    edges: readonly WorkflowGraphEdge[],
  ): string | null {
    const subagentSteps = steps.filter(
      (step): step is PipelinePlannerSubagentStep =>
        step.stepType === "subagent_task",
    );
    if (subagentSteps.length === 0) return null;
    if (subagentSteps.length > this.maxFanoutPerTurn) {
      return (
        `Planner emitted ${subagentSteps.length} subagent tasks but maxFanoutPerTurn ` +
        `is ${this.maxFanoutPerTurn}`
      );
    }

    const subagentNames = new Set(subagentSteps.map((step) => step.name));
    const dependencies = new Map<string, Set<string>>();
    for (const step of subagentSteps) {
      const fromDependsOn = (step.dependsOn ?? []).filter((dep) =>
        subagentNames.has(dep),
      );
      dependencies.set(step.name, new Set(fromDependsOn));
    }
    for (const edge of edges) {
      if (!subagentNames.has(edge.from) || !subagentNames.has(edge.to)) continue;
      dependencies.get(edge.to)?.add(edge.from);
    }

    const visiting = new Set<string>();
    const memo = new Map<string, number>();
    const visit = (node: string): number => {
      if (memo.has(node)) return memo.get(node)!;
      if (visiting.has(node)) return Number.POSITIVE_INFINITY;
      visiting.add(node);
      let maxDepth = 1;
      for (const dep of dependencies.get(node) ?? []) {
        const depDepth = visit(dep);
        if (!Number.isFinite(depDepth)) {
          visiting.delete(node);
          return Number.POSITIVE_INFINITY;
        }
        maxDepth = Math.max(maxDepth, depDepth + 1);
      }
      visiting.delete(node);
      memo.set(node, maxDepth);
      return maxDepth;
    };

    let observedDepth = 1;
    for (const step of subagentSteps) {
      observedDepth = Math.max(observedDepth, visit(step.name));
      if (!Number.isFinite(observedDepth)) {
        return "Planner subagent dependency graph contains a cycle";
      }
    }
    return null;
  }

  private materializeDag(
    steps: readonly PipelinePlannerStep[],
    edges: readonly WorkflowGraphEdge[],
  ): { nodes: RuntimeNode[]; order: string[]; error?: string } {
    const stepByName = new Map<string, PipelinePlannerStep>();
    for (const step of steps) {
      if (stepByName.has(step.name)) {
        return {
          nodes: [],
          order: [],
          error: `Planner DAG has duplicate step name "${step.name}"`,
        };
      }
      stepByName.set(step.name, step);
    }

    const dependencyMap = new Map<string, Set<string>>();
    for (const step of steps) {
      dependencyMap.set(step.name, new Set(step.dependsOn ?? []));
    }
    for (const edge of edges) {
      if (!stepByName.has(edge.from) || !stepByName.has(edge.to)) continue;
      dependencyMap.get(edge.to)!.add(edge.from);
    }

    for (const [stepName, dependencies] of dependencyMap.entries()) {
      for (const dependency of dependencies) {
        if (!stepByName.has(dependency)) {
          return {
            nodes: [],
            order: [],
            error:
              `Planner DAG step "${stepName}" has unknown dependency "${dependency}"`,
          };
        }
      }
    }

    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const stepIndex = new Map<string, number>();
    for (const [index, step] of steps.entries()) {
      stepIndex.set(step.name, index);
      inDegree.set(step.name, dependencyMap.get(step.name)?.size ?? 0);
      outgoing.set(step.name, []);
    }
    for (const [nodeName, dependencies] of dependencyMap.entries()) {
      for (const dep of dependencies) {
        outgoing.get(dep)!.push(nodeName);
      }
    }

    const queue: string[] = [];
    for (const [nodeName, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(nodeName);
    }
    queue.sort((a, b) => (stepIndex.get(a) ?? 0) - (stepIndex.get(b) ?? 0));

    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const next of outgoing.get(node) ?? []) {
        const nextDegree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, nextDegree);
        if (nextDegree === 0) {
          queue.push(next);
        }
      }
      queue.sort((a, b) => (stepIndex.get(a) ?? 0) - (stepIndex.get(b) ?? 0));
    }

    if (order.length !== steps.length) {
      return {
        nodes: [],
        order: [],
        error: "Planner DAG contains a cycle",
      };
    }

    const nodes = steps.map((step, index) => ({
      step,
      dependencies: dependencyMap.get(step.name) ?? new Set<string>(),
      orderIndex: index,
    }));

    return { nodes, order };
  }

  private dependenciesSatisfied(
    node: RuntimeNode,
    completed: ReadonlySet<string>,
  ): boolean {
    for (const dependency of node.dependencies) {
      if (!completed.has(dependency)) return false;
    }
    return true;
  }

  private collectBlockedDependencies(
    node: RuntimeNode,
    unsatisfied: ReadonlyMap<string, DependencySatisfactionState>,
  ): readonly BlockedDependencyDetail[] {
    const blocked: BlockedDependencyDetail[] = [];
    for (const dependency of node.dependencies) {
      const state = unsatisfied.get(dependency);
      if (!state || state.satisfied) continue;
      blocked.push({
        stepName: dependency,
        reason:
          state.reason ??
          `Planner step "${dependency}" did not satisfy its dependency contract`,
        stopReasonHint: state.stopReasonHint ?? "validation_error",
      });
    }
    return blocked;
  }

  private buildDependencyBlockedError(
    stepName: string,
    blockedDependencies: readonly BlockedDependencyDetail[],
  ): string {
    const primary = blockedDependencies[0];
    if (!primary) {
      return `Planner step "${stepName}" was blocked by an unmet dependency`;
    }
    if (blockedDependencies.length === 1) {
      return (
        `Planner step "${stepName}" was blocked by unmet dependency ` +
        `"${primary.stepName}": ${primary.reason}`
      );
    }
    return (
      `Planner step "${stepName}" was blocked by ${blockedDependencies.length} unmet ` +
      `dependencies; first blocker "${primary.stepName}": ${primary.reason}`
    );
  }

  private buildDependencyBlockedResult(
    stepName: string,
    blockedDependencies: readonly BlockedDependencyDetail[],
    error: string,
    stopReasonHint: PipelineStopReasonHint,
  ): string {
    return safeStringify({
      status: "dependency_blocked",
      success: false,
      stepName,
      error,
      stopReasonHint,
      unmetDependencies: blockedDependencies.map((dependency) => ({
        stepName: dependency.stepName,
        reason: dependency.reason,
        stopReasonHint: dependency.stopReasonHint,
      })),
    });
  }

  private assessDependencySatisfaction(
    step: PipelinePlannerStep,
    result: string,
  ): DependencySatisfactionState {
    if (step.stepType === "deterministic_tool") {
      if (result.startsWith("SKIPPED:")) {
        const reason = result.slice("SKIPPED:".length).trim();
        return {
          satisfied: false,
          reason:
            reason.length > 0
              ? reason
              : `Planner step "${step.name}" was skipped`,
          stopReasonHint: "tool_error",
        };
      }
      if (didToolCallFail(false, result)) {
        return {
          satisfied: false,
          reason: extractToolFailureTextFromResult(result),
          stopReasonHint: "tool_error",
        };
      }
      return { satisfied: true };
    }
    if (step.stepType === "subagent_task") {
      if (result.startsWith("SKIPPED:")) {
        const reason = result.slice("SKIPPED:".length).trim();
        return {
          satisfied: false,
          reason:
            reason.length > 0
              ? reason
              : `Sub-agent step "${step.name}" was skipped`,
          stopReasonHint: "validation_error",
        };
      }
      try {
        const parsed = JSON.parse(result) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const obj = parsed as Record<string, unknown>;
          const status =
            typeof obj.status === "string" ? obj.status : undefined;
          const error =
            typeof obj.error === "string" && obj.error.trim().length > 0
              ? obj.error.trim()
              : undefined;
          if (
            obj.success === false ||
            status === "failed" ||
            status === "cancelled" ||
            status === "delegation_fallback" ||
            status === "needs_decomposition" ||
            status === "dependency_blocked"
          ) {
            return {
              satisfied: false,
              reason:
                error ??
                `Sub-agent step "${step.name}" returned unresolved status "${status ?? "unknown"}"`,
              stopReasonHint:
                (isPipelineStopReasonHint(obj.stopReasonHint)
                  ? obj.stopReasonHint
                  : undefined) ??
                (status === "cancelled"
                  ? "cancelled"
                  : "validation_error"),
            };
          }
          if (error) {
            return {
              satisfied: false,
              reason: error,
              stopReasonHint:
                isPipelineStopReasonHint(obj.stopReasonHint)
                  ? obj.stopReasonHint
                  : "validation_error",
            };
          }
        }
      } catch {
        if (didToolCallFail(false, result)) {
          return {
            satisfied: false,
            reason: extractToolFailureTextFromResult(result),
            stopReasonHint: "tool_error",
          };
        }
      }
    }
    return { satisfied: true };
  }

  private isExclusiveNode(step: PipelinePlannerStep): boolean {
    if (!this.allowParallelSubtasks) return true;
    if (step.stepType === "subagent_task") {
      return !step.canRunParallel;
    }
    return false;
  }

  private async executeNode(
    step: PipelinePlannerStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
    options?: PipelineExecutionOptions,
  ): Promise<NodeExecutionOutcome> {
    if (step.stepType === "deterministic_tool") {
      return this.executeDeterministicStep(step, pipeline, results, options);
    }
    if (step.stepType === "subagent_task") {
      return this.executeSubagentStep(step, pipeline, results, budgetTracker);
    }
    // Synthesis node is materialized as a no-op execution marker.
    return {
      status: "completed",
      result: safeStringify({
        deferred: true,
        type: "synthesis",
        objective: step.objective ?? null,
      }),
    };
  }

  private async executeDeterministicStep(
    step: PipelinePlannerDeterministicStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    options?: PipelineExecutionOptions,
  ): Promise<NodeExecutionOutcome> {
    const singleStep: PipelineStep = {
      name: step.name,
      tool: step.tool,
      args: step.args,
      onError: step.onError,
      maxRetries: step.maxRetries,
    };
    const stepPipeline: Pipeline = {
      id: `${pipeline.id}:${step.name}`,
      createdAt: pipeline.createdAt,
      context: { results: { ...results } },
      steps: [singleStep],
    };
    const outcome = await this.fallbackExecutor.execute(
      stepPipeline,
      0,
      options,
    );
    if (outcome.status === "halted") {
      return {
        status: "halted",
        error: outcome.error ?? `Deterministic step "${step.name}" halted`,
      };
    }
    if (outcome.status === "failed") {
      return {
        status: "failed",
        error:
          outcome.error ?? `Deterministic step "${step.name}" failed`,
        stopReasonHint: outcome.stopReasonHint ?? "tool_error",
      };
    }
    const result = outcome.context.results[step.name];
    if (typeof result === "string") {
      return { status: "completed", result };
    }
    return {
      status: "completed",
      result: safeStringify({
        status: outcome.status,
        result: result ?? null,
      }),
    };
  }

  private async executeSubagentStep(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
  ): Promise<NodeExecutionOutcome> {
    const subAgentManager = this.resolveSubAgentManager();
    if (!subAgentManager) {
      return {
        status: "failed",
        error:
          `Sub-agent manager unavailable for planner step "${step.name}"`,
        stopReasonHint: "tool_error",
      };
    }

    const parentSessionId = this.resolveParentSessionId(pipeline.id);
    const lifecycleEmitter = this.resolveLifecycleEmitter();
    lifecycleEmitter?.emit({
      type: "subagents.planned",
      timestamp: Date.now(),
      sessionId: parentSessionId,
      parentSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: step.name,
        objective: step.objective,
      },
    });

    const timeoutMs = this.parseBudgetHintMs(step.maxBudgetHint);
    const toolScope = this.deriveChildToolAllowlist(step, pipeline);
    if (toolScope.blockedReason) {
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          stage: "validation",
          reason: toolScope.blockedReason,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error: toolScope.blockedReason,
        stopReasonHint: "validation_error",
      };
    }
    if (toolScope.allowedTools.length === 0 && !toolScope.allowsToollessExecution) {
      const error =
        `No permitted child tools remain for step "${step.name}" after policy scoping`;
      lifecycleEmitter?.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          stage: "validation",
          reason: error,
          removedLowSignalBrowserTools: toolScope.removedLowSignalBrowserTools,
          removedByPolicy: toolScope.removedByPolicy,
          removedAsDelegationTools: toolScope.removedAsDelegationTools,
          removedAsUnknownTools: toolScope.removedAsUnknownTools,
          semanticFallback: toolScope.semanticFallback,
        },
      });
      return {
        status: "failed",
        error,
        stopReasonHint: "validation_error",
      };
    }
    const subagentTask = this.buildSubagentTaskPrompt(
      step,
      pipeline,
      results,
      toolScope,
    );
    const plannerSteps = pipeline.plannerSteps ?? [];
    const subagentStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "subagent_task",
    ).length;
    const deterministicStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "deterministic_tool",
    ).length;
    const synthesisStepCount = plannerSteps.filter(
      (plannerStep) => plannerStep.stepType === "synthesis",
    ).length;
    const stepComplexityScore = Math.min(
      10,
      Math.max(
        1,
        1 +
          step.acceptanceCriteria.length +
          step.requiredToolCapabilities.length +
          Math.min(3, step.contextRequirements.length),
      ),
    );
    const childContextClusterId = deriveDelegationContextClusterId({
      complexityScore: stepComplexityScore,
      subagentStepCount: Math.max(1, subagentStepCount),
      hasHistory: (pipeline.plannerContext?.history.length ?? 0) > 0,
      highRiskPlan: this.hasHighRiskCapabilities(step.requiredToolCapabilities),
    });
    const parentTurnId = `parent:${parentSessionId}:${pipeline.createdAt}`;
    const trajectoryTraceId = `trace:${parentSessionId}:${pipeline.createdAt}`;
    const retryAttempts = this.createRetryAttemptTracker();
    let attempt = 0;
    let lastFailure: SubagentFailureOutcome | null = null;
    const failureHistory: SubagentFailureOutcome[] = [];
    let taskPrompt = subagentTask.taskPrompt;

    while (true) {
      attempt += 1;
      const reservationError = budgetTracker.reserveSpawn();
      if (reservationError) {
        lifecycleEmitter?.emit({
          type: "subagents.failed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: step.name,
            stage: "circuit_breaker",
            reason: reservationError,
            attempt,
          },
        });
        return {
          status: "failed",
          error:
            `Sub-agent circuit breaker opened for step "${step.name}": ${reservationError}`,
          stopReasonHint: "budget_exceeded",
        };
      }
      const attemptOutcome = await this.executeSubagentAttempt({
        subAgentManager,
        step,
        parentSessionId,
        parentRequest: pipeline.plannerContext?.parentRequest,
        lastValidationCode: lastFailure?.validationCode,
        timeoutMs,
        taskPrompt,
        diagnostics: subagentTask.diagnostics,
        tools: toolScope.allowedTools,
        lifecycleEmitter,
      });
      const spawnedChild =
        attemptOutcome.status === "completed"
          ? true
          : Boolean(attemptOutcome.failure.childSessionId);
      budgetTracker.commitSpawnResult(spawnedChild);
      if (attemptOutcome.status === "completed") {
        this.recordSubagentTrajectory({
          traceId: trajectoryTraceId,
          turnId:
            `child:${step.name}:${attempt}:${attemptOutcome.subagentSessionId}`,
          parentTurnId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          step,
          stepComplexityScore,
          contextClusterId: childContextClusterId,
          plannerStepCount: plannerSteps.length,
          subagentStepCount,
          deterministicStepCount,
          synthesisStepCount,
          dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
          fanout: Math.max(1, subagentStepCount),
          tools: toolScope.allowedTools,
          timeoutMs,
          delegated: true,
          strategyArmId: "balanced",
          qualityProxy: 0.9,
          tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
          latencyMs: attemptOutcome.durationMs,
          errorCount: 0,
          metadata: {
            success: true,
            attempt,
            pipelineId: pipeline.id,
            toolCalls: attemptOutcome.toolCalls.length,
            stepName: step.name,
            providerName: attemptOutcome.providerName ?? "unknown",
          },
        });
        const usageBreach = budgetTracker.recordUsage(
          attemptOutcome.toolCalls.length,
          attemptOutcome.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${step.name}:${attempt}:${attemptOutcome.subagentSessionId}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            step,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.2,
            tokenCost: attemptOutcome.tokenUsage?.totalTokens ?? 0,
            latencyMs: attemptOutcome.durationMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: step.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolName: "execute_with_agent",
            payload: {
              stepName: step.name,
              stage: "circuit_breaker",
              reason: usageBreach,
              attempt,
            },
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${usageBreach}`,
            stopReasonHint: "budget_exceeded",
          };
        }
        return {
          status: "completed",
          result: safeStringify({
            status: "completed",
            subagentSessionId: attemptOutcome.subagentSessionId,
            output: attemptOutcome.output,
            success: true,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage ?? null,
            providerName: attemptOutcome.providerName ?? null,
            attempts: attempt,
            retryPolicy: retryAttempts,
          }),
        };
      }

      lastFailure = attemptOutcome.failure;
      failureHistory.push(lastFailure);
      if (spawnedChild) {
        const usageBreach = budgetTracker.recordUsage(
          lastFailure.toolCallCount ?? 0,
          lastFailure.tokenUsage?.totalTokens ?? 0,
        );
        if (usageBreach) {
          this.recordSubagentTrajectory({
            traceId: trajectoryTraceId,
            turnId:
              `child:${step.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}:budget`,
            parentTurnId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            step,
            stepComplexityScore,
            contextClusterId: childContextClusterId,
            plannerStepCount: plannerSteps.length,
            subagentStepCount,
            deterministicStepCount,
            synthesisStepCount,
            dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
            fanout: Math.max(1, subagentStepCount),
            tools: toolScope.allowedTools,
            timeoutMs,
            delegated: true,
            strategyArmId: "balanced",
            qualityProxy: 0.1,
            tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
            latencyMs: lastFailure.durationMs ?? timeoutMs,
            errorCount: 1,
            errorClass: "budget_exceeded",
            metadata: {
              success: false,
              attempt,
              pipelineId: pipeline.id,
              stepName: step.name,
              stage: "circuit_breaker",
            },
          });
          lifecycleEmitter?.emit({
            type: "subagents.failed",
            timestamp: Date.now(),
            sessionId: parentSessionId,
            parentSessionId,
            subagentSessionId: lastFailure.childSessionId,
            toolName: "execute_with_agent",
            payload: {
              stepName: step.name,
              stage: "circuit_breaker",
              reason: usageBreach,
              attempt,
            },
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${usageBreach}`,
            stopReasonHint: "budget_exceeded",
          };
        }
      }
      const retryRule = SUBAGENT_RETRY_POLICY[lastFailure.failureClass];
      const retriesUsed = retryAttempts[lastFailure.failureClass];
      const shouldRetry =
        lastFailure.validationCode !== "blocked_phase_output" &&
        retriesUsed < retryRule.maxRetries;
      const retryAttempt = retriesUsed + 1;
      const retryDelayMs = shouldRetry
        ? this.computeRetryDelayMs(retryRule, retryAttempt)
        : 0;

      lifecycleEmitter?.emit({
        type:
          lastFailure.failureClass === "cancelled"
            ? "subagents.cancelled"
            : "subagents.failed",
        timestamp: Date.now(),
        sessionId: parentSessionId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        toolName: "execute_with_agent",
        payload: {
          stepName: step.name,
          output: lastFailure.message,
          durationMs: lastFailure.durationMs,
          failureClass: lastFailure.failureClass,
          validationCode: lastFailure.validationCode,
          decomposition: lastFailure.decomposition,
          attempt,
          retrying: shouldRetry,
          retryAttempt,
          maxRetries: retryRule.maxRetries,
          nextRetryDelayMs: retryDelayMs,
        },
      });

      this.recordSubagentTrajectory({
        traceId: trajectoryTraceId,
        turnId: `child:${step.name}:${attempt}:${lastFailure.childSessionId ?? "unknown"}`,
        parentTurnId,
        parentSessionId,
        subagentSessionId: lastFailure.childSessionId,
        step,
        stepComplexityScore,
        contextClusterId: childContextClusterId,
        plannerStepCount: plannerSteps.length,
        subagentStepCount,
        deterministicStepCount,
        synthesisStepCount,
        dependencyDepth: Math.max(1, (step.dependsOn?.length ?? 0) + 1),
        fanout: Math.max(1, subagentStepCount),
        tools: toolScope.allowedTools,
        timeoutMs,
        delegated: true,
        strategyArmId: "balanced",
        qualityProxy: shouldRetry ? 0.3 : 0.15,
        tokenCost: lastFailure.tokenUsage?.totalTokens ?? 0,
        latencyMs: lastFailure.durationMs ?? timeoutMs,
        errorCount: 1,
        errorClass: lastFailure.failureClass,
        metadata: {
          success: false,
          attempt,
          retrying: shouldRetry,
          pipelineId: pipeline.id,
          stepName: step.name,
        },
      });

      if (shouldRetry) {
        retryAttempts[lastFailure.failureClass] = retryAttempt;
        taskPrompt = this.buildRetryTaskPrompt(
          taskPrompt,
          step,
          toolScope.allowedTools,
          lastFailure,
          retryAttempt,
        );
        lifecycleEmitter?.emit({
          type: "subagents.progress",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: lastFailure.childSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: step.name,
            phase: "retry_backoff",
            failureClass: lastFailure.failureClass,
            attempt,
            retryAttempt,
            delayMs: retryDelayMs,
          },
        });
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
        continue;
      }

      if (
        lastFailure.failureClass === "needs_decomposition" &&
        lastFailure.decomposition
      ) {
        return {
          status: "failed",
          error:
            `Sub-agent step "${step.name}" requires decomposition: ${lastFailure.message}`,
          stopReasonHint: lastFailure.stopReasonHint,
          decomposition: lastFailure.decomposition,
          result: safeStringify({
            status: "needs_decomposition",
            success: false,
            delegated: false,
            recoveredViaParentFallback: false,
            failureClass: lastFailure.failureClass,
            error: lastFailure.message,
            stopReasonHint: lastFailure.stopReasonHint,
            failureHistory: failureHistory.map((failure) => ({
              failureClass: failure.failureClass,
              validationCode: failure.validationCode ?? null,
              message: failure.message,
            })),
            decomposition: lastFailure.decomposition,
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      if (this.fallbackBehavior === "continue_without_delegation") {
        return {
          status: "completed",
          result: safeStringify({
            status: "delegation_fallback",
            success: false,
            delegated: false,
            recoveredViaParentFallback: true,
            failureClass: lastFailure.failureClass,
            error: lastFailure.message,
            stopReasonHint: lastFailure.stopReasonHint,
            failureHistory: failureHistory.map((failure) => ({
              failureClass: failure.failureClass,
              validationCode: failure.validationCode ?? null,
              message: failure.message,
            })),
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      return {
        status: "failed",
        error: summarizeSubagentFailureHistory(step.name, failureHistory),
        stopReasonHint: lastFailure.stopReasonHint,
      };
    }
  }

  private hasHighRiskCapabilities(capabilities: readonly string[]): boolean {
    for (const capability of capabilities) {
      const normalized = capability.trim().toLowerCase();
      if (!normalized) continue;
      if (
        normalized.startsWith("wallet.") ||
        normalized.startsWith("solana.") ||
        normalized.startsWith("agenc.") ||
        normalized.startsWith("desktop.") ||
        normalized === "system.delete" ||
        normalized === "system.execute" ||
        normalized === "system.open" ||
        normalized === "system.applescript" ||
        normalized === "system.notification"
      ) {
        return true;
      }
    }
    return false;
  }

  private recordSubagentTrajectory(input: {
    traceId: string;
    turnId: string;
    parentTurnId: string;
    parentSessionId: string;
    subagentSessionId?: string;
    step: PipelinePlannerSubagentStep;
    stepComplexityScore: number;
    contextClusterId: string;
    plannerStepCount: number;
    subagentStepCount: number;
    deterministicStepCount: number;
    synthesisStepCount: number;
    dependencyDepth: number;
    fanout: number;
    tools: readonly string[];
    timeoutMs: number;
    delegated: boolean;
    strategyArmId: string;
    qualityProxy: number;
    tokenCost: number;
    latencyMs: number;
    errorCount: number;
    errorClass?: string;
    metadata?: Readonly<Record<string, string | number | boolean>>;
  }): void {
    const sink = this.resolveTrajectorySink();
    if (!sink) return;

    const reward = computeDelegationFinalReward({
      qualityProxy: input.qualityProxy,
      tokenCost: input.tokenCost,
      latencyMs: input.latencyMs,
      errorCount: input.errorCount,
    });

    sink.record({
      schemaVersion: 1,
      traceId: input.traceId,
      turnId: input.turnId,
      parentTurnId: input.parentTurnId,
      turnType: "child",
      timestampMs: Date.now(),
      stateFeatures: {
        sessionId: input.subagentSessionId ?? input.parentSessionId,
        contextClusterId: input.contextClusterId,
        complexityScore: input.stepComplexityScore,
        plannerStepCount: input.plannerStepCount,
        subagentStepCount: input.subagentStepCount,
        deterministicStepCount: input.deterministicStepCount,
        synthesisStepCount: input.synthesisStepCount,
        dependencyDepth: Math.max(1, input.dependencyDepth),
        fanout: Math.max(1, input.fanout),
      },
      action: {
        delegated: input.delegated,
        strategyArmId: input.strategyArmId,
        threshold: 0,
        selectedTools: [...input.tools],
        childConfig: {
          maxDepth: this.maxDepth,
          maxFanoutPerTurn: this.maxFanoutPerTurn,
          timeoutMs: input.timeoutMs,
        },
      },
      immediateOutcome: {
        qualityProxy: input.qualityProxy,
        tokenCost: input.tokenCost,
        latencyMs: input.latencyMs,
        errorCount: input.errorCount,
        ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      },
      finalReward: reward,
      metadata: {
        stepName: input.step.name,
        objectiveChars: input.step.objective.length,
        ...(input.metadata ?? {}),
      },
    });
  }

  private parseBudgetHintMs(hint: string): number {
    return resolveDelegationBudgetHintMs(
      hint,
      this.defaultSubagentTimeoutMs,
    );
  }

  private createRetryAttemptTracker(): Record<SubagentFailureClass, number> {
    return {
      timeout: 0,
      tool_misuse: 0,
      malformed_result_contract: 0,
      needs_decomposition: 0,
      invalid_input: 0,
      transient_provider_error: 0,
      cancelled: 0,
      spawn_error: 0,
      unknown: 0,
    };
  }

  private computeRetryDelayMs(
    rule: SubagentRetryRule,
    retryAttempt: number,
  ): number {
    if (rule.maxRetries <= 0 || rule.baseDelayMs <= 0) return 0;
    const scaled = rule.baseDelayMs * Math.max(1, retryAttempt);
    return Math.max(0, Math.min(rule.maxDelayMs, scaled));
  }

  private classifySpawnFailure(message: string): SubagentFailureClass {
    const lower = message.toLowerCase();
    if (
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("deadline exceeded")
    ) {
      return "timeout";
    }
    if (
      lower.includes("temporarily unavailable") ||
      lower.includes("resource temporarily unavailable") ||
      lower.includes("connection reset") ||
      lower.includes("econnreset") ||
      lower.includes("429") ||
      lower.includes("rate limit")
    ) {
      return "transient_provider_error";
    }
    return "spawn_error";
  }

  private classifySubagentFailureMessage(message: string): SubagentFailureClass {
    const lower = message.toLowerCase();
    if (
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("deadline exceeded")
    ) {
      return "timeout";
    }
    if (lower.includes("cancelled") || lower.includes("canceled")) {
      return "cancelled";
    }
    if (
      lower.includes("provider error") ||
      lower.includes("fetch failed") ||
      lower.includes("temporarily unavailable") ||
      lower.includes("connection reset") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("rate limit") ||
      lower.includes("429")
    ) {
      return "transient_provider_error";
    }
    if (
      lower.includes("missing required argument") ||
      lower.includes("invalid argument") ||
      lower.includes("unknown tool") ||
      lower.includes("tool call validation") ||
      lower.includes("command must be one executable token/path") ||
      lower.includes("shell snippets")
    ) {
      return "tool_misuse";
    }
    if (
      lower.includes("malformed result contract") ||
      lower.includes("expected json object")
    ) {
      return "malformed_result_contract";
    }
    return "unknown";
  }

  private classifySubagentFailureResult(
    result: Pick<SubAgentResult, "output" | "stopReason" | "stopReasonDetail">,
  ): SubagentFailureClass {
    if (result.stopReason === "timeout") return "timeout";
    if (result.stopReason === "cancelled") return "cancelled";
    if (
      result.stopReason === "provider_error" ||
      result.stopReason === "authentication_error" ||
      result.stopReason === "rate_limited"
    ) {
      return "transient_provider_error";
    }
    const message =
      typeof result.stopReasonDetail === "string" &&
        result.stopReasonDetail.trim().length > 0
        ? result.stopReasonDetail
        : (typeof result.output === "string" ? result.output : "");
    return this.classifySubagentFailureMessage(message);
  }

  private async executeSubagentAttempt(
    input: ExecuteSubagentAttemptParams,
  ): Promise<ExecuteSubagentAttemptOutcome> {
    const scopeAssessment = assessDelegationScope({
      objective: input.step.objective,
      inputContract: input.step.inputContract,
      acceptanceCriteria: input.step.acceptanceCriteria,
    });
    if (!scopeAssessment.ok) {
      return {
        status: "failed",
        failure: {
          failureClass: "needs_decomposition",
          message:
            `Refusing overloaded subagent step "${input.step.name}": ${scopeAssessment.error}`,
          decomposition: scopeAssessment.decomposition,
          stopReasonHint: "validation_error",
        },
      };
    }

    const delegatedWorkingDirectory = resolveDelegatedWorkingDirectory({
      task: input.step.name,
      objective: input.step.objective,
      inputContract: input.step.inputContract,
      acceptanceCriteria: input.step.acceptanceCriteria,
      contextRequirements: input.step.contextRequirements,
    });
    let childSessionId: string;
    try {
      const workingDirectory = delegatedWorkingDirectory?.path;
      childSessionId = await input.subAgentManager.spawn({
        parentSessionId: input.parentSessionId,
        task: input.taskPrompt,
        timeoutMs: input.timeoutMs,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(delegatedWorkingDirectory
          ? { workingDirectorySource: delegatedWorkingDirectory.source }
          : {}),
        tools: input.tools,
        requiredCapabilities: input.step.requiredToolCapabilities,
        requireToolCall: specRequiresSuccessfulToolEvidence({
          objective: input.step.objective,
          inputContract: input.step.inputContract,
          acceptanceCriteria: input.step.acceptanceCriteria,
          requiredToolCapabilities: input.step.requiredToolCapabilities,
          tools: input.tools,
        }),
        delegationSpec: {
          task: input.step.name,
          objective: input.step.objective,
          parentRequest: input.parentRequest,
          inputContract: input.step.inputContract,
          acceptanceCriteria: input.step.acceptanceCriteria,
          requiredToolCapabilities: input.step.requiredToolCapabilities,
          contextRequirements: input.step.contextRequirements,
          tools: input.tools,
          ...(input.lastValidationCode
            ? { lastValidationCode: input.lastValidationCode }
            : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = this.classifySpawnFailure(message);
      return {
        status: "failed",
        failure: {
          failureClass,
          message:
            `Failed to spawn subagent for step "${input.step.name}": ${message}`,
          stopReasonHint: SUBAGENT_FAILURE_STOP_REASON[failureClass],
        },
      };
    }

    input.lifecycleEmitter?.emit({
      type: "subagents.spawned",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
        timeoutMs: input.timeoutMs,
        contextCuration: input.diagnostics,
        ...(delegatedWorkingDirectory
          ? {
            workingDirectory: delegatedWorkingDirectory.path,
            workingDirectorySource: delegatedWorkingDirectory.source,
          }
          : {}),
      },
    });
    input.lifecycleEmitter?.emit({
      type: "subagents.started",
      timestamp: Date.now(),
      sessionId: input.parentSessionId,
      parentSessionId: input.parentSessionId,
      subagentSessionId: childSessionId,
      toolName: "execute_with_agent",
      payload: {
        stepName: input.step.name,
      },
    });

    while (true) {
      const result = input.subAgentManager.getResult(childSessionId);
      if (!result) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (result.success) {
        const contractValidation = validateDelegatedOutputContract({
          spec: {
            objective: input.step.objective,
            inputContract: input.step.inputContract,
            acceptanceCriteria: input.step.acceptanceCriteria,
            requiredToolCapabilities: input.step.requiredToolCapabilities,
          },
          output: result.output,
          toolCalls: result.toolCalls,
          providerEvidence: result.providerEvidence,
        });
        if (contractValidation.error) {
          return {
            status: "failed",
            failure: {
              failureClass: "malformed_result_contract",
              message: contractValidation.error,
              validationCode: contractValidation.code,
              stopReasonHint:
                SUBAGENT_FAILURE_STOP_REASON.malformed_result_contract,
              childSessionId,
              durationMs: result.durationMs,
              toolCallCount: result.toolCalls.length,
              tokenUsage: result.tokenUsage,
            },
          };
        }

        input.lifecycleEmitter?.emit({
          type: "subagents.completed",
          timestamp: Date.now(),
          sessionId: input.parentSessionId,
          parentSessionId: input.parentSessionId,
          subagentSessionId: childSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: input.step.name,
            durationMs: result.durationMs,
            toolCalls: result.toolCalls.length,
            providerName: result.providerName,
          },
        });

        return {
          status: "completed",
          subagentSessionId: childSessionId,
          output: result.output,
          durationMs: result.durationMs,
          toolCalls: result.toolCalls,
          tokenUsage: result.tokenUsage,
          providerName: result.providerName,
        };
      }

      const message =
        typeof result.stopReasonDetail === "string" &&
          result.stopReasonDetail.trim().length > 0
          ? result.stopReasonDetail
          : (
              typeof result.output === "string" && result.output.length > 0
                ? result.output
                : "unknown sub-agent failure"
            );
      const initialFailureClass = this.classifySubagentFailureResult(result);
      const contractValidation =
        result.stopReason === "validation_error" && !result.validationCode
          ? validateDelegatedOutputContract({
            spec: {
              objective: input.step.objective,
              inputContract: input.step.inputContract,
              acceptanceCriteria: input.step.acceptanceCriteria,
              requiredToolCapabilities: input.step.requiredToolCapabilities,
            },
            output: result.output,
            toolCalls: result.toolCalls,
            providerEvidence: result.providerEvidence,
          })
          : undefined;
      const validationCode = result.validationCode ?? contractValidation?.code;
      const failureClass =
        validationCode !== undefined ||
          initialFailureClass === "malformed_result_contract"
          ? "malformed_result_contract"
          : initialFailureClass;
      const inheritedStopReasonHint = toPipelineStopReasonHint(result.stopReason);
      return {
        status: "failed",
        failure: {
          failureClass,
          message: contractValidation?.error ?? message,
          validationCode,
          stopReasonHint:
            inheritedStopReasonHint ?? SUBAGENT_FAILURE_STOP_REASON[failureClass],
          childSessionId,
          durationMs: result.durationMs,
          toolCallCount: result.toolCalls.length,
          tokenUsage: result.tokenUsage,
        },
      };
    }
  }

  private buildSubagentTaskPrompt(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Readonly<Record<string, string>>,
    toolScope: {
      allowedTools: readonly string[];
      allowsToollessExecution: boolean;
      semanticFallback: readonly string[];
      removedLowSignalBrowserTools: readonly string[];
      removedByPolicy: readonly string[];
      removedAsDelegationTools: readonly string[];
      removedAsUnknownTools: readonly string[];
      parentPolicyAllowed: readonly string[];
    },
  ): {
    taskPrompt: string;
    diagnostics: SubagentContextDiagnostics;
  } {
    const plannerContext = pipeline.plannerContext;
    const promptBudgetCaps = this.resolveSubagentPromptBudgetCaps();
    const parentRequest = plannerContext?.parentRequest?.trim();
    const summarizedParentRequest = parentRequest
      ? this.summarizeParentRequestForSubagent(parentRequest, step)
      : undefined;
    const relevanceTerms = this.buildRelevanceTerms(step);
    const artifactRelevanceTerms = this.buildArtifactRelevanceTerms(
      step,
      summarizedParentRequest,
    );
    const requirementTerms = this.extractTerms(step.contextRequirements.join(" "));
    const dependencies = this.collectDependencyContexts(step, pipeline, results);
    const dependencyArtifactCandidates = this.collectDependencyArtifactCandidates(
      dependencies,
      artifactRelevanceTerms,
    );
    const toolContextBudgets = this.allocateContextGroupBudgets(
      promptBudgetCaps.toolOutputChars,
      [
        {
          key: "toolOutputs",
          active:
            dependencies.length > 0 ||
            (plannerContext?.toolOutputs?.length ?? 0) > 0,
        },
        { key: "dependencyArtifacts", active: dependencyArtifactCandidates.length > 0 },
      ],
    );

    const historySection = this.curateHistorySection(
      plannerContext?.history ?? [],
      relevanceTerms,
      promptBudgetCaps.historyChars,
    );
    const memorySection = this.curateMemorySection(
      plannerContext?.memory ?? [],
      requirementTerms,
      promptBudgetCaps.memoryChars,
    );
    const toolOutputSection = this.curateToolOutputSection(
      step,
      plannerContext?.toolOutputs ?? [],
      dependencies,
      relevanceTerms,
      requirementTerms,
      toolContextBudgets.toolOutputs ?? 0,
    );
    const dependencyArtifactSection = this.curateDependencyArtifactSection(
      dependencyArtifactCandidates,
      toolContextBudgets.dependencyArtifacts ?? 0,
    );
    const hostToolingSection = this.buildHostToolingPromptSection(
      step,
      dependencyArtifactCandidates,
    );
    const downstreamRequirementLines = this.buildDownstreamRequirementLines(
      step,
      pipeline,
    );
    const delegatedWorkingDirectory = resolveDelegatedWorkingDirectory({
      task: step.name,
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: step.acceptanceCriteria,
      contextRequirements: step.contextRequirements,
    });

    const buildPrompt = (diagnostics: SubagentContextDiagnostics): string => {
      const sections: string[] = [];
      const allowsStructuredShell = toolScope.allowedTools.some((toolName) =>
        toolName === "system.bash" || toolName === "desktop.bash"
      );
      const allowsDirectFileWrite = toolScope.allowedTools.some((toolName) =>
        toolName === "system.writeFile" ||
        toolName === "system.appendFile" ||
        toolName === "desktop.text_editor"
      );
      sections.push(
        `Execution rules:
- Execute only the assigned phase \`${step.name}\`.
- Do not create a new multi-step plan for the broader parent request.
- Do not attempt sibling phases or synthesize the final deliverable.
- If the task requires tool-grounded evidence, you must use one or more allowed tools before answering.
- If you cannot complete the phase with the allowed tools, state that you are blocked and explain exactly why.`,
      );
      sections.push(`Objective: ${this.redactSensitiveData(step.objective)}`);
      sections.push(
        `Input contract: ${this.redactSensitiveData(step.inputContract)}`,
      );
      if (summarizedParentRequest && summarizedParentRequest.length > 0) {
        sections.push(
          `Parent request summary: ${this.redactSensitiveData(summarizedParentRequest)}`,
        );
      }
      if (step.acceptanceCriteria.length > 0) {
        sections.push(
          `Acceptance criteria:\n${step.acceptanceCriteria.map((item) => `- ${this.redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (step.contextRequirements.length > 0) {
        sections.push(
          `Context requirements:\n${step.contextRequirements.map((item) => `- ${this.redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (
        delegatedWorkingDirectory &&
        delegatedWorkingDirectory.source !== "context_requirement"
      ) {
        sections.push(
          "Working directory:\n" +
            `- Use \`${this.redactSensitiveData(delegatedWorkingDirectory.path)}\` as the workspace root for this phase.\n` +
            "- Keep filesystem reads and writes under that root.\n" +
            "- Prefer relative paths rooted there; do not create alternate workspaces elsewhere.",
        );
      }
      if (toolScope.allowedTools.length > 0) {
        sections.push(
          `Allowed tools (policy-scoped):\n${
            toolScope.allowedTools.map((item) => `- ${item}`).join("\n")
          }`,
        );
      } else if (toolScope.allowsToollessExecution) {
        sections.push(
          "Allowed tools (policy-scoped): none. Complete this phase from curated parent context, memory, and dependency outputs only.",
        );
      }
      if (allowsStructuredShell || allowsDirectFileWrite) {
        const toolUsageRules: string[] = [];
        if (allowsStructuredShell) {
          toolUsageRules.push(
            "- For `system.bash`/`desktop.bash` direct mode, `command` must be exactly one executable token. Put flags and operands in `args`.",
          );
          toolUsageRules.push(
            "- Use shell mode only when you need pipes, redirects, chaining, or subshells. In shell mode, set `command` to the full shell string and omit `args`.",
          );
          toolUsageRules.push(
            "- Verification commands must be non-interactive and exit on their own. Do not use watch/dev mode for tests or validation. Prefer runner-native single-run invocations. For Vitest use `vitest run`/`vitest --run`. For Jest use `CI=1 npm test` or `jest --runInBand`. Only pass extra npm `--` flags when the underlying runner supports them.",
          );
        }
        if (allowsDirectFileWrite) {
          toolUsageRules.push(
            "- Use file-write tools for file contents instead of shell heredocs or inline shell-generated source files when those tools are allowed.",
          );
        }
        sections.push(`Tool usage rules:\n${toolUsageRules.join("\n")}`);
      }
      if (historySection.lines.length > 0) {
        sections.push(
          `Curated parent history slice:\n${
            historySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (memorySection.lines.length > 0) {
        sections.push(
          `Required memory retrievals:\n${
            memorySection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (toolOutputSection.lines.length > 0) {
        sections.push(
          `Relevant tool outputs:\n${
            toolOutputSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (dependencyArtifactSection.lines.length > 0) {
        sections.push(
          "Dependency-derived workspace context:\n" +
            "- Use these file snapshots as the starting point for this phase.\n" +
            "- Do not spend tool rounds re-listing directories or re-reading the same files unless you need fresh verification after a mutation.\n" +
            dependencyArtifactSection.lines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (hostToolingSection.lines.length > 0) {
        sections.push(
          `Host tooling constraints:\n${
            hostToolingSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      if (downstreamRequirementLines.length > 0) {
        sections.push(
          "Downstream execution requirements:\n" +
            downstreamRequirementLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      sections.push(`Budget hint: ${step.maxBudgetHint}`);
      sections.push(
        `Context curation diagnostics:\n${safeStringify(diagnostics)}`,
      );
      return this.redactSensitiveData(sections.join("\n\n"));
    };

    let diagnostics: SubagentContextDiagnostics = {
      history: {
        selected: historySection.selected,
        available: historySection.available,
        omitted: historySection.omitted,
        truncated: historySection.truncated,
      },
      memory: {
        selected: memorySection.selected,
        available: memorySection.available,
        omitted: memorySection.omitted,
        truncated: memorySection.truncated,
      },
      toolOutputs: {
        selected: toolOutputSection.selected,
        available: toolOutputSection.available,
        omitted: toolOutputSection.omitted,
        truncated: toolOutputSection.truncated,
      },
      dependencyArtifacts: {
        selected: dependencyArtifactSection.selected,
        available: dependencyArtifactSection.available,
        omitted: dependencyArtifactSection.omitted,
        truncated: dependencyArtifactSection.truncated,
      },
      hostTooling: hostToolingSection.diagnostics,
      promptTruncated: false,
      toolScope: {
        strategy: this.childToolAllowlistStrategy,
        required: [...step.requiredToolCapabilities],
        parentPolicyAllowed: [...toolScope.parentPolicyAllowed],
        parentPolicyForbidden: [...this.forbiddenParentTools],
        resolved: [...toolScope.allowedTools],
        allowsToollessExecution: toolScope.allowsToollessExecution,
        semanticFallback: [...toolScope.semanticFallback],
        removedLowSignalBrowserTools: [
          ...toolScope.removedLowSignalBrowserTools,
        ],
        removedByPolicy: [...toolScope.removedByPolicy],
        removedAsDelegationTools: [...toolScope.removedAsDelegationTools],
        removedAsUnknownTools: [...toolScope.removedAsUnknownTools],
      },
    };

    let taskPrompt = buildPrompt(diagnostics);
    if (taskPrompt.length > promptBudgetCaps.totalPromptChars) {
      diagnostics = {
        ...diagnostics,
        promptTruncated: true,
      };
      taskPrompt = this.truncateText(
        buildPrompt(diagnostics),
        promptBudgetCaps.totalPromptChars,
      );
    }

    return { taskPrompt, diagnostics };
  }

  private buildHostToolingPromptSection(
    step: PipelinePlannerSubagentStep,
    dependencyArtifactCandidates: readonly DependencyArtifactCandidate[],
  ): {
    lines: readonly string[];
    diagnostics: SubagentContextDiagnostics["hostTooling"];
  } {
    const stepTexts = [
      step.name,
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      ...dependencyArtifactCandidates.map((candidate) => candidate.path),
    ];
    const relevant = stepTexts.some((text) =>
      NODE_PACKAGE_TOOLING_RE.test(text) ||
      NODE_PACKAGE_MANIFEST_PATH_RE.test(text)
    );
    if (!relevant) {
      return {
        lines: [],
        diagnostics: {
          included: false,
          reason: "not_relevant",
        },
      };
    }

    const profile = this.resolveHostToolingProfile();
    if (!profile) {
      return {
        lines: [],
        diagnostics: {
          included: false,
          reason: "profile_unavailable",
        },
      };
    }

    const diagnostics: SubagentContextDiagnostics["hostTooling"] = {
      included: true,
      reason: "node_package_tooling",
      nodeVersion: profile.nodeVersion,
      ...(profile.npm?.version ? { npmVersion: profile.npm.version } : {}),
      ...(profile.npm?.workspaceProtocolSupport
        ? { npmWorkspaceProtocolSupport: profile.npm.workspaceProtocolSupport }
        : {}),
      ...(profile.npm?.workspaceProtocolEvidence
        ? { npmWorkspaceProtocolEvidence: profile.npm.workspaceProtocolEvidence }
        : {}),
    };
    const lines = [`Host Node version: \`${profile.nodeVersion}\`.`];

    if (profile.npm?.version) {
      lines.push(`Host npm version: \`${profile.npm.version}\`.`);
    }
    if (profile.npm?.workspaceProtocolSupport === "unsupported") {
      const evidence = profile.npm.workspaceProtocolEvidence
        ? ` (${this.redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
        : "";
      lines.push(
        "Empirical npm probe: local `workspace:*` dependency specifiers are unsupported on this host" +
          `${evidence}.`,
      );
      lines.push(
        "Do not rely on `workspace:*` in generated manifests. Choose a host-compatible local dependency reference and verify it with `npm install` on this host before proceeding.",
      );
    } else if (profile.npm?.workspaceProtocolSupport === "unknown") {
      const evidence = profile.npm.workspaceProtocolEvidence
        ? ` (${this.redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
        : "";
      lines.push(
        "Empirical npm probe could not confirm whether local `workspace:*` dependency specifiers work on this host" +
          `${evidence}. Verify the manifest with a real install before depending on workspace protocol semantics.`,
      );
    } else if (profile.npm?.workspaceProtocolSupport === "supported") {
      lines.push(
        "Empirical npm probe: local `workspace:*` dependency specifiers are supported on this host.",
      );
    }

    return { lines, diagnostics };
  }

  private deriveChildToolAllowlist(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): {
    allowedTools: readonly string[];
    allowsToollessExecution: boolean;
    semanticFallback: readonly string[];
    removedLowSignalBrowserTools: readonly string[];
    blockedReason?: string;
    removedByPolicy: readonly string[];
    removedAsDelegationTools: readonly string[];
    removedAsUnknownTools: readonly string[];
    parentPolicyAllowed: readonly string[];
  } {
    const parentPolicyAllowed = this.resolveParentPolicyAllowlist(pipeline);
    const availableTools = this.resolveAvailableToolNames();
    const resolvedScope = resolveDelegatedChildToolScope({
      spec: {
        task: step.name,
        objective: step.objective,
        parentRequest: pipeline.plannerContext?.parentRequest,
        inputContract: step.inputContract,
        acceptanceCriteria: step.acceptanceCriteria,
        requiredToolCapabilities: step.requiredToolCapabilities,
      },
      requestedTools: step.requiredToolCapabilities,
      parentAllowedTools: parentPolicyAllowed,
      availableTools: availableTools ?? undefined,
      forbiddenTools: [...this.forbiddenParentTools],
      enforceParentIntersection:
        this.childToolAllowlistStrategy === "inherit_intersection",
    });

    return {
      allowedTools: resolvedScope.allowedTools,
      allowsToollessExecution: resolvedScope.allowsToollessExecution,
      semanticFallback: resolvedScope.semanticFallback,
      removedLowSignalBrowserTools: resolvedScope.removedLowSignalBrowserTools,
      blockedReason: resolvedScope.blockedReason,
      removedByPolicy: resolvedScope.removedByPolicy,
      removedAsDelegationTools: resolvedScope.removedAsDelegationTools,
      removedAsUnknownTools: resolvedScope.removedAsUnknownTools,
      parentPolicyAllowed,
    };
  }

  private buildRetryTaskPrompt(
    currentTaskPrompt: string,
    step: PipelinePlannerSubagentStep,
    allowedTools: readonly string[],
    failure: SubagentFailureOutcome,
    retryAttempt: number,
  ): string {
    if (failure.failureClass !== "malformed_result_contract") {
      return currentTaskPrompt;
    }

    const corrections: string[] = [];
    if (failure.validationCode === "expected_json_object") {
      corrections.push(
        "Return a single JSON object only. Do not wrap it in markdown, code fences, prose, or bullet lists.",
      );
    }
    if (failure.validationCode === "empty_output") {
      corrections.push(
        "Do not return an empty reply. Produce the required deliverable with concrete evidence.",
      );
    }
    if (failure.validationCode === "low_signal_browser_evidence") {
      corrections.push(
        "Use real browser interactions against concrete non-blank URLs or localhost pages. `browser_tabs` or about:blank state checks do not count as evidence.",
      );
      corrections.push(
        "Use allowed browser tools like navigate, snapshot, or run_code on the target page and cite the visited URL in the output.",
      );
    }
    if (failure.validationCode === "acceptance_evidence_missing") {
      corrections.push(
        "Do not just restate the acceptance criteria. Use allowed tools to directly verify the missing criteria and cite the observed evidence.",
      );
      if (
        /\b(?:compile|compiles|compiled|compiling|build|test|verify|validated?|output(?:\s+format)?|stdout|stderr|exit(?:\s+code|s)?)\b/i.test(
          [
            step.objective,
            step.inputContract,
            ...(step.acceptanceCriteria ?? []),
          ]
            .filter((value): value is string =>
              typeof value === "string" && value.length > 0
            )
            .join(" "),
        ) &&
        allowedTools.some((toolName) =>
          toolName === "desktop.bash" || toolName === "system.bash"
        )
      ) {
        corrections.push(
          "If the acceptance criteria mention compile/build/test/output behavior, run the relevant shell command(s) and report the observed result instead of rewriting the file again.",
        );
      }
    }
    if (failure.validationCode === "blocked_phase_output") {
      corrections.push(
        "Do not present the phase as successful if your own output says it is blocked or cannot be completed.",
      );
      corrections.push(
        "Only return a completed phase after fixing and verifying the blocking issue with the allowed tools.",
      );
    }
    if (failure.validationCode === "contradictory_completion_claim") {
      corrections.push(
        "Do not claim the phase is complete while also mentioning unresolved mismatches, placeholders, or follow-up work.",
      );
      corrections.push(
        "Fix and verify the issue with the allowed tools first. If the issue remains unresolved, report the phase as blocked instead of successful.",
      );
    }
    if (
      step.requiredToolCapabilities.length > 0 ||
      /tool-grounded evidence|no tool calls|all child tool calls failed/i.test(
        failure.message,
      )
    ) {
      corrections.push(
        `You must invoke one or more of the allowed tools before answering. Allowed tools: ${allowedTools.join(", ") || "none"}. Do not answer from memory.`,
      );
    }
    if (/file creation\/edit evidence|file mutation tools/i.test(failure.message)) {
      corrections.push(
        "You must create or edit the required files using allowed tools and identify those files in the output.",
      );
    }
    if (/identify any files/i.test(failure.message)) {
      corrections.push(
        "Your output must explicitly name the files you created or modified.",
      );
    }

    if (corrections.length === 0) {
      corrections.push(
        `The previous attempt for step "${step.name}" violated the delegated output contract. Re-run the phase and satisfy the stated input contract and acceptance criteria exactly.`,
      );
    }

    return `${currentTaskPrompt}\n\nRetry corrections (attempt ${retryAttempt}):\n${corrections.map((entry) => `- ${entry}`).join("\n")}`;
  }

  private summarizeParentRequestForSubagent(
    parentRequest: string,
    step: PipelinePlannerSubagentStep,
  ): string {
    const stripped = parentRequest
      .replace(SUBAGENT_ORCHESTRATION_SECTION_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    const highLevelScope = stripped
      .split(/\bExecution rules:\b/i)[0]
      ?.trim();
    const base =
      highLevelScope && highLevelScope.length > 0
        ? highLevelScope
        : stripped.length > 0
          ? stripped
        : `Complete only the assigned ${step.name} phase of the parent request.`;
    return this.truncateText(
      `${base} Assigned phase only: ${step.name}. Ignore broader orchestration instructions and other phases.`,
      600,
    );
  }

  private resolveEffectiveMaxCumulativeTokensPerRequestTree(
    plannerSteps: readonly PipelinePlannerStep[],
  ): number {
    if (this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const plannedSubagentSteps = plannerSteps.filter(
      (step) => step.stepType === "subagent_task",
    ).length;
    if (plannedSubagentSteps <= 0) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    return Math.max(
      this.maxCumulativeTokensPerRequestTree,
      plannedSubagentSteps *
        DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP *
        DEFAULT_REQUEST_TREE_SUBAGENT_PASSES,
    );
  }

  private resolveParentPolicyAllowlist(
    pipeline: Pipeline,
  ): readonly string[] {
    const plannerContextAllowed =
      pipeline.plannerContext?.parentAllowedTools
        ?.map((name) => name.trim())
        .filter((name) => name.length > 0) ?? [];
    if (plannerContextAllowed.length > 0) return plannerContextAllowed;
    if (this.allowedParentTools.size > 0) {
      return [...this.allowedParentTools];
    }
    return [];
  }

  private collectDependencyContexts(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    results: Readonly<Record<string, string>>,
  ): readonly DependencyContextEntry[] {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0 || (step.dependsOn?.length ?? 0) === 0) {
      return [];
    }

    const stepIndexByName = new Map(
      plannerSteps.map((plannerStep, index) => [plannerStep.name, index]),
    );
    const stepByName = new Map(
      plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
    );
    const queue = (step.dependsOn ?? []).map((dependencyName) => ({
      dependencyName,
      depth: 1,
    }));
    const visited = new Set<string>();
    const collected: DependencyContextEntry[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (visited.has(current.dependencyName)) continue;
      visited.add(current.dependencyName);

      collected.push({
        dependencyName: current.dependencyName,
        result: results[current.dependencyName] ?? null,
        depth: current.depth,
        orderIndex:
          stepIndexByName.get(current.dependencyName) ?? Number.MAX_SAFE_INTEGER,
      });

      const dependencyStep = stepByName.get(current.dependencyName);
      if (!dependencyStep) continue;
      for (const ancestorName of dependencyStep.dependsOn ?? []) {
        if (!visited.has(ancestorName)) {
          queue.push({
            dependencyName: ancestorName,
            depth: current.depth + 1,
          });
        }
      }
    }

    return collected.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.orderIndex - b.orderIndex;
    });
  }

  private buildArtifactRelevanceTerms(
    step: PipelinePlannerSubagentStep,
    summarizedParentRequest: string | undefined,
  ): ReadonlySet<string> {
    const aggregate = [
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      ...step.requiredToolCapabilities,
      summarizedParentRequest ?? "",
    ].join(" ");
    return new Set(this.extractTerms(aggregate));
  }

  private buildDownstreamRequirementLines(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): readonly string[] {
    const plannerSteps = pipeline.plannerSteps ?? [];
    if (plannerSteps.length === 0) {
      return [];
    }

    const dependentsByName = new Map<string, PipelinePlannerStep[]>();
    for (const plannerStep of plannerSteps) {
      for (const dependencyName of plannerStep.dependsOn ?? []) {
        const dependents = dependentsByName.get(dependencyName) ?? [];
        dependents.push(plannerStep);
        dependentsByName.set(dependencyName, dependents);
      }
    }

    const queue = (dependentsByName.get(step.name) ?? []).map((dependentStep) => ({
      dependentStep,
      depth: 1,
    }));
    const visited = new Set<string>();
    const lines: string[] = [];
    while (queue.length > 0 && lines.length < 4) {
      const current = queue.shift();
      if (!current) break;
      if (visited.has(current.dependentStep.name)) continue;
      visited.add(current.dependentStep.name);

      const summarized = this.summarizeDownstreamRequirementStep(
        current.dependentStep,
      );
      for (const line of summarized) {
        if (!lines.includes(line)) {
          lines.push(line);
        }
        if (lines.length >= 4) break;
      }
      if (lines.length >= 4) break;

      for (const nextDependent of dependentsByName.get(current.dependentStep.name) ?? []) {
        if (!visited.has(nextDependent.name)) {
          queue.push({
            dependentStep: nextDependent,
            depth: current.depth + 1,
          });
        }
      }
    }

    return lines;
  }

  private summarizeDownstreamRequirementStep(
    step: PipelinePlannerStep,
  ): readonly string[] {
    if (step.stepType === "subagent_task") {
      const inputContract = step.inputContract.trim();
      if (inputContract.length === 0) {
        return [];
      }
      return [
        `\`${step.name}\` expects: ${this.redactSensitiveData(inputContract)}`,
      ];
    }

    if (step.stepType === "deterministic_tool") {
      const commandSummary = this.summarizeDeterministicVerificationStep(step);
      return commandSummary ? [commandSummary] : [];
    }

    return [];
  }

  private summarizeDeterministicVerificationStep(
    step: PipelinePlannerDeterministicStep,
  ): string | undefined {
    if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
      return undefined;
    }

    const args =
      typeof step.args === "object" &&
        step.args !== null &&
        !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : undefined;
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args?.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    const rendered = [command, ...commandArgs].filter((value) => value.length > 0).join(" ");
    if (rendered.length === 0) {
      return undefined;
    }
    const normalizedCommand = command.toLowerCase();
    const normalizedArgs = commandArgs.map((value) => value.toLowerCase());
    const looksLikeTestVerification =
      step.name.toLowerCase().includes("test") ||
      normalizedCommand === "vitest" ||
      normalizedCommand === "jest" ||
      normalizedArgs.includes("test");
    if (looksLikeTestVerification) {
      return "Later deterministic verification reruns the workspace test command in non-interactive single-run mode.";
    }

    return `Later deterministic verification runs \`${this.redactSensitiveData(rendered)}\`.`;
  }

  private curateHistorySection(
    history: readonly PipelinePlannerContextHistoryEntry[],
    relevanceTerms: ReadonlySet<string>,
    maxChars: number,
  ): CuratedSection {
    if (history.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }

    const lastIndex = history.length - 1;
    const pinned = new Set<number>();
    for (
      let index = Math.max(0, history.length - CONTEXT_HISTORY_TAIL_PIN);
      index <= lastIndex;
      index++
    ) {
      pinned.add(index);
    }

    const scored = history.map((entry, index) => {
      const score = this.scoreText(entry.content, relevanceTerms);
      return { entry, index, score };
    });
    const relevant = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.index - a.index;
      });
    const filtered = (
      relevant.length > 0
        ? relevant
        : scored.filter((item) => pinned.has(item.index))
    ).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.index - a.index;
    });
    const selectedIndices = new Set<number>(
      (filtered.length > 0 ? filtered : scored.slice(-CONTEXT_HISTORY_TAIL_PIN))
        .map((item) => item.index),
    );
    const orderedLines = scored
      .filter((item) => selectedIndices.has(item.index))
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => {
        const prefix = entry.toolName
          ? `[${entry.role}:${entry.toolName}]`
          : `[${entry.role}]`;
        return `${prefix} ${this.redactSensitiveData(entry.content)}`;
      });
    const section = this.applySectionCaps(orderedLines, maxChars);
    return {
      ...section,
      available: history.length,
      omitted: Math.max(0, history.length - section.selected),
    };
  }

  private curateMemorySection(
    memory: readonly PipelinePlannerContextMemoryEntry[],
    requirementTerms: readonly string[],
    maxChars: number,
  ): CuratedSection {
    if (memory.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }
    const lowerRequirements = requirementTerms.map((term) => term.toLowerCase());
    const requirementTermSet = new Set(lowerRequirements);
    const sourceHints = this.resolveAllowedMemorySources(lowerRequirements);
    const candidates = memory
      .map((entry) => {
        if (!sourceHints.has(entry.source)) {
          return null;
        }
        const sourceMatch = sourceHints.has(entry.source);
        const score = this.scoreText(entry.content, requirementTermSet);
        return { entry, sourceMatch, score };
      })
      .filter(
        (entry): entry is {
          entry: PipelinePlannerContextMemoryEntry;
          sourceMatch: boolean;
          score: number;
        } => entry !== null,
      )
      .filter((entry) => entry.sourceMatch || entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.entry.source.localeCompare(b.entry.source);
      });
    const lines = candidates.map(
      ({ entry }) =>
        `[${entry.source}] ${this.redactSensitiveData(entry.content)}`,
    );
    const section = this.applySectionCaps(lines, maxChars);
    return {
      ...section,
      available: memory.length,
      omitted: Math.max(0, memory.length - section.selected),
    };
  }

  private curateToolOutputSection(
    step: PipelinePlannerSubagentStep,
    toolOutputs: readonly PipelinePlannerContextToolOutputEntry[],
    dependencies: readonly { dependencyName: string; result: string | null }[],
    relevanceTerms: ReadonlySet<string>,
    requirementTerms: readonly string[],
    maxChars: number,
  ): CuratedSection {
    const requiredCapabilities = new Set(
      step.requiredToolCapabilities.map((tool) => tool.toLowerCase()),
    );
    const requirementTermSet = new Set(
      requirementTerms.map((term) => term.toLowerCase()),
    );
    const dependencyLines = dependencies.map(
      ({ dependencyName, result }) =>
        `[dependency:${dependencyName}] ${this.redactSensitiveData(
          this.summarizeDependencyResultForPrompt(result),
        )}`,
    );
    const historicalLines = toolOutputs
      .map((entry) => {
        const toolName = entry.toolName?.toLowerCase();
        const capabilityMatch =
          typeof toolName === "string" &&
          Array.from(requiredCapabilities).some((required) =>
            toolName === required ||
            toolName.startsWith(required) ||
            required.startsWith(toolName)
          );
        const requirementMatch = this.scoreText(entry.content, requirementTermSet) > 0;
        const relevanceMatch = this.scoreText(entry.content, relevanceTerms) > 0;
        if (!capabilityMatch && !requirementMatch && !relevanceMatch) return null;
        const prefix = entry.toolName
          ? `[tool:${entry.toolName}]`
          : "[tool]";
        return `${prefix} ${this.redactSensitiveData(entry.content)}`;
      })
      .filter((line): line is string => line !== null);

    const combined = [...dependencyLines, ...historicalLines];
    const section = this.applySectionCaps(combined, maxChars);
    return {
      ...section,
      available: dependencies.length + toolOutputs.length,
      omitted: Math.max(
        0,
        dependencies.length + toolOutputs.length - section.selected,
      ),
    };
  }

  private curateDependencyArtifactSection(
    artifacts: readonly DependencyArtifactCandidate[],
    maxChars: number,
  ): CuratedSection {
    if (artifacts.length === 0 || maxChars <= 0) {
      return {
        lines: [],
        selected: 0,
        available: artifacts.length,
        omitted: artifacts.length,
        truncated: false,
      };
    }

    const prefixLengths = artifacts.map((artifact) =>
      `[artifact:${artifact.dependencyName}:${artifact.path}] `.length
    );
    const totalPrefixChars = prefixLengths.reduce((sum, value) => sum + value, 0);
    const previewBudget = Math.max(0, maxChars - totalPrefixChars);
    const weights = artifacts.map((artifact) =>
      artifact.score > 0 ? artifact.score : 1
    );
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const rawPreviewAllocations = weights.map((weight) =>
      totalWeight > 0 ? (previewBudget * weight) / totalWeight : 0
    );
    const previewAllocations = rawPreviewAllocations.map((value) =>
      Math.floor(value)
    );
    let remainder =
      previewBudget - previewAllocations.reduce((sum, value) => sum + value, 0);
    const fractionalOrder = rawPreviewAllocations
      .map((value, index) => ({ index, fractional: value - previewAllocations[index]! }))
      .sort((a, b) => b.fractional - a.fractional);
    for (const entry of fractionalOrder) {
      if (remainder <= 0) break;
      previewAllocations[entry.index] =
        (previewAllocations[entry.index] ?? 0) + 1;
      remainder -= 1;
    }
    const lines = artifacts.map((artifact, index) => {
      const prefix = `[artifact:${artifact.dependencyName}:${artifact.path}]`;
      const normalizedContent = artifact.content.trim().replace(/\s+/g, " ");
      const previewChars = previewAllocations[index] ?? 0;
      if (previewChars <= 0 || normalizedContent.length === 0) {
        return prefix;
      }
      return `${prefix} ${
        this.truncateText(normalizedContent, previewChars)
      }`;
    });
    const section = this.applySectionCaps(lines, maxChars);
    return {
      ...section,
      available: artifacts.length,
      omitted: Math.max(0, artifacts.length - section.selected),
    };
  }

  private collectDependencyArtifactCandidates(
    dependencies: readonly DependencyContextEntry[],
    queryTerms: ReadonlySet<string>,
  ): readonly DependencyArtifactCandidate[] {
    if (dependencies.length === 0) return [];
    const candidates = new Map<string, DependencyArtifactCandidate>();
    let order = 0;

    dependencies.forEach(({ dependencyName, result, depth }) => {
      if (typeof result !== "string" || result.trim().length === 0) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }

      const record = parsed as Record<string, unknown>;
      const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
      for (const toolCall of toolCalls) {
        const extracted = this.extractDependencyArtifactsFromToolCall(toolCall);
        for (const artifact of extracted) {
          const normalizedPath = artifact.path.trim().replace(/\\/g, "/");
          if (!this.isDependencyArtifactPathCandidate(normalizedPath)) {
            continue;
          }
          const content = artifact.content.trim();
          if (content.length === 0) continue;
          const candidate: DependencyArtifactCandidate = {
            dependencyName,
            path: normalizedPath,
            content,
            score: 0,
            order,
            depth,
          };
          order += 1;
          const previous = candidates.get(normalizedPath);
          if (
            !previous ||
            candidate.depth < previous.depth ||
            (
              candidate.depth === previous.depth &&
              candidate.order > previous.order
            )
          ) {
            candidates.set(normalizedPath, candidate);
          }
        }
      }
    });

    const uniqueCandidates = [...candidates.values()];
    if (uniqueCandidates.length === 0) {
      return [];
    }

    const bm25Scores = this.computeBm25Scores(
      uniqueCandidates.map((candidate) => ({
        id: candidate.path,
        text: `${candidate.path}\n${candidate.content}`,
      })),
      [...queryTerms],
    );

    return uniqueCandidates
      .map((candidate) => ({
        ...candidate,
        score: bm25Scores.get(candidate.path) ?? 0,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.order - b.order;
      });
  }

  private extractDependencyArtifactsFromToolCall(
    toolCall: unknown,
  ): readonly { path: string; content: string }[] {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
      return [];
    }

    const record = toolCall as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const args =
      typeof record.args === "object" &&
        record.args !== null &&
        !Array.isArray(record.args)
        ? record.args as Record<string, unknown>
        : undefined;
    const rawResult = typeof record.result === "string" ? record.result : "";

    if (
      (name === "system.writeFile" || name === "system.appendFile") &&
      args
    ) {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      return path.trim().length > 0 && content.trim().length > 0
        ? [{ path, content }]
        : [];
    }

    if (name === "system.readFile") {
      const path =
        (args && typeof args.path === "string" ? args.path : "").trim();
      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(rawResult);
      } catch {
        parsedResult = undefined;
      }
      if (
        parsedResult &&
        typeof parsedResult === "object" &&
        !Array.isArray(parsedResult)
      ) {
        const resultRecord = parsedResult as Record<string, unknown>;
        const resultPath =
          typeof resultRecord.path === "string" ? resultRecord.path : path;
        const content =
          typeof resultRecord.content === "string" ? resultRecord.content : "";
        return resultPath.trim().length > 0 && content.trim().length > 0
          ? [{ path: resultPath, content }]
          : [];
      }
      return [];
    }

    if (name !== "system.bash" || !args) {
      return [];
    }

    const command = typeof args.command === "string" ? args.command.trim() : "";
    const commandArgs = Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === "string")
      : [];
    if (command !== "cat" || commandArgs.length === 0) {
      return [];
    }

    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(rawResult);
    } catch {
      parsedResult = undefined;
    }
    if (
      !parsedResult ||
      typeof parsedResult !== "object" ||
      Array.isArray(parsedResult)
    ) {
      return [];
    }
    const stdout = (parsedResult as Record<string, unknown>).stdout;
    return typeof stdout === "string" && stdout.trim().length > 0
      ? [{ path: commandArgs[0]!, content: stdout }]
      : [];
  }

  private isDependencyArtifactPathCandidate(path: string): boolean {
    const normalized = path.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (
      normalized.includes("/node_modules/") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes("/dist/") ||
      normalized.startsWith("dist/") ||
      normalized.endsWith(".tsbuildinfo")
    ) {
      return false;
    }
    return /\.(?:[cm]?[jt]sx?|json|md|txt)$/i.test(normalized);
  }

  private allocateContextGroupBudgets(
    totalChars: number,
    groups: readonly { key: string; active: boolean }[],
  ): Record<string, number> {
    const activeGroups = groups.filter((group) => group.active);
    const budgets: Record<string, number> = {};
    if (activeGroups.length === 0) {
      return budgets;
    }
    const base = Math.floor(totalChars / activeGroups.length);
    let remainder = totalChars - base * activeGroups.length;
    for (const group of activeGroups) {
      budgets[group.key] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    return budgets;
  }

  private resolveAllowedMemorySources(
    lowerRequirements: readonly string[],
  ): Set<PipelinePlannerContextMemorySource> {
    const allowed = new Set<PipelinePlannerContextMemorySource>([
      "memory_semantic",
    ]);
    for (const term of lowerRequirements) {
      if (term.includes("semantic")) allowed.add("memory_semantic");
      if (term.includes("episodic")) allowed.add("memory_episodic");
      if (term.includes("working")) allowed.add("memory_working");
    }
    return allowed;
  }

  private redactSensitiveData(value: string): string {
    if (value.length === 0) return value;
    let redacted = value;
    redacted = redacted.replace(PRIVATE_KEY_BLOCK_RE, REDACTED_PRIVATE_KEY_BLOCK);
    redacted = redacted.replace(IMAGE_DATA_URL_RE, REDACTED_IMAGE_DATA_URL);
    redacted = redacted.replace(BEARER_TOKEN_RE, REDACTED_BEARER_TOKEN);
    redacted = redacted.replace(
      API_KEY_ASSIGNMENT_RE,
      (_match, key: string) => `${key}=<redacted>`,
    );
    redacted = redacted.replace(OPENAI_KEY_RE, REDACTED_API_KEY);
    redacted = redacted.replace(INTERNAL_URL_RE, REDACTED_INTERNAL_URL);
    redacted = redacted.replace(FILE_URL_RE, REDACTED_FILE_URL);
    redacted = redacted.replace(
      ABSOLUTE_PATH_RE,
      (_match, prefix: string) => `${prefix}${REDACTED_ABSOLUTE_PATH}`,
    );
    return redacted;
  }

  private buildRelevanceTerms(
    step: PipelinePlannerSubagentStep,
  ): Set<string> {
    const aggregate = [
      step.objective,
      step.inputContract,
      ...step.acceptanceCriteria,
      ...step.contextRequirements,
      ...step.requiredToolCapabilities,
    ].join(" ");
    return new Set(this.extractTerms(aggregate));
  }

  private extractTerms(value: string): string[] {
    const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
    const deduped = new Set<string>();
    for (const match of matches) {
      if (match.length < CONTEXT_TERM_MIN_LENGTH) continue;
      deduped.add(match);
    }
    return [...deduped];
  }

  private computeBm25Scores(
    documents: readonly { id: string; text: string }[],
    queryTerms: readonly string[],
  ): ReadonlyMap<string, number> {
    if (documents.length === 0 || queryTerms.length === 0) {
      return new Map();
    }

    const filteredQueryTerms = [...new Set(
      queryTerms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= CONTEXT_TERM_MIN_LENGTH),
    )];
    if (filteredQueryTerms.length === 0) {
      return new Map();
    }

    const stats = documents.map((document) => {
      const tokens = document.text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
      const termFrequencies = new Map<string, number>();
      for (const token of tokens) {
        if (token.length < CONTEXT_TERM_MIN_LENGTH) continue;
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
      }
      return {
        id: document.id,
        length: Math.max(1, tokens.length),
        termFrequencies,
      };
    });

    const averageDocumentLength =
      stats.reduce((sum, document) => sum + document.length, 0) / stats.length;
    const documentFrequency = new Map<string, number>();
    for (const term of filteredQueryTerms) {
      documentFrequency.set(
        term,
        stats.reduce(
          (count, document) =>
            count + (document.termFrequencies.has(term) ? 1 : 0),
          0,
        ),
      );
    }

    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map<string, number>();
    for (const document of stats) {
      let score = 0;
      for (const term of filteredQueryTerms) {
        const termFrequency = document.termFrequencies.get(term) ?? 0;
        if (termFrequency <= 0) continue;
        const docFrequency = documentFrequency.get(term) ?? 0;
        const idf = Math.log(
          1 + (stats.length - docFrequency + 0.5) / (docFrequency + 0.5),
        );
        const normalization =
          termFrequency +
          k1 * (1 - b + b * (document.length / Math.max(1, averageDocumentLength)));
        score += idf * ((termFrequency * (k1 + 1)) / Math.max(1e-9, normalization));
      }
      scores.set(document.id, score);
    }

    return scores;
  }

  private scoreText(text: string, terms: ReadonlySet<string>): number {
    if (terms.size === 0) return 0;
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score++;
    }
    return score;
  }

  private applySectionCaps(
    lines: readonly string[],
    maxChars: number,
  ): CuratedSection {
    const cleaned = lines
      .map((line) => this.redactSensitiveData(line.trim()))
      .filter((line) => line.length > 0);
    if (cleaned.length === 0) {
      return {
        lines: [],
        selected: 0,
        available: 0,
        omitted: 0,
        truncated: false,
      };
    }

    const selected: string[] = [];
    let usedChars = 0;
    let truncated = false;
    for (const line of cleaned) {
      const remaining = maxChars - usedChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (line.length <= remaining) {
        selected.push(line);
        usedChars += line.length + 1;
        continue;
      }
      if (remaining >= 24) {
        selected.push(this.truncateText(line, remaining));
      }
      truncated = true;
      break;
    }
    const omitted = Math.max(0, cleaned.length - selected.length);
    if (omitted > 0) truncated = true;
    return {
      lines: selected,
      selected: selected.length,
      available: cleaned.length,
      omitted,
      truncated,
    };
  }

  private truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
    return value.slice(0, maxChars - 3) + "...";
  }

  private resolveSubagentPromptBudgetCaps(): SubagentPromptBudgetCaps {
    if (!this.childPromptBudget) {
      return {
        historyChars: FALLBACK_CONTEXT_HISTORY_CHARS,
        memoryChars: FALLBACK_CONTEXT_MEMORY_CHARS,
        toolOutputChars: FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS,
        totalPromptChars: FALLBACK_SUBAGENT_TASK_PROMPT_CHARS,
      };
    }

    const plan = derivePromptBudgetPlan(this.childPromptBudget);
    return {
      historyChars: plan.caps.historyChars,
      memoryChars: plan.caps.memoryChars,
      toolOutputChars: plan.caps.toolChars,
      totalPromptChars:
        plan.caps.userChars +
        plan.caps.historyChars +
        plan.caps.memoryChars +
        plan.caps.toolChars +
        plan.caps.assistantRuntimeChars +
        plan.caps.otherChars,
    };
  }

  private summarizeDependencyResultForPrompt(result: string | null): string {
    if (result === null) return "null";

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return result;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return result;
    }

    const record = parsed as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    for (const key of [
      "status",
      "success",
      "durationMs",
      "providerName",
      "attempts",
      "stopReason",
      "stopReasonDetail",
      "validationCode",
    ]) {
      const value = record[key];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        summary[key] = value;
      }
    }

    if (typeof record.output === "string" && record.output.length > 0) {
      summary.output = record.output;
    }

    if (
      record.tokenUsage &&
      typeof record.tokenUsage === "object" &&
      !Array.isArray(record.tokenUsage)
    ) {
      const totalTokens = (record.tokenUsage as Record<string, unknown>).totalTokens;
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
        summary.tokenUsage = { totalTokens };
      }
    }

    if (Array.isArray(record.toolCalls)) {
      const toolNames = new Set<string>();
      for (const entry of record.toolCalls) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === "string" && name.trim().length > 0) {
          toolNames.add(name);
        }
      }
      summary.toolCallSummary = {
        count: record.toolCalls.length,
        tools: [...toolNames],
      };
    }

    return safeStringify(
      Object.keys(summary).length > 0 ? summary : record,
    );
  }

  private resolveParentSessionId(pipelineId: string): string {
    if (!pipelineId.startsWith("planner:")) return pipelineId;
    const segments = pipelineId.split(":");
    return segments[1] ?? pipelineId;
  }
}
