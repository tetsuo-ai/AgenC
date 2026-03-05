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
import type { LLMUsage } from "../llm/types.js";
import type {
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import { isDelegationToolName } from "./delegation-runtime.js";
import { sleep } from "../utils/async.js";
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
  readonly allowParallelSubtasks?: boolean;
  readonly maxParallelSubtasks?: number;
  readonly pollIntervalMs?: number;
  readonly defaultSubagentTimeoutMs?: number;
  readonly maxDepth?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxTotalSubagentsPerRequest?: number;
  readonly maxCumulativeToolCallsPerRequestTree?: number;
  readonly maxCumulativeTokensPerRequestTree?: number;
  readonly childToolAllowlistStrategy?: "inherit_intersection" | "explicit_only";
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior?: "continue_without_delegation" | "fail_request";
}

type SubagentFailureClass =
  | "timeout"
  | "tool_misuse"
  | "malformed_result_contract"
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
  readonly childSessionId?: string;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly tokenUsage?: LLMUsage;
};

interface ExecuteSubagentAttemptParams {
  readonly subAgentManager: SubAgentExecutionManager;
  readonly step: PipelinePlannerSubagentStep;
  readonly parentSessionId: string;
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

interface CuratedSection {
  readonly lines: readonly string[];
  readonly selected: number;
  readonly available: number;
  readonly omitted: number;
  readonly truncated: boolean;
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
  readonly promptTruncated: boolean;
  readonly toolScope: {
    readonly strategy: "inherit_intersection" | "explicit_only";
    readonly required: readonly string[];
    readonly parentPolicyAllowed: readonly string[];
    readonly parentPolicyForbidden: readonly string[];
    readonly resolved: readonly string[];
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
const CONTEXT_TERM_MIN_LENGTH = 3;
const CONTEXT_HISTORY_TAIL_PIN = 2;
const MAX_CONTEXT_HISTORY_ENTRIES = 6;
const MAX_CONTEXT_HISTORY_CHARS = 2_000;
const MAX_CONTEXT_MEMORY_ENTRIES = 4;
const MAX_CONTEXT_MEMORY_CHARS = 2_800;
const MAX_CONTEXT_TOOL_OUTPUT_ENTRIES = 8;
const MAX_CONTEXT_TOOL_OUTPUT_CHARS = 3_200;
const MAX_SUBAGENT_TASK_PROMPT_CHARS = 14_000;
const DEFAULT_FALLBACK_BEHAVIOR = "fail_request" as const;
const REDACTED_IMAGE_DATA_URL = "[REDACTED_IMAGE_DATA_URL]";
const REDACTED_PRIVATE_KEY_BLOCK = "[REDACTED_PRIVATE_KEY_BLOCK]";
const REDACTED_INTERNAL_URL = "[REDACTED_INTERNAL_URL]";
const REDACTED_FILE_URL = "[REDACTED_FILE_URL]";
const REDACTED_BEARER_TOKEN = "Bearer [REDACTED_TOKEN]";
const REDACTED_API_KEY = "[REDACTED_API_KEY]";
const REDACTED_ABSOLUTE_PATH = "[REDACTED_ABSOLUTE_PATH]";
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

const SUBAGENT_RETRY_POLICY: Readonly<
  Record<SubagentFailureClass, SubagentRetryRule>
> = {
  timeout: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  tool_misuse: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  malformed_result_contract: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
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
  transient_provider_error: "provider_error",
  cancelled: "cancelled",
  spawn_error: "tool_error",
  unknown: "tool_error",
};

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
  private readonly allowParallelSubtasks: boolean;
  private readonly maxParallelSubtasks: number;
  private readonly pollIntervalMs: number;
  private readonly defaultSubagentTimeoutMs: number;
  private readonly maxDepth: number;
  private readonly maxFanoutPerTurn: number;
  private readonly maxTotalSubagentsPerRequest: number;
  private readonly maxCumulativeToolCallsPerRequestTree: number;
  private readonly maxCumulativeTokensPerRequestTree: number;
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
    const completed = new Set<string>();
    const running = new Map<string, RunningNode>();
    const mutableResults: Record<string, string> = { ...pipeline.context.results };
    const totalSteps = plannerSteps.length;
    let completedSteps = 0;
    const budgetTracker = new RequestTreeBudgetTracker(
      this.maxTotalSubagentsPerRequest,
      this.maxCumulativeToolCallsPerRequestTree,
      this.maxCumulativeTokensPerRequestTree,
    );

    const maxParallel = this.resolveMaxParallelism(pipeline.maxParallelism);

    while (completedSteps < totalSteps) {
      let scheduledAny = false;
      const exclusiveRunning = Array.from(running.values()).some((r) => r.exclusive);

      for (const nodeName of executionOrder) {
        if (!pending.has(nodeName)) continue;
        if (running.size >= maxParallel) break;
        const node = stepByName.get(nodeName);
        if (!node) continue;
        if (!this.dependenciesSatisfied(node, completed)) continue;

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
        completed.add(node.step.name);
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

      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps,
        error: completion.outcome.error,
        stopReasonHint: completion.outcome.stopReasonHint,
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
    if (observedDepth > this.maxDepth) {
      return (
        `Planner subagent dependency depth ${observedDepth} exceeds maxDepth ` +
        `${this.maxDepth}`
      );
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
    if (toolScope.allowedTools.length === 0) {
      return {
        status: "failed",
        error:
          `No permitted child tools remain for step "${step.name}" after policy scoping`,
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
        timeoutMs,
        taskPrompt: subagentTask.taskPrompt,
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
      const shouldRetry = retriesUsed < retryRule.maxRetries;
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
            attempts: attempt,
            retryPolicy: retryAttempts,
            subagentSessionId: lastFailure.childSessionId ?? null,
          }),
        };
      }

      return {
        status: "failed",
        error:
          `Sub-agent step "${step.name}" failed: ${lastFailure.message}`,
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
    const normalized = hint.trim().toLowerCase();
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)?/);
    if (!match) return this.defaultSubagentTimeoutMs;
    const value = Number.parseFloat(match[1] ?? "0");
    if (!Number.isFinite(value) || value <= 0) return this.defaultSubagentTimeoutMs;
    const unit = match[2] ?? "m";
    if (unit === "ms") return Math.max(1_000, Math.floor(value));
    if (unit === "s" || unit === "sec") return Math.max(1_000, Math.floor(value * 1_000));
    if (unit === "h" || unit === "hr") {
      return Math.max(1_000, Math.floor(value * 60 * 60 * 1_000));
    }
    return Math.max(1_000, Math.floor(value * 60 * 1_000));
  }

