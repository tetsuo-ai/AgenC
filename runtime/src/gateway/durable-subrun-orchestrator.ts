/**
 * Durable multi-agent orchestration on top of BackgroundRunSupervisor.
 *
 * Phase 10 requires runtime-owned, typed subruns rather than prompt-only
 * delegation. This orchestrator spawns child background runs with explicit
 * scope, budget, and artifact contracts, then joins their outcomes through
 * deterministic strategies.
 *
 * @module
 */

import type { BackgroundRunSupervisor } from "./background-run-supervisor.js";
import type {
  BackgroundRunContract,
  BackgroundRunEvent,
  PersistedBackgroundRun,
} from "./background-run-store.js";
import {
  artifactContractSatisfied,
  assertValidBackgroundRunLineage,
  assertValidDurableSubrunSpec,
  buildSubrunSessionId,
  summarizeNestedBudget,
  type BackgroundRunLineage,
  type DurableSubrunPlan,
  type DurableSubrunSpec,
  type SubrunArtifactContract,
  type SubrunBudget,
  type SubrunJoinOutcome,
  type SubrunRedundancyPattern,
  type SubrunScope,
} from "./subrun-contract.js";
import type { BackgroundRunQualityArtifact } from "../eval/background-run-quality.js";
import { evaluateBackgroundRunQualityGates } from "../eval/background-run-gates.js";
import type { DelegationBenchmarkSummary } from "../eval/delegation-benchmark.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

export interface DurableSubrunTreeNode {
  readonly runId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: PersistedBackgroundRun["state"];
  readonly role: BackgroundRunLineage["role"];
  readonly childRunIds: readonly string[];
  readonly children: readonly DurableSubrunTreeNode[];
}

interface DurableSubrunOrchestratorConfig {
  readonly supervisor: BackgroundRunSupervisor;
  readonly enabled?: boolean;
  readonly logger?: Logger;
  readonly qualityArtifactProvider?: () =>
    | BackgroundRunQualityArtifact
    | undefined
    | Promise<BackgroundRunQualityArtifact | undefined>;
  readonly delegationBenchmarkProvider?: () =>
    | DelegationBenchmarkSummary
    | undefined
    | Promise<DelegationBenchmarkSummary | undefined>;
  readonly admissionEvaluator?: (params: {
    readonly parentRun: PersistedBackgroundRun;
    readonly plan: DurableSubrunPlan;
  }) =>
    | DurableSubrunAdmissionDecision
    | Promise<DurableSubrunAdmissionDecision>;
}

export interface DurableSubrunPlanStartResult {
  readonly parentRunId: string;
  readonly childSessionIds: readonly string[];
  readonly childRunIds: readonly string[];
}

export interface DurableSubrunAdmissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function mergeChildScope(children: readonly DurableSubrunSpec[]): SubrunScope {
  return {
    allowedTools: uniqueStrings(children.flatMap((child) => child.scope.allowedTools)),
    allowedWriteRoots: uniqueStrings(
      children.flatMap((child) => child.scope.allowedWriteRoots ?? []),
    ),
    allowedHosts: uniqueStrings(
      children.flatMap((child) => child.scope.allowedHosts ?? []),
    ),
  };
}

function mergeChildArtifactContract(
  children: readonly DurableSubrunSpec[],
): SubrunArtifactContract {
  return {
    requiredKinds: [
      ...new Set(children.flatMap((child) => child.artifactContract.requiredKinds)),
    ],
    minArtifactCount: children.reduce(
      (max, child) =>
        Math.max(max, child.artifactContract.minArtifactCount ?? 0),
      0,
    ) || undefined,
    summaryRequired: children.some(
      (child) => child.artifactContract.summaryRequired === true,
    ),
  };
}

function deriveRootBudget(
  parentRun: PersistedBackgroundRun,
  existingLineage: BackgroundRunLineage | undefined,
  children: readonly DurableSubrunSpec[],
): SubrunBudget {
  if (existingLineage) {
    return existingLineage.budget;
  }
  return {
    maxRuntimeMs: parentRun.budgetState.maxRuntimeMs,
    maxChildren: Math.max(children.length, 1),
  };
}

function isTerminalRunState(state: PersistedBackgroundRun["state"]): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled"
  );
}

