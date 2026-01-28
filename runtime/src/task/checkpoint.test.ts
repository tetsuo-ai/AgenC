import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { InMemoryCheckpointStore } from './checkpoint.js';
import { TaskExecutor } from './executor.js';
import type { TaskOperations } from './operations.js';
import type { TaskDiscovery, TaskDiscoveryResult, TaskDiscoveryListener } from './discovery.js';
import type {
  OnChainTask,
  OnChainTaskClaim,
  TaskExecutionContext,
  TaskExecutionResult,
  TaskExecutorConfig,
  ClaimResult,
  CompleteResult,
  CheckpointStore,
  TaskCheckpoint,
} from './types.js';
import { OnChainTaskStatus } from './types.js';
import { TaskType } from '../events/types.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

function createTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 1n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

function createDiscoveryResult(overrides: Partial<TaskDiscoveryResult> = {}): TaskDiscoveryResult {
  return {
    pda: Keypair.generate().publicKey,
    task: createTask(),
    discoveredAt: Date.now(),
    source: 'poll',
    ...overrides,
  };
}

function createMockOperations(): TaskOperations & {
  claimTask: ReturnType<typeof vi.fn>;
  completeTask: ReturnType<typeof vi.fn>;
  completeTaskPrivate: ReturnType<typeof vi.fn>;
  fetchTask: ReturnType<typeof vi.fn>;
  fetchTaskByIds: ReturnType<typeof vi.fn>;
  fetchClaim: ReturnType<typeof vi.fn>;
} {
  const claimPda = Keypair.generate().publicKey;
  return {
    fetchClaimableTasks: vi.fn().mockResolvedValue([]),
    fetchTask: vi.fn().mockResolvedValue(null),
    fetchAllTasks: vi.fn().mockResolvedValue([]),
    fetchClaim: vi.fn().mockResolvedValue(null),
    fetchActiveClaims: vi.fn().mockResolvedValue([]),
    fetchTaskByIds: vi.fn().mockResolvedValue(null),
    claimTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      claimPda,
      transactionSignature: 'claim-sig',
    } satisfies ClaimResult),
    completeTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      isPrivate: false,
      transactionSignature: 'complete-sig',
    } satisfies CompleteResult),
    completeTaskPrivate: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      isPrivate: true,
      transactionSignature: 'private-complete-sig',
    } satisfies CompleteResult),
  } as unknown as TaskOperations & {
    claimTask: ReturnType<typeof vi.fn>;
    completeTask: ReturnType<typeof vi.fn>;
    completeTaskPrivate: ReturnType<typeof vi.fn>;
    fetchTask: ReturnType<typeof vi.fn>;
    fetchTaskByIds: ReturnType<typeof vi.fn>;
    fetchClaim: ReturnType<typeof vi.fn>;
  };
}

