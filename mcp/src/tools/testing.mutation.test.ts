import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeBenchmarkMutationArtifacts } from './testing.js';

test('summarizeBenchmarkMutationArtifacts renders benchmark and mutation deltas', () => {
  const summary = summarizeBenchmarkMutationArtifacts({
    benchmarkArtifact: {
      runId: 'benchmark-v1',
      corpusVersion: 'v1.0.0',
      aggregate: {
        scorecard: {
          aggregate: {
            passRate: 0.75,
            conformanceScore: 0.82,
            costNormalizedUtility: 0.61,
          },
        },
      },
    },
    mutationArtifact: {
      runId: 'mutation-v1',
      mutationSeed: 17,
      aggregate: {
        deltasFromBaseline: {
          passRate: -0.21,
          conformanceScore: -0.12,
          costNormalizedUtility: -0.08,
        },
      },
      topRegressions: [
        { scope: 'scenario', id: 'policy_regression', passRateDelta: -0.6 },
        { scope: 'operator', id: 'tool.inject_failure', passRateDelta: -0.4 },
      ],
    },
  });

  assert.match(summary, /Benchmark run: benchmark-v1/);
  assert.match(summary, /Mutation run: mutation-v1/);
  assert.match(summary, /Mutation aggregate pass-rate delta: -0\.2100/);
  assert.match(summary, /\[scenario\] policy_regression: -0\.6000/);
});

test('summarizeBenchmarkMutationArtifacts handles missing mutation artifact', () => {
  const summary = summarizeBenchmarkMutationArtifacts({
    benchmarkArtifact: {
      runId: 'benchmark-only',
      corpusVersion: 'v1',
      aggregate: {
        scorecard: {
          aggregate: {
            passRate: 0.9,
          },
        },
      },
    },
  });

  assert.match(summary, /Benchmark run: benchmark-only/);
  assert.match(summary, /Mutation artifact not provided/);
});