function buildRootLineage(
  parentRun: PersistedBackgroundRun,
  plan: DurableSubrunPlan,
): BackgroundRunLineage {
  const existing = parentRun.lineage;
  if (existing) {
    return {
      ...existing,
      joinStrategy: plan.joinStrategy,
      redundancyPattern: plan.redundancyPattern,
    };
  }
  return {
    rootRunId: parentRun.id,
    role: "planner",
    depth: 0,
    joinStrategy: plan.joinStrategy,
    redundancyPattern: plan.redundancyPattern,
    scope: mergeChildScope(plan.children),
    artifactContract: mergeChildArtifactContract(plan.children),
    budget: deriveRootBudget(parentRun, undefined, plan.children),
    childRunIds: [],
  };
}

function buildChildContract(
  parentContract: BackgroundRunContract,
  spec: DurableSubrunSpec,
): BackgroundRunContract {
  const nextCheckMs = Math.max(
    2_000,
    Math.min(parentContract.nextCheckMs, spec.budget.maxRuntimeMs),
  );
  const heartbeatMs =
    parentContract.heartbeatMs !== undefined
      ? Math.max(2_000, Math.min(parentContract.heartbeatMs, spec.budget.maxRuntimeMs))
      : undefined;
  return {
    domain: parentContract.domain,
    kind: "finite",
    successCriteria: [
      `Complete the ${spec.role} subrun with deterministic evidence.`,
    ],
    completionCriteria: [
      "Only complete once the artifact contract is satisfied or the verifier confirmed success.",
    ],
    blockedCriteria: [
      "Block if the scoped tools, write scope, or network scope are insufficient.",
    ],
    nextCheckMs,
    heartbeatMs,
    requiresUserStop: false,
    managedProcessPolicy: { mode: "none" },
  };
}

function buildChildOutcomeKey(run: PersistedBackgroundRun): string {
  return (
    run.carryForward?.summary ??
    run.lastUserUpdate ??
    run.lastToolEvidence ??
    run.objective
  ).trim();
}

async function resolveOptional<T>(
  resolver:
    | (() => T | undefined | Promise<T | undefined>)
    | undefined,
): Promise<T | undefined> {
  if (!resolver) return undefined;
  return resolver();
}

export function redundancyPatternProvenUseful(
  pattern: SubrunRedundancyPattern,
  benchmark: DelegationBenchmarkSummary,
): boolean {
  if (pattern === "none") return true;
  if (benchmark.harmfulDelegationRate > benchmark.usefulDelegationRate) {
    return false;
  }
  switch (pattern) {
    case "critic":
    case "verifier":
      return benchmark.qualityDeltaVsBaseline > 0;
    case "majority_vote":
    case "independent_research":
      return (
        benchmark.passAtKDeltaVsBaseline > 0 ||
        benchmark.passCaretKDeltaVsBaseline > 0
      );
  }
}

export class DurableSubrunOrchestrator {
  private readonly supervisor: BackgroundRunSupervisor;
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly qualityArtifactProvider?;
  private readonly delegationBenchmarkProvider?;
  private readonly admissionEvaluator?;

  constructor(config: DurableSubrunOrchestratorConfig) {
    this.supervisor = config.supervisor;
    this.enabled = config.enabled !== false;
    this.logger = config.logger ?? silentLogger;
    this.qualityArtifactProvider = config.qualityArtifactProvider;
    this.delegationBenchmarkProvider = config.delegationBenchmarkProvider;
    this.admissionEvaluator = config.admissionEvaluator;
  }

  private async assertHealthySingleAgentRuntime(): Promise<void> {
    const artifact = await resolveOptional(this.qualityArtifactProvider);
    if (!artifact) {
      throw new Error(
        "Durable multi-agent orchestration is disabled until single-agent quality artifacts are available.",
      );
    }
    const evaluation = evaluateBackgroundRunQualityGates(artifact);
    if (!evaluation.passed) {
      throw new Error(
        `Durable multi-agent orchestration is blocked because single-agent quality gates failed (${evaluation.violations[0]?.metric ?? "unknown"}).`,
      );
    }
  }

  private async assertRedundancyPatternAllowed(
    pattern: SubrunRedundancyPattern,
  ): Promise<void> {
    if (pattern === "none") return;
    const benchmark = await resolveOptional(this.delegationBenchmarkProvider);
    if (!benchmark) {
      throw new Error(
        `Redundancy pattern "${pattern}" requires delegation benchmark evidence before rollout.`,
      );
    }
    if (!redundancyPatternProvenUseful(pattern, benchmark)) {
      throw new Error(
        `Redundancy pattern "${pattern}" is blocked because benchmark evidence does not show a quality benefit.`,
      );
    }
  }

