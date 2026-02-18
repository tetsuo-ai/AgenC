import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { TaskExecutor } from './types.js';
import { AutonomousAgent } from './agent.js';
import { PolicyEngine } from '../policy/engine.js';
import { PolicyViolationError } from '../policy/types.js';
import { createTask } from './test-utils.js';

function createAgent(
  executor: TaskExecutor,
  policyEngine: PolicyEngine,
): AutonomousAgent {
  return new AutonomousAgent({
    connection: {} as any,
    wallet: Keypair.generate(),
    capabilities: 1n,
    executor,
    policyEngine,
  });
}

describe('AutonomousAgent policy integration', () => {
  it('pause_discovery mode blocks polling without errors', async () => {
    const policyEngine = new PolicyEngine({ policy: { enabled: true } });
    policyEngine.setMode('pause_discovery', 'test');
    const executor = {
      execute: vi.fn(async () => [1n]),
    };

    const agent = createAgent(executor, policyEngine);
    const scanner = {
      scan: vi.fn(async () => [createTask()]),
      isTaskAvailable: vi.fn(async () => true),
      subscribeToNewTasks: vi.fn(),
    };

    const agentAny = agent as any;
    agentAny.scanner = scanner;
    agentAny.scanLoopRunning = true;

    await agentAny.pollAndProcess();
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('halt_submissions mode blocks completion submission', async () => {
    const policyEngine = new PolicyEngine({ policy: { enabled: true } });
    policyEngine.setMode('halt_submissions', 'incident');
    const executor = {
      execute: vi.fn(async () => [1n, 2n]),
    };

    const agent = createAgent(executor, policyEngine);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => 'complete-tx');

    const task = createTask();
    await expect(
      agentAny.executeSequential(task, {
        task,
        claimedAt: Date.now(),
        claimTx: 'claim-tx',
        retryCount: 0,
      }, task.pda.toBase58()),
    ).rejects.toBeInstanceOf(PolicyViolationError);

    expect(agentAny.completeTaskWithRetry).not.toHaveBeenCalled();
  });

  it('disabled policy preserves legacy execution behavior', async () => {
    const policyEngine = new PolicyEngine({ policy: { enabled: false } });
    const executor = {
      execute: vi.fn(async () => [9n]),
    };

    const agent = createAgent(executor, policyEngine);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => 'complete-tx');

    const task = createTask();
    const result = await agentAny.executeSequential(task, {
      task,
      claimedAt: Date.now(),
      claimTx: 'claim-tx',
      retryCount: 0,
    }, task.pda.toBase58());

    expect(result.success).toBe(true);
    expect(result.completionTx).toBe('complete-tx');
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledTimes(1);
  });
});
