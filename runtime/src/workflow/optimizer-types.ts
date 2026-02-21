/**
 * Workflow optimizer feature/objective contracts.
 *
 * @module
 */

export const WORKFLOW_FEATURE_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_OBJECTIVE_SCHEMA_VERSION = 1 as const;

export type WorkflowRunOutcome = "completed" | "failed" | "partially_completed";

export interface WorkflowTopologyFeatures {
  nodeCount: number;
  edgeCount: number;
  rootCount: number;
  maxDepth: number;
  averageBranchingFactor: number;
}

export interface WorkflowCompositionFeatures {
  taskTypeHistogram: Record<string, number>;
  dependencyTypeHistogram: Record<string, number>;
  privateTaskCount: number;
  totalRewardLamports: string;
  averageRewardLamports: number;
}

export interface WorkflowNodeFeature {
  name: string;
  taskType: number;
  dependencyType: number;
  rewardLamports: string;
  maxWorkers: number;
  minReputation: number;
  hasConstraintHash: boolean;
  status: string;
}

export interface WorkflowOutcomeLabels {
  outcome: WorkflowRunOutcome;
  success: boolean;
  elapsedMs: number;
  completionRate: number;
  failureRate: number;
  cancelledRate: number;
  costUnits: number;
  rollbackRate: number;
  verifierDisagreementRate: number;
  conformanceScore: number;
}

export interface WorkflowFeatureVector {
  schemaVersion: typeof WORKFLOW_FEATURE_SCHEMA_VERSION;
  workflowId: string;
  capturedAtMs: number;
  topology: WorkflowTopologyFeatures;
  composition: WorkflowCompositionFeatures;
  outcomes: WorkflowOutcomeLabels;
  nodeFeatures: WorkflowNodeFeature[];
  metadata?: Record<string, string>;
}

export interface LegacyWorkflowFeatureVectorV0 {
  workflowId: string;
  capturedAtMs?: number;
  topology: WorkflowTopologyFeatures;
  composition: WorkflowCompositionFeatures;
  outcomes: WorkflowOutcomeLabels;
  nodeFeatures: WorkflowNodeFeature[];
  metadata?: Record<string, string>;
}

export type WorkflowObjectiveMetric =
  | "success_rate"
  | "conformance_score"
  | "latency_ms"
  | "cost_units"
  | "rollback_rate"
  | "verifier_disagreement_rate";

export interface WorkflowObjectiveWeight {
  metric: WorkflowObjectiveMetric;
  direction: "maximize" | "minimize";
  weight: number;
  /** Optional baseline for scale normalization. */
  baseline?: number;
}

export interface WorkflowObjectiveSpec {
  id: string;
  schemaVersion: typeof WORKFLOW_OBJECTIVE_SCHEMA_VERSION;
  weights: WorkflowObjectiveWeight[];
}