  private async assertPlanAllowed(plan: DurableSubrunPlan): Promise<void> {
    if (!this.enabled) {
      throw new Error("Durable multi-agent orchestration is disabled.");
    }
    if (plan.children.length === 0) {
      throw new Error("Durable subrun plans must contain at least one child.");
    }
    await this.assertHealthySingleAgentRuntime();
    await this.assertRedundancyPatternAllowed(plan.redundancyPattern);
  }

  private async assertPlanAdmission(
    parentRun: PersistedBackgroundRun,
    plan: DurableSubrunPlan,
  ): Promise<void> {
    if (!this.admissionEvaluator) {
      return;
    }
    const decision = await this.admissionEvaluator({
      parentRun,
      plan,
    });
    if (!decision.allowed) {
      throw new Error(decision.reason);
    }
  }

  private assertNestedBudgetFits(
    parentRun: PersistedBackgroundRun,
    parentLineage: BackgroundRunLineage,
    children: readonly DurableSubrunSpec[],
  ): void {
    const childLineages: BackgroundRunLineage[] = children.map((child) => ({
      rootRunId: parentLineage.rootRunId,
      parentRunId: parentRun.id,
      role: child.role,
      depth: parentLineage.depth + 1,
      joinStrategy: parentLineage.joinStrategy,
      redundancyPattern: parentLineage.redundancyPattern,
      scope: child.scope,
      artifactContract: child.artifactContract,
      budget: child.budget,
      childRunIds: [],
    }));
    const nestedBudget = summarizeNestedBudget(childLineages);
    if (nestedBudget.maxRuntimeMs > parentLineage.budget.maxRuntimeMs) {
      throw new Error(
        `Subrun runtime budget ${nestedBudget.maxRuntimeMs}ms exceeds parent limit ${parentLineage.budget.maxRuntimeMs}ms.`,
      );
    }
    if (
      parentLineage.budget.maxTokens !== undefined &&
      nestedBudget.maxTokens > parentLineage.budget.maxTokens
    ) {
      throw new Error(
        `Subrun token budget ${nestedBudget.maxTokens} exceeds parent limit ${parentLineage.budget.maxTokens}.`,
      );
    }
    if (
      parentLineage.budget.maxToolCalls !== undefined &&
      nestedBudget.maxToolCalls > parentLineage.budget.maxToolCalls
    ) {
      throw new Error(
        `Subrun tool-call budget ${nestedBudget.maxToolCalls} exceeds parent limit ${parentLineage.budget.maxToolCalls}.`,
      );
    }
    if (
      parentLineage.budget.maxChildren !== undefined &&
      parentLineage.childRunIds.length + children.length >
        parentLineage.budget.maxChildren
    ) {
      throw new Error(
        `Subrun count ${parentLineage.childRunIds.length + children.length} exceeds parent child budget ${parentLineage.budget.maxChildren}.`,
      );
    }
    if (children.length > parentRun.budgetState.maxCycles) {
      throw new Error(
        `Subrun fan-out ${children.length} exceeds parent cycle budget ${parentRun.budgetState.maxCycles}.`,
      );
    }
  }

