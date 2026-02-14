import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TaskStatus, type Task, type VerifierLaneConfig } from './types.js';
import {
  allocateVerificationBudget,
  BudgetAuditTrail,
  BudgetAuditEntry,
  BudgetGuardrail,
  BudgetAdjustmentInput,
  calculateNextBudget,
  DEFAULT_BUDGET_GUARDRAIL,
  validateBudgetGuardrail,
} from './verification-budget.js';
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

  it('clamps negative max allowed spend to zero', () => {
    const task = makeTask({ reward: 100n });
    const config = makeVerifierConfig({
      policy: {
        enabled: true,
        adaptiveRisk: {
          enabled: true,
          hardMaxVerificationCostLamports: -1n,
        },
      },
    });

    const risk = scoreTaskRisk(task, {
      verifierDisagreementRate: 0.95,
      rollbackRate: 0.95,
    });

    const budget = allocateVerificationBudget(task, risk, config);
    expect(budget.maxAllowedSpendLamports).toBe(0n);
  });
});

describe('calculateNextBudget', () => {
  const guardrail: BudgetGuardrail = {
    ...DEFAULT_BUDGET_GUARDRAIL,
    cooldownMs: 1_000,
  };

  const baseInput = (overrides: Partial<BudgetAdjustmentInput>): BudgetAdjustmentInput => ({
    currentBudgetLamports: 100_000n,
    success: true,
    history: [],
    guardrail,
    lastAdjustmentTimestampMs: 0,
    nowMs: 5_000,
    ...overrides,
  });

  it('returns identical results for identical inputs', () => {
    const input = baseInput({
      history: [true, true],
      nowMs: 2_000,
      lastAdjustmentTimestampMs: 0,
    });
    const first = calculateNextBudget(input);
    const second = calculateNextBudget(input);

    expect(second.nextBudgetLamports).toBe(first.nextBudgetLamports);
    expect(second.adjustmentFraction).toBe(first.adjustmentFraction);
    expect(second.reason).toBe(first.reason);
  });

  it('increases budget on success streak', () => {
    const result = calculateNextBudget(baseInput({
      success: true,
      history: [true, true, true, true],
      nowMs: 6_000,
      lastAdjustmentTimestampMs: 0,
    }));

    expect(result.adjusted).toBe(true);
    expect(result.nextBudgetLamports).toBeGreaterThan(100_000n);
    expect(result.reason).toBe('increased_on_success');
  });

  it('decreases budget on failure streak', () => {
    const result = calculateNextBudget(baseInput({
      success: false,
      history: [false, false],
      nowMs: 6_000,
      lastAdjustmentTimestampMs: 0,
    }));

    expect(result.adjusted).toBe(true);
    expect(result.nextBudgetLamports).toBeLessThan(100_000n);
    expect(result.reason).toBe('decreased_on_failure');
  });

  it('respects cooldown and avoids changing budget', () => {
    const result = calculateNextBudget(baseInput({
      success: true,
      history: [true],
      nowMs: 4_500,
      lastAdjustmentTimestampMs: 4_000,
    }));

    expect(result.adjusted).toBe(false);
    expect(result.reason).toBe('cooldown_active');
    expect(result.nextBudgetLamports).toBe(100_000n);
  });

  it('clamps to minimum budget on extreme failure', () => {
    const result = calculateNextBudget({
      currentBudgetLamports: 1_500n,
      success: false,
      history: [false, false, false, false],
      guardrail: {
        ...guardrail,
        minBudgetLamports: 1_300n,
      },
      lastAdjustmentTimestampMs: 0,
      nowMs: 6_000,
    });
    expect(result.nextBudgetLamports).toBe(1_300n);
  });

  it('clamps to maximum budget on extreme success', () => {
    const result = calculateNextBudget({
      currentBudgetLamports: 950_000n,
      success: true,
      history: [true, true, true, true, true],
      guardrail: {
        ...guardrail,
        maxBudgetLamports: 1_000_000n,
      },
      lastAdjustmentTimestampMs: 0,
      nowMs: 6_000,
    });
    expect(result.nextBudgetLamports).toBe(1_000_000n);
  });

  it('never produces a negative budget', () => {
    const result = calculateNextBudget({
      currentBudgetLamports: 0n,
      success: false,
      history: [false],
      guardrail: {
        ...guardrail,
        minBudgetLamports: 0n,
      },
      lastAdjustmentTimestampMs: 0,
      nowMs: 6_000,
    });
    expect(result.nextBudgetLamports).toBeGreaterThanOrEqual(0n);
  });
});

