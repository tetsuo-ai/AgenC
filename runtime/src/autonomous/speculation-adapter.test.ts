import { describe, it, expect, vi } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  autonomousTaskToOnChainTask,
  onChainTaskToAutonomousTask,
  packBigintsToProofHash,
  executorToTaskHandler,
} from './speculation-adapter.js';
import { TaskStatus, type Task, type TaskExecutor } from './types.js';
import { OnChainTaskStatus, type OnChainTask, type TaskExecutionContext } from '../task/types.js';
import { TaskType } from '../events/types.js';
import { silentLogger } from '../utils/logger.js';
import { createTask as createBaseTask } from './test-utils.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return createBaseTask({
    pda: PublicKey.unique(),
    creator: PublicKey.unique(),
    requiredCapabilities: 3n,
    reward: 1_000_000n,
    description: new Uint8Array(64).fill(2),
    deadline: 1700000000,
    maxWorkers: 5,
    currentClaims: 2,
    status: TaskStatus.InProgress,
    ...overrides,
  });
}

function makeOnChainTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(3),
    creator: PublicKey.unique(),
    requiredCapabilities: 7n,
    description: new Uint8Array(64).fill(4),
    constraintHash: new Uint8Array(32),
    rewardAmount: 2_000_000n,
    maxWorkers: 3,
    currentWorkers: 1,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700100000,
    completedAt: 0,
    escrow: PublicKey.unique(),
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

// ============================================================================
// autonomousTaskToOnChainTask
// ============================================================================

describe('autonomousTaskToOnChainTask', () => {
  it('maps core fields correctly', () => {
    const task = makeTask();
    const result = autonomousTaskToOnChainTask(task);

    expect(result.taskId).toBe(task.taskId);
    expect(result.creator).toBe(task.creator);
    expect(result.requiredCapabilities).toBe(task.requiredCapabilities);
    expect(result.description).toBe(task.description);
    expect(result.constraintHash).toBe(task.constraintHash);
    expect(result.rewardAmount).toBe(task.reward);
    expect(result.maxWorkers).toBe(task.maxWorkers);
    expect(result.currentWorkers).toBe(task.currentClaims);
    expect(result.deadline).toBe(task.deadline);
  });

  it('maps status correctly', () => {
    expect(autonomousTaskToOnChainTask(makeTask({ status: TaskStatus.Open })).status)
      .toBe(OnChainTaskStatus.Open);
    expect(autonomousTaskToOnChainTask(makeTask({ status: TaskStatus.InProgress })).status)
      .toBe(OnChainTaskStatus.InProgress);
    expect(autonomousTaskToOnChainTask(makeTask({ status: TaskStatus.Completed })).status)
      .toBe(OnChainTaskStatus.Completed);
    expect(autonomousTaskToOnChainTask(makeTask({ status: TaskStatus.Cancelled })).status)
      .toBe(OnChainTaskStatus.Cancelled);
    expect(autonomousTaskToOnChainTask(makeTask({ status: TaskStatus.Disputed })).status)
      .toBe(OnChainTaskStatus.Disputed);
  });

  it('fills default values for fields not in autonomous Task', () => {
    const result = autonomousTaskToOnChainTask(makeTask());

    expect(result.taskType).toBe(TaskType.Exclusive);
    expect(result.escrow.equals(SystemProgram.programId)).toBe(true);
    expect(result.result).toEqual(new Uint8Array(64));
    expect(result.completions).toBe(0);
    expect(result.requiredCompletions).toBe(1);
    expect(result.bump).toBe(0);
    expect(result.createdAt).toBe(0);
    expect(result.completedAt).toBe(0);
  });
});

// ============================================================================
// onChainTaskToAutonomousTask
// ============================================================================

describe('onChainTaskToAutonomousTask', () => {
  it('maps core fields correctly', () => {
    const onChain = makeOnChainTask();
    const pda = PublicKey.unique();
    const result = onChainTaskToAutonomousTask(onChain, pda);

    expect(result.pda).toBe(pda);
    expect(result.taskId).toBe(onChain.taskId);
    expect(result.creator).toBe(onChain.creator);
    expect(result.requiredCapabilities).toBe(onChain.requiredCapabilities);
    expect(result.reward).toBe(onChain.rewardAmount);
    expect(result.description).toBe(onChain.description);
    expect(result.constraintHash).toBe(onChain.constraintHash);
    expect(result.deadline).toBe(onChain.deadline);
    expect(result.maxWorkers).toBe(onChain.maxWorkers);
    expect(result.currentClaims).toBe(onChain.currentWorkers);
  });

  it('maps OnChainTaskStatus to TaskStatus', () => {
    const pda = PublicKey.unique();

    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.Open }), pda).status)
      .toBe(TaskStatus.Open);
    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.InProgress }), pda).status)
      .toBe(TaskStatus.InProgress);
    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.Completed }), pda).status)
      .toBe(TaskStatus.Completed);
    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.Cancelled }), pda).status)
      .toBe(TaskStatus.Cancelled);
    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.Disputed }), pda).status)
      .toBe(TaskStatus.Disputed);
    // PendingValidation maps to InProgress
    expect(onChainTaskToAutonomousTask(makeOnChainTask({ status: OnChainTaskStatus.PendingValidation }), pda).status)
      .toBe(TaskStatus.InProgress);
  });
});

// ============================================================================
// Round-trip conversion
// ============================================================================

