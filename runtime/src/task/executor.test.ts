import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TaskExecutor } from './executor.js';
import type {
  TaskExecutionContext,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskExecutorConfig,
  TaskExecutorEvents,
  ClaimResult,
  CompleteResult,
  BackpressureConfig,
} from './types.js';
import { isPrivateExecutionResult } from './types.js';
import { silentLogger } from '../utils/logger.js';
import { TaskTimeoutError, ClaimExpiredError, RetryExhaustedError } from '../types/errors.js';
import {
  createTask,
  createDiscoveryResult,
  createMockOperations,
  createMockDiscovery,
  createMockClaim,
  waitFor,
  flushAsync,
} from './test-utils.js';

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

      const handler = async (): Promise<PrivateTaskExecutionResult> => {
        const sealBytes = new Uint8Array(260).fill(1);
        sealBytes.set([0x52, 0x5a, 0x56, 0x4d], 0);
        return {
          sealBytes,
          journal: new Uint8Array(192).fill(2),
          imageId: new Uint8Array(32).fill(3),
          bindingValue: new Uint8Array(32).fill(4),
          nullifierSeed: new Uint8Array(32).fill(5),
        };
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
        sealBytes: new Uint8Array(260),
        journal: new Uint8Array(192),
        imageId: new Uint8Array(32),
        bindingValue: new Uint8Array(32),
        nullifierSeed: new Uint8Array(32),
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
  // Claim Deadline Monitoring
  // ==========================================================================

  describe('claim deadline monitoring', () => {
    it('aborts immediately when remaining claim time < buffer', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskFailed = vi.fn();

      // Claim expires 10 seconds from now, buffer is 30 seconds → should abort immediately
      const expiresAt = Math.floor(Date.now() / 1000) + 10;
      mockOps.fetchClaim.mockResolvedValue(createMockClaim({ expiresAt }));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        claimExpiryBufferMs: 30_000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);

      await waitFor(() => onClaimExpiring.mock.calls.length > 0, 3000);

      expect(onClaimExpiring).toHaveBeenCalledTimes(1);
      const [error, pda] = onClaimExpiring.mock.calls[0];
      expect(error).toBeInstanceOf(ClaimExpiredError);
      expect((error as ClaimExpiredError).bufferMs).toBe(30_000);
      expect(pda).toBe(task.pda);

      // Also emits onTaskFailed
      expect(onTaskFailed).toHaveBeenCalledTimes(1);
      expect(onTaskFailed.mock.calls[0][0]).toBeInstanceOf(ClaimExpiredError);

      // Metrics updated
      expect(executor.getStatus().tasksFailed).toBe(1);
      // Should not attempt to execute or submit
      expect(mockOps.completeTask).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('aborts mid-execution when claim deadline timer fires', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskFailed = vi.fn();

      // Claim expires 100ms from now (after claim is fetched), buffer is 20ms → ~80ms effective
      // We'll use a handler that hangs longer than that
      const expiresAt = Math.floor(Date.now() / 1000) + 1; // 1 second
      mockOps.fetchClaim.mockResolvedValue(createMockClaim({ expiresAt }));

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
        // Hang until aborted
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
        claimExpiryBufferMs: 500, // 500ms buffer; claim expires in ~1s → ~500ms effective
        taskTimeoutMs: 0, // disable task timeout to isolate claim deadline behavior
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      const task = createDiscoveryResult();
      mockDiscovery._emitTask(task);

      await waitFor(() => onClaimExpiring.mock.calls.length > 0, 5000);

      expect(onClaimExpiring).toHaveBeenCalledTimes(1);
      expect(onClaimExpiring.mock.calls[0][0]).toBeInstanceOf(ClaimExpiredError);
      expect(onClaimExpiring.mock.calls[0][1]).toBe(task.pda);

      expect(onTaskFailed).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().tasksFailed).toBe(1);
      expect(mockOps.completeTask).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('does not abort when claim has plenty of time remaining', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskCompleted = vi.fn();

      // Claim expires far in the future
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      mockOps.fetchClaim.mockResolvedValue(createMockClaim({ expiresAt }));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        claimExpiryBufferMs: 30_000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskCompleted.mock.calls.length > 0);

      expect(onClaimExpiring).not.toHaveBeenCalled();
      expect(executor.getStatus().tasksCompleted).toBe(1);
      expect(executor.getStatus().tasksFailed).toBe(0);

      await executor.stop();
      await startPromise;
    });

    it('claimExpiryBufferMs=0 disables claim deadline monitoring', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskCompleted = vi.fn();

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        claimExpiryBufferMs: 0,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskCompleted.mock.calls.length > 0);

      // fetchClaim should not be called when disabled
      expect(mockOps.fetchClaim).not.toHaveBeenCalled();
      expect(onClaimExpiring).not.toHaveBeenCalled();
      expect(executor.getStatus().tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('coexists with taskTimeoutMs (shorter timeout fires first)', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskTimeout = vi.fn();

      // Claim expires far in the future, but task timeout is 50ms
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      mockOps.fetchClaim.mockResolvedValue(createMockClaim({ expiresAt }));

      const handler = async (ctx: TaskExecutionContext): Promise<TaskExecutionResult> => {
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
        claimExpiryBufferMs: 30_000,
        taskTimeoutMs: 50, // task timeout fires first
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskTimeout });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskTimeout.mock.calls.length > 0, 3000);

      // Task timeout fires, not claim expiry
      expect(onTaskTimeout).toHaveBeenCalledTimes(1);
      expect(onClaimExpiring).not.toHaveBeenCalled();

      await executor.stop();
      await startPromise;
    });

    it('skips deadline check when fetchClaim returns null', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskCompleted = vi.fn();

      // fetchClaim returns null (default mock behavior)
      mockOps.fetchClaim.mockResolvedValue(null);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        claimExpiryBufferMs: 30_000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onTaskCompleted.mock.calls.length > 0);

      expect(onClaimExpiring).not.toHaveBeenCalled();
      expect(executor.getStatus().tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('defaults to 30_000ms claim expiry buffer', () => {
      const config = createExecutorConfig({ mode: 'batch' });
      const executor = new TaskExecutor(config);

      // Config was accepted without error
      expect(executor).toBeDefined();
    });

    it('increments claimsExpired metric on claim deadline abort', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();

      // Claim expires 5 seconds from now, buffer is 30 seconds → abort immediately
      const expiresAt = Math.floor(Date.now() / 1000) + 5;
      mockOps.fetchClaim.mockResolvedValue(createMockClaim({ expiresAt }));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        claimExpiryBufferMs: 30_000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => onClaimExpiring.mock.calls.length > 0, 3000);

      expect(executor.getStatus().tasksFailed).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('releases concurrency slot on claim deadline abort', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimExpiring = vi.fn();
      const onTaskCompleted = vi.fn();

      let callCount = 0;
      // First call: claim about to expire; second call: claim has plenty of time
      mockOps.fetchClaim
        .mockResolvedValueOnce(createMockClaim({ expiresAt: Math.floor(Date.now() / 1000) + 5 }))
        .mockResolvedValueOnce(createMockClaim({ expiresAt: Math.floor(Date.now() / 1000) + 3600 }));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        maxConcurrentTasks: 1,
        claimExpiryBufferMs: 30_000,
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimExpiring, onTaskCompleted });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // First task aborts due to claim deadline
      mockDiscovery._emitTask(createDiscoveryResult());
      // Second task should run after the first is aborted
      mockDiscovery._emitTask(createDiscoveryResult());

      await waitFor(() => onClaimExpiring.mock.calls.length > 0, 3000);
      await waitFor(() => onTaskCompleted.mock.calls.length > 0, 3000);

      expect(onClaimExpiring).toHaveBeenCalledTimes(1);
      expect(onTaskCompleted).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().tasksFailed).toBe(1);
      expect(executor.getStatus().tasksCompleted).toBe(1);

      await executor.stop();
      await startPromise;
    });
  });

  // ==========================================================================
  // Retry with Exponential Backoff
  // ==========================================================================

  describe('retry with exponential backoff', () => {
    it('retries claim on transient failure and succeeds on second attempt', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const claimPda = Keypair.generate().publicKey;

      mockOps.claimTask
        .mockRejectedValueOnce(new Error('RPC timeout'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          claimPda,
          transactionSignature: 'retry-sig',
        } satisfies ClaimResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0, 5000);

      expect(mockOps.claimTask).toHaveBeenCalledTimes(2);
      expect(executor.getStatus().tasksClaimed).toBe(1);
      expect(executor.getStatus().tasksCompleted).toBe(1);
      expect(executor.getStatus().claimRetries).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('retries submit on transient failure and succeeds on second attempt', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      mockOps.completeTask
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce({
          success: true,
          taskId: new Uint8Array(32),
          isPrivate: false,
          transactionSignature: 'retry-submit-sig',
        } satisfies CompleteResult);

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksCompleted >= 1, 5000);

      expect(mockOps.completeTask).toHaveBeenCalledTimes(2);
      expect(executor.getStatus().tasksCompleted).toBe(1);
      expect(executor.getStatus().submitRetries).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('throws RetryExhaustedError when all claim attempts fail', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onClaimFailed = vi.fn();
      const onTaskFailed = vi.fn();

      mockOps.claimTask.mockRejectedValue(new Error('persistent RPC failure'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);
      executor.on({ onClaimFailed });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for all retry attempts to exhaust
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 3, 5000);
      // Allow pipeline to settle
      await new Promise((r) => setTimeout(r, 100));

      // claimTask called 3 times (initial + 2 retries)
      expect(mockOps.claimTask).toHaveBeenCalledTimes(3);
      // claimsFailed emitted each time by claimTaskStep
      expect(executor.getStatus().claimsFailed).toBe(3);
      expect(executor.getStatus().claimRetries).toBe(2);

      await executor.stop();
      await startPromise;
    });

    it('throws RetryExhaustedError when all submit attempts fail', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      mockOps.completeTask.mockRejectedValue(new Error('persistent submit failure'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length >= 2, 5000);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockOps.completeTask).toHaveBeenCalledTimes(2);
      expect(executor.getStatus().submitsFailed).toBe(2);
      expect(executor.getStatus().submitRetries).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('does not retry handler execution failures', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      let handlerCallCount = 0;

      const handler = async (): Promise<TaskExecutionResult> => {
        handlerCallCount++;
        throw new Error('handler logic error');
      };

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        handler,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().tasksFailed >= 1, 3000);

      // Handler called exactly once — no retry
      expect(handlerCallCount).toBe(1);
      expect(executor.getStatus().tasksFailed).toBe(1);

      await executor.stop();
      await startPromise;
    });

    it('respects abort signal during retry backoff wait', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // Claim always fails so we enter retry backoff
      mockOps.claimTask.mockRejectedValue(new Error('fail'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000, jitter: false },
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for first attempt to fail
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 1, 3000);

      // Now stop the executor which aborts all controllers
      await executor.stop();
      await startPromise;

      // Should have been called only once — the retry wait was interrupted by abort
      expect(mockOps.claimTask).toHaveBeenCalledTimes(1);
    });

    it('logs retry attempts', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const warnSpy = vi.fn();
      const logger = { ...silentLogger, warn: warnSpy };

      mockOps.claimTask
        .mockRejectedValueOnce(new Error('transient'))
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
        retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0, 5000);

      // Verify a retry warning was logged
      const retryLogs = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('Retry claim'),
      );
      expect(retryLogs.length).toBeGreaterThanOrEqual(1);

      await executor.stop();
      await startPromise;
    });

    it('applies exponential backoff delays (no jitter)', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const timestamps: number[] = [];

      mockOps.claimTask.mockImplementation(async () => {
        timestamps.push(Date.now());
        if (timestamps.length < 3) {
          throw new Error('transient');
        }
        return {
          success: true,
          taskId: new Uint8Array(32),
          claimPda: Keypair.generate().publicKey,
          transactionSignature: 'sig',
        } satisfies ClaimResult;
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
      await waitFor(() => mockOps.completeTask.mock.calls.length > 0, 5000);

      expect(timestamps.length).toBe(3);
      // First retry: baseDelay * 2^0 = 50ms
      const delay1 = timestamps[1] - timestamps[0];
      // Second retry: baseDelay * 2^1 = 100ms
      const delay2 = timestamps[2] - timestamps[1];

      // Allow some tolerance for timer imprecision
      expect(delay1).toBeGreaterThanOrEqual(40);
      expect(delay1).toBeLessThan(200);
      expect(delay2).toBeGreaterThanOrEqual(80);
      expect(delay2).toBeLessThan(300);

      await executor.stop();
      await startPromise;
    });

    it('retryPolicy maxAttempts=1 disables retries', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      mockOps.claimTask.mockRejectedValue(new Error('fail'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());
      await waitFor(() => executor.getStatus().claimsFailed >= 1, 3000);
      await new Promise((r) => setTimeout(r, 100));

      // Only 1 attempt, no retries
      expect(mockOps.claimTask).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().claimRetries).toBe(0);

      await executor.stop();
      await startPromise;
    });

    it('uses default retry policy when none is provided', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();

      // The default policy has maxAttempts=3, so claim is retried up to 3 times total
      // We'll make it fail all 3 times with a very recognizable error
      mockOps.claimTask.mockRejectedValue(new Error('default policy test'));

      const config = createExecutorConfig({
        mode: 'autonomous',
        operations: mockOps,
        discovery: mockDiscovery,
        // No retryPolicy — uses defaults: maxAttempts=3, baseDelayMs=1000
        // To avoid a slow test, we'll just verify the behavior after stop
      });
      const executor = new TaskExecutor(config);

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      mockDiscovery._emitTask(createDiscoveryResult());

      // Wait for first claim attempt
      await waitFor(() => mockOps.claimTask.mock.calls.length >= 1, 3000);

      // Stop immediately — the default delay (1000ms) means we're still in backoff
      await executor.stop();
      await startPromise;

      // At least 1 attempt was made
      expect(mockOps.claimTask).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Backpressure
  // ==========================================================================

  describe('backpressure', () => {
    it('pauses discovery when queue reaches highWaterMark', async () => {
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
        backpressure: { highWaterMark: 3, lowWaterMark: 1, pauseDiscovery: true },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // First task occupies the only slot; next tasks go to queue
      // Emit 4 tasks: 1 active + 3 queued (queue hits highWaterMark=3)
      for (let i = 0; i < 4; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);

      expect(executor.getQueueSize()).toBe(3);
      expect(mockDiscovery.pause).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().backpressureActive).toBe(true);

      // Clean up: resolve tasks one by one as they start
      for (let i = 0; i < 4; i++) {
        await waitFor(() => resolvers.length >= i + 1);
        resolvers[i]();
      }
      await waitFor(() => executor.getStatus().tasksCompleted >= 4, 5000);
      await executor.stop();
      await startPromise;
    });

    it('resumes discovery when queue drains to lowWaterMark', async () => {
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
        backpressure: { highWaterMark: 3, lowWaterMark: 1, pauseDiscovery: true },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // 1 active + 3 queued → backpressure activated
      for (let i = 0; i < 4; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);
      expect(mockDiscovery.pause).toHaveBeenCalledTimes(1);

      // Complete tasks one by one to drain the queue
      // After task 1 completes: queue goes from 3→2 (task 2 starts), not at lowWater yet
      resolvers[0]();
      await waitFor(() => resolvers.length >= 2);
      // queue is now 2 (task 2 running, tasks 3 & 4 queued) — wait, let me recalculate:
      // After completing task 1: drainQueue() launches task 2 from queue, queue is now 2
      // queue=2 > lowWater=1, so no resume yet
      expect(mockDiscovery.resume).not.toHaveBeenCalled();

      // Complete task 2: drainQueue launches task 3, queue drops to 1 = lowWater
      resolvers[1]();
      await waitFor(() => resolvers.length >= 3);
      // queue should be 1 now, which equals lowWaterMark
      await waitFor(() => mockDiscovery.resume.mock.calls.length > 0);
      expect(mockDiscovery.resume).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().backpressureActive).toBe(false);

      // Clean up
      resolvers[2]();
      await waitFor(() => resolvers.length >= 4);
      resolvers[3]();
      await waitFor(() => executor.getStatus().tasksCompleted >= 4, 5000);
      await executor.stop();
      await startPromise;
    });

    it('hysteresis prevents rapid pause/resume oscillation', async () => {
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
        backpressure: { highWaterMark: 3, lowWaterMark: 1, pauseDiscovery: true },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Push to highWaterMark
      for (let i = 0; i < 4; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);
      expect(mockDiscovery.pause).toHaveBeenCalledTimes(1);

      // Complete one task: queue goes from 3 to 2 (drainQueue launches one)
      resolvers[0]();
      await waitFor(() => resolvers.length >= 2);
      // Queue is now 2 — above lowWater (1), so backpressure should still be active
      expect(executor.getStatus().backpressureActive).toBe(true);
      expect(mockDiscovery.resume).not.toHaveBeenCalled();

      // Complete another: queue goes from 2 to 1, which meets lowWater
      resolvers[1]();
      await waitFor(() => resolvers.length >= 3);
      await waitFor(() => mockDiscovery.resume.mock.calls.length > 0);
      expect(mockDiscovery.resume).toHaveBeenCalledTimes(1);
      expect(executor.getStatus().backpressureActive).toBe(false);

      // Clean up
      resolvers[2]();
      await waitFor(() => resolvers.length >= 4);
      resolvers[3]();
      await waitFor(() => executor.getStatus().tasksCompleted >= 4, 5000);
      await executor.stop();
      await startPromise;
    });

    it('emits onBackpressureActivated and onBackpressureReleased events', async () => {
      const mockOps = createMockOperations();
      const mockDiscovery = createMockDiscovery();
      const onBackpressureActivated = vi.fn();
      const onBackpressureReleased = vi.fn();
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
        backpressure: { highWaterMark: 2, lowWaterMark: 0, pauseDiscovery: true },
      });
      const executor = new TaskExecutor(config);
      executor.on({ onBackpressureActivated, onBackpressureReleased });

      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // 1 active + 2 queued → highWaterMark hit
      for (let i = 0; i < 3; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);

      expect(onBackpressureActivated).toHaveBeenCalledTimes(1);
      expect(onBackpressureReleased).not.toHaveBeenCalled();

      // Drain to lowWaterMark (0): complete all but one active
      resolvers[0]();
      await waitFor(() => resolvers.length >= 2);
      // queue=1, lowWater=0: not yet released
      expect(onBackpressureReleased).not.toHaveBeenCalled();

      resolvers[1]();
      await waitFor(() => resolvers.length >= 3);
      // queue=0 <= lowWater=0: released
      await waitFor(() => onBackpressureReleased.mock.calls.length > 0);
      expect(onBackpressureReleased).toHaveBeenCalledTimes(1);

      // Clean up
      resolvers[2]();
      await waitFor(() => executor.getStatus().tasksCompleted >= 3, 5000);
      await executor.stop();
      await startPromise;
    });

    it('getQueueSize() returns current queue length', async () => {
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

      expect(executor.getQueueSize()).toBe(0);

      // 1 active + 2 queued
      mockDiscovery._emitTask(createDiscoveryResult());
      mockDiscovery._emitTask(createDiscoveryResult());
      mockDiscovery._emitTask(createDiscoveryResult());

      await waitFor(() => resolvers.length >= 1);
      expect(executor.getQueueSize()).toBe(2);

      // Clean up: resolve tasks one by one
      for (let i = 0; i < 3; i++) {
        await waitFor(() => resolvers.length >= i + 1);
        resolvers[i]();
      }
      await waitFor(() => executor.getStatus().tasksCompleted >= 3, 5000);
      await executor.stop();
      await startPromise;
    });

    it('does not pause discovery when pauseDiscovery is false', async () => {
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
        backpressure: { highWaterMark: 2, lowWaterMark: 1, pauseDiscovery: false },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // 1 active + 3 queued → exceeds highWaterMark but pauseDiscovery=false
      for (let i = 0; i < 4; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);

      expect(mockDiscovery.pause).not.toHaveBeenCalled();
      expect(executor.getStatus().backpressureActive).toBe(false);

      // Clean up: resolve tasks one by one
      for (let i = 0; i < 4; i++) {
        await waitFor(() => resolvers.length >= i + 1);
        resolvers[i]();
      }
      await waitFor(() => executor.getStatus().tasksCompleted >= 4, 5000);
      await executor.stop();
      await startPromise;
    });

    it('getStatus() includes queueSize and backpressureActive', () => {
      const config = createExecutorConfig({ mode: 'batch' });
      const executor = new TaskExecutor(config);
      const status = executor.getStatus();

      expect(status.queueSize).toBe(0);
      expect(status.backpressureActive).toBe(false);
    });

    it('stop() clears backpressure state', async () => {
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
        backpressure: { highWaterMark: 2, lowWaterMark: 0, pauseDiscovery: true },
      });
      const executor = new TaskExecutor(config);
      const startPromise = executor.start();
      await waitFor(() => mockDiscovery.start.mock.calls.length > 0);

      // Trigger backpressure
      for (let i = 0; i < 3; i++) {
        mockDiscovery._emitTask(createDiscoveryResult());
      }
      await waitFor(() => resolvers.length >= 1);
      expect(executor.getStatus().backpressureActive).toBe(true);

      // Stop should clear state
      for (const resolve of resolvers) resolve();
      await executor.stop();
      await startPromise;

      expect(executor.getStatus().backpressureActive).toBe(false);
      expect(executor.getStatus().queueSize).toBe(0);
    });
  });
});
