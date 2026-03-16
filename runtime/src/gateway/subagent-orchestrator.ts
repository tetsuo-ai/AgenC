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
  type PromptBudgetConfig,
} from "../llm/prompt-budget.js";
import type {
  LLMProviderExecutionProfile,
  LLMUsage,
} from "../llm/types.js";
import {
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
} from "../llm/chat-executor-constants.js";
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
/* ---- Extracted sub-modules ---- */
import {
  type SubagentFailureOutcome,
  type SubagentContextDiagnostics,
  isPipelineStopReasonHint,
  toPipelineStopReasonHint,
  summarizeSubagentFailureHistory,
  SUBAGENT_RETRY_POLICY,
  SUBAGENT_FAILURE_STOP_REASON,
} from "./subagent-orchestrator-types.js";
import {
  redactSensitiveData,
  truncateText,
  buildRelevanceTerms,
  extractTerms,
  allocateContextGroupBudgets,
  resolveSubagentPromptBudgetCaps,
  curateHistorySection,
  curateMemorySection,
  curateToolOutputSection,
  curateDependencyArtifactSection,
  collectDependencyArtifactCandidates,
  collectWorkspaceArtifactCandidates,
} from "./subagent-context-curation.js";
import {
  parseBudgetHintMs as parseBudgetHintMsFn,
  resolveSubagentToolBudgetPerRequest as resolveSubagentToolBudgetPerRequestFn,
  createRetryAttemptTracker,
  computeRetryDelayMs,
  classifySpawnFailure,
  classifySubagentFailureResult,
  resolvePlannerStepWorkingDirectory,
  buildEffectiveContextRequirements,
  hasHighRiskCapabilities,
} from "./subagent-failure-classification.js";
import {
  summarizeDependencyResultForPrompt,
  resolveParentSessionId,
} from "./subagent-dependency-summarization.js";
import {
  buildSubagentAcceptanceProbePlans,
  renderDeterministicCommandSummary,
  buildWorkspaceStateGuidanceLines,
} from "./subagent-workspace-probes.js";
import {
  summarizeParentRequestForSubagent,
  collectDependencyContexts,
  buildArtifactRelevanceTerms,
  buildDownstreamRequirementLines,
  buildWorkspaceVerificationContractLines,
  buildEffectiveDelegationSpec,
  buildEffectiveAcceptanceCriteria,
  buildRetryTaskPrompt as buildRetryTaskPromptFn,
  buildHostToolingPromptSection as buildHostToolingPromptSectionFn,
  resolveParentPolicyAllowlist as resolveParentPolicyAllowlistFn,
} from "./subagent-prompt-builder.js";

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