  async startPlan(
    parentSessionId: string,
    plan: DurableSubrunPlan,
  ): Promise<DurableSubrunPlanStartResult> {
    await this.assertPlanAllowed(plan);
    for (const child of plan.children) {
      assertValidDurableSubrunSpec(child);
    }

    const parentRun = await this.supervisor.loadRunRecord(parentSessionId);
    if (!parentRun) {
      throw new Error(`Parent background run "${parentSessionId}" not found.`);
    }
    if (plan.rootRunId !== parentRun.id) {
      throw new Error(
        `Durable subrun plan rootRunId "${plan.rootRunId}" does not match parent run "${parentRun.id}".`,
      );
    }
    if (isTerminalRunState(parentRun.state)) {
      throw new Error(`Parent background run "${parentSessionId}" is terminal.`);
    }
    await this.assertPlanAdmission(parentRun, plan);

    const rootLineage = buildRootLineage(parentRun, plan);
    assertValidBackgroundRunLineage(rootLineage);
    this.assertNestedBudgetFits(parentRun, rootLineage, plan.children);

    const childSessionIds: string[] = [];
    const childRunIds: string[] = [];
    const nextChildRunIds = [...rootLineage.childRunIds];
    await this.supervisor.updateRunLineage(parentSessionId, rootLineage);

    for (const [index, child] of plan.children.entries()) {
      const childSessionId =
        child.sessionId ??
        buildSubrunSessionId({
          parentSessionId,
          role: child.role,
          index,
        });
      const lineage: BackgroundRunLineage = {
        rootRunId: rootLineage.rootRunId,
        parentRunId: parentRun.id,
        role: child.role,
        depth: rootLineage.depth + 1,
        joinStrategy: plan.joinStrategy,
        redundancyPattern: plan.redundancyPattern,
        scope: child.scope,
        artifactContract: child.artifactContract,
        budget: child.budget,
        childRunIds: [],
      };
      assertValidBackgroundRunLineage(lineage);
      const childStatus = await this.supervisor.startRun({
        sessionId: childSessionId,
        objective: child.objective,
        options: {
          silent: true,
          lineage,
          contract: buildChildContract(parentRun.contract, child),
        },
      });
      childSessionIds.push(childSessionId);
      childRunIds.push(childStatus.id);
      nextChildRunIds.push(childStatus.id);

      const updatedRootLineage: BackgroundRunLineage = {
        ...rootLineage,
        childRunIds: [...new Set(nextChildRunIds)],
      };
      await this.supervisor.updateRunLineage(parentSessionId, updatedRootLineage);
      await this.supervisor.appendRunEvent(parentSessionId, {
        type: "subrun_spawned",
        summary: truncate(
          `Spawned ${child.role} subrun ${childStatus.id} for "${truncate(child.objective, 80)}".`,
        ),
        timestamp: Date.now(),
        data: {
          childRunId: childStatus.id,
          childSessionId,
          role: child.role,
          joinStrategy: plan.joinStrategy,
          redundancyPattern: plan.redundancyPattern,
        },
      });
    }

    this.logger.info("Durable subrun plan started", {
      parentSessionId,
      parentRunId: parentRun.id,
      childRunIds,
      joinStrategy: plan.joinStrategy,
      redundancyPattern: plan.redundancyPattern,
    });

    return {
      parentRunId: parentRun.id,
      childSessionIds,
      childRunIds,
    };
  }

  private async loadPlannedChildren(
    parentSessionId: string,
    plan: DurableSubrunPlan,
  ): Promise<PersistedBackgroundRun[]> {
    const children = await Promise.all(
      plan.children.map((child, index) =>
        this.supervisor.loadRunRecord(
          child.sessionId ??
            buildSubrunSessionId({
              parentSessionId,
              role: child.role,
              index,
            }),
        ),
      ),
    );
    return children.filter(
      (child): child is PersistedBackgroundRun => child !== undefined,
    );
  }

