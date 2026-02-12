import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrajectoryRecorder } from '../src/eval/recorder.js';
import { BenchmarkRunner, serializeBenchmarkArtifact } from '../src/eval/benchmark-runner.js';
import { BENCHMARK_MANIFEST_SCHEMA_VERSION } from '../src/eval/benchmark-manifest.js';
import type { BenchmarkManifest } from '../src/eval/benchmark-manifest.js';
import {
  createRuntimeTestContext,
  initializeProtocol,
} from './litesvm-setup.js';
import { BENCHMARK_ARTIFACT_GOLDEN_SHA256_V1 } from './fixtures/benchmark-artifact-golden.v1.js';

describe('benchmark runner integration', () => {
  it('runs deterministic scenarios with LiteSVM fixture context', async () => {
    const ctx = createRuntimeTestContext();
    await initializeProtocol(ctx);

    const manifest: BenchmarkManifest = {
      schemaVersion: BENCHMARK_MANIFEST_SCHEMA_VERSION,
      corpusVersion: 'v-lite',
      baselineScenarioId: 'litesvm_protocol_smoke',
      scenarios: [
        {
          id: 'litesvm_protocol_smoke',
          title: 'LiteSVM protocol initialized smoke benchmark',
          taskClass: 'protocol',
          riskTier: 'medium',
          expectedConstraints: ['litesvm_fixture'],
          seeds: [1, 2],
          verifierGated: true,
          rewardLamports: '1000000',
          costUnits: 1.0,
        },
      ],
    };

    const nowRef = { value: 1_700_000_000_000 };
    const artifact = await new BenchmarkRunner({
      now: () => nowRef.value++,
      runId: 'litesvm-run',
    }).run(manifest, {
      scenarioRunners: {
        litesvm_protocol_smoke: async ({ scenario, seed }) => {
          const slot = Number(ctx.svm.getClock().slot);
          let ts = 1000;
          const recorder = new TrajectoryRecorder({
            traceId: `${scenario.id}:${seed}:${slot}`,
            seed,
            now: () => ts++,
          });

          const taskPda = `task-${slot}-${seed}`;
          recorder.record({ type: 'discovered', taskPda });
          recorder.record({ type: 'claimed', taskPda, payload: { claimTx: `claim-${seed}` } });
          recorder.record({ type: 'executed', taskPda, payload: { outputLength: 1 } });
          recorder.record({
            type: 'completed',
            taskPda,
            payload: {
              completionTx: `complete-${seed}`,
              durationMs: 20 + seed,
            },
          });

          return {
            trace: recorder.createTrace(),
          };
        },
      },
    });

    expect(artifact.scenarios).toHaveLength(1);
    expect(artifact.scenarios[0]!.runs).toHaveLength(2);
    expect(artifact.aggregate.scorecard.aggregate.passRate).toBe(1);
  });

  it('matches golden artifact hash for benchmark corpus v1', async () => {
    const manifestPath = fileURLToPath(new URL('../benchmarks/v1/manifest.json', import.meta.url));
    const nowRef = { value: 1_700_000_100_000 };

    const artifact = await new BenchmarkRunner({
      now: () => nowRef.value++,
      runId: 'golden-v1',
    }).runFromFile(manifestPath);

    const serialized = serializeBenchmarkArtifact(artifact);
    const hash = createHash('sha256').update(serialized).digest('hex');
    expect(hash).toBe(BENCHMARK_ARTIFACT_GOLDEN_SHA256_V1);
  });
});