describe('round-trip conversion', () => {
  it('preserves core fields through Task → OnChainTask → Task', () => {
    const original = makeTask();
    const onChain = autonomousTaskToOnChainTask(original);
    const roundTripped = onChainTaskToAutonomousTask(onChain, original.pda);

    expect(roundTripped.pda).toBe(original.pda);
    expect(roundTripped.taskId).toBe(original.taskId);
    expect(roundTripped.creator).toBe(original.creator);
    expect(roundTripped.requiredCapabilities).toBe(original.requiredCapabilities);
    expect(roundTripped.reward).toBe(original.reward);
    expect(roundTripped.description).toBe(original.description);
    expect(roundTripped.constraintHash).toBe(original.constraintHash);
    expect(roundTripped.deadline).toBe(original.deadline);
    expect(roundTripped.maxWorkers).toBe(original.maxWorkers);
    expect(roundTripped.currentClaims).toBe(original.currentClaims);
    expect(roundTripped.status).toBe(original.status);
  });
});

// ============================================================================
// packBigintsToProofHash
// ============================================================================

describe('packBigintsToProofHash', () => {
  it('encodes bigints in LE format', () => {
    const result = packBigintsToProofHash([1n, 0n, 0n, 0n]);

    // 1n in 8-byte LE: [1, 0, 0, 0, 0, 0, 0, 0]
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(0);
    expect(result[7]).toBe(0);
    expect(result.length).toBe(32);
  });

  it('encodes a multi-byte value correctly', () => {
    // 0x0102 = 258 → LE: [2, 1, 0, 0, 0, 0, 0, 0]
    const result = packBigintsToProofHash([258n, 0n, 0n, 0n]);

    expect(result[0]).toBe(2);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(0);
  });

  it('handles all 4 elements', () => {
    const result = packBigintsToProofHash([1n, 2n, 3n, 4n]);

    // Element 0 at offset 0
    expect(result[0]).toBe(1);
    // Element 1 at offset 8
    expect(result[8]).toBe(2);
    // Element 2 at offset 16
    expect(result[16]).toBe(3);
    // Element 3 at offset 24
    expect(result[24]).toBe(4);
  });

  it('returns 32-byte array for empty input', () => {
    const result = packBigintsToProofHash([]);
    expect(result.length).toBe(32);
    expect(result.every((b) => b === 0)).toBe(true);
  });

  it('handles more than 4 elements by truncating', () => {
    const result = packBigintsToProofHash([1n, 2n, 3n, 4n, 5n, 6n]);
    // Only first 4 should be encoded
    expect(result[0]).toBe(1);
    expect(result[8]).toBe(2);
    expect(result[16]).toBe(3);
    expect(result[24]).toBe(4);
    expect(result.length).toBe(32);
  });

  it('encodes large bigints correctly (8-byte LE)', () => {
    // Max u64: 2^64 - 1 = 18446744073709551615
    const maxU64 = (1n << 64n) - 1n;
    const result = packBigintsToProofHash([maxU64, 0n, 0n, 0n]);

    // All 8 bytes should be 0xFF
    for (let i = 0; i < 8; i++) {
      expect(result[i]).toBe(0xff);
    }
  });
});

// ============================================================================
// executorToTaskHandler
// ============================================================================

describe('executorToTaskHandler', () => {
  it('converts executor output to TaskExecutionResult', async () => {
    const executor: TaskExecutor = {
      execute: vi.fn().mockResolvedValue([10n, 20n, 30n, 40n]),
    };

    const handler = executorToTaskHandler(executor);

    const context: TaskExecutionContext = {
      task: makeOnChainTask(),
      taskPda: PublicKey.unique(),
      claimPda: PublicKey.unique(),
      agentId: new Uint8Array(32),
      agentPda: PublicKey.unique(),
      logger: silentLogger,
      signal: new AbortController().signal,
    };

    const result = await handler(context);

    expect(result.proofHash).toBeInstanceOf(Uint8Array);
    expect(result.proofHash.length).toBe(32);
    // Verify LE encoding of first element (10n)
    expect(result.proofHash[0]).toBe(10);
    expect(result.proofHash[8]).toBe(20);
    expect(result.proofHash[16]).toBe(30);
    expect(result.proofHash[24]).toBe(40);
  });

  it('passes converted autonomous Task to executor', async () => {
    const executeFn = vi.fn().mockResolvedValue([1n, 2n, 3n, 4n]);
    const executor: TaskExecutor = { execute: executeFn };

    const handler = executorToTaskHandler(executor);

    const onChainTask = makeOnChainTask({ rewardAmount: 5_000_000n });
    const taskPda = PublicKey.unique();
    const context: TaskExecutionContext = {
      task: onChainTask,
      taskPda,
      claimPda: PublicKey.unique(),
      agentId: new Uint8Array(32),
      agentPda: PublicKey.unique(),
      logger: silentLogger,
      signal: new AbortController().signal,
    };

    await handler(context);

    // Verify the executor received an autonomous Task with correct field mapping
    const receivedTask = executeFn.mock.calls[0][0];
    expect(receivedTask.pda).toBe(taskPda);
    expect(receivedTask.reward).toBe(5_000_000n);
    expect(receivedTask.taskId).toBe(onChainTask.taskId);
  });

  it('propagates executor errors', async () => {
    const executor: TaskExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('execution failed')),
    };

    const handler = executorToTaskHandler(executor);

    const context: TaskExecutionContext = {
      task: makeOnChainTask(),
      taskPda: PublicKey.unique(),
      claimPda: PublicKey.unique(),
      agentId: new Uint8Array(32),
      agentPda: PublicKey.unique(),
      logger: silentLogger,
      signal: new AbortController().signal,
    };

    await expect(handler(context)).rejects.toThrow('execution failed');
  });
});
