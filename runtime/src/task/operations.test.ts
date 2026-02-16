import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import { TaskOperations, TASK_STATUS_OFFSET, type TaskOpsConfig } from './operations.js';
import { OnChainTaskStatus, type OnChainTask } from './types.js';
import { TaskType } from '../events/types.js';
import { TaskNotClaimableError, TaskSubmissionError, ValidationError, AnchorErrorCodes } from '../types/errors.js';
import { silentLogger } from '../utils/logger.js';
import { PROGRAM_ID } from '@agenc/sdk';

/**
 * Creates a 32-byte agent ID from a seed.
 */
function createAgentId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

/**
 * Creates a mock raw task as returned by Anchor fetch.
 */
function createMockRawTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: new Array(32).fill(0).map((_: number, i: number) => i),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: { toString: () => '3' },
    description: new Array(64).fill(0),
    constraintHash: new Array(32).fill(0),
    rewardAmount: { toString: () => '1000000' },
    maxWorkers: 5,
    currentWorkers: 0,
    status: { open: {} },
    taskType: { exclusive: {} },
    createdAt: { toNumber: () => 1700000000 },
    deadline: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    escrow: Keypair.generate().publicKey,
    result: new Array(64).fill(0),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Creates a mock raw task claim as returned by Anchor fetch.
 */
function createMockRawClaim(agentPda: PublicKey, taskPda: PublicKey, overrides: Record<string, unknown> = {}) {
  return {
    task: taskPda,
    worker: agentPda,
    claimedAt: { toNumber: () => 1700000000 },
    expiresAt: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    proofHash: new Array(32).fill(0),
    resultData: new Array(64).fill(0),
    isCompleted: false,
    isValidated: false,
    rewardPaid: { toString: () => '0' },
    bump: 254,
    ...overrides,
  };
}

/**
 * Creates a parsed OnChainTask for tests.
 */
function createParsedTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 3n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700003600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Creates a mock Anchor program for testing.
 */
function createMockProgram() {
  const mockProvider = {
    publicKey: Keypair.generate().publicKey,
  };

  const taskFetch = vi.fn();
  const taskAll = vi.fn().mockResolvedValue([]);
  const taskClaimFetch = vi.fn();
  const taskClaimAll = vi.fn().mockResolvedValue([]);
  const protocolConfigFetch = vi.fn().mockResolvedValue({
    treasury: Keypair.generate().publicKey,
  });

  const claimTaskRpc = vi.fn().mockResolvedValue('claim-sig');
  const completeTaskRpc = vi.fn().mockResolvedValue('complete-sig');
  const completeTaskPrivateRpc = vi.fn().mockResolvedValue('private-sig');

  const claimTaskBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: claimTaskRpc,
  };

  const completeTaskBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: completeTaskRpc,
  };

  const completeTaskPrivateBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: completeTaskPrivateRpc,
  };

  const program = {
    programId: PROGRAM_ID,
    provider: mockProvider,
    account: {
      task: { fetch: taskFetch, all: taskAll },
      taskClaim: { fetch: taskClaimFetch, all: taskClaimAll },
      protocolConfig: { fetch: protocolConfigFetch },
    },
    methods: {
      claimTask: vi.fn().mockReturnValue(claimTaskBuilder),
      completeTask: vi.fn().mockReturnValue(completeTaskBuilder),
      completeTaskPrivate: vi.fn().mockReturnValue(completeTaskPrivateBuilder),
    },
  };

  return {
    program: program as unknown as TaskOpsConfig['program'],
    mocks: {
      taskFetch,
      taskAll,
      taskClaimFetch,
      taskClaimAll,
      protocolConfigFetch,
      claimTaskRpc,
      completeTaskRpc,
      completeTaskPrivateRpc,
      claimTaskBuilder,
      completeTaskBuilder,
      completeTaskPrivateBuilder,
    },
  };
}