function createMockDiscovery(): TaskDiscovery & {
  onTaskDiscovered: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  _emitTask: (task: TaskDiscoveryResult) => void;
} {
  let listener: TaskDiscoveryListener | null = null;

  const mock = {
    onTaskDiscovered: vi.fn((cb: TaskDiscoveryListener) => {
      listener = cb;
      return () => { listener = null; };
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    isPaused: vi.fn().mockReturnValue(false),
    getDiscoveredCount: vi.fn().mockReturnValue(0),
    clearSeen: vi.fn(),
    poll: vi.fn().mockResolvedValue([]),
    _emitTask: (task: TaskDiscoveryResult) => {
      listener?.(task);
    },
  };

  return mock as unknown as TaskDiscovery & {
    onTaskDiscovered: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    _emitTask: (task: TaskDiscoveryResult) => void;
  };
}

function createMockClaim(overrides: Partial<OnChainTaskClaim> = {}): OnChainTaskClaim {
  return {
    task: Keypair.generate().publicKey,
    worker: Keypair.generate().publicKey,
    claimedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    completedAt: 0,
    proofHash: new Uint8Array(32),
    resultData: new Uint8Array(64),
    isCompleted: false,
    isValidated: false,
    rewardPaid: 0n,
    bump: 255,
    ...overrides,
  };
}

const agentId = new Uint8Array(32).fill(42);
const agentPda = Keypair.generate().publicKey;

const defaultHandler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => ({
  proofHash: new Uint8Array(32).fill(1),
});

function createExecutorConfig(overrides: Partial<TaskExecutorConfig> = {}): TaskExecutorConfig {
  return {
    operations: createMockOperations(),
    handler: defaultHandler,
    agentId,
    agentPda,
    logger: silentLogger,
    ...overrides,
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ============================================================================
// InMemoryCheckpointStore Tests
// ============================================================================

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('saves and loads a checkpoint', async () => {
    const checkpoint: TaskCheckpoint = {
      taskPda: 'abc123',
      stage: 'claimed',
      claimResult: {
        success: true,
        taskId: new Uint8Array(32),
        claimPda: Keypair.generate().publicKey,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.save(checkpoint);
    const loaded = await store.load('abc123');
    expect(loaded).toEqual(checkpoint);
  });

  it('returns null for unknown task', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('removes a checkpoint', async () => {
    const checkpoint: TaskCheckpoint = {
      taskPda: 'abc123',
      stage: 'claimed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.save(checkpoint);
    await store.remove('abc123');
    const loaded = await store.load('abc123');
    expect(loaded).toBeNull();
  });

  it('remove is a no-op for unknown task', async () => {
    await expect(store.remove('nonexistent')).resolves.toBeUndefined();
  });

  it('listPending returns all saved checkpoints', async () => {
    const cp1: TaskCheckpoint = {
      taskPda: 'task1',
      stage: 'claimed',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const cp2: TaskCheckpoint = {
      taskPda: 'task2',
      stage: 'executed',
      createdAt: 2000,
      updatedAt: 2000,
    };

    await store.save(cp1);
    await store.save(cp2);

    const pending = await store.listPending();
    expect(pending).toHaveLength(2);
    expect(pending).toContainEqual(cp1);
    expect(pending).toContainEqual(cp2);
  });

  it('listPending returns empty array when no checkpoints', async () => {
    const pending = await store.listPending();
    expect(pending).toEqual([]);
  });

  it('save overwrites existing checkpoint for same taskPda', async () => {
    const cp1: TaskCheckpoint = {
      taskPda: 'task1',
      stage: 'claimed',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const cp2: TaskCheckpoint = {
      taskPda: 'task1',
      stage: 'executed',
      createdAt: 1000,
      updatedAt: 2000,
    };

    await store.save(cp1);
    await store.save(cp2);

    const loaded = await store.load('task1');
    expect(loaded?.stage).toBe('executed');

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
  });
});

// ============================================================================
// Executor Checkpoint Integration Tests
// ============================================================================

describe('TaskExecutor checkpoint integration', () => {
  let executor: TaskExecutor;

  afterEach(async () => {
    if (executor?.isRunning()) {
      await executor.stop();
    }
  });

  describe('pipeline checkpoints', () => {
    it('saves checkpoint after claim and execution, removes after submit', async () => {
      const store = new InMemoryCheckpointStore();
      const saveSpy = vi.spyOn(store, 'save');
      const removeSpy = vi.spyOn(store, 'remove');

      const ops = createMockOperations();
      const discovery = createMockDiscovery();
      const task = createDiscoveryResult();

      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        checkpointStore: store,
      }));

      const completed = vi.fn();
      executor.on({ onTaskCompleted: completed });

      const startPromise = executor.start();

      // Wait for discovery to start before emitting
      await waitFor(() => discovery.start.mock.calls.length > 0);

      // Emit a task
      discovery._emitTask(task);

      await waitFor(() => completed.mock.calls.length > 0);
      await executor.stop();
      await startPromise.catch(() => {});

      // Should have saved twice: after claim and after execution
      expect(saveSpy).toHaveBeenCalledTimes(2);

      const firstSave = saveSpy.mock.calls[0][0] as TaskCheckpoint;
      expect(firstSave.stage).toBe('claimed');
      expect(firstSave.taskPda).toBe(task.pda.toBase58());

      const secondSave = saveSpy.mock.calls[1][0] as TaskCheckpoint;
      expect(secondSave.stage).toBe('executed');
      expect(secondSave.taskPda).toBe(task.pda.toBase58());

      // Should have removed after submit
      expect(removeSpy).toHaveBeenCalledWith(task.pda.toBase58());

      // Store should be empty
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('works normally without checkpoint store', async () => {
      const ops = createMockOperations();
      const discovery = createMockDiscovery();
      const task = createDiscoveryResult();

      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
      }));

      const completed = vi.fn();
      executor.on({ onTaskCompleted: completed });

      const startPromise = executor.start();
      await waitFor(() => discovery.start.mock.calls.length > 0);
      discovery._emitTask(task);
      await waitFor(() => completed.mock.calls.length > 0);
      await executor.stop();
      await startPromise.catch(() => {});

      expect(completed).toHaveBeenCalledTimes(1);
    });
  });

  describe('crash recovery', () => {
    it('resumes from claimed stage (skips claim, runs execute + submit)', async () => {
      const taskPda = Keypair.generate().publicKey;
      const claimPda = Keypair.generate().publicKey;
      const taskPdaStr = taskPda.toBase58();
      const task = createTask();

      const claimResult: ClaimResult = {
        success: true,
        taskId: new Uint8Array(32),
        claimPda,
      };

      const store = new InMemoryCheckpointStore();
      await store.save({
        taskPda: taskPdaStr,
        stage: 'claimed',
        claimResult,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      });

      const ops = createMockOperations();
      // fetchClaim returns a valid, non-expired claim
      ops.fetchClaim.mockResolvedValue(createMockClaim({
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }));
      // fetchTask returns the task
      ops.fetchTask.mockResolvedValue(task);

      const handlerCalled = vi.fn();
      const handler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        handlerCalled();
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const discovery = createMockDiscovery();
      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        handler,
        checkpointStore: store,
      }));

      const completed = vi.fn();
      executor.on({ onTaskCompleted: completed });

      const startPromise = executor.start();
      await waitFor(() => completed.mock.calls.length > 0);
      await executor.stop();
      await startPromise.catch(() => {});

      // Handler was called (execute step ran)
      expect(handlerCalled).toHaveBeenCalledTimes(1);
      // Claim was NOT called (skipped)
      expect(ops.claimTask).not.toHaveBeenCalled();
      // Submit was called
      expect(ops.completeTask).toHaveBeenCalledTimes(1);
      // Checkpoint was removed after success
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('resumes from executed stage (skips claim + execute, runs submit)', async () => {
      const taskPda = Keypair.generate().publicKey;
      const claimPda = Keypair.generate().publicKey;
      const taskPdaStr = taskPda.toBase58();
      const task = createTask();

      const claimResult: ClaimResult = {
        success: true,
        taskId: new Uint8Array(32),
        claimPda,
      };

      const executionResult: TaskExecutionResult = {
        proofHash: new Uint8Array(32).fill(1),
      };

      const store = new InMemoryCheckpointStore();
      await store.save({
        taskPda: taskPdaStr,
        stage: 'executed',
        claimResult,
        executionResult,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 500,
      });

      const ops = createMockOperations();
      ops.fetchClaim.mockResolvedValue(createMockClaim({
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }));
      ops.fetchTask.mockResolvedValue(task);

      const handlerCalled = vi.fn();
      const handler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        handlerCalled();
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const discovery = createMockDiscovery();
      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        handler,
        checkpointStore: store,
      }));

      const completed = vi.fn();
      executor.on({ onTaskCompleted: completed });

      const startPromise = executor.start();
      await waitFor(() => completed.mock.calls.length > 0);
      await executor.stop();
      await startPromise.catch(() => {});

      // Handler was NOT called (execute skipped)
      expect(handlerCalled).not.toHaveBeenCalled();
      // Claim was NOT called (skipped)
      expect(ops.claimTask).not.toHaveBeenCalled();
      // Submit was called
      expect(ops.completeTask).toHaveBeenCalledTimes(1);
      // Checkpoint was removed
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('cleans up stale checkpoint when claim has expired', async () => {
      const taskPda = Keypair.generate().publicKey;
      const claimPda = Keypair.generate().publicKey;
      const taskPdaStr = taskPda.toBase58();

      const claimResult: ClaimResult = {
        success: true,
        taskId: new Uint8Array(32),
        claimPda,
      };

      const store = new InMemoryCheckpointStore();
      await store.save({
        taskPda: taskPdaStr,
        stage: 'claimed',
        claimResult,
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 60000,
      });

      const ops = createMockOperations();
      // Return an expired claim
      ops.fetchClaim.mockResolvedValue(createMockClaim({
        expiresAt: Math.floor(Date.now() / 1000) - 10, // expired 10s ago
      }));

      const discovery = createMockDiscovery();
      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        checkpointStore: store,
      }));

      const startPromise = executor.start();
      // Give recovery time to run
      await new Promise((r) => setTimeout(r, 200));
      await executor.stop();
      await startPromise.catch(() => {});

      // Claim should NOT have been called
      expect(ops.claimTask).not.toHaveBeenCalled();
      // Handler should NOT have been called
      expect(ops.completeTask).not.toHaveBeenCalled();
      // Stale checkpoint should have been removed
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('cleans up checkpoint when task no longer exists on-chain', async () => {
      const taskPda = Keypair.generate().publicKey;
      const claimPda = Keypair.generate().publicKey;
      const taskPdaStr = taskPda.toBase58();

      const store = new InMemoryCheckpointStore();
      await store.save({
        taskPda: taskPdaStr,
        stage: 'claimed',
        claimResult: {
          success: true,
          taskId: new Uint8Array(32),
          claimPda,
        },
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      });

      const ops = createMockOperations();
      // Claim exists and is valid
      ops.fetchClaim.mockResolvedValue(createMockClaim({
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }));
      // But the task is gone
      ops.fetchTask.mockResolvedValue(null);

      const discovery = createMockDiscovery();
      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        checkpointStore: store,
      }));

      const startPromise = executor.start();
      await new Promise((r) => setTimeout(r, 200));
      await executor.stop();
      await startPromise.catch(() => {});

      // Checkpoint should be removed
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('recovers multiple checkpoints', async () => {
      const task1Pda = Keypair.generate().publicKey;
      const task2Pda = Keypair.generate().publicKey;
      const claimPda = Keypair.generate().publicKey;
      const task = createTask();

      const claimResult: ClaimResult = {
        success: true,
        taskId: new Uint8Array(32),
        claimPda,
      };

      const store = new InMemoryCheckpointStore();
      await store.save({
        taskPda: task1Pda.toBase58(),
        stage: 'executed',
        claimResult,
        executionResult: { proofHash: new Uint8Array(32).fill(1) },
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 1000,
      });
      await store.save({
        taskPda: task2Pda.toBase58(),
        stage: 'executed',
        claimResult,
        executionResult: { proofHash: new Uint8Array(32).fill(2) },
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 500,
      });

      const ops = createMockOperations();
      ops.fetchClaim.mockResolvedValue(createMockClaim({
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }));
      ops.fetchTask.mockResolvedValue(task);

      const discovery = createMockDiscovery();
      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        checkpointStore: store,
      }));

      const completed = vi.fn();
      executor.on({ onTaskCompleted: completed });

      const startPromise = executor.start();
      await waitFor(() => completed.mock.calls.length >= 2);
      await executor.stop();
      await startPromise.catch(() => {});

      expect(ops.completeTask).toHaveBeenCalledTimes(2);
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });

    it('skips recovery when no checkpoint store configured', async () => {
      const ops = createMockOperations();
      const discovery = createMockDiscovery();

      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        // no checkpointStore
      }));

      const startPromise = executor.start();
      await new Promise((r) => setTimeout(r, 200));
      await executor.stop();
      await startPromise.catch(() => {});

      // No tasks should have been processed
      expect(ops.claimTask).not.toHaveBeenCalled();
      expect(ops.completeTask).not.toHaveBeenCalled();
    });

    it('skips recovery when checkpoint store is empty', async () => {
      const store = new InMemoryCheckpointStore();
      const ops = createMockOperations();
      const discovery = createMockDiscovery();

      executor = new TaskExecutor(createExecutorConfig({
        operations: ops,
        discovery,
        mode: 'autonomous',
        checkpointStore: store,
      }));

      const startPromise = executor.start();
      await new Promise((r) => setTimeout(r, 200));
      await executor.stop();
      await startPromise.catch(() => {});

      expect(ops.claimTask).not.toHaveBeenCalled();
      expect(ops.completeTask).not.toHaveBeenCalled();
    });
  });
});
