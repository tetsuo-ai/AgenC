import { describe, expect, it } from 'vitest';
import {
  BenchmarkRunner,
  serializeBenchmarkArtifact,
  type BenchmarkManifest,
  type BenchmarkScenarioRunner,
} from './benchmark-runner.js';
import { BENCHMARK_MANIFEST_SCHEMA_VERSION } from './benchmark-manifest.js';

function buildTrace(options: {
  traceId: string;
  seed: number;
  taskPda: string;
  pass: boolean;
  durationMs: number;
  policyViolation?: boolean;
}): unknown {
  const events: Array<Record<string, unknown>> = [
    { seq: 1, type: 'discovered', taskPda: options.taskPda, timestampMs: 1, payload: {} },
    { seq: 2, type: 'claimed', taskPda: options.taskPda, timestampMs: 2, payload: { claimTx: 'claim-tx' } },
    { seq: 3, type: 'executed', taskPda: options.taskPda, timestampMs: 3, payload: { outputLength: 1 } },
  ];

  if (options.policyViolation) {
    events.push({
      seq: 4,
      type: 'policy_violation',
      taskPda: options.taskPda,
      timestampMs: 4,
      payload: { code: 'risk_threshold_exceeded' },
    });
  }

  events.push(options.pass
    ? {
      seq: options.policyViolation ? 5 : 4,
      type: 'completed',
      taskPda: options.taskPda,
      timestampMs: 10,
      payload: { completionTx: 'complete-tx', durationMs: options.durationMs },
    }
    : {
      seq: options.policyViolation ? 5 : 4,
      type: 'failed',
      taskPda: options.taskPda,
      timestampMs: 10,
      payload: { error: 'failed' },
    });

  return {
    schemaVersion: 1,
    traceId: options.traceId,
    seed: options.seed,
    createdAtMs: 0,
    events,
  };
}

function manifestFixture(): BenchmarkManifest {
  return {
    schemaVersion: BENCHMARK_MANIFEST_SCHEMA_VERSION,
    corpusVersion: 'v-test',
    baselineScenarioId: 'baseline',
    k: 2,
    scenarios: [
      {
        id: 'baseline',
        title: 'Baseline',
        taskClass: 'qa',
        riskTier: 'medium',
        expectedConstraints: ['deterministic_replay'],
        seeds: [1, 2],
        verifierGated: true,
        costUnits: 1.2,
      },
      {
        id: 'regression',
        title: 'Regression',
        taskClass: 'qa',
        riskTier: 'high',
        expectedConstraints: ['policy_guardrail'],
        seeds: [3, 4],
        verifierGated: true,
        costUnits: 2.4,
      },
    ],
  };
}

describe('BenchmarkRunner', () => {
  it('produces deterministic artifact outputs from fixed manifest and seeds', async () => {
    const runners: Record<string, BenchmarkScenarioRunner> = {
      baseline: async ({ scenario, seed }) => ({
        trace: buildTrace({
          traceId: `${scenario.id}-${seed}`,
          seed,
          taskPda: `task-${seed}`,
          pass: true,
          durationMs: 20 + seed,
        }),
      }),
      regression: async ({ scenario, seed }) => ({
        trace: buildTrace({
          traceId: `${scenario.id}-${seed}`,
          seed,
          taskPda: `task-${seed}`,
          pass: seed % 2 === 0,
          durationMs: 45 + seed,
          policyViolation: true,
        }),
      }),
    };

    const runnerA = new BenchmarkRunner({
      now: () => 1700000000000,
      runId: 'bench-test',
    });
    const runnerB = new BenchmarkRunner({
      now: () => 1700000000000,
      runId: 'bench-test',
    });

    const first = await runnerA.run(manifestFixture(), { scenarioRunners: runners });
    const second = await runnerB.run(manifestFixture(), { scenarioRunners: runners });

    expect(serializeBenchmarkArtifact(first)).toBe(serializeBenchmarkArtifact(second));
    expect(first.scenarios).toHaveLength(2);
    expect(first.aggregate.scorecard.aggregate.runCount).toBe(4);
  });

  it('computes scenario and aggregate deltas against baseline scorecard', async () => {
    const artifact = await new BenchmarkRunner({
      now: () => 1700000000010,
      runId: 'bench-delta',
    }).run(manifestFixture(), {
      scenarioRunners: {
        baseline: async ({ scenario, seed }) => ({
          trace: buildTrace({
            traceId: `${scenario.id}-${seed}`,
            seed,
            taskPda: `task-${seed}`,
            pass: true,
            durationMs: 25,
          }),
        }),
        regression: async ({ scenario, seed }) => ({
          trace: buildTrace({
            traceId: `${scenario.id}-${seed}`,
            seed,
            taskPda: `task-${seed}`,
            pass: false,
            durationMs: 65,
            policyViolation: true,
          }),
        }),
      },
    });

    const baseline = artifact.scenarios.find((scenario) => scenario.scenarioId === 'baseline');
    const regression = artifact.scenarios.find((scenario) => scenario.scenarioId === 'regression');

    expect(baseline?.deltasFromBaseline?.passRate).toBeCloseTo(0, 8);
    expect(regression?.deltasFromBaseline?.passRate).toBeLessThan(0);
    expect(artifact.aggregate.deltasFromBaseline?.conformanceScore).toBeLessThanOrEqual(0);
  });
});
