import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { UnifiedTelemetryCollector } from '../src/telemetry/collector.js';
import { TaskStatus, type Task, type VerifierVerdictPayload } from '../src/autonomous/types.js';
import { VerifierExecutor } from '../src/autonomous/verifier.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    pda: Keypair.generate().publicKey,
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 1n,
    reward: 100n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
    rewardMint: null,
    ...overrides,
  };
}

describe('adaptive verification budget integration', () => {
  it('applies risk-based verifier budgets and emits adaptive telemetry', async () => {
    const metrics = new UnifiedTelemetryCollector();

    const verify = vi.fn()
      .mockResolvedValueOnce({
        verdict: 'fail',
        confidence: 0.3,
        reasons: [{ code: 'fail_once', message: 'retry needed' }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce({
        verdict: 'pass',
        confidence: 0.96,
        reasons: [{ code: 'ok', message: 'approved' }],
      } satisfies VerifierVerdictPayload);

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 1,
        maxVerificationDurationMs: 30_000,
        minConfidence: 0.75,
        policy: {
          enabled: true,
          adaptiveRisk: {
            enabled: true,
            minRiskScoreToVerify: 0.35,
            mediumRiskThreshold: 0.3,
            highRiskThreshold: 0.5,
            maxVerificationRetriesByRisk: {
              low: 0,
              medium: 1,
              high: 2,
            },
            maxVerificationDurationMsByRisk: {
              low: 10_000,
              medium: 30_000,
              high: 60_000,
            },
            minConfidenceByRisk: {
              low: 0.6,
              medium: 0.75,
              high: 0.9,
            },
            hardMaxVerificationRetries: 2,
            hardMaxVerificationDurationMs: 60_000,
            hardMaxVerificationCostLamports: 10_000_000_000n,
          },
        },
      },
      executeTask: async () => [1n, 2n],
      metrics,
    });

    // Low-risk path: adaptive threshold disables verifier lane.
    const lowRiskTask = makeTask({ reward: 10n, taskType: 0, maxWorkers: 4, currentClaims: 0 });
    const lowResult = await lane.execute(lowRiskTask);
    expect(lowResult.attempts).toBe(0);

    // High-risk path: verifier lane enabled with retry budget.
    const highRiskTask = makeTask({
      reward: 5_000_000_000n,
      taskType: 2,
      deadline: Math.floor(Date.now() / 1000) + 30,
      maxWorkers: 1,
      currentClaims: 1,
    });

    const highResult = await lane.execute(highRiskTask);
    expect(highResult.passed).toBe(true);
    expect(highResult.attempts).toBe(2);
    expect(highResult.adaptiveRisk?.tier).not.toBe('low');

    const snapshot = metrics.getSnapshot();
    const histogramKeys = Object.keys(snapshot.histograms);

    expect(
      histogramKeys.some((key) => key.startsWith('agenc.verifier.adaptive.risk_score')),
    ).toBe(true);
    expect(
      histogramKeys.some((key) => key.startsWith('agenc.verifier.adaptive.max_retries')),
    ).toBe(true);
    expect(
      histogramKeys.some((key) => key.startsWith('agenc.verifier.adaptive.max_duration_ms')),
    ).toBe(true);
  });
});
