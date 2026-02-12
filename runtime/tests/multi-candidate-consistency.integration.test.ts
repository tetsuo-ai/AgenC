import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { InMemoryBackend } from '../src/memory/in-memory/backend.js';
import { AutonomousAgent } from '../src/autonomous/agent.js';
import { TaskStatus, type Task, type VerifierVerdictPayload } from '../src/autonomous/types.js';

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

describe('multi-candidate consistency integration', () => {
  it('applies policy-bounded candidate generation with disagreement provenance links', async () => {
    const memory = new InMemoryBackend();
    const executor = {
      execute: vi.fn()
        .mockResolvedValueOnce([101n])
        .mockResolvedValueOnce([202n])
        .mockResolvedValueOnce([303n]),
    };
    const verify = vi.fn(async (): Promise<VerifierVerdictPayload> => ({
      verdict: 'pass',
      confidence: 0.96,
      reasons: [{ code: 'ok', message: 'approved' }],
    }));

    const agent = new AutonomousAgent({
      connection: {} as any,
      wallet: Keypair.generate(),
      capabilities: 1n,
      executor,
      memory,
      verifier: {
        verifier: { verify },
        maxVerificationRetries: 0,
      },
      multiCandidate: {
        enabled: true,
        seed: 29,
        maxCandidates: 3,
        policyBudget: {
          maxCandidates: 2,
          maxExecutionCostLamports: 200n,
          maxTokenBudget: 100,
        },
        escalation: {
          maxPairwiseDisagreements: 5,
        },
      },
    });

    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => 'complete-tx');

    const task = makeTask();
    const result = await agentAny.executeSequential(
      task,
      {
        task,
        claimedAt: Date.now(),
        claimTx: 'claim-tx',
        retryCount: 0,
      },
      task.pda.toBase58(),
    );

    expect(result.success).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledTimes(1);

    const edgeKeys = await memory.listKeys('graph:edge:');
    expect(edgeKeys).toHaveLength(1);

    const lifecycle = await memory.getThread(`lifecycle:${task.pda.toBase58()}`);
    const executed = lifecycle.find((entry) => entry.content.includes('\"event\":\"executed\"'));
    expect(executed?.content).toContain('\"multiCandidate\"');
    expect(executed?.content).toContain('\"provenanceLinkIds\"');
  });
});
