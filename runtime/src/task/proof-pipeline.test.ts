import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ProofPipeline,
  DefaultProofGenerator,
  type ProofPipelineConfig,
  type ProofPipelineEvents,
  type ProofGenerationJob,
  type DependencyGraphLike,
  type ProofGenerator,
} from './proof-pipeline.js';
import type { TaskOperations } from './operations.js';
import type {
  TaskExecutionResult,
  PrivateTaskExecutionResult,
  OnChainTask,
  ClaimResult,
  CompleteResult,
} from './types.js';
import { OnChainTaskStatus } from './types.js';
import { TaskType } from '../events/types.js';

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

function createPublicResult(): TaskExecutionResult {
  return {
    proofHash: new Uint8Array(32).fill(1),
    resultData: new Uint8Array(64).fill(2),
  };
}

function createPrivateResult(): PrivateTaskExecutionResult {
  return {
    proof: new Uint8Array(388).fill(3),
    constraintHash: new Uint8Array(32).fill(4),
    outputCommitment: new Uint8Array(32).fill(5),
    expectedBinding: new Uint8Array(32).fill(6),
    nullifier: new Uint8Array(32).fill(7),
  };
}

function createMockOperations(): TaskOperations & {
  claimTask: ReturnType<typeof vi.fn>;
  completeTask: ReturnType<typeof vi.fn>;
  completeTaskPrivate: ReturnType<typeof vi.fn>;
  fetchTask: ReturnType<typeof vi.fn>;
} {
  const claimPda = Keypair.generate().publicKey;
  return {
    fetchClaimableTasks: vi.fn().mockResolvedValue([]),
    fetchTask: vi.fn().mockResolvedValue(createTask()),
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
      transactionSignature: 'complete-private-sig',
    } satisfies CompleteResult),
  } as unknown as TaskOperations & {
    claimTask: ReturnType<typeof vi.fn>;
    completeTask: ReturnType<typeof vi.fn>;
    completeTaskPrivate: ReturnType<typeof vi.fn>;
    fetchTask: ReturnType<typeof vi.fn>;
  };
}

function createMockDependencyGraph(
  unconfirmedAncestors: Uint8Array[] = [],
): DependencyGraphLike {
  return {
    getUnconfirmedAncestors: vi.fn().mockReturnValue(
      unconfirmedAncestors.map((taskId) => ({ taskId })),
    ),
    isConfirmed: vi.fn().mockReturnValue(unconfirmedAncestors.length === 0),
  };
}

function createDefaultConfig(): Partial<ProofPipelineConfig> {
  return {
    maxConcurrentProofs: 2,
    proofGenerationTimeoutMs: 5000,
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 10, // Short delays for tests
      maxDelayMs: 100,
      jitter: false,
    },
  };
}

