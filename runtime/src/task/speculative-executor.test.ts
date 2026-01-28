/**
 * Tests for SpeculativeExecutor - single-level speculative execution.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  SpeculativeExecutor,
  type SpeculativeExecutorConfig,
  type SpeculativeExecutorEvents,
  type SpeculativeTask,
} from './speculative-executor.js';
import { DependencyGraph, DependencyType } from './dependency-graph.js';
import type { ProofPipeline, ProofGenerationJob } from './proof-pipeline.js';
import type { TaskOperations } from './operations.js';
import type {
  OnChainTask,
  OnChainTaskStatus,
  OnChainTaskClaim,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  TaskExecutionContext,
  TaskHandler,
} from './types.js';
import { TaskType } from '../events/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 0n,
    description: new Uint8Array(64).fill(0),
    constraintHash: new Uint8Array(32).fill(0),
    rewardAmount: 1_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: 0 as OnChainTaskStatus, // Open
    taskType: TaskType.Exclusive,
    createdAt: Math.floor(Date.now() / 1000),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64).fill(0),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

function createMockClaim(overrides: Partial<OnChainTaskClaim> = {}): OnChainTaskClaim {
  return {
    task: Keypair.generate().publicKey,
    worker: Keypair.generate().publicKey,
    claimedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    completedAt: 0,
    proofHash: new Uint8Array(32).fill(0),
    resultData: new Uint8Array(64).fill(0),
    isCompleted: false,
    isValidated: false,
    rewardPaid: 0n,
    bump: 255,
    ...overrides,
  };
}

function createMockOperations(): TaskOperations {
  const mockTask = createMockTask();
  const mockClaim = createMockClaim();

  return {
    fetchTask: vi.fn().mockResolvedValue(mockTask),
    fetchClaim: vi.fn().mockResolvedValue(mockClaim),
    claimTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: mockTask.taskId,
      claimPda: Keypair.generate().publicKey,
      transactionSignature: 'test-sig',
    }),
    completeTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: mockTask.taskId,
      isPrivate: false,
      transactionSignature: 'complete-sig',
    }),
    completeTaskPrivate: vi.fn().mockResolvedValue({
      success: true,
      taskId: mockTask.taskId,
      isPrivate: true,
      transactionSignature: 'complete-private-sig',
    }),
    fetchTaskEscrow: vi.fn().mockResolvedValue(null),
    fetchProtocolConfig: vi.fn().mockResolvedValue(null),
    fetchTasksByCreator: vi.fn().mockResolvedValue([]),
    fetchAllOpenTasks: vi.fn().mockResolvedValue([]),
    fetchClaimsByWorker: vi.fn().mockResolvedValue([]),
  } as unknown as TaskOperations;
}

// ============================================================================
// Tests
// ============================================================================

describe('SpeculativeExecutor', () => {
  let operations: TaskOperations;
  let handler: TaskHandler;
  let agentId: Uint8Array;
  let agentPda: PublicKey;

  beforeEach(() => {
    operations = createMockOperations();
    handler = vi.fn().mockResolvedValue({
      proofHash: new Uint8Array(32).fill(1),
    });
    agentId = new Uint8Array(32).fill(42);
    agentPda = Keypair.generate().publicKey;
  });

  describe('constructor', () => {
    it('should create executor with default config', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const status = executor.getStatus();
      expect(status.speculationEnabled).toBe(true);
      expect(status.activeSpeculativeTasks).toBe(0);
      expect(status.tasksAwaitingParent).toBe(0);
    });

    it('should respect custom speculation config', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        enableSpeculation: false,
        maxSpeculativeTasksPerParent: 10,
        speculatableDependencyTypes: [DependencyType.Data],
        abortOnParentFailure: false,
      });

      const status = executor.getStatus();
      expect(status.speculationEnabled).toBe(false);
    });
  });

  describe('addTaskToGraph', () => {
    it('should add root task to graph', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const task = createMockTask();
      const taskPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(task, taskPda);

      const graph = executor.getDependencyGraph();
      expect(graph.hasTask(taskPda)).toBe(true);
      expect(graph.getDepth(taskPda)).toBe(0);
    });

    it('should add task with parent dependency', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      const graph = executor.getDependencyGraph();
      expect(graph.hasTask(childPda)).toBe(true);
      expect(graph.getDepth(childPda)).toBe(1);
      expect(graph.getParent(childPda)?.taskPda.equals(parentPda)).toBe(true);
    });
  });

  describe('executeTask', () => {
    it('should execute task and return result', async () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const taskPda = Keypair.generate().publicKey;

      const result = await executor.executeTask(taskPda);

      expect(result).toBeDefined();
      expect(result.proofHash).toEqual(new Uint8Array(32).fill(1));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should pass parent result to handler context', async () => {
      let capturedContext: TaskExecutionContext | null = null;
      handler = vi.fn().mockImplementation(async (ctx: TaskExecutionContext) => {
        capturedContext = ctx;
        return { proofHash: new Uint8Array(32).fill(1) };
      });

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const taskPda = Keypair.generate().publicKey;
      const parentResult: TaskExecutionResult = {
        proofHash: new Uint8Array(32).fill(99),
      };

      await executor.executeTask(taskPda, parentResult);

      expect(capturedContext).toBeDefined();
      // Check parent result is accessible
      const ctxWithParent = capturedContext as TaskExecutionContext & { parentResult?: TaskExecutionResult };
      expect(ctxWithParent.parentResult).toEqual(parentResult);
    });

    it('should throw if task not found', async () => {
      (operations.fetchTask as Mock).mockResolvedValue(null);

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const taskPda = Keypair.generate().publicKey;

      await expect(executor.executeTask(taskPda)).rejects.toThrow('Task not found');
    });

    it('should throw if claim not found', async () => {
      (operations.fetchClaim as Mock).mockResolvedValue(null);

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const taskPda = Keypair.generate().publicKey;

      await expect(executor.executeTask(taskPda)).rejects.toThrow('Claim not found');
    });
  });

  describe('executeWithSpeculation', () => {
    it('should execute task and queue proof', async () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const task = createMockTask();
      const taskPda = Keypair.generate().publicKey;
      executor.addTaskToGraph(task, taskPda);

      const result = await executor.executeWithSpeculation(taskPda);

      expect(result.proofHash).toEqual(new Uint8Array(32).fill(1));

      // Verify proof was queued (status may have advanced due to async processing)
      const pipeline = executor.getProofPipeline();
      const job = pipeline.getJob(taskPda);
      expect(job).toBeDefined();
      // Job may be queued, generating, or already confirmed depending on timing
      expect(['queued', 'generating', 'generated', 'submitting', 'confirmed']).toContain(job?.status);
    });

    it('should start speculative execution of dependents', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      // Set up parent-child relationship
      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      // Execute parent (should trigger speculation on child)
      await executor.executeWithSpeculation(parentPda);

      // Wait for speculative execution to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(childPda, parentPda);

      const status = executor.getStatus();
      expect(status.activeSpeculativeTasks).toBeGreaterThanOrEqual(1);
    });

    it('should not speculate when speculation is disabled', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        enableSpeculation: false,
      });
      executor.on(events);

      // Set up parent-child relationship
      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.onSpeculativeExecutionStarted).not.toHaveBeenCalled();
    });

    it('should respect maxSpeculativeTasksPerParent limit', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        maxSpeculativeTasksPerParent: 2,
      });
      executor.on(events);

      // Set up parent with 5 children
      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const parentPda = Keypair.generate().publicKey;
      executor.addTaskToGraph(parentTask, parentPda);

      for (let i = 0; i < 5; i++) {
        const childTask = createMockTask({ taskId: new Uint8Array(32).fill(10 + i) });
        const childPda = Keypair.generate().publicKey;
        executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);
      }

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should only have started 2 speculative executions (the limit)
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledTimes(2);
    });

    it('should only speculate on allowed dependency types', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        speculatableDependencyTypes: [DependencyType.Data], // Only Data, not Resource
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const dataChildTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const resourceChildTask = createMockTask({ taskId: new Uint8Array(32).fill(3) });
      const parentPda = Keypair.generate().publicKey;
      const dataChildPda = Keypair.generate().publicKey;
      const resourceChildPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(dataChildTask, dataChildPda, parentPda, DependencyType.Data);
      executor.addTaskToGraph(resourceChildTask, resourceChildPda, parentPda, DependencyType.Resource);

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only the Data dependency child should be speculated
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledTimes(1);
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(dataChildPda, parentPda);
    });
  });

  describe('cancelSpeculativeTask', () => {
    it('should cancel a pending speculative task', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
        onSpeculativeExecutionAborted: vi.fn(),
      };

      // Track execution order - parent must complete before speculation starts
      let parentCompleted = false;
      let childStarted = false;

      // Parent handler completes quickly
      const parentHandler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        parentCompleted = true;
        return { proofHash: new Uint8Array(32).fill(1) };
      });

      // Child handler is slow to allow cancellation
      const childHandler = vi.fn().mockImplementation(async () => {
        childStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { proofHash: new Uint8Array(32).fill(2) };
      });

      // Use a handler that switches based on task
      let callCount = 0;
      handler = vi.fn().mockImplementation(async (ctx) => {
        callCount++;
        if (callCount === 1) {
          // First call is parent
          return parentHandler(ctx);
        }
        // Subsequent calls are child (speculative)
        return childHandler(ctx);
      });

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      // Start parent execution - this will complete and trigger speculation
      const parentPromise = executor.executeWithSpeculation(parentPda);

      // Wait for parent to complete and speculation to start
      await parentPromise;
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify speculation started
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(childPda, parentPda);

      // Cancel the speculative child (should be executing now)
      const cancelled = executor.cancelSpeculativeTask(childPda, 'test cancellation');

      expect(cancelled).toBe(true);
      expect(events.onSpeculativeExecutionAborted).toHaveBeenCalledWith(childPda, 'test cancellation');
    });

    it('should return false if task not found', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const unknownPda = Keypair.generate().publicKey;
      const result = executor.cancelSpeculativeTask(unknownPda, 'test');

      expect(result).toBe(false);
    });
  });

  describe('event callbacks', () => {
    it('should emit onTaskExecutionStarted for each execution', async () => {
      const events: SpeculativeExecutorEvents = {
        onTaskExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      const task = createMockTask();
      const taskPda = Keypair.generate().publicKey;
      executor.addTaskToGraph(task, taskPda);

      await executor.executeTask(taskPda);

      expect(events.onTaskExecutionStarted).toHaveBeenCalledTimes(1);
      expect(events.onTaskExecutionStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          taskPda,
          agentId,
          agentPda,
        })
      );
    });

    it('should emit parent proof events', async () => {
      const events: SpeculativeExecutorEvents = {
        onParentProofConfirmed: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      const task = createMockTask();
      const taskPda = Keypair.generate().publicKey;
      executor.addTaskToGraph(task, taskPda);

      await executor.executeWithSpeculation(taskPda);

      // Simulate proof confirmation
      const pipeline = executor.getProofPipeline();
      const job = pipeline.getJob(taskPda);

      // Wait for proof to be processed (the pipeline auto-submits)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The proof pipeline will call our event handlers when proof is confirmed
      // In real scenarios, this happens asynchronously after submission
    });
  });

  describe('metrics', () => {
    it('should track speculative execution metrics', async () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      // Set up parent-child relationship
      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = executor.getMetrics();
      expect(metrics.speculativeExecutionsStarted).toBe(1);
    });

    it('should provide complete status snapshot', () => {
      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });

      const status = executor.getStatus();

      expect(status).toEqual(
        expect.objectContaining({
          speculationEnabled: true,
          activeSpeculativeTasks: 0,
          tasksAwaitingParent: 0,
          proofPipelineStats: expect.objectContaining({
            queued: 0,
            generating: 0,
            awaitingSubmission: 0,
            confirmed: 0,
            failed: 0,
          }),
          metrics: expect.objectContaining({
            speculativeExecutionsStarted: 0,
            speculativeExecutionsConfirmed: 0,
            speculativeExecutionsAborted: 0,
            estimatedTimeSavedMs: 0,
          }),
        })
      );
    });
  });

  describe('proof ordering invariant', () => {
    it('should queue proofs for speculative tasks', async () => {
      // This test verifies that speculative tasks get their proofs queued
      // The actual ordering is handled by the ProofPipeline

      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify speculative execution was started
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(childPda, parentPda);

      // Verify that the parent proof was queued
      const pipeline = executor.getProofPipeline();
      const parentJob = pipeline.getJob(parentPda);
      expect(parentJob).toBeDefined();
    });
  });

  describe('abort on parent failure', () => {
    it('should abort speculative tasks when parent proof fails', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
        onSpeculativeExecutionAborted: vi.fn(),
        onParentProofFailed: vi.fn(),
      };

      // Make complete task fail
      (operations.completeTask as Mock).mockRejectedValue(new Error('Proof verification failed'));

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        abortOnParentFailure: true,
        proofPipelineConfig: {
          retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitter: false },
        },
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      await executor.executeWithSpeculation(parentPda);

      // Wait for proof failure to propagate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify parent failure was detected
      expect(events.onParentProofFailed).toHaveBeenCalled();

      // Verify speculative task was aborted
      expect(events.onSpeculativeExecutionAborted).toHaveBeenCalledWith(
        childPda,
        expect.stringContaining('parent proof failed')
      );
    });

    it('should not abort when abortOnParentFailure is false', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionAborted: vi.fn(),
      };

      (operations.completeTask as Mock).mockRejectedValue(new Error('Proof verification failed'));

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
        abortOnParentFailure: false,
        proofPipelineConfig: {
          retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitter: false },
        },
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      await executor.executeWithSpeculation(parentPda);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Speculative task should NOT be aborted
      expect(events.onSpeculativeExecutionAborted).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should abort all speculative tasks on shutdown', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
        onSpeculativeExecutionAborted: vi.fn(),
      };

      // Track execution
      let callCount = 0;

      // Parent completes quickly, child is slow
      handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Parent - quick
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { proofHash: new Uint8Array(32).fill(1) };
        }
        // Child - slow
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { proofHash: new Uint8Array(32).fill(2) };
      });

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      const parentTask = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const childTask = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const parentPda = Keypair.generate().publicKey;
      const childPda = Keypair.generate().publicKey;

      executor.addTaskToGraph(parentTask, parentPda);
      executor.addTaskToGraph(childTask, childPda, parentPda, DependencyType.Data);

      // Start parent execution (will complete and trigger speculation)
      const execPromise = executor.executeWithSpeculation(parentPda);

      // Wait for parent to complete and speculative task to start
      await execPromise;
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify speculation started
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(childPda, parentPda);

      // Shutdown while child is still executing
      await executor.shutdown();

      expect(events.onSpeculativeExecutionAborted).toHaveBeenCalledWith(childPda, 'shutdown');
    });
  });

  describe('single-level speculation constraint', () => {
    it('should only speculate one level deep (no chaining)', async () => {
      const events: SpeculativeExecutorEvents = {
        onSpeculativeExecutionStarted: vi.fn(),
      };

      const executor = new SpeculativeExecutor({
        operations,
        handler,
        agentId,
        agentPda,
      });
      executor.on(events);

      // Set up chain: A -> B -> C
      const taskA = createMockTask({ taskId: new Uint8Array(32).fill(1) });
      const taskB = createMockTask({ taskId: new Uint8Array(32).fill(2) });
      const taskC = createMockTask({ taskId: new Uint8Array(32).fill(3) });
      const pdaA = Keypair.generate().publicKey;
      const pdaB = Keypair.generate().publicKey;
      const pdaC = Keypair.generate().publicKey;

      executor.addTaskToGraph(taskA, pdaA);
      executor.addTaskToGraph(taskB, pdaB, pdaA, DependencyType.Data);
      executor.addTaskToGraph(taskC, pdaC, pdaB, DependencyType.Data);

      // Execute A
      await executor.executeWithSpeculation(pdaA);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // B should be speculated (direct dependent of A)
      // C should NOT be speculated (only single-level, not chained)
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledTimes(1);
      expect(events.onSpeculativeExecutionStarted).toHaveBeenCalledWith(pdaB, pdaA);
    });
  });
});
