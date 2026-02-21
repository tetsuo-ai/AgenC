/**
 * Reliability regression gate evaluation for mutation artifacts.
 *
 * @module
 */

import type { MutationArtifact } from "./mutation-runner.js";

export interface MutationGateThresholds {
  maxAggregatePassRateDrop: number;
  maxAggregateConformanceDrop: number;
  maxAggregateCostUtilityDrop: number;
  maxScenarioPassRateDrop: number;
  maxOperatorPassRateDrop: number;
  maxChaosScenarioFailRate: number;
}

export interface MutationGatingPolicyManifest {
  schemaVersion: 1;
  name: string;
  updatedAt: string;
  thresholds: MutationGateThresholds;
  operatorOverrides?: Record<
    string,
    Partial<Pick<MutationGateThresholds, "maxOperatorPassRateDrop">>
  >;
  scenarioOverrides?: Record<
    string,
    Partial<Pick<MutationGateThresholds, "maxScenarioPassRateDrop">>
  >;
}

export interface MutationGateViolation {
  scope: "aggregate" | "scenario" | "operator" | "chaos";
  id: string;
  metric:
    | "passRate"
    | "conformanceScore"
    | "costNormalizedUtility"
    | "chaosFailRate";
  delta: number;
  minAllowedDelta: number;
}

export interface MutationGateEvaluation {
  passed: boolean;
  thresholds: MutationGateThresholds;
  violations: MutationGateViolation[];
}

export const DEFAULT_MUTATION_GATE_THRESHOLDS: MutationGateThresholds = {
  maxAggregatePassRateDrop: 0.6,
  maxAggregateConformanceDrop: 0.35,
  maxAggregateCostUtilityDrop: 0.45,
  maxScenarioPassRateDrop: 1.0,
  maxOperatorPassRateDrop: 0.6,
  maxChaosScenarioFailRate: 0.0,
};

function mergeThresholds(
  overrides: Partial<MutationGateThresholds> | undefined,
): MutationGateThresholds {
  return {
    ...DEFAULT_MUTATION_GATE_THRESHOLDS,
    ...(overrides ?? {}),
  };
}

function parseThresholds(raw: unknown): MutationGateThresholds {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "Mutation gating policy thresholds must be a non-null object",
    );
  }

  const candidate = raw as Partial<
    Record<keyof MutationGateThresholds, unknown>
  >;
  const requiredKeys: Array<keyof MutationGateThresholds> = [
    "maxAggregatePassRateDrop",
    "maxAggregateConformanceDrop",
    "maxAggregateCostUtilityDrop",
    "maxScenarioPassRateDrop",
    "maxOperatorPassRateDrop",
    "maxChaosScenarioFailRate",
  ];

  for (const key of requiredKeys) {
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Mutation gating threshold "${key}" must be a finite number`,
      );
    }
  }

  return candidate as unknown as MutationGateThresholds;
}

function parseOverrideMap(
  raw: unknown,
  fieldName: string,
  allowedField: "maxOperatorPassRateDrop" | "maxScenarioPassRateDrop",
):
  | Record<
      string,
      Partial<
        Pick<
          MutationGateThresholds,
          "maxOperatorPassRateDrop" | "maxScenarioPassRateDrop"
        >
      >
    >
  | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const parsed: Record<
    string,
    Partial<
      Pick<
        MutationGateThresholds,
        "maxOperatorPassRateDrop" | "maxScenarioPassRateDrop"
      >
    >
  > = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${fieldName}.${id} must be an object`);
    }

    const override = value as Partial<
      Record<"maxOperatorPassRateDrop" | "maxScenarioPassRateDrop", unknown>
    >;
    const candidate = override[allowedField];
    if (candidate !== undefined) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        throw new Error(
          `${fieldName}.${id}.${allowedField} must be a finite number`,
        );
      }
      parsed[id] = { [allowedField]: candidate };
    } else {
      parsed[id] = {};
    }
  }

  return parsed;
}

/**
 * Parse and validate a versioned mutation gating policy manifest.
 */
export function parseMutationGatingPolicyManifest(
  raw: unknown,
): MutationGatingPolicyManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      "Mutation gating policy manifest must be a non-null object",
    );
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    throw new Error(
      `Unsupported mutation gating policy schema version: ${String(candidate.schemaVersion)}`,
    );
  }
  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0
  ) {
    throw new Error(
      'Mutation gating policy manifest requires a non-empty "name"',
    );
  }
  if (
    typeof candidate.updatedAt !== "string" ||
    candidate.updatedAt.trim().length === 0
  ) {
    throw new Error(
      'Mutation gating policy manifest requires a non-empty "updatedAt"',
    );
  }

  const thresholds = parseThresholds(candidate.thresholds);
  const operatorOverrides = parseOverrideMap(
    candidate.operatorOverrides,
    "operatorOverrides",
    "maxOperatorPassRateDrop",
  ) as MutationGatingPolicyManifest["operatorOverrides"];
  const scenarioOverrides = parseOverrideMap(
    candidate.scenarioOverrides,
    "scenarioOverrides",
    "maxScenarioPassRateDrop",
  ) as MutationGatingPolicyManifest["scenarioOverrides"];

  return {
    schemaVersion: 1,
    name: candidate.name,
    updatedAt: candidate.updatedAt,
    thresholds,
    ...(operatorOverrides !== undefined ? { operatorOverrides } : {}),
    ...(scenarioOverrides !== undefined ? { scenarioOverrides } : {}),
  };
}

