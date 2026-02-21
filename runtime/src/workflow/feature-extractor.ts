/**
 * Deterministic workflow feature extraction for optimizer inputs.
 *
 * @module
 */

import type { TelemetrySnapshot } from "../telemetry/types.js";
import type { TelemetryCollector } from "../telemetry/types.js";
import { clamp01 } from "../utils/numeric.js";
import type { WorkflowState } from "./types.js";
import { WorkflowNodeStatus, WorkflowStatus } from "./types.js";
import {
  WORKFLOW_FEATURE_SCHEMA_VERSION,
  type WorkflowFeatureVector,
  type WorkflowNodeFeature,
  type WorkflowOutcomeLabels,
} from "./optimizer-types.js";

export const WORKFLOW_TELEMETRY_KEYS = {
  COST_UNITS: "agenc.workflow.cost.units",
  ROLLBACKS_TOTAL: "agenc.workflow.rollbacks.total",
  VERIFIER_DISAGREEMENTS_TOTAL: "agenc.workflow.verifier_disagreements.total",
  // Fallback: existing speculation rollbacks metric.
  SPECULATION_ROLLBACKS_TOTAL: "agenc.speculation.rollbacks.total",
} as const;

export interface WorkflowFeatureExtractionOptions {
  capturedAtMs?: number;
  telemetrySnapshot?: TelemetrySnapshot;
  metadata?: Record<string, string>;
  taskRoleByTaskName?: Record<string, string>;
  costUnits?: number;
  rollbackCount?: number;
  verifierDisagreementCount?: number;
  conformanceScore?: number;
}

function safeNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

function safeBigIntToNumber(value: bigint): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maxSafe) return Number.MAX_SAFE_INTEGER;
  if (value < 0n) return 0;
  return Number(value);
}

function parseCompositeMetricKey(key: string): {
  name: string;
  labels: Record<string, string>;
} {
  const [name, ...labelParts] = key.split("|");
  const labels: Record<string, string> = {};

  for (const labelPart of labelParts) {
    const idx = labelPart.indexOf("=");
    if (idx <= 0 || idx >= labelPart.length - 1) continue;
    const label = labelPart.slice(0, idx);
    const value = labelPart.slice(idx + 1);
    labels[label] = value;
  }

  return { name, labels };
}

function sumMatchingMetrics(
  values: Record<string, number>,
  metricName: string,
  workflowId: string,
): number {
  let total = 0;
  const keys = Object.keys(values).sort();

  for (const key of keys) {
    const parsed = parseCompositeMetricKey(key);
    if (parsed.name !== metricName) continue;

    const labelWorkflowId = parsed.labels.workflow_id;
    if (labelWorkflowId && labelWorkflowId !== workflowId) continue;

    total += safeNonNegative(values[key]);
  }

  return total;
}

function integerRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return safeNonNegative(numerator) / denominator;
}

function computeDepthByNode(state: WorkflowState): Map<string, number> {
  const parentByChild = new Map<string, string>();
  for (const edge of state.definition.edges) {
    if (!parentByChild.has(edge.to)) {
      parentByChild.set(edge.to, edge.from);
    }
  }

  const memo = new Map<string, number>();

  const computeDepth = (taskName: string): number => {
    const cached = memo.get(taskName);
    if (cached !== undefined) return cached;

    const seen = new Set<string>();
    let depth = 0;
    let current: string | undefined = taskName;

    while (current) {
      const parent = parentByChild.get(current);
      if (!parent) break;
      if (seen.has(parent)) {
        break;
      }
      seen.add(parent);
      depth++;
      current = parent;
    }

    memo.set(taskName, depth);
    return depth;
  };

  const result = new Map<string, number>();
  for (const task of state.definition.tasks) {
    result.set(task.name, computeDepth(task.name));
  }

  return result;
}

function orderedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) {
    out[key] = map.get(key) ?? 0;
  }
  return out;
}

function hasConstraintHash(
  task: WorkflowState["definition"]["tasks"][number],
): boolean {
  return !!task.constraintHash;
}

