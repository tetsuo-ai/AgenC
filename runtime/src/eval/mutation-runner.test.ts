import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_MANIFEST_SCHEMA_VERSION,
  type BenchmarkManifest,
} from './benchmark-manifest.js';
import {
  MutationRunner,
  serializeMutationArtifact,
} from './mutation-runner.js';
import type { BenchmarkScenarioRunner } from './benchmark-runner.js';

function buildTrace(options: {
  traceId: string;
  seed: number;
  taskPda: string;
  pass: boolean;
  includeVerifier: boolean;
  durationMs: number;
}): unknown {
  const events: Array<Record<string, unknown>> = [
    { seq: 1, type: 'discovered', taskPda: options.taskPda, timestampMs: 1, payload: {} },
    { seq: 2, type: 'claimed', taskPda: options.taskPda, timestampMs: 2, payload: { claimTx: 'claim-tx' } },
  ];

  if (options.includeVerifier) {
    events.push({
      seq: 3,
      type: 'verifier_verdict',
      taskPda: options.taskPda,
      timestampMs: 3,
      payload: { attempt: 1, verdict: 'pass', confidence: 0.9 },
    });
  }

  events.push({
    seq: options.includeVerifier ? 4 : 3,
    type: 'executed',
    taskPda: options.taskPda,
    timestampMs: 4,
    payload: { outputLength: 1 },
  });

  if (options.pass) {
    events.push({
      seq: options.includeVerifier ? 5 : 4,
      type: 'completed',
      taskPda: options.taskPda,
      timestampMs: 25,
      payload: { completionTx: 'complete-tx', durationMs: options.durationMs },
    });
  } else {
    events.push({
      seq: options.includeVerifier ? 5 : 4,
      type: 'failed',
      taskPda: options.taskPda,
      timestampMs: 25,
      payload: { error: 'failure' },
    });
  }

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
    corpusVersion: 'v-mutation-test',
    baselineScenarioId: 'baseline',
    k: 2,
    scenarios: [
      {
        id: 'baseline',
        title: 'Baseline scenario',
        taskClass: 'qa',
        riskTier: 'medium',
        expectedConstraints: ['deterministic_replay'],
        seeds: [1, 2],
        verifierGated: true,
        costUnits: 1,
      },
      {
        id: 'regression',
        title: 'Regression sentinel',
        taskClass: 'qa',
        riskTier: 'high',
        expectedConstraints: ['policy_guardrail'],
        seeds: [3, 4],
        verifierGated: true,
        costUnits: 2,
      },
    ],
  };
}

function scenarioRunners(): Record<string, BenchmarkScenarioRunner> {
  return {
    baseline: async ({ scenario, seed }) => ({
      trace: buildTrace({
        traceId: `${scenario.id}-${seed}`,
        seed,
        taskPda: `task-${seed}`,
        pass: true,
        includeVerifier: true,
        durationMs: 20 + seed,
      }),
    }),
    regression: async ({ scenario, seed }) => ({
      trace: buildTrace({
        traceId: `${scenario.id}-${seed}`,
        seed,
        taskPda: `task-${seed}`,
        pass: seed % 2 === 0,
        includeVerifier: true,
        durationMs: 40 + seed,
      }),
    }),
  };
}

describe('MutationRunner', () => {
  it('produces deterministic mutation artifacts from fixed manifest and seeds', async () => {
    const runnerA = new MutationRunner({
      now: () => 1700000000100,
      runId: 'mutation-test',
    });
    const runnerB = new MutationRunner({
      now: () => 1700000000100,
      runId: 'mutation-test',
    });

    const first = await runnerA.run(manifestFixture(), {
      scenarioRunners: scenarioRunners(),
      mutationSeed: 55,
    });
    const second = await runnerB.run(manifestFixture(), {
      scenarioRunners: scenarioRunners(),
      mutationSeed: 55,
    });

    expect(serializeMutationArtifact(first)).toBe(serializeMutationArtifact(second));
    expect(first.runs.length).toBeGreaterThan(0);
    expect(first.operators.length).toBeGreaterThan(0);
  });

  it('computes aggregate/operator/scenario regression deltas and top regressions', async () => {
    const artifact = await new MutationRunner({
      now: () => 1700000000200,
      runId: 'mutation-regression',
    }).run(manifestFixture(), {
      scenarioRunners: scenarioRunners(),
      mutationSeed: 7,
    });

    expect(artifact.aggregate.deltasFromBaseline.passRate).toBeLessThanOrEqual(0);
    expect(artifact.scenarios).toHaveLength(2);
    expect(artifact.operators.length).toBeGreaterThanOrEqual(2);
    expect(artifact.topRegressions[0]?.scope).toBeDefined();
    expect(artifact.topRegressions[0]?.passRateDelta).toBeLessThanOrEqual(
      artifact.topRegressions[artifact.topRegressions.length - 1]?.passRateDelta ?? 0,
    );
  });
});

