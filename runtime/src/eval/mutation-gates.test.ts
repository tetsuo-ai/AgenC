import { describe, expect, it } from 'vitest';
import {
  evaluateMutationRegressionGates,
  formatMutationGateEvaluation,
} from './mutation-gates.js';
import type { MutationArtifact } from './mutation-runner.js';

function artifactFixture(deltaPassRate: number): MutationArtifact {
  return {
    schemaVersion: 1,
    benchmarkSchemaVersion: 1,
    runId: 'mutation-fixture',
    generatedAtMs: 1700000000000,
    mutationSeed: 7,
    corpusVersion: 'v1',
    manifestHash: 'abc',
    baselineBenchmarkRunId: 'baseline-run',
    baselineAggregate: {
      scorecard: {
        k: 2,
        aggregate: {
          runCount: 4,
          successCount: 4,
          passRate: 1,
          passAtK: 1,
          passCaretK: 1,
          riskWeightedSuccess: 1,
          conformanceScore: 1,
          costNormalizedUtility: 1,
          meanLatencyMs: 20,
          meanCostUnits: 1,
        },
        byTaskType: {},
        byRewardTier: { low: {} as never, medium: {} as never, high: {} as never, unknown: {} as never },
        byVerifierGate: { gated: {} as never, ungated: {} as never },
      },
      serializedScorecard: { json: '{}', summary: 'baseline' },
    },
    aggregate: {
      scorecard: {
        k: 2,
        aggregate: {
          runCount: 4,
          successCount: 2,
          passRate: 0.5,
          passAtK: 0.5,
          passCaretK: 0.75,
          riskWeightedSuccess: 0.5,
          conformanceScore: 0.6,
          costNormalizedUtility: 0.4,
          meanLatencyMs: 40,
          meanCostUnits: 2,
        },
        byTaskType: {},
        byRewardTier: { low: {} as never, medium: {} as never, high: {} as never, unknown: {} as never },
        byVerifierGate: { gated: {} as never, ungated: {} as never },
      },
      serializedScorecard: { json: '{}', summary: 'mutation' },
      deltasFromBaseline: {
        passRate: deltaPassRate,
        passAtK: -0.2,
        passCaretK: -0.2,
        riskWeightedSuccess: -0.2,
        conformanceScore: -0.2,
        costNormalizedUtility: -0.2,
      },
    },
    runs: [],
    operators: [
      {
        operatorId: 'workflow.drop_completion',
        operatorCategory: 'workflow',
        description: 'desc',
        runCount: 2,
        scorecard: {} as never,
        serializedScorecard: { json: '{}', summary: '' },
        deltasFromBaseline: {
          passRate: deltaPassRate,
          passAtK: -0.1,
          passCaretK: -0.1,
          riskWeightedSuccess: -0.1,
          conformanceScore: -0.1,
          costNormalizedUtility: -0.1,
        },
      },
    ],
    scenarios: [
      {
        scenarioId: 'baseline',
        title: 'Baseline',
        taskClass: 'qa',
        riskTier: 'medium',
        runCount: 2,
        scorecard: {} as never,
        serializedScorecard: { json: '{}', summary: '' },
        deltasFromBaseline: {
          passRate: deltaPassRate,
          passAtK: -0.1,
          passCaretK: -0.1,
          riskWeightedSuccess: -0.1,
          conformanceScore: -0.1,
          costNormalizedUtility: -0.1,
        },
      },
    ],
    topRegressions: [],
  };
}

describe('mutation regression gates', () => {
  it('passes when deltas stay within thresholds', () => {
    const evaluation = evaluateMutationRegressionGates(artifactFixture(-0.2), {
      maxAggregatePassRateDrop: 0.4,
      maxScenarioPassRateDrop: 0.4,
      maxOperatorPassRateDrop: 0.4,
    });

    expect(evaluation.passed).toBe(true);
    expect(evaluation.violations).toHaveLength(0);
  });

  it('fails when deltas exceed thresholds and formats report', () => {
    const evaluation = evaluateMutationRegressionGates(artifactFixture(-0.8), {
      maxAggregatePassRateDrop: 0.2,
      maxScenarioPassRateDrop: 0.2,
      maxOperatorPassRateDrop: 0.2,
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.length).toBeGreaterThan(0);

    const rendered = formatMutationGateEvaluation(evaluation);
    expect(rendered).toContain('FAIL');
    expect(rendered).toContain('Violations');
  });
});