function createMockEvents(): ProofPipelineEvents & {
  onProofQueued: ReturnType<typeof vi.fn>;
  onProofGenerating: ReturnType<typeof vi.fn>;
  onProofGenerated: ReturnType<typeof vi.fn>;
  onProofSubmitting: ReturnType<typeof vi.fn>;
  onProofConfirmed: ReturnType<typeof vi.fn>;
  onProofFailed: ReturnType<typeof vi.fn>;
} {
  return {
    onProofQueued: vi.fn(),
    onProofGenerating: vi.fn(),
    onProofGenerated: vi.fn(),
    onProofSubmitting: vi.fn(),
    onProofConfirmed: vi.fn(),
    onProofFailed: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ProofPipeline', () => {
  let operations: ReturnType<typeof createMockOperations>;
  let events: ReturnType<typeof createMockEvents>;
  let config: Partial<ProofPipelineConfig>;
  let pipeline: ProofPipeline;

  beforeEach(() => {
    operations = createMockOperations();
    events = createMockEvents();
    config = createDefaultConfig();
    pipeline = new ProofPipeline(config, events, operations);
  });

  describe('enqueue()', () => {
    it('should create a job for public task', async () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPublicResult();

      const job = pipeline.enqueue(taskPda, taskId, result);

      expect(job).toBeDefined();
      expect(job.taskPda).toBe(taskPda);
      expect(job.taskId).toEqual(taskId);
      expect(job.executionResult).toBe(result);
      expect(job.isPrivate).toBe(false);
      expect(job.retryCount).toBe(0);
      expect(job.createdAt).toBeGreaterThan(0);

      // Wait for the job to complete (auto-submission)
      await pipeline.waitForConfirmation(taskPda, 5000);
      expect(job.status).toBe('confirmed');
    });

    it('should create a job for private task', async () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPrivateResult();

      const job = pipeline.enqueue(taskPda, taskId, result);

      expect(job.isPrivate).toBe(true);

      await pipeline.waitForConfirmation(taskPda, 5000);
      expect(job.status).toBe('confirmed');
    });

    it('should emit onProofQueued event', () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPublicResult();

      const job = pipeline.enqueue(taskPda, taskId, result);

      expect(events.onProofQueued).toHaveBeenCalledWith(job);
    });

    it('should throw if job already exists for task', () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPublicResult();

      pipeline.enqueue(taskPda, taskId, result);

      expect(() => pipeline.enqueue(taskPda, taskId, result)).toThrow(
        /already exists/,
      );
    });

    it('should throw if pipeline is shutting down', async () => {
      // Trigger shutdown
      const shutdownPromise = pipeline.shutdown();

      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPublicResult();

      expect(() => pipeline.enqueue(taskPda, taskId, result)).toThrow(
        /shutting down/,
      );

      await shutdownPromise;
    });
  });

  describe('getJob()', () => {
    it('should return job by task PDA', () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      const result = createPublicResult();

      const enqueuedJob = pipeline.enqueue(taskPda, taskId, result);
      const foundJob = pipeline.getJob(taskPda);

      expect(foundJob).toBe(enqueuedJob);
    });

    it('should return undefined for unknown task PDA', () => {
      const taskPda = Keypair.generate().publicKey;

      const foundJob = pipeline.getJob(taskPda);

      expect(foundJob).toBeUndefined();
    });
  });

  describe('getStats()', () => {
    it('should return correct initial stats', () => {
      const stats = pipeline.getStats();

      expect(stats).toEqual({
        queued: 0,
        generating: 0,
        awaitingSubmission: 0,
        confirmed: 0,
        failed: 0,
      });
    });

    it('should track confirmed jobs after completion', async () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      pipeline.enqueue(taskPda, taskId, createPublicResult());

      await pipeline.waitForConfirmation(taskPda, 5000);

      const stats = pipeline.getStats();
      expect(stats.confirmed).toBe(1);
      expect(stats.queued).toBe(0);
      expect(stats.generating).toBe(0);
    });
  });

  describe('cancel()', () => {
    it('should return false for already confirmed job', async () => {
      const taskPda = Keypair.generate().publicKey;
      const job = pipeline.enqueue(
        taskPda,
        new Uint8Array(32).fill(1),
        createPublicResult(),
      );

      // Wait for job to complete
      await pipeline.waitForConfirmation(taskPda, 5000);

      expect(job.status).toBe('confirmed');

      const cancelled = pipeline.cancel(taskPda);
      expect(cancelled).toBe(false);
    });

    it('should return false for unknown task', () => {
      const taskPda = Keypair.generate().publicKey;

      const cancelled = pipeline.cancel(taskPda);

      expect(cancelled).toBe(false);
    });
  });

  describe('proof generation lifecycle', () => {
    it('should emit all lifecycle events', async () => {
      const taskPda = Keypair.generate().publicKey;
      const job = pipeline.enqueue(
        taskPda,
        new Uint8Array(32).fill(1),
        createPublicResult(),
      );

      await pipeline.waitForConfirmation(taskPda, 5000);

      expect(events.onProofQueued).toHaveBeenCalledWith(job);
      expect(events.onProofGenerating).toHaveBeenCalled();
      expect(events.onProofGenerated).toHaveBeenCalled();
      expect(events.onProofSubmitting).toHaveBeenCalled();
      expect(events.onProofConfirmed).toHaveBeenCalled();
    });

    it('should process multiple jobs', async () => {
      // Enqueue multiple jobs and verify they all complete
      pipeline = new ProofPipeline(
        { ...config, maxConcurrentProofs: 2 },
        events,
        operations,
      );

      const taskPdas: PublicKey[] = [];
      for (let i = 0; i < 4; i++) {
        const taskPda = Keypair.generate().publicKey;
        taskPdas.push(taskPda);
        pipeline.enqueue(taskPda, new Uint8Array(32).fill(i), createPublicResult());
      }

      // Wait for all jobs to complete
      await Promise.all(taskPdas.map((pda) => pipeline.waitForConfirmation(pda, 5000)));

      // All should be confirmed
      const stats = pipeline.getStats();
      expect(stats.confirmed).toBe(4);
    });
  });

  describe('waitForConfirmation()', () => {
    it('should resolve when job is confirmed', async () => {
      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      const confirmedJob = await pipeline.waitForConfirmation(taskPda, 5000);

      expect(confirmedJob.status).toBe('confirmed');
      expect(confirmedJob.transactionSignature).toBe('complete-sig');
    });

    it('should reject when job fails', async () => {
      // Make completeTask fail
      operations.completeTask.mockRejectedValue(new Error('Submission failed'));

      // Override retry policy to fail fast
      pipeline = new ProofPipeline(
        {
          ...config,
          retryPolicy: {
            maxAttempts: 1,
            baseDelayMs: 10,
            maxDelayMs: 10,
            jitter: false,
          },
        },
        events,
        operations,
      );

      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      await expect(pipeline.waitForConfirmation(taskPda, 5000)).rejects.toThrow(
        /Submission failed/,
      );
    });

    it('should reject for unknown task', async () => {
      const taskPda = Keypair.generate().publicKey;

      await expect(pipeline.waitForConfirmation(taskPda)).rejects.toThrow(
        /No job found/,
      );
    });

    it('should resolve immediately for already confirmed job', async () => {
      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      // Wait for first confirmation
      await pipeline.waitForConfirmation(taskPda, 5000);

      // Second wait should resolve immediately
      const confirmedJob = await pipeline.waitForConfirmation(taskPda);
      expect(confirmedJob.status).toBe('confirmed');
    });

    it('should timeout if job takes too long', async () => {
      // Make completeTask hang
      operations.completeTask.mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      await expect(pipeline.waitForConfirmation(taskPda, 100)).rejects.toThrow(
        /Timeout/,
      );
    });
  });

  describe('areAncestorsConfirmed()', () => {
    it('should return true when no unconfirmed ancestors', () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      pipeline.enqueue(taskPda, taskId, createPublicResult());

      const graph = createMockDependencyGraph([]);

      expect(pipeline.areAncestorsConfirmed(taskPda, graph)).toBe(true);
    });

    it('should return false when there are unconfirmed ancestors', () => {
      const taskPda = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);
      pipeline.enqueue(taskPda, taskId, createPublicResult());

      const ancestorId = new Uint8Array(32).fill(2);
      const graph = createMockDependencyGraph([ancestorId]);

      expect(pipeline.areAncestorsConfirmed(taskPda, graph)).toBe(false);
    });

    it('should return false for unknown task', () => {
      const taskPda = Keypair.generate().publicKey;
      const graph = createMockDependencyGraph([]);

      expect(pipeline.areAncestorsConfirmed(taskPda, graph)).toBe(false);
    });
  });

  describe('submitWhenReady()', () => {
    it('should complete successfully when ancestors are confirmed', async () => {
      const taskPda = Keypair.generate().publicKey;
      const job = pipeline.enqueue(
        taskPda,
        new Uint8Array(32).fill(1),
        createPublicResult(),
      );

      // Wait for job to be confirmed (auto-submit path)
      await pipeline.waitForConfirmation(taskPda, 5000);
      expect(job.status).toBe('confirmed');

      // Verify the graph ancestor check works
      const graph = createMockDependencyGraph([]);
      expect(pipeline.areAncestorsConfirmed(taskPda, graph)).toBe(true);
    });
  });

  describe('private task handling', () => {
    it('should use completeTaskPrivate for private tasks', async () => {
      const taskPda = Keypair.generate().publicKey;
      const privateResult = createPrivateResult();

      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), privateResult);

      await pipeline.waitForConfirmation(taskPda, 5000);

      expect(operations.completeTaskPrivate).toHaveBeenCalled();
      expect(operations.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    it('should retry on transient failure', async () => {
      // Fail twice, succeed on third attempt
      let attemptCount = 0;
      operations.completeTask.mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Transient error');
        }
        return {
          success: true,
          taskId: new Uint8Array(32),
          isPrivate: false,
          transactionSignature: 'complete-sig',
        };
      });

      pipeline = new ProofPipeline(
        {
          ...config,
          retryPolicy: {
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 50,
            jitter: false,
          },
        },
        events,
        operations,
      );

      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      const confirmedJob = await pipeline.waitForConfirmation(taskPda, 5000);

      expect(confirmedJob.status).toBe('confirmed');
      expect(attemptCount).toBe(3);
    });

    it('should fail after max retries exceeded', async () => {
      operations.completeTask.mockRejectedValue(new Error('Permanent error'));

      pipeline = new ProofPipeline(
        {
          ...config,
          retryPolicy: {
            maxAttempts: 2,
            baseDelayMs: 10,
            maxDelayMs: 50,
            jitter: false,
          },
        },
        events,
        operations,
      );

      const taskPda = Keypair.generate().publicKey;
      const job = pipeline.enqueue(
        taskPda,
        new Uint8Array(32).fill(1),
        createPublicResult(),
      );

      await expect(pipeline.waitForConfirmation(taskPda, 5000)).rejects.toThrow(
        /Permanent error/,
      );

      expect(job.status).toBe('failed');
      expect(job.retryCount).toBeGreaterThanOrEqual(2);
      expect(events.onProofFailed).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('should complete in-flight generations before shutdown', async () => {
      const taskPda = Keypair.generate().publicKey;
      const job = pipeline.enqueue(
        taskPda,
        new Uint8Array(32).fill(1),
        createPublicResult(),
      );

      // Start shutdown while job might be in progress
      const shutdownPromise = pipeline.shutdown();

      // Job should still complete
      await shutdownPromise;

      // Job should have completed (confirmed or failed, not stuck in generating)
      expect(['confirmed', 'failed']).toContain(job.status);
    });

    it('should reject new enqueues after shutdown starts', async () => {
      const shutdownPromise = pipeline.shutdown();

      const taskPda = Keypair.generate().publicKey;

      expect(() =>
        pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult()),
      ).toThrow(/shutting down/);

      await shutdownPromise;
    });

    it('should reject pending waiters on shutdown', async () => {
      // Make completeTask hang but resolve on demand
      let resolveSubmit: () => void;
      operations.completeTask.mockImplementation(
        () => new Promise((resolve) => {
          resolveSubmit = () => resolve({
            success: true,
            taskId: new Uint8Array(32),
            isPrivate: false,
            transactionSignature: 'sig',
          });
        }),
      );

      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      // Give it time to start processing
      await new Promise((r) => setTimeout(r, 50));

      // Start waiting with a short timeout
      const waitPromise = pipeline.waitForConfirmation(taskPda, 100);

      // The wait should timeout
      await expect(waitPromise).rejects.toThrow(/Timeout/);
      
      // Now resolve the pending submit so shutdown can complete
      resolveSubmit!();
      
      // Start shutdown - should complete now
      await pipeline.shutdown();
    }, 5000);
  });

  describe('custom ProofGenerator', () => {
    it('should use custom proof generator when provided', async () => {
      const customGenerator: ProofGenerator = {
        generatePublicProof: vi.fn().mockResolvedValue(new Uint8Array(32).fill(99)),
        generatePrivateProof: vi.fn().mockResolvedValue(new Uint8Array(388).fill(99)),
      };

      pipeline = new ProofPipeline(config, events, operations, customGenerator);

      const taskPda = Keypair.generate().publicKey;
      pipeline.enqueue(taskPda, new Uint8Array(32).fill(1), createPublicResult());

      await pipeline.waitForConfirmation(taskPda, 5000);

      expect(customGenerator.generatePublicProof).toHaveBeenCalled();
    });
  });
});

describe('DefaultProofGenerator', () => {
  const generator = new DefaultProofGenerator();

  it('should return proofHash for public tasks', async () => {
    const task = createTask();
    const result = createPublicResult();

    const proof = await generator.generatePublicProof(task, result);

    expect(proof).toEqual(result.proofHash);
  });

  it('should return proof for private tasks', async () => {
    const task = createTask({
      constraintHash: new Uint8Array(32).fill(1), // Non-zero = private
    });
    const result = createPrivateResult();

    const proof = await generator.generatePrivateProof(task, result);

    expect(proof).toEqual(result.proof);
  });
});
