import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TaskStatus, type Task, type VerifierVerdictPayload } from '../src/autonomous/types.js';
import { VerifierExecutor, VerifierLaneEscalationError } from '../src/autonomous/verifier.js';

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

describe('verifier adaptive escalation integration', () => {
  it('escalates deterministically on disagreement threshold', async () => {
    const verify = vi.fn(async (): Promise<VerifierVerdictPayload> => ({
      verdict: 'fail',
      confidence: 0.4,
      reasons: [{ code: 'first_fail', message: 'disagree with executor' }],
    }));

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 2,
        policy: {
          enabled: true,
          adaptiveRisk: {
            enabled: true,
            minRiskScoreToVerify: 0,
            routeByRisk: {
              low: 'retry_execute',
            },
            maxDisagreementsByRisk: {
              low: 1,
            },
          },
        },
      },
      executeTask: async () => [1n],
    });

    const lowRiskTask = makeTask({ reward: 10n, taskType: 0, maxWorkers: 4, currentClaims: 0 });

    await expect(lane.execute(lowRiskTask)).rejects.toMatchObject({
      name: 'VerifierLaneEscalationError',
      metadata: expect.objectContaining({ reason: 'verifier_disagreement' }),
    });
  });

  it('escalates on timeout path under adaptive scheduling', async () => {
    const verify = vi.fn(async () => await new Promise<VerifierVerdictPayload>(() => {}));

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationDurationMs: 20,
        policy: {
          enabled: true,
          adaptiveRisk: {
            enabled: true,
            minRiskScoreToVerify: 0,
            maxVerificationDurationMsByRisk: {
              low: 20,
              medium: 20,
              high: 20,
            },
          },
        },
      },
      executeTask: async () => [1n],
    });

    const task = makeTask({ reward: 100n, taskType: 1 });

    try {
      await lane.execute(task);
      throw new Error('expected escalation');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifierLaneEscalationError);
      const typed = error as VerifierLaneEscalationError;
      expect(typed.metadata.reason).toBe('verifier_timeout');
    }
  });
});