interface ExecuteSubagentAttemptParams {
  readonly subAgentManager: SubAgentExecutionManager;
  readonly step: PipelinePlannerSubagentStep;
  readonly pipeline: Pipeline;
  readonly parentSessionId: string;
  readonly parentRequest?: string;
  readonly lastValidationCode?: DelegationOutputValidationCode;
  readonly timeoutMs: number;
  readonly toolBudgetPerRequest: number;
  readonly taskPrompt: string;
  readonly diagnostics: SubagentContextDiagnostics;
  readonly tools: readonly string[];
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  readonly signal?: AbortSignal;
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

interface RuntimeNode {
  readonly step: PipelinePlannerStep;
  readonly dependencies: ReadonlySet<string>;
  readonly orderIndex: number;
}

interface RunningNode {
  readonly promise: Promise<NodeExecutionOutcome>;
  readonly exclusive: boolean;
  readonly abortController: AbortController;
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

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_PARALLEL_SUBTASKS = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
const DEFAULT_MAX_SUBAGENT_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_REQUEST = 32;
const DEFAULT_MAX_CUMULATIVE_TOOL_CALLS_PER_REQUEST_TREE = 256;
const DEFAULT_MAX_CUMULATIVE_TOKENS_PER_REQUEST_TREE = 0;
const DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP = 150_000;
const DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS =
  DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP /
  DEFAULT_SUBAGENT_TIMEOUT_MS;
const DEFAULT_REQUEST_TREE_SUBAGENT_PASSES = Math.max(
  1,
  DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS,
);
const DEFAULT_FALLBACK_BEHAVIOR = "fail_request" as const;

interface SubAgentExecutionManager {
  spawn(config: SubAgentConfig): Promise<string>;
  getResult(sessionId: string): SubAgentResult | null;
  cancel(sessionId: string): boolean;
}

interface ResolvedChildPromptBudget {
  readonly promptBudget?: PromptBudgetConfig;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

export interface SubAgentOrchestratorConfig {
  readonly fallbackExecutor: DeterministicPipelineExecutor;
  readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  readonly resolveLifecycleEmitter?: () => SubAgentLifecycleEmitter | null;
  readonly resolveTrajectorySink?: () => DelegationTrajectorySink | null;
  readonly resolveAvailableToolNames?: () => readonly string[] | null;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  readonly resolveHostWorkspaceRoot?: () => string | null;
  readonly childPromptBudget?: PromptBudgetConfig;
  readonly resolveChildPromptBudget?: (params: {
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) =>
    | Promise<ResolvedChildPromptBudget | undefined>
    | ResolvedChildPromptBudget
    | undefined;
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
  readonly unsafeBenchmarkMode?: boolean;
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

  snapshot(): {
    readonly spawnedChildren: number;
    readonly reservedSpawns: number;
    readonly cumulativeToolCalls: number;
    readonly cumulativeTokens: number;
    readonly maxTotalSubagentsPerRequest: number;
    readonly maxCumulativeToolCallsPerRequestTree: number;
    readonly maxCumulativeTokensPerRequestTree: number;
  } {
    return {
      spawnedChildren: this.spawnedChildren,
      reservedSpawns: this.reservedSpawns,
      cumulativeToolCalls: this.cumulativeToolCalls,
      cumulativeTokens: this.cumulativeTokens,
      maxTotalSubagentsPerRequest: this.maxTotalSubagentsPerRequest,
      maxCumulativeToolCallsPerRequestTree:
        this.maxCumulativeToolCallsPerRequestTree,
      maxCumulativeTokensPerRequestTree:
        this.maxCumulativeTokensPerRequestTree,
    };
  }

  reserveSpawn(): RequestTreeBudgetBreach | null {
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: this.spawnedChildren + this.reservedSpawns + 1,
        state: this.snapshot(),
      };
    }
    const projected = this.spawnedChildren + this.reservedSpawns + 1;
    if (projected > this.maxTotalSubagentsPerRequest) {
      this.circuitBreakerReason =
        `max spawned children per request exceeded (${this.maxTotalSubagentsPerRequest})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "spawns",
        attemptedSpawnCount: projected,
        state: this.snapshot(),
      };
    }
    this.reservedSpawns += 1;
    return null;
  }

  commitSpawnResult(spawned: boolean): void {
    this.reservedSpawns = Math.max(0, this.reservedSpawns - 1);
    if (spawned) this.spawnedChildren += 1;
  }

  recordUsage(
    toolCallCount: number,
    tokenCount: number,
  ): RequestTreeBudgetBreach | null {
    const normalizedToolCalls = Math.max(0, Math.floor(toolCallCount));
    const normalizedTokens = Math.max(0, Math.floor(tokenCount));
    if (this.circuitBreakerReason) {
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    this.cumulativeToolCalls += normalizedToolCalls;
    this.cumulativeTokens += normalizedTokens;
    if (
      this.maxCumulativeToolCallsPerRequestTree > 0 &&
      this.cumulativeToolCalls > this.maxCumulativeToolCallsPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tool calls per request tree exceeded (${this.maxCumulativeToolCallsPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tool_calls",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    if (
      this.maxCumulativeTokensPerRequestTree > 0 &&
      this.cumulativeTokens > this.maxCumulativeTokensPerRequestTree
    ) {
      this.circuitBreakerReason =
        `max cumulative child tokens per request tree exceeded (${this.maxCumulativeTokensPerRequestTree})`;
      return {
        reason: this.circuitBreakerReason,
        limitKind: "tokens",
        stepToolCalls: normalizedToolCalls,
        stepTokens: normalizedTokens,
        state: this.snapshot(),
      };
    }
    return null;
  }
}

interface RequestTreeBudgetSnapshot {
  readonly spawnedChildren: number;
  readonly reservedSpawns: number;
  readonly cumulativeToolCalls: number;
  readonly cumulativeTokens: number;
  readonly maxTotalSubagentsPerRequest: number;
  readonly maxCumulativeToolCallsPerRequestTree: number;
  readonly maxCumulativeTokensPerRequestTree: number;
}

type RequestTreeBudgetBreach =
  | {
    readonly reason: string;
    readonly limitKind: "spawns";
    readonly attemptedSpawnCount: number;
    readonly state: RequestTreeBudgetSnapshot;
  }
  | {
    readonly reason: string;
    readonly limitKind: "tool_calls" | "tokens";
    readonly stepToolCalls: number;
    readonly stepTokens: number;
    readonly state: RequestTreeBudgetSnapshot;
  };

export class SubAgentOrchestrator implements DeterministicPipelineExecutor {
  private readonly fallbackExecutor: DeterministicPipelineExecutor;
  private readonly resolveSubAgentManager: () => SubAgentExecutionManager | null;
  private readonly resolveLifecycleEmitter: () => SubAgentLifecycleEmitter | null;
  private readonly resolveTrajectorySink: () => DelegationTrajectorySink | null;
  private readonly resolveAvailableToolNames: () => readonly string[] | null;
  private readonly resolveHostToolingProfile: () => HostToolingProfile | null;
  private readonly resolveHostWorkspaceRoot: () => string | null;
  private readonly childPromptBudget?: PromptBudgetConfig;
  private readonly resolveChildPromptBudget?:
    SubAgentOrchestratorConfig["resolveChildPromptBudget"];
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
  private readonly unsafeBenchmarkMode: boolean;

  constructor(config: SubAgentOrchestratorConfig) {
    this.fallbackExecutor = config.fallbackExecutor;
    this.resolveSubAgentManager = config.resolveSubAgentManager;
    this.resolveLifecycleEmitter =
      config.resolveLifecycleEmitter ?? (() => null);
    this.resolveTrajectorySink = config.resolveTrajectorySink ?? (() => null);
    this.resolveAvailableToolNames = config.resolveAvailableToolNames ?? (() => null);
    this.resolveHostToolingProfile =
      config.resolveHostToolingProfile ?? (() => null);
    this.resolveHostWorkspaceRoot =
      config.resolveHostWorkspaceRoot ?? (() => null);
    this.childPromptBudget = config.childPromptBudget;
    this.resolveChildPromptBudget = config.resolveChildPromptBudget;
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
      0,
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
    this.unsafeBenchmarkMode = config.unsafeBenchmarkMode === true;
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
    const parentSessionId = resolveParentSessionId(pipeline.id);
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

        const traceTool = this.resolvePipelineTraceToolName(node.step);
        const traceArgs = this.buildPipelineTraceArgs(node.step);
        const emitPlannerNodeTrace = traceTool !== undefined;
        const stepStartedAt = emitPlannerNodeTrace ? Date.now() : 0;
        if (emitPlannerNodeTrace) {
          options?.onEvent?.({
            type: "step_started",
            pipelineId: pipeline.id,
            stepName: node.step.name,
            stepIndex: node.orderIndex,
            tool: traceTool,
            args: traceArgs,
          });
        }
        const nodeAbortController = new AbortController();
        const promise = this.executeNode(
          node.step,
          pipeline,
          mutableResults,
          budgetTracker,
          options,
          nodeAbortController.signal,
        ).then((outcome) => {
          if (emitPlannerNodeTrace) {
            const event: {
              type: "step_finished";
              pipelineId: string;
              stepName: string;
              stepIndex: number;
              tool: string;
              args?: Record<string, unknown>;
              durationMs: number;
              result?: string;
              error?: string;
            } = {
              type: "step_finished",
              pipelineId: pipeline.id,
              stepName: node.step.name,
              stepIndex: node.orderIndex,
              tool: traceTool,
              args: traceArgs,
              durationMs: Math.max(0, Date.now() - stepStartedAt),
            };
            if ("result" in outcome && typeof outcome.result === "string") {
              event.result = outcome.result;
            }
            if (outcome.status === "failed") {
              event.error = outcome.error;
            } else if (outcome.status === "halted" && outcome.error) {
              event.error = outcome.error;
            }
            options?.onEvent?.(event);
          }
          return outcome;
        });
        running.set(node.step.name, { promise, exclusive: exclusiveNode, abortController: nodeAbortController });
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
        // Cancel all still-running siblings before returning
        for (const [, handle] of running) {
          handle.abortController.abort();
        }
        if (running.size > 0) {
          await Promise.allSettled(Array.from(running.values()).map((h) => h.promise));
          running.clear();
        }
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
      // Cancel all still-running siblings before returning
      for (const [, handle] of running) {
        handle.abortController.abort();
      }
      if (running.size > 0) {
        await Promise.allSettled(Array.from(running.values()).map((h) => h.promise));
        running.clear();
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
        if (step.onError === "skip") {
          return { satisfied: true };
        }
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

  private resolvePipelineTraceToolName(
    step: PipelinePlannerStep,
  ): string | undefined {
    if (step.stepType === "subagent_task") {
      return "execute_with_agent";
    }
    return undefined;
  }

  private buildPipelineTraceArgs(
    step: PipelinePlannerStep,
  ): Record<string, unknown> | undefined {
    if (step.stepType !== "subagent_task") {
      return undefined;
    }
    return {
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: [...step.acceptanceCriteria],
      requiredToolCapabilities: [...step.requiredToolCapabilities],
      contextRequirements: [...step.contextRequirements],
      maxBudgetHint: step.maxBudgetHint,
      canRunParallel: step.canRunParallel,
    };
  }

  private async executeNode(
    step: PipelinePlannerStep,
    pipeline: Pipeline,
    results: Record<string, string>,
    budgetTracker: RequestTreeBudgetTracker,
    options?: PipelineExecutionOptions,
    signal?: AbortSignal,
  ): Promise<NodeExecutionOutcome> {
    if (signal?.aborted) {
      return { status: "failed", error: "Step cancelled (sibling failure)", stopReasonHint: "cancelled" };
    }
    if (step.stepType === "deterministic_tool") {
      return this.executeDeterministicStep(step, pipeline, results, options);
    }
    if (step.stepType === "subagent_task") {
      return this.executeSubagentStep(step, pipeline, results, budgetTracker, signal);
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
    signal?: AbortSignal,
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

    const parentSessionId = resolveParentSessionId(pipeline.id);
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

    const timeoutMs = parseBudgetHintMsFn(step.maxBudgetHint, this.defaultSubagentTimeoutMs);
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
    const subagentTask = await this.buildSubagentTaskPrompt(
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
      highRiskPlan: hasHighRiskCapabilities(step.requiredToolCapabilities),
    });
    const parentTurnId = `parent:${parentSessionId}:${pipeline.createdAt}`;
    const trajectoryTraceId = `trace:${parentSessionId}:${pipeline.createdAt}`;
    const retryAttempts = createRetryAttemptTracker();
    let attempt = 0;
    let lastFailure: SubagentFailureOutcome | null = null;
    const failureHistory: SubagentFailureOutcome[] = [];
    let taskPrompt = subagentTask.taskPrompt;

    while (true) {
      if (signal?.aborted) {
        return { status: "failed", error: "Step cancelled (sibling failure)", stopReasonHint: "cancelled" };
      }
      attempt += 1;
      const reservationBreach = budgetTracker.reserveSpawn();
      if (reservationBreach) {
        const breakerMessage =
          this.formatRequestTreeBudgetBreach(reservationBreach);
        lifecycleEmitter?.emit({
          type: "subagents.failed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          toolName: "execute_with_agent",
          payload: this.buildRequestTreeBudgetBreachPayload({
            stepName: step.name,
            attempt,
            breach: reservationBreach,
          }),
        });
        return {
          status: "failed",
          error:
            `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
          stopReasonHint: "budget_exceeded",
        };
      }
      let attemptOutcome: ExecuteSubagentAttemptOutcome =
        await this.executeSubagentAttempt({
        subAgentManager,
        step,
        pipeline,
        parentSessionId,
        parentRequest: pipeline.plannerContext?.parentRequest,
        lastValidationCode: lastFailure?.validationCode,
        timeoutMs,
        toolBudgetPerRequest: resolveSubagentToolBudgetPerRequestFn({
          timeoutMs,
          priorFailureClass: lastFailure?.failureClass,
        }),
        taskPrompt,
        diagnostics: subagentTask.diagnostics,
        tools: toolScope.allowedTools,
        lifecycleEmitter,
        signal,
      });
      if (attemptOutcome.status === "completed") {
        const acceptanceProbeFailure =
          await this.runCompletedSubagentAcceptanceProbes({
            step,
            pipeline,
            results,
            parentSessionId,
            subagentSessionId: attemptOutcome.subagentSessionId,
            toolCalls: attemptOutcome.toolCalls,
            tokenUsage: attemptOutcome.tokenUsage,
            durationMs: attemptOutcome.durationMs,
            lifecycleEmitter,
          });
        if (acceptanceProbeFailure) {
          attemptOutcome = {
            status: "failed",
            failure: acceptanceProbeFailure,
          };
        }
      }
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
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
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
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: step.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
            stopReasonHint: "budget_exceeded",
          };
        }
        lifecycleEmitter?.emit({
          type: "subagents.completed",
          timestamp: Date.now(),
          sessionId: parentSessionId,
          parentSessionId,
          subagentSessionId: attemptOutcome.subagentSessionId,
          toolName: "execute_with_agent",
          payload: {
            stepName: step.name,
            durationMs: attemptOutcome.durationMs,
            toolCalls: attemptOutcome.toolCalls.length,
            providerName: attemptOutcome.providerName,
          },
        });
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
          const breakerMessage = this.formatRequestTreeBudgetBreach(usageBreach);
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
            payload: this.buildRequestTreeBudgetBreachPayload({
              stepName: step.name,
              attempt,
              breach: usageBreach,
            }),
          });
          return {
            status: "failed",
            error:
              `Sub-agent circuit breaker opened for step "${step.name}": ${breakerMessage}`,
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
        ? computeRetryDelayMs(retryRule, retryAttempt)
        : 0;

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
        taskPrompt = buildRetryTaskPromptFn(
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
            output: lastFailure.message,
            durationMs: lastFailure.durationMs,
            failureClass: lastFailure.failureClass,
            validationCode: lastFailure.validationCode,
            decomposition: lastFailure.decomposition,
            attempt,
            retrying: true,
            retryAttempt,
            maxRetries: retryRule.maxRetries,
            delayMs: retryDelayMs,
            nextRetryDelayMs: retryDelayMs,
          },
        });
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
        continue;
      }

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
          retrying: false,
          retryAttempt,
          maxRetries: retryRule.maxRetries,
          nextRetryDelayMs: retryDelayMs,
        },
      });

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

  private async executeSubagentAttempt(
    input: ExecuteSubagentAttemptParams,
  ): Promise<ExecuteSubagentAttemptOutcome> {
    const scopeAssessment = assessDelegationScope({
      objective: input.step.objective,
      inputContract: input.step.inputContract,
      acceptanceCriteria: input.step.acceptanceCriteria,
      requiredToolCapabilities: input.step.requiredToolCapabilities,
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

    const delegatedWorkingDirectory = resolvePlannerStepWorkingDirectory(
      input.step,
      input.pipeline,
      this.resolveHostWorkspaceRoot(),
    );
    const effectiveStep = {
      ...input.step,
      contextRequirements: buildEffectiveContextRequirements(
        input.step,
        delegatedWorkingDirectory?.path,
      ),
    } satisfies PipelinePlannerSubagentStep;
    const effectiveDelegationSpec = buildEffectiveDelegationSpec(
      effectiveStep,
      input.pipeline,
      {
        parentRequest: input.parentRequest,
        lastValidationCode: input.lastValidationCode,
        delegatedWorkingDirectory: delegatedWorkingDirectory?.path,
        resolveHostToolingProfile: this.resolveHostToolingProfile,
      },
    );
    let childSessionId: string;
    try {
      const workingDirectory = delegatedWorkingDirectory?.path;
      childSessionId = await input.subAgentManager.spawn({
        parentSessionId: input.parentSessionId,
        task: input.taskPrompt,
        timeoutMs: input.timeoutMs,
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(delegatedWorkingDirectory
          ? { workingDirectorySource: delegatedWorkingDirectory.source }
          : {}),
        tools: input.tools,
        requiredCapabilities: effectiveStep.requiredToolCapabilities,
        requireToolCall: specRequiresSuccessfulToolEvidence({
            objective: effectiveStep.objective,
            inputContract: effectiveStep.inputContract,
            acceptanceCriteria:
              effectiveDelegationSpec.acceptanceCriteria,
            requiredToolCapabilities: effectiveStep.requiredToolCapabilities,
            tools: input.tools,
          }),
        delegationSpec: effectiveDelegationSpec,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifySpawnFailure(message);
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
        toolBudgetPerRequest: input.toolBudgetPerRequest,
        contextCuration: input.diagnostics,
        ...(this.unsafeBenchmarkMode ? { unsafeBenchmarkMode: true } : {}),
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
      if (input.signal?.aborted) {
        // Sibling step failed — cancel this child sub-agent and bail
        input.subAgentManager.cancel(childSessionId);
        return {
          status: "failed",
          failure: {
            failureClass: "cancelled",
            message: `Sub-agent for step "${input.step.name}" cancelled (sibling failure)`,
            stopReasonHint: "cancelled",
          },
        };
      }
      const result = input.subAgentManager.getResult(childSessionId);
      if (!result) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (result.success) {
        const contractValidation = validateDelegatedOutputContract({
          spec: effectiveDelegationSpec,
          output: result.output,
          toolCalls: result.toolCalls,
          providerEvidence: result.providerEvidence,
          unsafeBenchmarkMode: this.unsafeBenchmarkMode,
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
      const initialFailureClass = classifySubagentFailureResult(result);
      const contractValidation =
        result.stopReason === "validation_error" && !result.validationCode
          ? validateDelegatedOutputContract({
            spec: effectiveDelegationSpec,
            output: result.output,
            toolCalls: result.toolCalls,
            providerEvidence: result.providerEvidence,
            unsafeBenchmarkMode: this.unsafeBenchmarkMode,
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

  private async runCompletedSubagentAcceptanceProbes(params: {
    readonly step: PipelinePlannerSubagentStep;
    readonly pipeline: Pipeline;
    readonly results: Record<string, string>;
    readonly parentSessionId: string;
    readonly subagentSessionId: string;
    readonly toolCalls: SubAgentResult["toolCalls"];
    readonly tokenUsage?: LLMUsage;
    readonly durationMs: number;
    readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  }): Promise<SubagentFailureOutcome | undefined> {
    const probes = buildSubagentAcceptanceProbePlans(
      params.step,
      params.pipeline,
      params.toolCalls,
    );
    if (probes.length === 0) {
      return undefined;
    }

    for (const probe of probes) {
      const probeArgs = probe.step.args as {
        readonly command?: string;
        readonly args?: readonly string[];
        readonly cwd?: string;
      };
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.started",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
        },
      });

      const startedAt = Date.now();
      const outcome = await this.executeDeterministicStep(
        probe.step,
        params.pipeline,
        params.results,
      );
      const durationMs = Date.now() - startedAt;

      if (outcome.status === "completed") {
        params.lifecycleEmitter?.emit({
          type: "subagents.acceptance_probe.completed",
          timestamp: Date.now(),
          sessionId: params.parentSessionId,
          parentSessionId: params.parentSessionId,
          subagentSessionId: params.subagentSessionId,
          toolName: probe.step.tool,
          payload: {
            stepName: params.step.name,
            probeName: probe.name,
            category: probe.category,
            durationMs,
            result: outcome.result,
          },
        });
        continue;
      }

      const commandSummary = renderDeterministicCommandSummary(probe.step);
      const cwdSummary =
        typeof probeArgs.cwd === "string" && probeArgs.cwd.trim().length > 0
          ? ` in \`${redactSensitiveData(probeArgs.cwd)}\``
          : "";
      const failureMessage =
        `Parent-side deterministic acceptance probe failed for step "${params.step.name}" ` +
        `(${probe.category})${cwdSummary}: ${commandSummary}. ${outcome.error}`;
      const probeStopReasonHint =
        outcome.status === "failed" ? outcome.stopReasonHint : undefined;
      params.lifecycleEmitter?.emit({
        type: "subagents.acceptance_probe.failed",
        timestamp: Date.now(),
        sessionId: params.parentSessionId,
        parentSessionId: params.parentSessionId,
        subagentSessionId: params.subagentSessionId,
        toolName: probe.step.tool,
        payload: {
          stepName: params.step.name,
          probeName: probe.name,
          category: probe.category,
          durationMs,
          command: probeArgs.command ?? null,
          args: probeArgs.args ?? [],
          cwd: probeArgs.cwd ?? null,
          error: outcome.error,
        },
      });
      return {
        failureClass: "malformed_result_contract",
        message: failureMessage,
        validationCode: "acceptance_probe_failed",
        stopReasonHint: probeStopReasonHint ?? "validation_error",
        childSessionId: params.subagentSessionId,
        durationMs: params.durationMs,
        toolCallCount: params.toolCalls.length,
        tokenUsage: params.tokenUsage,
      };
    }

    return undefined;
  }

  private async buildSubagentTaskPrompt(
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
  ): Promise<{
    taskPrompt: string;
    diagnostics: SubagentContextDiagnostics;
  }> {
    const plannerContext = pipeline.plannerContext;
    let resolvedChildPromptBudget: ResolvedChildPromptBudget | undefined;
    try {
      resolvedChildPromptBudget =
        await this.resolveChildPromptBudget?.({
          task: step.objective,
          tools: toolScope.allowedTools,
          requiredCapabilities: step.requiredToolCapabilities,
        });
    } catch {
      resolvedChildPromptBudget = undefined;
    }
    const effectivePromptBudget =
      resolvedChildPromptBudget?.promptBudget ?? this.childPromptBudget;
    const promptBudgetCaps = resolveSubagentPromptBudgetCaps(
      effectivePromptBudget,
    );
    const parentRequest = plannerContext?.parentRequest?.trim();
    const summarizedParentRequest = parentRequest
      ? summarizeParentRequestForSubagent(parentRequest, step)
      : undefined;
    const relevanceTerms = buildRelevanceTerms(step);
    const artifactRelevanceTerms = buildArtifactRelevanceTerms(step);
    const delegatedWorkingDirectory = resolvePlannerStepWorkingDirectory(
      step,
      pipeline,
      this.resolveHostWorkspaceRoot(),
    );
    const effectiveContextRequirements = buildEffectiveContextRequirements(
      step,
      delegatedWorkingDirectory?.path,
    );
    const effectiveStep = {
      ...step,
      contextRequirements: effectiveContextRequirements,
    } satisfies PipelinePlannerSubagentStep;
    const requirementTerms = extractTerms(
      effectiveContextRequirements.join(" "),
    );
    const dependencies = collectDependencyContexts(step, pipeline, results);
    const dependencyArtifactCandidates = collectDependencyArtifactCandidates(
      dependencies,
      artifactRelevanceTerms,
      delegatedWorkingDirectory?.path,
    );
    const workspaceArtifactCandidates =
      dependencyArtifactCandidates.length === 0 &&
        delegatedWorkingDirectory?.path
        ? collectWorkspaceArtifactCandidates(
          delegatedWorkingDirectory.path,
          artifactRelevanceTerms,
          promptBudgetCaps.toolOutputChars,
        )
        : [];
    const promptArtifactCandidates =
      dependencyArtifactCandidates.length > 0
        ? dependencyArtifactCandidates
        : workspaceArtifactCandidates;
    const toolContextBudgets = allocateContextGroupBudgets(
      promptBudgetCaps.toolOutputChars,
      [
        {
          key: "toolOutputs",
          active:
            dependencies.length > 0 ||
            (plannerContext?.toolOutputs?.length ?? 0) > 0,
        },
        { key: "dependencyArtifacts", active: promptArtifactCandidates.length > 0 },
      ],
    );

    const historySection = curateHistorySection(
      plannerContext?.history ?? [],
      relevanceTerms,
      promptBudgetCaps.historyChars,
    );
    const memorySection = curateMemorySection(
      plannerContext?.memory ?? [],
      effectiveContextRequirements,
      relevanceTerms,
      promptBudgetCaps.memoryChars,
    );
    const toolOutputSection = curateToolOutputSection(
      effectiveStep,
      plannerContext?.toolOutputs ?? [],
      dependencies,
      relevanceTerms,
      requirementTerms,
      toolContextBudgets.toolOutputs ?? 0,
      summarizeDependencyResultForPrompt,
    );
    const dependencyArtifactSection = curateDependencyArtifactSection(
      promptArtifactCandidates,
      toolContextBudgets.dependencyArtifacts ?? 0,
    );
    const workspaceStateGuidanceLines = buildWorkspaceStateGuidanceLines(
      effectiveStep,
      pipeline,
      promptArtifactCandidates,
      delegatedWorkingDirectory?.path,
    );
    const hostToolingSection = buildHostToolingPromptSectionFn(
      effectiveStep,
      pipeline,
      dependencyArtifactCandidates,
      this.resolveHostToolingProfile,
    );
    const downstreamRequirementLines = buildDownstreamRequirementLines(
      effectiveStep,
      pipeline,
    );
    const workspaceVerificationContractLines =
      buildWorkspaceVerificationContractLines(effectiveStep, pipeline);
    const effectiveAcceptanceCriteria = buildEffectiveAcceptanceCriteria(
      effectiveStep,
      pipeline,
      delegatedWorkingDirectory?.path,
      this.resolveHostToolingProfile,
    );

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
- Execute only the assigned phase \`${effectiveStep.name}\`.
- Do not create a new multi-step plan for the broader parent request.
- Do not attempt sibling phases or synthesize the final deliverable.
- If the task requires tool-grounded evidence, you must use one or more allowed tools before answering.
- If you cannot complete the phase with the allowed tools, state that you are blocked and explain exactly why.`,
      );
      sections.push(`Objective: ${redactSensitiveData(effectiveStep.objective)}`);
      sections.push(
        `Input contract: ${redactSensitiveData(effectiveStep.inputContract)}`,
      );
      if (summarizedParentRequest && summarizedParentRequest.length > 0) {
        sections.push(
          `Parent request summary: ${redactSensitiveData(summarizedParentRequest)}`,
        );
      }
      if (effectiveAcceptanceCriteria.length > 0) {
        sections.push(
          `Acceptance criteria:\n${effectiveAcceptanceCriteria.map((item) => `- ${redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (effectiveContextRequirements.length > 0) {
        sections.push(
          `Context requirements:\n${effectiveContextRequirements.map((item) => `- ${redactSensitiveData(item)}`).join("\n")}`,
        );
      }
      if (
        delegatedWorkingDirectory &&
        delegatedWorkingDirectory.source !== "context_requirement"
      ) {
        sections.push(
          "Working directory:\n" +
            `- Use \`${redactSensitiveData(delegatedWorkingDirectory.path)}\` as the workspace root for this phase.\n` +
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
      if (!allowsDirectFileWrite) {
        sections.push(
          "Output contract:\n" +
            "- If this phase needs a design document, summary, JSON payload, notes, or other textual artifact and no file-write tools are allowed, return that artifact inline in your response.\n" +
            "- Do not block solely because you cannot persist a workspace file unless the acceptance criteria explicitly require a file on disk.",
        );
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
      if (workspaceStateGuidanceLines.length > 0) {
        sections.push(
          "Observed workspace state:\n" +
            workspaceStateGuidanceLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      if (hostToolingSection.lines.length > 0) {
        sections.push(
          `Host tooling constraints:\n${
            hostToolingSection.lines.map((line) => `- ${line}`).join("\n")
          }`,
        );
      }
      const allDownstreamRequirementLines = [
        ...downstreamRequirementLines,
        ...workspaceVerificationContractLines,
      ];
      if (allDownstreamRequirementLines.length > 0) {
        sections.push(
          "Downstream execution requirements:\n" +
            allDownstreamRequirementLines.map((line) => `- ${line}`).join("\n"),
        );
      }
      sections.push(`Budget hint: ${step.maxBudgetHint}`);
      sections.push(
        `Context curation diagnostics:\n${safeStringify(diagnostics)}`,
      );
      return redactSensitiveData(sections.join("\n\n"));
    };

    let diagnostics: SubagentContextDiagnostics = {
      executionBudget: {
        provider: resolvedChildPromptBudget?.providerProfile?.provider,
        model: resolvedChildPromptBudget?.providerProfile?.model,
        contextWindowTokens:
          resolvedChildPromptBudget?.providerProfile?.contextWindowTokens ??
          effectivePromptBudget?.contextWindowTokens,
        contextWindowSource:
          resolvedChildPromptBudget?.providerProfile?.contextWindowSource,
        maxOutputTokens:
          resolvedChildPromptBudget?.providerProfile?.maxOutputTokens ??
          effectivePromptBudget?.maxOutputTokens,
        historyChars: promptBudgetCaps.historyChars,
        memoryChars: promptBudgetCaps.memoryChars,
        toolOutputChars: promptBudgetCaps.toolOutputChars,
        totalPromptChars: promptBudgetCaps.totalPromptChars,
      },
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
        available: promptArtifactCandidates.length,
        omitted: Math.max(
          0,
          promptArtifactCandidates.length - dependencyArtifactSection.selected,
        ),
        truncated: dependencyArtifactSection.truncated,
      },
      hostTooling: hostToolingSection.diagnostics,
      promptTruncated: false,
      toolScope: {
        strategy: this.childToolAllowlistStrategy,
        unsafeBenchmarkMode: this.unsafeBenchmarkMode,
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
      taskPrompt = truncateText(
        buildPrompt(diagnostics),
        promptBudgetCaps.totalPromptChars,
      );
    }

    return { taskPrompt, diagnostics };
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
    const parentPolicyAllowed = resolveParentPolicyAllowlistFn(pipeline, this.allowedParentTools);
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
      unsafeBenchmarkMode: this.unsafeBenchmarkMode,
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

  private resolveEffectiveMaxCumulativeTokensPerRequestTree(
    plannerSteps: readonly PipelinePlannerStep[],
  ): number {
    if (this.maxCumulativeTokensPerRequestTree <= 0) {
      return 0;
    }
    if (this.maxCumulativeTokensPerRequestTreeExplicitlyConfigured) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const plannedSubagentSteps = plannerSteps.filter(
      (step) => step.stepType === "subagent_task",
    ) as readonly PipelinePlannerSubagentStep[];
    if (plannedSubagentSteps.length <= 0) {
      return this.maxCumulativeTokensPerRequestTree;
    }
    const derivedBudget = plannedSubagentSteps.reduce(
      (total, step) =>
        total + this.estimatePlannedSubagentStepTokenBudget(step),
      0,
    );
    return Math.max(
      this.maxCumulativeTokensPerRequestTree,
      derivedBudget * DEFAULT_REQUEST_TREE_SUBAGENT_PASSES,
    );
  }

  private estimatePlannedSubagentStepTokenBudget(
    step: PipelinePlannerSubagentStep,
  ): number {
    const timeoutMs = parseBudgetHintMsFn(step.maxBudgetHint, this.defaultSubagentTimeoutMs);
    return Math.max(
      DEFAULT_MIN_TOKENS_PER_PLANNED_SUBAGENT_STEP,
      Math.ceil(timeoutMs * DEFAULT_PLANNED_SUBAGENT_TOKENS_PER_MS),
    );
  }

  private formatRequestTreeBudgetBreach(
    breach: RequestTreeBudgetBreach,
  ): string {
    const { state } = breach;
    const usageSummary =
      `cumulativeToolCalls=${state.cumulativeToolCalls}/${state.maxCumulativeToolCallsPerRequestTree}; ` +
      `cumulativeTokens=${state.cumulativeTokens}/${state.maxCumulativeTokensPerRequestTree}; ` +
      `spawnedChildren=${state.spawnedChildren}; reservedSpawns=${state.reservedSpawns}`;
    if (breach.limitKind === "spawns") {
      return `${breach.reason}; attemptedSpawnCount=${breach.attemptedSpawnCount}; ${usageSummary}`;
    }
    return (
      `${breach.reason}; ` +
      `stepToolCalls=${breach.stepToolCalls}; ` +
      `stepTokens=${breach.stepTokens}; ` +
      usageSummary
    );
  }

  private buildRequestTreeBudgetBreachPayload(params: {
    readonly stepName: string;
    readonly attempt: number;
    readonly breach: RequestTreeBudgetBreach;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      stepName: params.stepName,
      stage: "circuit_breaker",
      reason: params.breach.reason,
      limitKind: params.breach.limitKind,
      attempt: params.attempt,
      ...params.breach.state,
    };
    if (params.breach.limitKind === "spawns") {
      payload.attemptedSpawnCount = params.breach.attemptedSpawnCount;
    } else {
      payload.stepToolCalls = params.breach.stepToolCalls;
      payload.stepTokens = params.breach.stepTokens;
    }
    return payload;
  }

  /* ---- Thin wrappers for test access to extracted standalone functions ---- */
  buildRetryTaskPrompt(
    currentTaskPrompt: string,
    step: PipelinePlannerSubagentStep,
    allowedTools: readonly string[],
    failure: SubagentFailureOutcome,
    retryAttempt: number,
  ): string {
    return buildRetryTaskPromptFn(currentTaskPrompt, step, allowedTools, failure, retryAttempt);
  }

  buildEffectiveDelegationSpec(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
    options: {
      readonly parentRequest?: string;
      readonly lastValidationCode?: DelegationOutputValidationCode;
      readonly delegatedWorkingDirectory?: string;
    } = {},
  ) {
    return buildEffectiveDelegationSpec(step, pipeline, {
      ...options,
      resolveHostToolingProfile: this.resolveHostToolingProfile,
    });
  }

  summarizeDependencyResultForPrompt(result: string | null): string {
    return summarizeDependencyResultForPrompt(result);
  }
}
