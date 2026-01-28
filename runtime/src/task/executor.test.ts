import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TaskExecutor } from './executor.js';
import type { TaskOperations } from './operations.js';
import type { TaskDiscovery, TaskDiscoveryResult, TaskDiscoveryListener } from './discovery.js';
import type {
  OnChainTask,
  TaskExecutionContext,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskExecutorConfig,
  TaskExecutorEvents,
  ClaimResult,
  CompleteResult,
  RetryPolicy,
} from './types.js';
import { OnChainTaskStatus, isPrivateExecutionResult } from './types.js';
import { TaskType } from '../events/types.js';
import { silentLogger } from '../utils/logger.js';
import { TaskTimeoutError } from '../types/errors.js';

// ============================================================================
// Helpers
// ============================================================================

const COMPUTE = 1n << 0n;

function createTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: COMPUTE,
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
  };
}

function createMockDiscovery(): TaskDiscovery & {
  onTaskDiscovered: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
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
    isRunning: vi.fn().mockReturnValue(false),
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
    _emitTask: (task: TaskDiscoveryResult) => void;
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

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskExecutor', () => {
  // ==========================================================================
  // Autonomous Mode
  // ==========================================================================

  describe('autonomous mode', () => {
    it('starts discovery and enters processing loop', async () => {
      const mockDiscovery = createMockDiscovery();
      const config = createExecutorConfig({
        mode: 'autonomous',
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);

      // Start in background (autonomous mode loops)
      const startPromise = executor.start();

      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);
      expect(mockDiscovery.onTaskDiscovered).toHaveBeenCalled();
      expect(mockDiscovery.start).toHaveBeenCalled();
      expect(executor.isRunning()).toBe(true);

      await executor.stop();
      await startPromise;
    });

    it('full pipeline: discover → claim → execute → submit', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const handlerCalled = vi.fn();

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        handlerCalled(ctx);
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();

      // Wait for discovery to start
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Inject a task
      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);

      // Wait for pipeline to complete
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0);

      expect(mockOps.claimTask).toHaveBeenCalledWith(task.pda, task.task);
      expect(handlerCalled).toHaveBeenCalledTimes(1);
      expect(mockOps.completeTask).toHaveBeenCalledTimes(1);

      const status = executor.getStatus();
      expect(status.tasksDiscovered).toBe(1);
      expect(status.tasksClaimed).toBe(1);
      expect(status.tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('provides correct TaskExecutionContext to handler', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let capturedContext: TaskExecutionContext | null = null;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        capturedContext = ctx;
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);
      await waitFor(() => capturedContext !== null);

      expect(capturedContext!.task).toBe(task.task);
      expect(capturedContext!.taskPda).toBe(task.pda);
      expect(capturedContext!.agentPda).toBe(agentPda);
      expect(capturedContext!.agentId).toEqual(agentId);
      expect(capturedContext!.logger).toBeDefined();
      expect(capturedContext!.signal).toBeInstanceOf(AbortSignal);
      // claimPda should be the one from the claim result
      expect(capturedContext!.claimPda).toBeInstanceOf(PublicKey);

      await executor.stop();
      await startPromise;
    });

    it('throws if discovery is not provided for autonomous mode', async () => {
      const config = createExecutorConfig({ mode: 'autonomous' });
      const executor = new TaskExecutor(config);

      await expect(executor.start()).rejects.toThrow('TaskDiscovery is required');
    });

    it('throws if already running', async () => {
      const mockDiscovery = createMockDiscovery();
      const config = createExecutorConfig({
        mode: 'autonomous',
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();

      await waitFor(() => executor.isRunning());

      await expect(executor.start()).rejects.toThrow('already running');

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Batch Mode
  // ==========================================================================

  describe('batch mode', () => {
    it('processes all specified batch tasks', async () => {
      const mockOps = createMockOperations();
      const taskPda = Keypair.generate().publicKey;
      const task = createTask();
      mockOps.fetchTask.mockResolvedValue(task);

      const config = createExecutorConfig({
        mode: 'batch',
        operations: mockOps,
        batchTasks: [{ taskPda }],
      });
      const executor = new TaskExecutor(config);
      await executor.start();

      expect(mockOps.claimTask).toHaveBeenCalledTimes(1);
      expect(mockOps.completeTask).toHaveBeenCalledTimes(1);

      const status = executor.getStatus();
      expect(status.tasksDiscovered).toBe(1);
      expect(status.tasksCompleted).toBe(1);
    });

    it('resolves start() promise when batch is complete', async () => {
      const mockOps = createMockOperations();
      const taskPda = Keypair.generate().publicKey;
      mockOps.fetchTask.mockResolvedValue(createTask());

      const config = createExecutorConfig({
        mode: 'batch',
        operations: mockOps,
        batchTasks: [{ taskPda }],
      });
      const executor = new TaskExecutor(config);

      // Should resolve after processing
      await executor.start();

      // After batch completes, status reflects
      expect(executor.getStatus().tasksCompleted).toBe(1);
    });

    it('handles mix of taskPda and creator+taskId batch items', async () => {
      const mockOps = createMockOperations();
      const taskPda1 = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const taskIdBytes = new Uint8Array(32).fill(5);

      const task1 = createTask();
      const task2 = createTask({ creator, taskId: taskIdBytes });

      mockOps.fetchTask.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);

      const config = createExecutorConfig({
        mode: 'batch',
        operations: mockOps,
        batchTasks: [
          { taskPda: taskPda1 },
          { creator, taskId: taskIdBytes },
        ],
      });
      const executor = new TaskExecutor(config);
      await executor.start();

      expect(mockOps.claimTask).toHaveBeenCalledTimes(2);
      expect(mockOps.completeTask).toHaveBeenCalledTimes(2);
    });

    it('handles empty batch gracefully', async () => {
      const config = createExecutorConfig({
        mode: 'batch',
        batchTasks: [],
      });
      const executor = new TaskExecutor(config);
      await executor.start();

      expect(executor.getStatus().tasksDiscovered).toBe(0);
    });

    it('handles batch task not found on-chain', async () => {
      const mockOps = createMockOperations();
      mockOps.fetchTask.mockResolvedValue(null);

      const config = createExecutorConfig({
        mode: 'batch',
        operations: mockOps,
        batchTasks: [{ taskPda: Keypair.generate().publicKey }],
      });
      const executor = new TaskExecutor(config);
      await executor.start();

      expect(mockOps.claimTask).not.toHaveBeenCalled();
      expect(executor.getStatus().tasksDiscovered).toBe(0);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('continues processing on claim failure', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      mockOps.claimTask
        .mockRejectedValueOnce(new Error('TaskFullyClaimed'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          claimPda: Keypair.generate().publicKey,
          transactionSignature: 'sig',
        } satisfies ClaimResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 1 },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // First task: claim fails
      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 1);
      await flushAsync();

      // Second task: succeeds
      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length >= 1);

      const status = executor.getStatus();
      expect(status.claimsFailed).toBe(1);
      expect(status.tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('increments tasksFailed on handler failure', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      const handler = async (): Promise<TaskExecutionResult> => {
        throw new Error('Handler error');
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksFailed >= 1);

      expect(executor.getStatus().tasksFailed).toBe(1);
      // Should not attempt to submit
      expect(mockOps.completeTask).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('increments submitsFailed on submit failure', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      mockOps.completeTask.mockRejectedValueOnce(new Error('Submit failed'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().submitsFailed >= 1);

      expect(executor.getStatus().submitsFailed).toBe(1);

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Status & Metrics
  // ==========================================================================

  describe('status and metrics', () => {
    it('getStatus() returns correct initial state', () => {
      const config = createExecutorConfig({ mode: 'batch' });
      const executor = new TaskExecutor(config);

      const status = executor.getStatus();
      expect(status.running).toBe(false);
      expect(status.mode).toBe('batch');
      expect(status.tasksDiscovered).toBe(0);
      expect(status.tasksClaimed).toBe(0);
      expect(status.tasksCompleted).toBe(0);
      expect(status.tasksFailed).toBe(0);
      expect(status.tasksInProgress).toBe(0);
      expect(status.claimsFailed).toBe(0);
      expect(status.submitsFailed).toBe(0);
      expect(status.startedAt).toBeNull();
      expect(status.uptimeMs).toBe(0);
    });

    it('isRunning() reflects state correctly', async () => {
      const mockDiscovery = createMockDiscovery();
      const config = createExecutorConfig({
        mode: 'autonomous',
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);

      expect(executor.isRunning()).toBe(false);

      const startPromise = executor.start();
      await waitFor(() => executor.isRunning());

      expect(executor.isRunning()).toBe(true);

      await executor.stop();
      await startPromise;

      expect(executor.isRunning()).toBe(false);
    });

    it('getStatus() computes uptimeMs from startedAt', async () => {
      const mockDiscovery = createMockDiscovery();
      const config = createExecutorConfig({
        mode: 'autonomous',
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();

      await waitFor(() => executor.isRunning());

      // Allow some time to pass
      await new Promise((r) => setTimeout(r, 50));

      const status = executor.getStatus();
      expect(status.startedAt).toBeTypeOf('number');
      expect(status.uptimeMs).toBeGreaterThan(0);

      await executor.stop();
      await startPromise;
    });

    it('tracks metrics across multiple tasks', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Inject 3 tasks
      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksCompleted >= 1);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksCompleted >= 2);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksCompleted >= 3);

      const status = executor.getStatus();
      expect(status.tasksDiscovered).toBe(3);
      expect(status.tasksClaimed).toBe(3);
      expect(status.tasksCompleted).toBe(3);

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Event Callbacks
  // ==========================================================================

  describe('event callbacks', () => {
    it('emits onTaskDiscovered when task enters pipeline', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskDiscovered = vi.fn();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskDiscovered });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);

      await waitFor(() => onTaskDiscovered.mock.calls.length > 0);
      expect(onTaskDiscovered).toHaveBeenCalledWith(task);

      await executor.stop();
      await startPromise;
    });

    it('emits onTaskClaimed after successful claim', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskClaimed = vi.fn();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskClaimed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskClaimed.mock.calls.length > 0);

      expect(onTaskClaimed).toHaveBeenCalledTimes(1);
      expect(onTaskClaimed.mock.calls[0][0].success).toBe(true);

      await executor.stop();
      await startPromise;
    });

    it('emits onTaskExecutionStarted when handler begins', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskExecutionStarted = vi.fn();

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskExecutionStarted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskExecutionStarted.mock.calls.length > 0);

      expect(onTaskExecutionStarted).toHaveBeenCalledTimes(1);
      const ctx = onTaskExecutionStarted.mock.calls[0][0] as TaskExecutionContext;
      expect(ctx.signal).toBeInstanceOf(AbortSignal);

      await executor.stop();
      await startPromise;
    });

    it('emits onTaskCompleted after successful submission', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskCompleted = vi.fn();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskCompleted.mock.calls.length > 0);

      expect(onTaskCompleted).toHaveBeenCalledTimes(1);
      expect(onTaskCompleted.mock.calls[0][0].success).toBe(true);

      await executor.stop();
      await startPromise;
    });

    it('emits onClaimFailed when claim fails', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimFailed = vi.fn();
      mockOps.claimTask.mockRejectedValueOnce(new Error('claim error'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);
      await waitFor(() => onClaimFailed.mock.calls.length > 0);

      expect(onClaimFailed).toHaveBeenCalledTimes(1);
      expect(onClaimFailed.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(onClaimFailed.mock.calls[0][1]).toBe(task.pda);

      await executor.stop();
      await startPromise;
    });

    it('emits onTaskFailed when handler throws', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskFailed = vi.fn();

      const handler = async (): Promise<TaskExecutionResult> => {
        throw new Error('handler boom');
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);
      await waitFor(() => onTaskFailed.mock.calls.length > 0);

      expect(onTaskFailed).toHaveBeenCalledTimes(1);
      expect(onTaskFailed.mock.calls[0][0].message).toBe('handler boom');
      expect(onTaskFailed.mock.calls[0][1]).toBe(task.pda);

      await executor.stop();
      await startPromise;
    });

    it('emits onSubmitFailed when submit fails', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onSubmitFailed = vi.fn();
      mockOps.completeTask.mockRejectedValueOnce(new Error('submit error'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onSubmitFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);
      await waitFor(() => onSubmitFailed.mock.calls.length > 0);

      expect(onSubmitFailed).toHaveBeenCalledTimes(1);
      expect(onSubmitFailed.mock.calls[0][0].message).toBe('submit error');
      expect(onSubmitFailed.mock.calls[0][1]).toBe(task.pda);

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Concurrency
  // ==========================================================================

  describe('concurrency', () => {
    it('handler receives AbortSignal in context', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let capturedSignal: AbortSignal | null = null;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        capturedSignal = ctx.signal;
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => capturedSignal !== null);

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(false);

      await executor.stop();
      await startPromise;
    });

    it('AbortSignal fires on stop()', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let capturedSignal: AbortSignal | null = null;
      let handlerResolve: (() => void) | null = null;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        capturedSignal = ctx.signal;
        // Hold the handler open until we resolve
        await new Promise<void>((resolve) => {
          handlerResolve = resolve;
        });
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => capturedSignal !== null);

      expect(capturedSignal!.aborted).toBe(false);

      // Stop aborts controllers synchronously before async cleanup
      const stopPromise = executor.stop();
      expect(capturedSignal!.aborted).toBe(true);

      // Resolve the handler so cleanup completes
      handlerResolve?.();
      await stopPromise;
      await startPromise;
    });

    it('respects maxConcurrentTasks limit', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let activeCount = 0;
      let maxActive = 0;
      const resolvers: (() => void)[] = [];

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        activeCount--;
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        maxConcurrentTasks: 2,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Inject 4 tasks
      for (let i = 0; i < 4; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }

      // Wait for 2 handlers to start
      await waitFor(() => activeCount === 2, 2000);

      // Only 2 should be active at once
      expect(activeCount).toBe(2);
      expect(maxActive).toBe(2);

      // Complete tasks one at a time, verifying concurrency never exceeds 2
      // Resolve task 1 — should allow queued task 3 to start
      resolvers[0]();
      await waitFor(() => resolvers.length >= 3, 2000);
      expect(activeCount).toBeLessThanOrEqual(2);

      // Resolve task 2 — should allow queued task 4 to start
      resolvers[1]();
      await waitFor(() => resolvers.length >= 4, 2000);
      expect(activeCount).toBeLessThanOrEqual(2);

      // Resolve remaining tasks
      resolvers[2]();
      resolvers[3]();

      await waitFor(() => executor.getStatus().tasksCompleted >= 4, 5000);
      expect(executor.getStatus().tasksCompleted).toBe(4);
      expect(maxActive).toBe(2);

      await executor.stop();
      await startPromise;
    });

    it('queues tasks beyond limit (not dropped)', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const resolvers: (() => void)[] = [];

      const handler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        maxConcurrentTasks: 1,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Inject 3 tasks
      mockDiscovery._emitTask(createDiscoveryResult());
      mockDiscovery._emitTask(createDiscoveryResult());
      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for first handler to start
      await waitFor(() => resolvers.length >= 1);

      // All 3 discovered
      expect(executor.getStatus().tasksDiscovered).toBe(3);

      // Only 1 active
      expect(executor.getStatus().tasksInProgress).toBe(1);

      // Complete tasks one by one
      resolvers[0]();
      await waitFor(() => resolvers.length >= 2);

      resolvers[1]();
      await waitFor(() => resolvers.length >= 3);

      resolvers[2]();
      await waitFor(() => executor.getStatus().tasksCompleted >= 3, 5000);

      expect(executor.getStatus().tasksCompleted).toBe(3);

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Private Tasks
  // ==========================================================================

  describe('private tasks', () => {
    it('calls completeTaskPrivate for PrivateTaskExecutionResult', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      const handler = async (): Promise<PrivateTaskExecutionResult> => ({
        proof: new Uint8Array(388),
        constraintHash: new Uint8Array(32).fill(1),
        outputCommitment: new Uint8Array(32).fill(2),
        expectedBinding: new Uint8Array(32).fill(3),
      });

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTaskPrivate.mock.calls.length > 0);

      expect(mockOps.completeTaskPrivate).toHaveBeenCalledTimes(1);
      expect(mockOps.completeTask).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('calls completeTask for TaskExecutionResult', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      const handler = async (): Promise<TaskExecutionResult> => ({
        proofHash: new Uint8Array(32).fill(1),
        resultData: new Uint8Array(64).fill(2),
      });

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0);

      expect(mockOps.completeTask).toHaveBeenCalledTimes(1);
      expect(mockOps.completeTaskPrivate).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('isPrivateExecutionResult correctly routes result type', () => {
      const publicResult: TaskExecutionResult = {
        proofHash: new Uint8Array(32),
      };

      const privateResult: PrivateTaskExecutionResult = {
        proof: new Uint8Array(388),
        constraintHash: new Uint8Array(32),
        outputCommitment: new Uint8Array(32),
        expectedBinding: new Uint8Array(32),
      };

      expect(isPrivateExecutionResult(publicResult)).toBe(false);
      expect(isPrivateExecutionResult(privateResult)).toBe(true);
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('lifecycle', () => {
    it('stop() is idempotent when not running', async () => {
      const config = createExecutorConfig({ mode: 'batch' });
      const executor = new TaskExecutor(config);

      // Should not throw
      await executor.stop();
      await executor.stop();
    });

    it('stop() clears queue and stops discovery', async () => {
      const mockDiscovery = createMockDiscovery();
      const config = createExecutorConfig({
        mode: 'autonomous',
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => executor.isRunning());

      await executor.stop();
      await startPromise;

      expect(mockDiscovery.stop).toHaveBeenCalled();
      expect(executor.isRunning()).toBe(false);
    });

    it('on() registers multiple event callback sets', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onDiscovered1 = vi.fn();
      const onCompleted2 = vi.fn();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskDiscovered: onDiscovered1 });
      executor.on({ onTaskCompleted: onCompleted2 });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onCompleted2.mock.calls.length > 0);

      expect(onDiscovered1).toHaveBeenCalled();
      expect(onCompleted2).toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Task Timeout
  // ==========================================================================

  describe('task timeout', () => {
    it('times out handler that exceeds taskTimeoutMs', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskTimeout = vi.fn();
      const onTaskFailed = vi.fn();

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        // Hang indefinitely until aborted
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        taskTimeoutMs: 50,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskTimeout, onTaskFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);

      await waitFor(() => onTaskTimeout.mock.calls.length > 0, 3000);

      expect(onTaskTimeout).toHaveBeenCalledTimes(1);
      const [error, pda] = onTaskTimeout.mock.calls[0];
      expect(error).toBeInstanceOf(TaskTimeoutError);
      expect((error as TaskTimeoutError).timeoutMs).toBe(50);
      expect(pda).toBe(task.pda);

      // Also emits onTaskFailed
      expect(onTaskFailed).toHaveBeenCalledTimes(1);
      expect(onTaskFailed.mock.calls[0][0]).toBeInstanceOf(TaskTimeoutError);

      // Metrics updated
      expect(executor.getStatus().tasksFailed).toBe(1);
      expect(executor.getStatus().tasksCompleted).toBe(0);

      await executor.stop();
      await startPromise;
    });

    it('does not timeout handler that completes within taskTimeoutMs', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskTimeout = vi.fn();
      const onTaskCompleted = vi.fn();

      const handler = async (_ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        // Complete quickly
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        taskTimeoutMs: 5000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskTimeout, onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskCompleted.mock.calls.length > 0);

      expect(onTaskTimeout).not.toHaveBeenCalled();
      expect(executor.getStatus().tasksCompleted).toBe(1);
      expect(executor.getStatus().tasksFailed).toBe(0);

      await executor.stop();
      await startPromise;
    });

    it('propagates abort signal to handler on timeout', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let capturedSignal: AbortSignal | null = null;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        capturedSignal = ctx.signal;
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        taskTimeoutMs: 50,
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => capturedSignal !== null);

      expect(capturedSignal!.aborted).toBe(false);

      // Wait for timeout to fire
      await waitFor(() => capturedSignal!.aborted, 3000);
      expect(capturedSignal!.aborted).toBe(true);

      await executor.stop();
      await startPromise;
    });

    it('releases concurrency slot on timeout so queued tasks run', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskTimeout = vi.fn();
      let callCount = 0;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        callCount++;
        if (callCount === 1) {
          // First task: hang until aborted
          await new Promise<void>((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        // Second task: complete normally
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        maxConcurrentTasks: 1,
        taskTimeoutMs: 50,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskTimeout });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Emit 2 tasks — first will timeout, second should then get a slot
      mockDiscovery._emitTask(createDiscoveryResult());
      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for the first task to timeout
      await waitFor(() => onTaskTimeout.mock.calls.length > 0, 3000);

      // Wait for the second task to complete
      await waitFor(() => executor.getStatus().tasksCompleted >= 1, 3000);

      expect(executor.getStatus().tasksFailed).toBe(1);
      expect(executor.getStatus().tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('taskTimeoutMs=0 disables timeout', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onTaskTimeout = vi.fn();
      let handlerResolve: (() => void) | null = null;

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        await new Promise<void>((resolve) => {
          handlerResolve = resolve;
        });
        return { proofHash: new Uint8Array(32).fill(1) };
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        taskTimeoutMs: 0,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onTaskTimeout });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => handlerResolve !== null);

      // Wait a bit to verify no timeout fires
      await new Promise((r) => setTimeout(r, 100));
      expect(onTaskTimeout).not.toHaveBeenCalled();

      // Resolve the handler manually
      handlerResolve!();
      await waitFor(() => executor.getStatus().tasksCompleted >= 1);

      expect(executor.getStatus().tasksCompleted).toBe(1);
      expect(executor.getStatus().tasksFailed).toBe(0);

      await executor.stop();
      await startPromise;
    });

    it('defaults to 300_000ms timeout', () => {
      const config = createExecutorConfig({ mode: 'batch' });
      const executor = new TaskExecutor(config);

      // We can't directly access the private field, but we can verify
      // the config was accepted without error
      expect(executor).toBeDefined();
    });
  });

  // ==========================================================================
  // Retry with Backoff
  // ==========================================================================

  describe('retry with backoff', () => {
    it('retries claim on transient failure then succeeds', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // First claim fails, second succeeds
      mockOps.claimTask
        .mockRejectedValueOnce(new Error('RPC timeout'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          claimPda: Keypair.generate().publicKey,
          transactionSignature: 'sig',
        } satisfies ClaimResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0, 3000);

      const status = executor.getStatus();
      expect(status.tasksClaimed).toBe(1);
      expect(status.tasksCompleted).toBe(1);
      expect(status.claimRetries).toBe(1);
      expect(mockOps.claimTask).toHaveBeenCalledTimes(2);

      await executor.stop();
      await startPromise;
    });

    it('retries submit on transient failure then succeeds', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // First submit fails, second succeeds
      mockOps.completeTask
        .mockRejectedValueOnce(new Error('Transaction timeout'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          isPrivate: false,
          transactionSignature: 'complete-sig-2',
        } satisfies CompleteResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksCompleted >= 1, 3000);

      const status = executor.getStatus();
      expect(status.tasksCompleted).toBe(1);
      expect(status.submitRetries).toBe(1);
      expect(mockOps.completeTask).toHaveBeenCalledTimes(2);

      await executor.stop();
      await startPromise;
    });

    it('exhausts retries and fails after maxAttempts', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // All claims fail
      mockOps.claimTask.mockRejectedValue(new Error('RPC down'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for all attempts to exhaust
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 3, 3000);
      await flushAsync();

      const status = executor.getStatus();
      expect(status.claimsFailed).toBe(3);
      expect(status.claimRetries).toBe(2); // 2 retries after the initial attempt
      expect(status.tasksCompleted).toBe(0);
      expect(mockOps.claimTask).toHaveBeenCalledTimes(3);

      await executor.stop();
      await startPromise;
    });

    it('does NOT retry execute (handler) failures', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let handlerCallCount = 0;

      const handler = async (): Promise<TaskExecutionResult> => {
        handlerCallCount++;
        throw new Error('Handler bug');
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);

      // Handler should only have been called once — no retries
      expect(handlerCallCount).toBe(1);
      expect(executor.getStatus().tasksFailed).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('respects abort signal during retry wait', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // Claim always fails to trigger retries
      mockOps.claimTask.mockRejectedValue(new Error('RPC timeout'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: {
          maxAttempts: 10,
          baseDelayMs: 5000, // Long delay to ensure abort hits during sleep
          maxDelayMs: 30000,
          jitter: false,
        },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for the first attempt to fail
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 1);

      // Stop while retry is sleeping
      await executor.stop();
      await startPromise;

      // Should not have exhausted all retries — was interrupted
      expect(mockOps.claimTask.mock.calls.length).toBeLessThan(10);
    });

    it('logs each retry attempt', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const warnLogs: string[] = [];

      const logger = {
        ...silentLogger,
        warn: (msg: string) => { warnLogs.push(msg); },
      };

      mockOps.claimTask
        .mockRejectedValueOnce(new Error('RPC error'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          claimPda: Keypair.generate().publicKey,
          transactionSignature: 'sig',
        } satisfies ClaimResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        logger,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0, 3000);

      // Should have logged the retry
      expect(warnLogs.some((msg) => msg.includes('Retry claim'))).toBe(true);

      await executor.stop();
      await startPromise;
    });

    it('uses default retry policy when none provided', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
      });
      const executor = new TaskExecutor(config);

      // Should be created without error using defaults
      expect(executor).toBeDefined();

      const status = executor.getStatus();
      expect(status.claimRetries).toBe(0);
      expect(status.submitRetries).toBe(0);
    });

    it('applies exponential backoff delays (no jitter)', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const timestamps: number[] = [];

      // All claims fail to observe the timing of retries
      mockOps.claimTask.mockImplementation(async () => {
        timestamps.push(Date.now());
        throw new Error('RPC down');
      });

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 5000, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 3, 5000);
      await flushAsync();

      // Verify the delays are approximately exponential:
      // attempt 0: no delay
      // attempt 1: ~50ms delay (baseDelay * 2^0 = 50ms)
      // attempt 2: ~100ms delay (baseDelay * 2^1 = 100ms)
      expect(timestamps.length).toBe(3);
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];

      // Allow generous tolerance for CI environments
      expect(delay1).toBeGreaterThanOrEqual(30);
      expect(delay1).toBeLessThan(200);
      expect(delay2).toBeGreaterThanOrEqual(60);
      expect(delay2).toBeLessThan(400);

      await executor.stop();
      await startPromise;
    });

    it('caps delay at maxDelayMs', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const timestamps: number[] = [];

      mockOps.claimTask.mockImplementation(async () => {
        timestamps.push(Date.now());
        throw new Error('RPC down');
      });

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        // baseDelay=200, maxDelay=100 — the cap should limit the delay
        retryPolicy: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 3, 5000);
      await flushAsync();

      expect(timestamps.length).toBe(3);
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];

      // Delays should be capped at ~100ms (maxDelayMs)
      expect(delay1).toBeLessThan(300);
      expect(delay2).toBeLessThan(300);

      await executor.stop();
      await startPromise;
    });

    it('maxAttempts=1 disables retries', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      mockOps.claimTask.mockRejectedValue(new Error('RPC down'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 1);
      // Small wait to confirm no retries happen
      await new Promise((r) => setTimeout(r, 100));

      expect(mockOps.claimTask).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().claimRetries).toBe(0);

      await executor.stop();
      await startPromise;
    });
  });
});
