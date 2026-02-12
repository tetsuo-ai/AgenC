import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TaskStatus, type Task, type VerifierLaneConfig } from './types.js';
import { allocateVerificationBudget } from './verification-budget.js';
import { scoreTaskRisk } from './risk-scoring.js';

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

function makeVerifierConfig(overrides: Partial<VerifierLaneConfig> = {}): VerifierLaneConfig {
  return {
    verifier: {
      verify: async () => ({
        verdict: 'pass',
        confidence: 0.9,
        reasons: [{ code: 'ok', message: 'ok' }],
      }),
    },
    minConfidence: 0.75,
    maxVerificationRetries: 2,
    maxVerificationDurationMs: 30_000,
    ...overrides,
  };
}

describe('allocateVerificationBudget', () => {
  it('preserves static verifier behavior when adaptive mode is disabled', () => {
    const task = makeTask({ reward: 500n });
    const config = makeVerifierConfig({
      policy: {
        enabled: true,
        adaptiveRisk: { enabled: false },
      },
    });

    const risk = scoreTaskRisk(task, {});
    const budget = allocateVerificationBudget(task, risk, config);

    expect(budget.adaptive).toBe(false);
    expect(budget.maxVerificationRetries).toBe(2);
    expect(budget.maxVerificationDurationMs).toBe(30_000);
    expect(budget.minConfidence).toBe(0.75);
  });

  it('adapts retries/duration/confidence by risk tier and enforces hard ceilings', () => {
    const nowMs = 1_700_000_000_000;
    const highRiskTask = makeTask({
      reward: 2_000n,
      deadline: Math.floor(nowMs / 1000) + 30,
      maxWorkers: 2,
      currentClaims: 2,
      taskType: 2,
    });

    const config = makeVerifierConfig({
      policy: {
        enabled: true,
        adaptiveRisk: {
          enabled: true,
          maxVerificationRetriesByRisk: { high: 5 },
          maxVerificationDurationMsByRisk: { high: 90_000 },
          minConfidenceByRisk: { high: 0.95 },
          hardMaxVerificationRetries: 3,
          hardMaxVerificationDurationMs: 45_000,
          hardMaxVerificationCostLamports: 5_000n,
        },
      },
    });

    const risk = scoreTaskRisk(highRiskTask, {
      nowMs,
      verifierDisagreementRate: 0.8,
      rollbackRate: 0.5,
    }, {
      enabled: true,
      mediumRiskThreshold: 0.3,
      highRiskThreshold: 0.6,
    });

    const budget = allocateVerificationBudget(highRiskTask, risk, config);

    expect(budget.adaptive).toBe(true);
    expect(budget.riskTier).toBe('high');
    expect(budget.maxVerificationRetries).toBe(3); // hard capped
    expect(budget.maxVerificationDurationMs).toBe(45_000); // hard capped
    expect(budget.minConfidence).toBe(0.95);
    expect(budget.maxAllowedSpendLamports).toBe(5_000n);
  });

  it('disables verifier lane when risk score is below configured threshold', () => {
    const task = makeTask({ reward: 100n, taskType: 0 });
    const config = makeVerifierConfig({
      policy: {
        enabled: true,
        adaptiveRisk: {
          enabled: true,
          minRiskScoreToVerify: 0.8,
        },
      },
    });

    const lowRisk = scoreTaskRisk(task, {
      verifierDisagreementRate: 0,
      rollbackRate: 0,
    });

    const budget = allocateVerificationBudget(task, lowRisk, config);

    expect(lowRisk.score).toBeLessThan(0.8);
    expect(budget.enabled).toBe(false);
    expect(budget.metadata.reason).toBe('below_risk_threshold');
  });
});