  async evaluatePlanJoin(
    parentSessionId: string,
    plan: DurableSubrunPlan,
  ): Promise<SubrunJoinOutcome> {
    const childRuns = await this.loadPlannedChildren(parentSessionId, plan);
    const childSpecBySessionId = new Map(
      plan.children.map((child, index) => [
        child.sessionId ??
          buildSubrunSessionId({
            parentSessionId,
            role: child.role,
            index,
          }),
        child,
      ] as const),
    );
    const failedChildRunIds = childRuns
      .filter((run) => run.state === "failed" || run.state === "cancelled")
      .map((run) => run.id);
    const blockedChildRunIds = childRuns
      .filter((run) =>
        run.state === "blocked" ||
        run.state === "paused" ||
        run.state === "pending" ||
        run.state === "running" ||
        run.state === "working" ||
        run.state === "suspended",
      )
      .map((run) => run.id);
    const completedChildren = childRuns.filter((run) =>
      run.state === "completed" &&
      artifactContractSatisfied({
        artifacts: run.carryForward?.artifacts ?? [],
        artifactContract: childSpecBySessionId.get(run.sessionId)?.artifactContract ?? {
          requiredKinds: [],
        },
        carryForwardSummary: run.carryForward?.summary,
      }),
    );
    const completedChildRunIds = completedChildren.map((run) => run.id);

    const terminalWithoutSuccess =
      childRuns.length === plan.children.length &&
      blockedChildRunIds.length === 0 &&
      completedChildRunIds.length === 0;

    let outcome: SubrunJoinOutcome;
    switch (plan.joinStrategy) {
      case "all_success":
        if (failedChildRunIds.length > 0) {
          outcome = {
            status: "failed",
            summary: "At least one required subrun failed.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else if (completedChildRunIds.length === plan.children.length) {
          outcome = {
            status: "completed",
            summary: `All ${completedChildRunIds.length} subruns completed successfully.`,
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else {
          outcome = {
            status: "blocked",
            summary: "Waiting for all required subruns to complete.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        }
        break;
      case "first_success":
        if (completedChildRunIds.length > 0) {
          outcome = {
            status: "completed",
            summary:
              completedChildren[0] !== undefined
                ? truncate(
                    `First successful subrun: ${buildChildOutcomeKey(completedChildren[0])}`,
                    200,
                  )
                : "First successful subrun completed.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else if (terminalWithoutSuccess) {
          outcome = {
            status: "failed",
            summary: "No subrun satisfied the first-success join strategy.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else {
          outcome = {
            status: "blocked",
            summary: "Waiting for the first successful subrun.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        }
        break;
      case "majority_vote": {
        const votes = new Map<string, string[]>();
        for (const run of completedChildren) {
          const key = buildChildOutcomeKey(run);
          votes.set(key, [...(votes.get(key) ?? []), run.id]);
        }
        const winner = [...votes.entries()].sort(
          (left, right) => right[1].length - left[1].length,
        )[0];
        if (winner && winner[1].length > Math.floor(plan.children.length / 2)) {
          outcome = {
            status: "completed",
            summary: truncate(`Majority vote accepted: ${winner[0]}`, 200),
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else if (terminalWithoutSuccess) {
          outcome = {
            status: "failed",
            summary: "Majority vote did not converge on a successful result.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else {
          outcome = {
            status: "blocked",
            summary: "Waiting for enough completed subruns to establish a majority vote.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        }
        break;
      }
      case "reduce": {
        if (completedChildRunIds.length > 0 && blockedChildRunIds.length === 0) {
          const summaries = completedChildren
            .map((child) => buildChildOutcomeKey(child))
            .filter((value) => value.length > 0);
          outcome = {
            status: "completed",
            summary: truncate(
              summaries.length > 0
                ? `Reduced subrun outputs: ${summaries.join(" | ")}`
                : "Reduced subrun outputs completed.",
              200,
            ),
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else if (terminalWithoutSuccess) {
          outcome = {
            status: "failed",
            summary: "Reduce join had no successful child outputs to combine.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        } else {
          outcome = {
            status: "blocked",
            summary: "Waiting for child outputs to reduce.",
            completedChildRunIds,
            failedChildRunIds,
            blockedChildRunIds,
          };
        }
        break;
      }
    }

    const parentRun = await this.supervisor.loadRunRecord(parentSessionId);
    if (parentRun) {
      const event: BackgroundRunEvent =
        outcome.status === "failed"
          ? {
              type: "subrun_failed_attribution",
              summary: truncate(outcome.summary),
              timestamp: Date.now(),
              data: {
                failedChildRunIds,
                blockedChildRunIds,
              },
            }
          : {
              type: "subrun_joined",
              summary: truncate(outcome.summary),
              timestamp: Date.now(),
              data: {
                completedChildRunIds,
                blockedChildRunIds,
                failedChildRunIds,
              },
            };
      await this.supervisor.appendRunEvent(parentSessionId, event);
    }

    return outcome;
  }

  async buildRunTree(
    rootRunId: string,
  ): Promise<DurableSubrunTreeNode | undefined> {
    const runs = await this.supervisor.listRunRecords();
    const relevantRuns = runs.filter(
      (run) => run.id === rootRunId || run.lineage?.rootRunId === rootRunId,
    );
    if (relevantRuns.length === 0) {
      return undefined;
    }

    const byRunId = new Map(
      relevantRuns.map((run) => [run.id, run] as const),
    );
    const childMap = new Map<string, PersistedBackgroundRun[]>();
    for (const run of relevantRuns) {
      const parentRunId = run.lineage?.parentRunId;
      if (!parentRunId) continue;
      childMap.set(parentRunId, [...(childMap.get(parentRunId) ?? []), run]);
    }

    const rootRun =
      byRunId.get(rootRunId) ??
      relevantRuns.find((run) => run.lineage?.rootRunId === rootRunId && !run.lineage?.parentRunId);
    if (!rootRun) {
      return undefined;
    }

    const buildNode = (run: PersistedBackgroundRun): DurableSubrunTreeNode => ({
      runId: run.id,
      sessionId: run.sessionId,
      objective: run.objective,
      state: run.state,
      role: run.lineage?.role ?? (run.id === rootRunId ? "planner" : "worker"),
      childRunIds: run.lineage?.childRunIds ?? [],
      children: (childMap.get(run.id) ?? []).map((child) => buildNode(child)),
    });

    return buildNode(rootRun);
  }
}