  private createRetryAttemptTracker(): Record<SubagentFailureClass, number> {
    return {
      timeout: 0,
      tool_misuse: 0,
      malformed_result_contract: 0,
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

  private validateSubagentResultContract(
    step: PipelinePlannerSubagentStep,
    output: string,
  ): string | null {
    const trimmed = output.trim();
    if (trimmed.length === 0) {
      return "Malformed result contract: empty output";
    }

    const normalized = trimmed.toLowerCase();
    if (
      normalized === "null" ||
      normalized === "undefined" ||
      normalized === "{}" ||
      normalized === "[]"
    ) {
      return "Malformed result contract: empty structured payload";
    }

    if (step.inputContract.toLowerCase().includes("json")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return "Malformed result contract: expected JSON object output";
        }
      } catch {
        return "Malformed result contract: expected JSON object output";
      }
    }

    return null;
  }

  private async executeSubagentAttempt(
    input: ExecuteSubagentAttemptParams,
  ): Promise<ExecuteSubagentAttemptOutcome> {
    let childSessionId: string;
    try {
      childSessionId = await input.subAgentManager.spawn({
        parentSessionId: input.parentSessionId,
        task: input.taskPrompt,
        timeoutMs: input.timeoutMs,
        tools: input.tools,
        requiredCapabilities: input.step.requiredToolCapabilities,
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
        const contractError = this.validateSubagentResultContract(
          input.step,
          result.output,
        );
        if (contractError) {
          return {
            status: "failed",
            failure: {
              failureClass: "malformed_result_contract",
              message: contractError,
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
        typeof result.output === "string" && result.output.length > 0
          ? result.output
          : "unknown sub-agent failure";
      const failureClass = this.classifySubagentFailureMessage(message);
      return {
        status: "failed",
        failure: {
          failureClass,
          message,
          stopReasonHint: SUBAGENT_FAILURE_STOP_REASON[failureClass],
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
    const parentRequest = plannerContext?.parentRequest?.trim();
    const relevanceTerms = this.buildRelevanceTerms(step);
    const requirementTerms = this.extractTerms(step.contextRequirements.join(" "));
    const dependencies = step.dependsOn?.map((dependencyName) => ({
      dependencyName,
      result: results[dependencyName] ?? null,
    })) ?? [];

    const historySection = this.curateHistorySection(
      plannerContext?.history ?? [],
      relevanceTerms,
    );
    const memorySection = this.curateMemorySection(
      plannerContext?.memory ?? [],
      requirementTerms,
    );
    const toolOutputSection = this.curateToolOutputSection(
      step,
      plannerContext?.toolOutputs ?? [],
      dependencies,
      relevanceTerms,
      requirementTerms,
    );

    const buildPrompt = (diagnostics: SubagentContextDiagnostics): string => {
      const sections: string[] = [];
      sections.push(`Objective: ${this.redactSensitiveData(step.objective)}`);
      sections.push(
        `Input contract: ${this.redactSensitiveData(step.inputContract)}`,
      );
      if (parentRequest && parentRequest.length > 0) {
        sections.push(`Parent request: ${this.redactSensitiveData(parentRequest)}`);
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
      if (step.requiredToolCapabilities.length > 0) {
        sections.push(
          `Required tool capabilities (policy-scoped):\n${
            toolScope.allowedTools.map((item) => `- ${item}`).join("\n")
          }`,
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
      promptTruncated: false,
      toolScope: {
        strategy: this.childToolAllowlistStrategy,
        required: [...step.requiredToolCapabilities],
        parentPolicyAllowed: [...toolScope.parentPolicyAllowed],
        parentPolicyForbidden: [...this.forbiddenParentTools],
        resolved: [...toolScope.allowedTools],
        removedByPolicy: [...toolScope.removedByPolicy],
        removedAsDelegationTools: [...toolScope.removedAsDelegationTools],
        removedAsUnknownTools: [...toolScope.removedAsUnknownTools],
      },
    };

    let taskPrompt = buildPrompt(diagnostics);
    if (taskPrompt.length > MAX_SUBAGENT_TASK_PROMPT_CHARS) {
      diagnostics = {
        ...diagnostics,
        promptTruncated: true,
      };
      taskPrompt = this.truncateText(
        buildPrompt(diagnostics),
        MAX_SUBAGENT_TASK_PROMPT_CHARS,
      );
    }

    return { taskPrompt, diagnostics };
  }

  private deriveChildToolAllowlist(
    step: PipelinePlannerSubagentStep,
    pipeline: Pipeline,
  ): {
    allowedTools: readonly string[];
    removedByPolicy: readonly string[];
    removedAsDelegationTools: readonly string[];
    removedAsUnknownTools: readonly string[];
    parentPolicyAllowed: readonly string[];
  } {
    const required = [...new Set(
      step.requiredToolCapabilities
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    )];

    const parentPolicyAllowed = this.resolveParentPolicyAllowlist(pipeline);
    const parentAllowedSet = new Set(parentPolicyAllowed);
    const availableTools = this.resolveAvailableToolNames();
    const availableSet = new Set(
      (availableTools ?? [])
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );

    const removedByPolicy: string[] = [];
    const removedAsDelegationTools: string[] = [];
    const removedAsUnknownTools: string[] = [];
    const allowedTools: string[] = [];

    for (const toolName of required) {
      if (
        this.childToolAllowlistStrategy === "inherit_intersection" &&
        parentAllowedSet.size > 0 &&
        !parentAllowedSet.has(toolName)
      ) {
        removedByPolicy.push(toolName);
        continue;
      }
      if (this.forbiddenParentTools.has(toolName)) {
        removedByPolicy.push(toolName);
        continue;
      }
      if (isDelegationToolName(toolName)) {
        removedAsDelegationTools.push(toolName);
        continue;
      }
      if (availableSet.size > 0 && !availableSet.has(toolName)) {
        removedAsUnknownTools.push(toolName);
        continue;
      }
      allowedTools.push(toolName);
    }

    return {
      allowedTools,
      removedByPolicy,
      removedAsDelegationTools,
      removedAsUnknownTools,
      parentPolicyAllowed,
    };
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

  private curateHistorySection(
    history: readonly PipelinePlannerContextHistoryEntry[],
    relevanceTerms: ReadonlySet<string>,
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
        .slice(0, MAX_CONTEXT_HISTORY_ENTRIES * 2)
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
    const section = this.applySectionCaps(
      orderedLines,
      MAX_CONTEXT_HISTORY_ENTRIES,
      MAX_CONTEXT_HISTORY_CHARS,
    );
    return {
      ...section,
      available: history.length,
      omitted: Math.max(0, history.length - section.selected),
    };
  }

  private curateMemorySection(
    memory: readonly PipelinePlannerContextMemoryEntry[],
    requirementTerms: readonly string[],
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
    const section = this.applySectionCaps(
      lines,
      MAX_CONTEXT_MEMORY_ENTRIES,
      MAX_CONTEXT_MEMORY_CHARS,
    );
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
  ): CuratedSection {
    const requiredCapabilities = new Set(
      step.requiredToolCapabilities.map((tool) => tool.toLowerCase()),
    );
    const requirementTermSet = new Set(
      requirementTerms.map((term) => term.toLowerCase()),
    );
    const dependencyLines = dependencies.map(
      ({ dependencyName, result }) =>
        `[dependency:${dependencyName}] ${this.redactSensitiveData(result ?? "null")}`,
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
    const section = this.applySectionCaps(
      combined,
      MAX_CONTEXT_TOOL_OUTPUT_ENTRIES,
      MAX_CONTEXT_TOOL_OUTPUT_CHARS,
    );
    return {
      ...section,
      available: dependencies.length + toolOutputs.length,
      omitted: Math.max(
        0,
        dependencies.length + toolOutputs.length - section.selected,
      ),
    };
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
    maxEntries: number,
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
      if (selected.length >= maxEntries) break;
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

  private resolveParentSessionId(pipelineId: string): string {
    if (!pipelineId.startsWith("planner:")) return pipelineId;
    const segments = pipelineId.split(":");
    return segments[1] ?? pipelineId;
  }
}