export interface WorkflowObjectiveOutcome {
  successRate: number;
  conformanceScore: number;
  latencyMs: number;
  costUnits: number;
  rollbackRate: number;
  verifierDisagreementRate: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Default multi-objective spec with conservative weighting.
 */
export function createDefaultWorkflowObjectiveSpec(
  id = "default-v1",
): WorkflowObjectiveSpec {
  return {
    id,
    schemaVersion: WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
    weights: [
      {
        metric: "success_rate",
        direction: "maximize",
        weight: 0.35,
        baseline: 1,
      },
      {
        metric: "conformance_score",
        direction: "maximize",
        weight: 0.25,
        baseline: 1,
      },
      {
        metric: "latency_ms",
        direction: "minimize",
        weight: 0.15,
        baseline: 60_000,
      },
      { metric: "cost_units", direction: "minimize", weight: 0.1, baseline: 1 },
      {
        metric: "rollback_rate",
        direction: "minimize",
        weight: 0.1,
        baseline: 0.1,
      },
      {
        metric: "verifier_disagreement_rate",
        direction: "minimize",
        weight: 0.05,
        baseline: 0.1,
      },
    ],
  };
}

export function validateWorkflowObjectiveSpec(
  spec: WorkflowObjectiveSpec,
): void {
  assert(
    spec.schemaVersion === WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
    "unsupported objective schemaVersion",
  );
  assert(spec.id.trim().length > 0, "objective id must be non-empty");
  assert(spec.weights.length > 0, "objective must contain at least one weight");

  for (const weight of spec.weights) {
    assert(
      weight.weight >= 0,
      `weight for ${weight.metric} must be non-negative`,
    );
    if (weight.baseline !== undefined) {
      assert(weight.baseline > 0, `baseline for ${weight.metric} must be > 0`);
    }
  }

  const totalWeight = spec.weights.reduce((sum, item) => sum + item.weight, 0);
  assert(totalWeight > 0, "objective weights must sum to > 0");
}

function normalizeMetric(
  value: number,
  direction: "maximize" | "minimize",
  baseline?: number,
): number {
  const safeValue = Math.max(0, value);
  if (direction === "maximize") {
    return Math.max(0, Math.min(1, safeValue));
  }

  const denom = baseline && baseline > 0 ? baseline : 1;
  return 1 / (1 + safeValue / denom);
}

export function scoreWorkflowObjective(
  outcome: WorkflowObjectiveOutcome,
  spec: WorkflowObjectiveSpec = createDefaultWorkflowObjectiveSpec(),
): number {
  validateWorkflowObjectiveSpec(spec);

  const metricMap: Record<WorkflowObjectiveMetric, number> = {
    success_rate: outcome.successRate,
    conformance_score: outcome.conformanceScore,
    latency_ms: outcome.latencyMs,
    cost_units: outcome.costUnits,
    rollback_rate: outcome.rollbackRate,
    verifier_disagreement_rate: outcome.verifierDisagreementRate,
  };

  const totalWeight = spec.weights.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;

  let weightedScore = 0;
  for (const weight of spec.weights) {
    const rawValue = metricMap[weight.metric] ?? 0;
    const normalized = normalizeMetric(
      rawValue,
      weight.direction,
      weight.baseline,
    );
    weightedScore += normalized * weight.weight;
  }

  return weightedScore / totalWeight;
}

export function workflowObjectiveOutcomeFromFeature(
  feature: WorkflowFeatureVector,
): WorkflowObjectiveOutcome {
  return {
    successRate: feature.outcomes.success ? 1 : 0,
    conformanceScore: feature.outcomes.conformanceScore,
    latencyMs: feature.outcomes.elapsedMs,
    costUnits: feature.outcomes.costUnits,
    rollbackRate: feature.outcomes.rollbackRate,
    verifierDisagreementRate: feature.outcomes.verifierDisagreementRate,
  };
}

/**
 * Parse and migrate feature vectors for backward compatibility.
 */
export function parseWorkflowFeatureVector(
  input: unknown,
): WorkflowFeatureVector {
  assert(isObject(input), "feature vector must be an object");

  if ("schemaVersion" in input) {
    assert(
      input.schemaVersion === WORKFLOW_FEATURE_SCHEMA_VERSION,
      "unsupported feature schemaVersion",
    );

    const schemaVersion = input.schemaVersion;
    const workflowId = input.workflowId;
    const capturedAtMs = input.capturedAtMs;
    const topology = input.topology;
    const composition = input.composition;
    const outcomes = input.outcomes;
    const nodeFeatures = input.nodeFeatures;
    const metadata = input.metadata;

    assert(
      typeof workflowId === "string" && workflowId.length > 0,
      "workflowId must be non-empty",
    );
    assert(
      Number.isInteger(capturedAtMs) && (capturedAtMs as number) >= 0,
      "capturedAtMs must be non-negative integer",
    );
    assert(isObject(topology), "topology must be an object");
    assert(isObject(composition), "composition must be an object");
    assert(isObject(outcomes), "outcomes must be an object");
    assert(Array.isArray(nodeFeatures), "nodeFeatures must be an array");

    return {
      schemaVersion: schemaVersion as typeof WORKFLOW_FEATURE_SCHEMA_VERSION,
      workflowId,
      capturedAtMs: capturedAtMs as number,
      topology: topology as unknown as WorkflowTopologyFeatures,
      composition: composition as unknown as WorkflowCompositionFeatures,
      outcomes: outcomes as unknown as WorkflowOutcomeLabels,
      nodeFeatures: nodeFeatures as unknown as WorkflowNodeFeature[],
      metadata: metadata as Record<string, string> | undefined,
    };
  }

  // Legacy v0 migration path (missing schemaVersion).
  const legacy = input as Record<string, unknown>;
  assert(
    typeof legacy.workflowId === "string" && legacy.workflowId.length > 0,
    "legacy workflowId must be non-empty",
  );
  assert(isObject(legacy.topology), "legacy topology must be an object");
  assert(isObject(legacy.composition), "legacy composition must be an object");
  assert(isObject(legacy.outcomes), "legacy outcomes must be an object");
  assert(
    Array.isArray(legacy.nodeFeatures),
    "legacy nodeFeatures must be an array",
  );
  const metadata = legacy.metadata;
  assert(
    metadata === undefined || isObject(metadata),
    "legacy metadata must be an object when provided",
  );

  return {
    schemaVersion: WORKFLOW_FEATURE_SCHEMA_VERSION,
    workflowId: legacy.workflowId as string,
    capturedAtMs: toFiniteNumber(legacy.capturedAtMs, Date.now()),
    topology:
      legacy.topology as unknown as LegacyWorkflowFeatureVectorV0["topology"],
    composition:
      legacy.composition as unknown as LegacyWorkflowFeatureVectorV0["composition"],
    outcomes:
      legacy.outcomes as unknown as LegacyWorkflowFeatureVectorV0["outcomes"],
    nodeFeatures:
      legacy.nodeFeatures as unknown as LegacyWorkflowFeatureVectorV0["nodeFeatures"],
    metadata: metadata as Record<string, string> | undefined,
  };
}