describe('BudgetGuardrail validation', () => {
  it('rejects negative minBudgetLamports', () => {
    expect(() => validateBudgetGuardrail({
      minBudgetLamports: -1n,
      maxBudgetLamports: 100n,
      adjustmentRate: 0.2,
      cooldownMs: 1_000,
    })).toThrow('minBudgetLamports must be non-negative');
  });

  it('rejects maxBudgetLamports < minBudgetLamports', () => {
    expect(() => validateBudgetGuardrail({
      minBudgetLamports: 200n,
      maxBudgetLamports: 100n,
      adjustmentRate: 0.2,
      cooldownMs: 1_000,
    })).toThrow('maxBudgetLamports must be >= minBudgetLamports');
  });

  it('rejects adjustmentRate > 1', () => {
    expect(() => validateBudgetGuardrail({
      minBudgetLamports: 0n,
      maxBudgetLamports: 100n,
      adjustmentRate: 1.5,
      cooldownMs: 1_000,
    })).toThrow('adjustmentRate must be in [0, 1]');
  });

  it('rejects negative cooldownMs', () => {
    expect(() => validateBudgetGuardrail({
      minBudgetLamports: 0n,
      maxBudgetLamports: 100n,
      adjustmentRate: 0.2,
      cooldownMs: -1,
    })).toThrow('cooldownMs must be non-negative');
  });
});

describe('BudgetAuditTrail', () => {
  it('records entries with incrementing sequence values', () => {
    const trail = new BudgetAuditTrail(5);
    trail.record({
      timestampMs: 1000,
      previousBudgetLamports: 100n,
      nextBudgetLamports: 120n,
      adjustmentFraction: 0.2,
      reason: 'increased_on_success',
      riskTier: 'low',
      success: true,
      consecutiveStreak: 1,
    });
    const entries = trail.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(0);
  });

  it('evicts the oldest entries when capacity is exceeded', () => {
    const trail = new BudgetAuditTrail(2);
    for (let i = 0; i < 4; i += 1) {
      trail.record({
        timestampMs: i * 1_000,
        previousBudgetLamports: BigInt(i * 100),
        nextBudgetLamports: BigInt((i + 1) * 100),
        adjustmentFraction: 0.1,
        reason: 'decreased_on_failure',
        riskTier: 'high',
        success: false,
        consecutiveStreak: 2,
      });
    }

    const entries = trail.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(2);
    expect(entries[1].seq).toBe(3);
  });

  it('supports bounded slice access', () => {
    const trail = new BudgetAuditTrail(10);
    for (let i = 0; i < 3; i += 1) {
      trail.record({
        timestampMs: i * 100,
        previousBudgetLamports: BigInt(i * 100),
        nextBudgetLamports: BigInt((i + 1) * 100),
        adjustmentFraction: 0.1,
        riskTier: 'low',
        reason: 'increased_on_success',
        success: true,
        consecutiveStreak: i + 1,
      });
    }

    const last: BudgetAuditEntry[] = [...trail.getLastN(2)] as BudgetAuditEntry[];
    expect(last).toHaveLength(2);
    expect(last[0].seq).toBe(1);
  });
});

describe('deterministic budget simulations', () => {
  it('keeps budget within configured bounds over alternating outcomes', () => {
    const guardrail: BudgetGuardrail = {
      minBudgetLamports: 1_000n,
      maxBudgetLamports: 1_000_000n,
      adjustmentRate: 0.1,
      cooldownMs: 0,
    };

    let budget = 100_000n;
    let lastAdjustment = 0;
    const history: boolean[] = [];

    for (let step = 0; step < 100; step++) {
      const success = step % 2 === 0;
      history.push(success);
      const result = calculateNextBudget({
        currentBudgetLamports: budget,
        success,
        history,
        guardrail,
        lastAdjustmentTimestampMs: lastAdjustment,
        nowMs: step * 1_000,
      });

      if (result.adjusted) {
        lastAdjustment = result.adjustedAtMs;
      }
      budget = result.nextBudgetLamports;
    }

    expect(budget).toBeGreaterThanOrEqual(guardrail.minBudgetLamports);
    expect(budget).toBeLessThanOrEqual(guardrail.maxBudgetLamports);
  });

  it('produces identical traces for identical simulation inputs', () => {
    const guardrail: BudgetGuardrail = {
      minBudgetLamports: 1_000n,
      maxBudgetLamports: 1_000_000n,
      adjustmentRate: 0.15,
      cooldownMs: 500,
    };
    const outcomes = [true, true, false, true, false, false, true, true, true, false];

    const run = (): bigint[] => {
      let budget = 50_000n;
      let lastAdjustment = 0;
      const history: boolean[] = [];
      const trace: bigint[] = [];

      for (let i = 0; i < outcomes.length; i++) {
        const success = outcomes[i]!;
        history.push(success);
        const result = calculateNextBudget({
          currentBudgetLamports: budget,
          success,
          history,
          guardrail,
          lastAdjustmentTimestampMs: lastAdjustment,
          nowMs: i * 1000,
        });

        if (result.adjusted) {
          lastAdjustment = result.adjustedAtMs;
        }
        budget = result.nextBudgetLamports;
        trace.push(budget);
      }

      return trace;
    };

    const first = run();
    const second = run();
    expect(first).toEqual(second);
  });
});