function violates(delta: number, maxDrop: number): boolean {
  return delta < -1 * Math.max(0, maxDrop);
}

/**
 * Evaluate mutation artifact against regression thresholds.
 */
export function evaluateMutationRegressionGates(
  artifact: MutationArtifact,
  thresholds?: Partial<MutationGateThresholds>,
  manifest?: MutationGatingPolicyManifest,
): MutationGateEvaluation {
  const merged = manifest?.thresholds ?? mergeThresholds(thresholds);
  const violations: MutationGateViolation[] = [];

  const aggregateDelta = artifact.aggregate.deltasFromBaseline;
  if (violates(aggregateDelta.passRate, merged.maxAggregatePassRateDrop)) {
    violations.push({
      scope: "aggregate",
      id: "aggregate",
      metric: "passRate",
      delta: aggregateDelta.passRate,
      minAllowedDelta: -1 * merged.maxAggregatePassRateDrop,
    });
  }
  if (
    violates(
      aggregateDelta.conformanceScore,
      merged.maxAggregateConformanceDrop,
    )
  ) {
    violations.push({
      scope: "aggregate",
      id: "aggregate",
      metric: "conformanceScore",
      delta: aggregateDelta.conformanceScore,
      minAllowedDelta: -1 * merged.maxAggregateConformanceDrop,
    });
  }
  if (
    violates(
      aggregateDelta.costNormalizedUtility,
      merged.maxAggregateCostUtilityDrop,
    )
  ) {
    violations.push({
      scope: "aggregate",
      id: "aggregate",
      metric: "costNormalizedUtility",
      delta: aggregateDelta.costNormalizedUtility,
      minAllowedDelta: -1 * merged.maxAggregateCostUtilityDrop,
    });
  }

  for (const scenario of artifact.scenarios) {
    const maxScenarioPassRateDrop =
      manifest?.scenarioOverrides?.[scenario.scenarioId]
        ?.maxScenarioPassRateDrop ?? merged.maxScenarioPassRateDrop;
    const delta = scenario.deltasFromBaseline.passRate;
    if (violates(delta, maxScenarioPassRateDrop)) {
      violations.push({
        scope: "scenario",
        id: scenario.scenarioId,
        metric: "passRate",
        delta,
        minAllowedDelta: -1 * maxScenarioPassRateDrop,
      });
    }
  }

  for (const operator of artifact.operators) {
    const maxOperatorPassRateDrop =
      manifest?.operatorOverrides?.[operator.operatorId]
        ?.maxOperatorPassRateDrop ?? merged.maxOperatorPassRateDrop;
    const delta = operator.deltasFromBaseline.passRate;
    if (violates(delta, maxOperatorPassRateDrop)) {
      violations.push({
        scope: "operator",
        id: operator.operatorId,
        metric: "passRate",
        delta,
        minAllowedDelta: -1 * maxOperatorPassRateDrop,
      });
    }
  }

  const chaosRuns = artifact.runs.filter((run) =>
    run.scenarioId.startsWith("chaos."),
  );
  if (chaosRuns.length > 0) {
    const failures = chaosRuns.filter((run) => !run.passed).length;
    const failRate = failures / chaosRuns.length;
    if (failRate > merged.maxChaosScenarioFailRate) {
      violations.push({
        scope: "chaos",
        id: "aggregate",
        metric: "chaosFailRate",
        delta: -1 * failRate,
        minAllowedDelta: -1 * merged.maxChaosScenarioFailRate,
      });
    }
  }

  return {
    passed: violations.length === 0,
    thresholds: merged,
    violations,
  };
}

/**
 * Human-readable gate report for CI and developer debugging.
 */
export function formatMutationGateEvaluation(
  evaluation: MutationGateEvaluation,
): string {
  const lines: string[] = [
    `Mutation regression gates: ${evaluation.passed ? "PASS" : "FAIL"}`,
    "Thresholds:",
    `  aggregate pass-rate drop <= ${evaluation.thresholds.maxAggregatePassRateDrop.toFixed(4)}`,
    `  aggregate conformance drop <= ${evaluation.thresholds.maxAggregateConformanceDrop.toFixed(4)}`,
    `  aggregate cost-utility drop <= ${evaluation.thresholds.maxAggregateCostUtilityDrop.toFixed(4)}`,
    `  scenario pass-rate drop <= ${evaluation.thresholds.maxScenarioPassRateDrop.toFixed(4)}`,
    `  operator pass-rate drop <= ${evaluation.thresholds.maxOperatorPassRateDrop.toFixed(4)}`,
    `  chaos scenario fail-rate <= ${evaluation.thresholds.maxChaosScenarioFailRate.toFixed(4)}`,
  ];

  if (evaluation.violations.length === 0) {
    lines.push("No threshold violations detected.");
    return lines.join("\n");
  }

  lines.push("Violations:");
  for (const violation of evaluation.violations) {
    lines.push(
      `  [${violation.scope}] ${violation.id} ${violation.metric} delta=${violation.delta.toFixed(4)} min=${violation.minAllowedDelta.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}