describe('TaskOperations', () => {
  const agentId = createAgentId(42);
  let ops: TaskOperations;
  let mocks: ReturnType<typeof createMockProgram>['mocks'];
  let mockProgram: ReturnType<typeof createMockProgram>['program'];

  beforeEach(() => {
    const created = createMockProgram();
    mockProgram = created.program;
    mocks = created.mocks;
    ops = new TaskOperations({
      program: mockProgram,
      agentId,
      logger: silentLogger,
    });
  });

  describe('constructor', () => {
    it('initializes with program and agentId', () => {
      expect(ops).toBeInstanceOf(TaskOperations);
    });

    it('accepts optional logger', () => {
      const opsWithLogger = new TaskOperations({
        program: mockProgram,
        agentId,
        logger: silentLogger,
      });
      expect(opsWithLogger).toBeInstanceOf(TaskOperations);
    });
  });

  describe('fetchTask', () => {
    it('returns parsed OnChainTask when found', async () => {
      const rawTask = createMockRawTask();
      mocks.taskFetch.mockResolvedValue(rawTask);

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).not.toBeNull();
      expect(result!.rewardAmount).toBe(1_000_000n);
      expect(typeof result!.requiredCapabilities).toBe('bigint');
      expect(result!.status).toBe(OnChainTaskStatus.Open);
    });

    it('returns null for non-existent PDA', async () => {
      mocks.taskFetch.mockRejectedValue(new Error('Account does not exist'));

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).toBeNull();
    });

    it('returns null for could not find error', async () => {
      mocks.taskFetch.mockRejectedValue(new Error('could not find account'));

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchTask(taskPda);

      expect(result).toBeNull();
    });

    it('throws on unexpected errors', async () => {
      mocks.taskFetch.mockRejectedValue(new Error('Network error'));

      const taskPda = Keypair.generate().publicKey;
      await expect(ops.fetchTask(taskPda)).rejects.toThrow('Network error');
    });
  });

  describe('fetchAllTasks', () => {
    it('returns all tasks from chain', async () => {
      const rawTask1 = createMockRawTask({ rewardAmount: { toString: () => '1000' } });
      const rawTask2 = createMockRawTask({ rewardAmount: { toString: () => '2000' } });

      mocks.taskAll.mockResolvedValue([
        { publicKey: Keypair.generate().publicKey, account: rawTask1 },
        { publicKey: Keypair.generate().publicKey, account: rawTask2 },
      ]);

      const results = await ops.fetchAllTasks();

      expect(results.length).toBe(2);
      expect(results[0].task.rewardAmount).toBe(1_000n);
      expect(results[1].task.rewardAmount).toBe(2_000n);
      expect(results[0].taskPda).toBeInstanceOf(PublicKey);
    });

    it('returns empty array when no tasks', async () => {
      mocks.taskAll.mockResolvedValue([]);

      const results = await ops.fetchAllTasks();

      expect(results).toEqual([]);
    });
  });

  describe('fetchClaimableTasks', () => {
    it('issues two memcmp-filtered queries for Open and InProgress', async () => {
      const openTask = createMockRawTask({ status: { open: {} } });
      const inProgressTask = createMockRawTask({ status: { inProgress: {} } });

      const openPda = Keypair.generate().publicKey;
      const inProgressPda = Keypair.generate().publicKey;

      // Return different results depending on the filter argument
      mocks.taskAll.mockImplementation((filters?: unknown[]) => {
        if (!filters || !Array.isArray(filters) || filters.length === 0) {
          return Promise.resolve([]);
        }
        const filter = filters[0] as { memcmp: { offset: number; bytes: string } };
        if (filter.memcmp.bytes === utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.Open]))) {
          return Promise.resolve([{ publicKey: openPda, account: openTask }]);
        }
        if (filter.memcmp.bytes === utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.InProgress]))) {
          return Promise.resolve([{ publicKey: inProgressPda, account: inProgressTask }]);
        }
        return Promise.resolve([]);
      });

      const results = await ops.fetchClaimableTasks();

      expect(results.length).toBe(2);
      expect(results[0].task.status).toBe(OnChainTaskStatus.Open);
      expect(results[0].taskPda.equals(openPda)).toBe(true);
      expect(results[1].task.status).toBe(OnChainTaskStatus.InProgress);
      expect(results[1].taskPda.equals(inProgressPda)).toBe(true);

      // Verify two calls with correct memcmp filters
      expect(mocks.taskAll).toHaveBeenCalledTimes(2);
      expect(mocks.taskAll).toHaveBeenCalledWith([
        { memcmp: { offset: TASK_STATUS_OFFSET, bytes: utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.Open])) } },
      ]);
      expect(mocks.taskAll).toHaveBeenCalledWith([
        { memcmp: { offset: TASK_STATUS_OFFSET, bytes: utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.InProgress])) } },
      ]);
    });

    it('uses correct offset 186 for status field', () => {
      // 8 (discriminator) + 32 (task_id) + 32 (creator) + 8 (required_capabilities)
      // + 64 (description) + 32 (constraint_hash) + 8 (reward_amount)
      // + 1 (max_workers) + 1 (current_workers) = 186
      expect(TASK_STATUS_OFFSET).toBe(186);
    });

    it('returns empty array when no claimable tasks exist', async () => {
      mocks.taskAll.mockResolvedValue([]);

      const results = await ops.fetchClaimableTasks();

      expect(results).toEqual([]);
    });

    it('falls back to fetchAllTasks on memcmp filter failure', async () => {
      const openTask = createMockRawTask({ status: { open: {} } });
      const completedTask = createMockRawTask({ status: { completed: {} } });
      const openPda = Keypair.generate().publicKey;
      const completedPda = Keypair.generate().publicKey;

      let callCount = 0;
      mocks.taskAll.mockImplementation((filters?: unknown[]) => {
        callCount++;
        // First two calls (memcmp) fail
        if (callCount <= 2 && filters && Array.isArray(filters) && filters.length > 0) {
          return Promise.reject(new Error('RPC does not support memcmp filters'));
        }
        // Third call (fallback, no filters) returns all tasks
        return Promise.resolve([
          { publicKey: openPda, account: openTask },
          { publicKey: completedPda, account: completedTask },
        ]);
      });

      const results = await ops.fetchClaimableTasks();

      // Should only return the Open task (fallback filters client-side)
      expect(results.length).toBe(1);
      expect(results[0].task.status).toBe(OnChainTaskStatus.Open);
    });

    it('combines results from both filtered queries', async () => {
      const openTasks = Array.from({ length: 3 }, () =>
        createMockRawTask({ status: { open: {} } }),
      );
      const inProgressTasks = Array.from({ length: 2 }, () =>
        createMockRawTask({ status: { inProgress: {} } }),
      );

      mocks.taskAll.mockImplementation((filters?: unknown[]) => {
        if (!filters || !Array.isArray(filters) || filters.length === 0) {
          return Promise.resolve([]);
        }
        const filter = filters[0] as { memcmp: { offset: number; bytes: string } };
        if (filter.memcmp.bytes === utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.Open]))) {
          return Promise.resolve(
            openTasks.map((t) => ({ publicKey: Keypair.generate().publicKey, account: t })),
          );
        }
        if (filter.memcmp.bytes === utils.bytes.bs58.encode(Buffer.from([OnChainTaskStatus.InProgress]))) {
          return Promise.resolve(
            inProgressTasks.map((t) => ({ publicKey: Keypair.generate().publicKey, account: t })),
          );
        }
        return Promise.resolve([]);
      });

      const results = await ops.fetchClaimableTasks();

      expect(results.length).toBe(5);
      expect(results.filter((r) => r.task.status === OnChainTaskStatus.Open).length).toBe(3);
      expect(results.filter((r) => r.task.status === OnChainTaskStatus.InProgress).length).toBe(2);
    });
  });

  describe('fetchClaim', () => {
    it('returns this agent\'s claim when found', async () => {
      const rawClaim = createMockRawClaim(Keypair.generate().publicKey, Keypair.generate().publicKey);
      mocks.taskClaimFetch.mockResolvedValue(rawClaim);

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchClaim(taskPda);

      expect(result).not.toBeNull();
      expect(result!.isCompleted).toBe(false);
    });

    it('returns null for non-existent claim', async () => {
      mocks.taskClaimFetch.mockRejectedValue(new Error('Account does not exist'));

      const taskPda = Keypair.generate().publicKey;
      const result = await ops.fetchClaim(taskPda);

      expect(result).toBeNull();
    });
  });

  describe('fetchActiveClaims', () => {
    it('returns only uncompleted claims for this agent', async () => {
      // Need to get the agent PDA to create matching claims
      const { address: agentPda } = (() => {
        const [address, bump] = PublicKey.findProgramAddressSync(
          [Buffer.from('agent'), Buffer.from(agentId)],
          PROGRAM_ID,
        );
        return { address, bump };
      })();

      const otherAgent = Keypair.generate().publicKey;
      const taskPda1 = Keypair.generate().publicKey;
      const taskPda2 = Keypair.generate().publicKey;

      mocks.taskClaimAll.mockResolvedValue([
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(agentPda, taskPda1, { isCompleted: false }),
        },
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(agentPda, taskPda2, { isCompleted: true }),
        },
        {
          publicKey: Keypair.generate().publicKey,
          account: createMockRawClaim(otherAgent, taskPda1, { isCompleted: false }),
        },
      ]);

      const results = await ops.fetchActiveClaims();

      expect(results.length).toBe(1);
      expect(results[0].claim.isCompleted).toBe(false);
      expect(results[0].claim.worker.equals(agentPda)).toBe(true);
    });
  });

  describe('claimTask', () => {
    it('calls claimTask with correct accounts', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      const result = await ops.claimTask(taskPda, task);

      expect(result.success).toBe(true);
      expect(result.transactionSignature).toBe('claim-sig');
      expect(mocks.claimTaskBuilder.accountsPartial).toHaveBeenCalledWith(
        expect.objectContaining({
          task: taskPda,
          systemProgram: SystemProgram.programId,
        }),
      );
    });

    it('throws TaskNotClaimableError on TaskFullyClaimed', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: { number: AnchorErrorCodes.TaskFullyClaimed, code: 'TaskFullyClaimed' },
        message: 'Task has reached maximum workers',
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(TaskNotClaimableError);
    });

    it('throws TaskNotClaimableError on TaskExpired', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: { number: AnchorErrorCodes.TaskExpired, code: 'TaskExpired' },
        message: 'Task has expired',
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(TaskNotClaimableError);
    });

    it('throws TaskNotClaimableError on InsufficientCapabilities', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: { number: AnchorErrorCodes.InsufficientCapabilities, code: 'InsufficientCapabilities' },
        message: 'Agent has insufficient capabilities',
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(TaskNotClaimableError);
    });

    it('throws TaskNotClaimableError on TaskNotOpen', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: { number: AnchorErrorCodes.TaskNotOpen, code: 'TaskNotOpen' },
        message: 'Task is not open',
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(TaskNotClaimableError);
    });

    it('throws TaskNotClaimableError on AlreadyClaimed', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.claimTaskBuilder.rpc.mockRejectedValue({
        errorCode: { number: AnchorErrorCodes.AlreadyClaimed, code: 'AlreadyClaimed' },
        message: 'Already claimed',
      });

      await expect(ops.claimTask(taskPda, task)).rejects.toThrow(TaskNotClaimableError);
    });
  });

  describe('completeTask', () => {
    it('calls completeTask with correct arguments', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);
      const resultData = new Uint8Array(64).fill(0xcd);

      const result = await ops.completeTask(taskPda, task, proofHash, resultData);

      expect(result.success).toBe(true);
      expect(result.isPrivate).toBe(false);
      expect(result.transactionSignature).toBe('complete-sig');
    });

    it('handles null resultData', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);

      const result = await ops.completeTask(taskPda, task, proofHash, null);

      expect(result.success).toBe(true);
    });

    it('throws TaskSubmissionError on failure', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.completeTaskBuilder.rpc.mockRejectedValue(new Error('Transaction failed'));

      await expect(
        ops.completeTask(taskPda, task, new Uint8Array(32).fill(0xab), null),
      ).rejects.toThrow(TaskSubmissionError);
    });
  });

  describe('completeTaskPrivate', () => {
    it('calls completeTaskPrivate with correct arguments', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofData = new Uint8Array(256).fill(0x01);
      const constraintHash = new Uint8Array(32).fill(0x02);
      const outputCommitment = new Uint8Array(32).fill(0x03);
      const expectedBinding = new Uint8Array(32).fill(0x04);
      const nullifier = new Uint8Array(32).fill(0x05);

      const result = await ops.completeTaskPrivate(
        taskPda,
        task,
        proofData,
        constraintHash,
        outputCommitment,
        expectedBinding,
        nullifier,
      );

      expect(result.success).toBe(true);
      expect(result.isPrivate).toBe(true);
      expect(result.transactionSignature).toBe('private-sig');
    });

    it('throws TaskSubmissionError on failure', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      mocks.completeTaskPrivateBuilder.rpc.mockRejectedValue(new Error('ZK verification failed'));

      await expect(
        ops.completeTaskPrivate(
          taskPda,
          task,
          new Uint8Array(256).fill(0x01),
          new Uint8Array(32).fill(0x02),
          new Uint8Array(32).fill(0x03),
          new Uint8Array(32).fill(0x04),
          new Uint8Array(32).fill(0x05),
        ),
      ).rejects.toThrow(TaskSubmissionError);
    });
  });

  describe('protocol treasury caching', () => {
    it('caches treasury address across multiple calls', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();
      const proofHash = new Uint8Array(32).fill(0xab);

      await ops.completeTask(taskPda, task, proofHash, null);
      await ops.completeTask(taskPda, task, proofHash, null);

      // protocolConfig.fetch should only be called once (cached)
      expect(mocks.protocolConfigFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent PDA caching', () => {
    it('reuses cached agent PDA across operations', async () => {
      const taskPda = Keypair.generate().publicKey;
      const task = createParsedTask();

      await ops.claimTask(taskPda, task);
      await ops.claimTask(taskPda, task);

      // Both should use the same agent PDA (verified via claimTask accounts)
      const calls = mocks.claimTaskBuilder.accountsPartial.mock.calls;
      expect(calls[0][0].worker.equals(calls[1][0].worker)).toBe(true);
    });
  });

  describe('Input validation (#963)', () => {
    const taskPda = Keypair.generate().publicKey;
    const mockTask: OnChainTask = {
      taskId: new Uint8Array(32).fill(1),
      creator: Keypair.generate().publicKey,
      requiredCapabilities: 3n,
      description: new Uint8Array(64),
      constraintHash: new Uint8Array(32),
      rewardAmount: 1000000n,
      maxWorkers: 5,
      currentWorkers: 0,
      status: OnChainTaskStatus.InProgress,
      taskType: TaskType.Exclusive,
      createdAt: 1700000000,
      deadline: 1700003600,
      completedAt: 0,
      escrow: Keypair.generate().publicKey,
      result: new Uint8Array(64),
      completions: 0,
      requiredCompletions: 1,
      bump: 255,
      protocolFeeBps: 100,
      rewardMint: null,
      minReputation: 0,
      dependsOn: null,
      dependencyType: null,
    };

    it('completeTask rejects proofHash shorter than 32 bytes', async () => {
      await expect(
        ops.completeTask(taskPda, mockTask, new Uint8Array(16), null)
      ).rejects.toThrow('expected 32 bytes');
    });

    it('completeTask rejects all-zero proofHash', async () => {
      await expect(
        ops.completeTask(taskPda, mockTask, new Uint8Array(32), null)
      ).rejects.toThrow('cannot be all zeros');
    });

    it('completeTask rejects resultData shorter than 64 bytes', async () => {
      const validProof = new Uint8Array(32).fill(1);
      await expect(
        ops.completeTask(taskPda, mockTask, validProof, new Uint8Array(32))
      ).rejects.toThrow('expected 64 bytes');
    });

    it('completeTaskPrivate rejects proof shorter than 256 bytes', async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda, mockTask,
          new Uint8Array(128),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
        )
      ).rejects.toThrow('expected 256 bytes');
    });

    it('completeTaskPrivate rejects all-zero outputCommitment', async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda, mockTask,
          new Uint8Array(256).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
        )
      ).rejects.toThrow('cannot be all zeros');
    });

    it('completeTaskPrivate rejects all-zero expectedBinding', async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda, mockTask,
          new Uint8Array(256).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32),
          new Uint8Array(32).fill(1),
        )
      ).rejects.toThrow('cannot be all zeros');
    });

    it('completeTaskPrivate rejects all-zero nullifier', async () => {
      await expect(
        ops.completeTaskPrivate(
          taskPda, mockTask,
          new Uint8Array(256).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(1),
          new Uint8Array(32),
        )
      ).rejects.toThrow('cannot be all zeros');
    });
  });
});
