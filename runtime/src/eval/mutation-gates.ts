/**
 * Reliability regression gate evaluation for mutation artifacts.
 *
 * @module
 */

import type { MutationArtifact } from './mutation-runner.js';

export interface MutationGateThresholds {
  maxAggregatePassRateDrop: number;
  maxAggregateConformanceDrop: number;
  maxAggregateCostUtilityDrop: number;
  maxScenarioPassRateDrop: number;
  maxOperatorPassRateDrop: number;
}

export interface MutationGateViolation {
  scope: 'aggregate' | 'scenario' | 'operator';
  id: string;
  metric: 'passRate' | 'conformanceScore' | 'costNormalizedUtility';
  delta: number;
  minAllowedDelta: number;
}

export interface MutationGateEvaluation {
  passed: boolean;
  thresholds: MutationGateThresholds;
  violations: MutationGateViolation[];
}

export const DEFAULT_MUTATION_GATE_THRESHOLDS: MutationGateThresholds = {
  maxAggregatePassRateDrop: 0.60,
  maxAggregateConformanceDrop: 0.35,
  maxAggregateCostUtilityDrop: 0.45,
  maxScenarioPassRateDrop: 1.00,
  maxOperatorPassRateDrop: 0.60,
};

function mergeThresholds(
  overrides: Partial<MutationGateThresholds> | undefined,
): MutationGateThresholds {
  return {
    ...DEFAULT_MUTATION_GATE_THRESHOLDS,
    ...(overrides ?? {}),
  };
}

function violates(delta: number, maxDrop: number): boolean {
  return delta < (-1 * Math.max(0, maxDrop));
}

/**
 * Evaluate mutation artifact against regression thresholds.
 */
export function evaluateMutationRegressionGates(
  artifact: MutationArtifact,
  thresholds?: Partial<MutationGateThresholds>,
): MutationGateEvaluation {
  const merged = mergeThresholds(thresholds);
  const violations: MutationGateViolation[] = [];

  const aggregateDelta = artifact.aggregate.deltasFromBaseline;
  if (violates(aggregateDelta.passRate, merged.maxAggregatePassRateDrop)) {
    violations.push({
      scope: 'aggregate',
      id: 'aggregate',
      metric: 'passRate',
      delta: aggregateDelta.passRate,
      minAllowedDelta: -1 * merged.maxAggregatePassRateDrop,
    });
  }
  if (violates(aggregateDelta.conformanceScore, merged.maxAggregateConformanceDrop)) {
    violations.push({
      scope: 'aggregate',
      id: 'aggregate',
      metric: 'conformanceScore',
      delta: aggregateDelta.conformanceScore,
      minAllowedDelta: -1 * merged.maxAggregateConformanceDrop,
    });
  }
  if (violates(aggregateDelta.costNormalizedUtility, merged.maxAggregateCostUtilityDrop)) {
    violations.push({
      scope: 'aggregate',
      id: 'aggregate',
      metric: 'costNormalizedUtility',
      delta: aggregateDelta.costNormalizedUtility,
      minAllowedDelta: -1 * merged.maxAggregateCostUtilityDrop,
    });
  }

  for (const scenario of artifact.scenarios) {
    const delta = scenario.deltasFromBaseline.passRate;
    if (violates(delta, merged.maxScenarioPassRateDrop)) {
      violations.push({
        scope: 'scenario',
        id: scenario.scenarioId,
        metric: 'passRate',
        delta,
        minAllowedDelta: -1 * merged.maxScenarioPassRateDrop,
      });
    }
  }

  for (const operator of artifact.operators) {
    const delta = operator.deltasFromBaseline.passRate;
    if (violates(delta, merged.maxOperatorPassRateDrop)) {
      violations.push({
        scope: 'operator',
        id: operator.operatorId,
        metric: 'passRate',
        delta,
        minAllowedDelta: -1 * merged.maxOperatorPassRateDrop,
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
export function formatMutationGateEvaluation(evaluation: MutationGateEvaluation): string {
  const lines: string[] = [
    `Mutation regression gates: ${evaluation.passed ? 'PASS' : 'FAIL'}`,
    'Thresholds:',
    `  aggregate pass-rate drop <= ${evaluation.thresholds.maxAggregatePassRateDrop.toFixed(4)}`,
    `  aggregate conformance drop <= ${evaluation.thresholds.maxAggregateConformanceDrop.toFixed(4)}`,
    `  aggregate cost-utility drop <= ${evaluation.thresholds.maxAggregateCostUtilityDrop.toFixed(4)}`,
    `  scenario pass-rate drop <= ${evaluation.thresholds.maxScenarioPassRateDrop.toFixed(4)}`,
    `  operator pass-rate drop <= ${evaluation.thresholds.maxOperatorPassRateDrop.toFixed(4)}`,
  ];

  if (evaluation.violations.length === 0) {
    lines.push('No threshold violations detected.');
    return lines.join('\n');
  }

  lines.push('Violations:');
  for (const violation of evaluation.violations) {
    lines.push(
      `  [${violation.scope}] ${violation.id} ${violation.metric} delta=${violation.delta.toFixed(4)} min=${violation.minAllowedDelta.toFixed(4)}`,
    );
  }
  return lines.join('\n');
}