function buildNodeFeatures(state: WorkflowState): WorkflowNodeFeature[] {
  const nodes = Array.from(state.nodes.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return nodes.map((node) => ({
    name: node.name,
    taskType: node.template.taskType,
    dependencyType: node.dependencyType,
    rewardLamports: node.template.rewardAmount.toString(),
    maxWorkers: node.template.maxWorkers,
    minReputation: node.template.minReputation ?? 0,
    hasConstraintHash: hasConstraintHash(node.template),
    status: node.status,
  }));
}

function deriveOutcome(
  state: WorkflowState,
): "completed" | "failed" | "partially_completed" {
  if (state.status === WorkflowStatus.Completed) return "completed";
  if (state.status === WorkflowStatus.Failed) return "failed";
  if (state.status === WorkflowStatus.PartiallyCompleted)
    return "partially_completed";

  const nodes = Array.from(state.nodes.values());
  const completed = nodes.filter(
    (node) => node.status === WorkflowNodeStatus.Completed,
  ).length;
  const failed = nodes.filter(
    (node) =>
      node.status === WorkflowNodeStatus.Failed ||
      node.status === WorkflowNodeStatus.Cancelled,
  ).length;

  if (completed === nodes.length && nodes.length > 0) return "completed";
  if (failed > 0) return "failed";
  return "partially_completed";
}

function deriveElapsedMs(state: WorkflowState, capturedAtMs: number): number {
  if (state.startedAt === null) return 0;
  const end = state.completedAt ?? capturedAtMs;
  return Math.max(0, end - state.startedAt);
}

function deriveConformanceScore(
  completionRate: number,
  failureRate: number,
  cancelledRate: number,
  rollbackRate: number,
  verifierDisagreementRate: number,
): number {
  const base = clamp01(completionRate);
  const penalties =
    failureRate * 0.45 +
    cancelledRate * 0.2 +
    rollbackRate * 0.2 +
    verifierDisagreementRate * 0.15;

  return clamp01(base - penalties);
}

function buildMetadata(
  base: Record<string, string> | undefined,
  nodeFeatures: WorkflowNodeFeature[],
  taskRoleByTaskName: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out = new Map<string, string>();

  if (base) {
    for (const key of Object.keys(base).sort()) {
      out.set(key, base[key]);
    }
  }

  if (taskRoleByTaskName) {
    const roleCounts = new Map<string, number>();
    for (const node of nodeFeatures) {
      const role = taskRoleByTaskName[node.name];
      if (!role) continue;
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }

    if (roleCounts.size > 0) {
      out.set("workflow_source", "team_adapter");
      for (const role of [...roleCounts.keys()].sort()) {
        out.set(`role_count.${role}`, String(roleCounts.get(role) ?? 0));
      }
    }
  } else {
    out.set("workflow_source", "single_agent");
  }

  if (out.size === 0) return undefined;

  const object: Record<string, string> = {};
  for (const key of [...out.keys()].sort()) {
    object[key] = out.get(key) ?? "";
  }
  return object;
}

function deriveTelemetryCounts(
  workflowId: string,
  snapshot: TelemetrySnapshot | undefined,
): {
  costUnits: number;
  rollbackCount: number;
  verifierDisagreementCount: number;
} {
  if (!snapshot) {
    return {
      costUnits: 0,
      rollbackCount: 0,
      verifierDisagreementCount: 0,
    };
  }

  const costFromGauges = sumMatchingMetrics(
    snapshot.gauges,
    WORKFLOW_TELEMETRY_KEYS.COST_UNITS,
    workflowId,
  );

  const rollbackCount =
    sumMatchingMetrics(
      snapshot.counters,
      WORKFLOW_TELEMETRY_KEYS.ROLLBACKS_TOTAL,
      workflowId,
    ) ||
    sumMatchingMetrics(
      snapshot.counters,
      WORKFLOW_TELEMETRY_KEYS.SPECULATION_ROLLBACKS_TOTAL,
      workflowId,
    );

  const verifierDisagreementCount = sumMatchingMetrics(
    snapshot.counters,
    WORKFLOW_TELEMETRY_KEYS.VERIFIER_DISAGREEMENTS_TOTAL,
    workflowId,
  );

  return {
    costUnits: safeNonNegative(costFromGauges),
    rollbackCount: safeNonNegative(rollbackCount),
    verifierDisagreementCount: safeNonNegative(verifierDisagreementCount),
  };
}

/**
 * Deterministically extracts optimizer features from workflow runtime state.
 */
export function extractWorkflowFeatureVector(
  state: WorkflowState,
  options: WorkflowFeatureExtractionOptions = {},
): WorkflowFeatureVector {
  const capturedAtMs = options.capturedAtMs ?? Date.now();
  const totalNodes = state.nodes.size;

  const nodeFeatures = buildNodeFeatures(state);

  const childSet = new Set(state.definition.edges.map((edge) => edge.to));
  const rootCount = state.definition.tasks.filter(
    (task) => !childSet.has(task.name),
  ).length;

  const depthByNode = computeDepthByNode(state);
  const maxDepth = Math.max(0, ...depthByNode.values());

  const childrenByParent = new Map<string, number>();
  for (const edge of state.definition.edges) {
    childrenByParent.set(edge.from, (childrenByParent.get(edge.from) ?? 0) + 1);
  }

  let averageBranchingFactor = 0;
  if (childrenByParent.size > 0) {
    const childrenTotal = [...childrenByParent.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    averageBranchingFactor = childrenTotal / childrenByParent.size;
  }

  const taskTypeHistogram = new Map<string, number>();
  const dependencyTypeHistogram = new Map<string, number>();
  let privateTaskCount = 0;
  let totalReward = 0n;

  for (const node of nodeFeatures) {
    const taskTypeKey = String(node.taskType);
    taskTypeHistogram.set(
      taskTypeKey,
      (taskTypeHistogram.get(taskTypeKey) ?? 0) + 1,
    );

    const dependencyKey = String(node.dependencyType);
    dependencyTypeHistogram.set(
      dependencyKey,
      (dependencyTypeHistogram.get(dependencyKey) ?? 0) + 1,
    );

    if (node.hasConstraintHash) {
      privateTaskCount += 1;
    }

    totalReward += BigInt(node.rewardLamports);
  }

  const completedCount = nodeFeatures.filter(
    (node) => node.status === WorkflowNodeStatus.Completed,
  ).length;
  const failedCount = nodeFeatures.filter(
    (node) => node.status === WorkflowNodeStatus.Failed,
  ).length;
  const cancelledCount = nodeFeatures.filter(
    (node) => node.status === WorkflowNodeStatus.Cancelled,
  ).length;

  const completionRate = integerRatio(completedCount, totalNodes);
  const failureRate = integerRatio(failedCount, totalNodes);
  const cancelledRate = integerRatio(cancelledCount, totalNodes);

  const telemetryCounts = deriveTelemetryCounts(
    state.id,
    options.telemetrySnapshot,
  );
  const costUnits = safeNonNegative(
    options.costUnits ?? telemetryCounts.costUnits,
  );
  const rollbackCount = safeNonNegative(
    options.rollbackCount ?? telemetryCounts.rollbackCount,
  );
  const verifierDisagreementCount = safeNonNegative(
    options.verifierDisagreementCount ??
      telemetryCounts.verifierDisagreementCount,
  );

  const rollbackRate = integerRatio(rollbackCount, totalNodes);
  const verifierDisagreementRate = integerRatio(
    verifierDisagreementCount,
    totalNodes,
  );

  const conformanceScore = clamp01(
    options.conformanceScore ??
      deriveConformanceScore(
        completionRate,
        failureRate,
        cancelledRate,
        rollbackRate,
        verifierDisagreementRate,
      ),
  );

  const outcomes: WorkflowOutcomeLabels = {
    outcome: deriveOutcome(state),
    success:
      completedCount === totalNodes &&
      totalNodes > 0 &&
      failedCount === 0 &&
      cancelledCount === 0,
    elapsedMs: deriveElapsedMs(state, capturedAtMs),
    completionRate,
    failureRate,
    cancelledRate,
    costUnits,
    rollbackRate,
    verifierDisagreementRate,
    conformanceScore,
  };

  return {
    schemaVersion: WORKFLOW_FEATURE_SCHEMA_VERSION,
    workflowId: state.id,
    capturedAtMs,
    topology: {
      nodeCount: totalNodes,
      edgeCount: state.definition.edges.length,
      rootCount,
      maxDepth,
      averageBranchingFactor,
    },
    composition: {
      taskTypeHistogram: orderedRecord(taskTypeHistogram),
      dependencyTypeHistogram: orderedRecord(dependencyTypeHistogram),
      privateTaskCount,
      totalRewardLamports: totalReward.toString(),
      averageRewardLamports:
        totalNodes > 0 ? safeBigIntToNumber(totalReward) / totalNodes : 0,
    },
    outcomes,
    nodeFeatures,
    metadata: buildMetadata(
      options.metadata,
      nodeFeatures,
      options.taskRoleByTaskName,
    ),
  };
}

/**
 * Convenience helper for extracting features directly from a telemetry collector.
 */
export function extractWorkflowFeatureVectorFromCollector(
  state: WorkflowState,
  collector: Pick<TelemetryCollector, "getFullSnapshot">,
  options: Omit<WorkflowFeatureExtractionOptions, "telemetrySnapshot"> = {},
): WorkflowFeatureVector {
  return extractWorkflowFeatureVector(state, {
    ...options,
    telemetrySnapshot: collector.getFullSnapshot(),
  });
}
