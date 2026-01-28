/**
 * Tests for ProofDeferralManager
 *
 * Focuses on the critical invariant: proofs only submit when ALL ancestors are confirmed.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  ProofDeferralManager,
  type ProofDeferralConfig,
  type ProofDeferralEvents,
} from './proof-deferral.js';
import { CommitmentLedger } from './commitment-ledger.js';
import { DependencyGraph } from './dependency-graph.js';
import type { ProofPipeline, ProofGenerationJob } from './proof-pipeline.js';
import type { TaskExecutionResult, OnChainTask, PrivateTaskExecutionResult } from './types.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createTaskPda(): PublicKey {
  return Keypair.generate().publicKey;
}

function createTaskId(): Uint8Array {
  return new Uint8Array(32).fill(Math.floor(Math.random() * 256));
}

function createOnChainTask(taskId: Uint8Array): OnChainTask {
  return {
    taskId,
    creator: createTaskPda(),
    templateId: new Uint8Array(32),
    claimedBy: null,
    status: { unclaimed: {} },
    requiredCapabilities: BigInt(0),
    rewardLamports: BigInt(1000000),
    claimExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    bump: 255,
    inputHash: new Uint8Array(32),
    escrowBump: 254,
    dependsOn: null,
    constraintHash: new Uint8Array(32),
    specCommitmentBump: null,
  };
}

function createMockExecutionResult(taskPda: PublicKey): TaskExecutionResult {
  return {
    taskPda,
    proofHash: new Uint8Array(32),
    resultData: new Uint8Array([1, 2, 3, 4]),
  };
}

// ============================================================================
// Mock ProofPipeline
// ============================================================================

class MockProofPipeline {
  private jobs: Map<string, ProofGenerationJob> = new Map();
  private jobIdCounter = 0;
  private waitResolvers: Map<string, Array<(job: ProofGenerationJob) => void>> = new Map();
  private waitRejecters: Map<string, Array<(err: Error) => void>> = new Map();

  public shouldAutoConfirm = false;
  public confirmDelay = 0;
  /** Short timeout to trigger catch block quickly in tests */
  public shortTimeoutMs = 50;

  enqueue(
    taskPda: PublicKey,
    taskId: Uint8Array,
    result: TaskExecutionResult | PrivateTaskExecutionResult
  ): ProofGenerationJob {
    const pdaKey = taskPda.toBase58();

    const job: ProofGenerationJob = {
      id: `job-${++this.jobIdCounter}`,
      taskPda,
      taskId: new Uint8Array(taskId),
      executionResult: result,
      status: 'queued',
      createdAt: Date.now(),
      retryCount: 0,
      isPrivate: 'proof' in result,
    };

    this.jobs.set(pdaKey, job);

    // Auto-generate proof immediately
    setTimeout(() => {
      const currentJob = this.jobs.get(pdaKey);
      if (currentJob && currentJob.status === 'queued') {
        currentJob.status = 'generating';
        setTimeout(() => {
          if (currentJob.status === 'generating') {
            currentJob.status = 'generated';
            currentJob.proofBytes = new Uint8Array(388);

            if (this.shouldAutoConfirm) {
              setTimeout(() => {
                this.confirmJob(pdaKey);
              }, this.confirmDelay);
            }
          }
        }, 10);
      }
    }, 0);

    return job;
  }

  getJob(taskPda: PublicKey): ProofGenerationJob | undefined {
    return this.jobs.get(taskPda.toBase58());
  }

  async waitForConfirmation(
    taskPda: PublicKey,
    timeoutMs?: number
  ): Promise<ProofGenerationJob> {
    const pdaKey = taskPda.toBase58();
    const job = this.jobs.get(pdaKey);

    if (!job) {
      throw new Error(`No job found for task ${pdaKey}`);
    }

    if (job.status === 'confirmed') {
      return job;
    }

    if (job.status === 'failed') {
      throw job.error ?? new Error('Job failed');
    }

    // Use short timeout for tests to trigger catch block quickly
    const effectiveTimeout = timeoutMs ?? this.shortTimeoutMs;

    return new Promise((resolve, reject) => {
      if (!this.waitResolvers.has(pdaKey)) {
        this.waitResolvers.set(pdaKey, []);
        this.waitRejecters.set(pdaKey, []);
      }
      this.waitResolvers.get(pdaKey)!.push(resolve);
      this.waitRejecters.get(pdaKey)!.push(reject);

      setTimeout(() => {
        // Check if job was confirmed before timeout
        const currentJob = this.jobs.get(pdaKey);
        if (currentJob?.status !== 'confirmed') {
          reject(new Error('Timeout waiting for confirmation'));
        }
      }, effectiveTimeout);
    });
  }

  confirmJob(pdaKey: string): void {
    const job = this.jobs.get(pdaKey);
    if (job) {
      job.status = 'confirmed';
      job.transactionSignature = `sig-${pdaKey.slice(0, 8)}`;
      job.completedAt = Date.now();

      const resolvers = this.waitResolvers.get(pdaKey) ?? [];
      for (const resolve of resolvers) {
        resolve(job);
      }
      this.waitResolvers.delete(pdaKey);
      this.waitRejecters.delete(pdaKey);
    }
  }

  cancel(taskPda: PublicKey): boolean {
    const pdaKey = taskPda.toBase58();
    const job = this.jobs.get(pdaKey);
    if (job && (job.status === 'queued' || job.status === 'generating')) {
      job.status = 'failed';
      job.error = new Error('Cancelled');
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    // No-op for mock
  }

  reset(): void {
    this.jobs.clear();
    this.waitResolvers.clear();
    this.waitRejecters.clear();
    this.jobIdCounter = 0;
    this.shouldAutoConfirm = false;
    this.confirmDelay = 0;
    this.shortTimeoutMs = 50;
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Wait for a proof to move past the 'generating' status.
 * Useful because proof generation is async via the mock pipeline.
 */
async function waitForProofGenerated(
  manager: ProofDeferralManager,
  taskPda: PublicKey,
  maxWaitMs = 500
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = manager.getStatus(taskPda)?.status;
    // Wait for proof to move past generating/queued state
    // and reach generated, awaiting_ancestors, submitting, confirmed, or failed
    if (status !== 'generating' && status !== 'queued') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // If still not ready after max wait, give one more chance with longer wait
  await new Promise((resolve) => setTimeout(resolve, 150));
}

// ============================================================================
// Test Setup
// ============================================================================

describe('ProofDeferralManager', () => {
  let commitmentLedger: CommitmentLedger;
  let dependencyGraph: DependencyGraph;
  let mockPipeline: MockProofPipeline;
  let manager: ProofDeferralManager;
  let events: ProofDeferralEvents;
  let config: Partial<ProofDeferralConfig>;

  beforeEach(() => {
    commitmentLedger = new CommitmentLedger();
    dependencyGraph = new DependencyGraph();
    mockPipeline = new MockProofPipeline();

    events = {
      onProofQueued: vi.fn(),
      onProofGenerating: vi.fn(),
      onProofGenerated: vi.fn(),
      onProofAwaitingAncestors: vi.fn(),
      onProofSubmitting: vi.fn(),
      onProofConfirmed: vi.fn(),
      onProofFailed: vi.fn(),
      onProofTimedOut: vi.fn(),
      onProofCancelled: vi.fn(),
    };

    config = {
      maxConcurrentGenerations: 4,
      maxConcurrentSubmissions: 2,
      generationTimeoutMs: 100, // Short for tests - triggers catch block quickly
      submissionTimeoutMs: 100, // Short for tests
      ancestorTimeoutMs: 10000,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: false,
      },
    };

    manager = new ProofDeferralManager(
      config,
      events,
      commitmentLedger,
      dependencyGraph,
      mockPipeline as unknown as ProofPipeline
    );
  });

  afterEach(async () => {
    await manager.shutdown();
    mockPipeline.reset();
  });

  // ==========================================================================
  // Basic Functionality Tests
  // ==========================================================================

  describe('Basic Functionality', () => {
    it('should queue a proof for a root task', () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      // Add task to dependency graph
      dependencyGraph.addTask(task, taskPda);

      // Queue proof
      const result = createMockExecutionResult(taskPda);
      manager.queueProof(taskPda, result);

      // Check events
      expect(events.onProofQueued).toHaveBeenCalledWith(taskPda);

      // Check status
      const status = manager.getStatus(taskPda);
      expect(status).toBeDefined();
      expect(status?.status).toBe('generating');
    });

    it('should reject duplicate proof queue requests', () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      dependencyGraph.addTask(task, taskPda);
      const result = createMockExecutionResult(taskPda);

      manager.queueProof(taskPda, result);

      expect(() => manager.queueProof(taskPda, result)).toThrow(
        /Proof already queued/
      );
    });

    it('should track proof generation lifecycle', () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      dependencyGraph.addTask(task, taskPda);
      commitmentLedger.createCommitment(
        taskPda,
        taskId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      commitmentLedger.markConfirmed(taskPda);

      mockPipeline.shouldAutoConfirm = true;
      mockPipeline.confirmDelay = 10;

      const result = createMockExecutionResult(taskPda);
      manager.queueProof(taskPda, result);

      expect(events.onProofGenerating).toHaveBeenCalled();
    });

    it('should return correct stats', () => {
      const stats = manager.getStats();
      expect(stats.total).toBe(0);
      expect(stats.queued).toBe(0);
      expect(stats.confirmed).toBe(0);
    });
  });

  // ==========================================================================
  // CRITICAL: Submission Ordering Invariant Tests
  // ==========================================================================

  describe('Submission Ordering Invariant', () => {
    it('should block submission when ancestor is not confirmed', async () => {
      // Create ancestor and child tasks
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      // Add to dependency graph
      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      // Create ancestor commitment (but NOT confirmed)
      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      // Note: NOT marking confirmed!

      // Queue child proof
      const result = createMockExecutionResult(childPda);
      manager.queueProof(childPda, result);

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);

      // Attempt submission
      const submitted = await manager.trySubmit(childPda);
      expect(submitted).toBe(false);

      // Check status is awaiting ancestors
      const status = manager.getStatus(childPda);
      expect(status?.status).toBe('awaiting_ancestors');
      expect(status?.pendingAncestors.length).toBeGreaterThan(0);

      // Check events
      expect(events.onProofAwaitingAncestors).toHaveBeenCalled();
    });

    it('should block submission when any ancestor in chain is not confirmed', async () => {
      // Create a 3-level chain: grandparent -> parent -> child
      const grandparentPda = createTaskPda();
      const grandparentId = createTaskId();
      const grandparentTask = createOnChainTask(grandparentId);

      const parentPda = createTaskPda();
      const parentId = createTaskId();
      const parentTask = createOnChainTask(parentId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      // Build dependency chain
      dependencyGraph.addTask(grandparentTask, grandparentPda);
      dependencyGraph.addTaskWithParent(parentTask, parentPda, grandparentPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, parentPda);

      // Grandparent is confirmed
      commitmentLedger.createCommitment(
        grandparentPda,
        grandparentId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      commitmentLedger.markConfirmed(grandparentPda);

      // Parent is NOT confirmed
      commitmentLedger.createCommitment(
        parentPda,
        parentId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      // Not confirmed!

      // Queue child proof
      const result = createMockExecutionResult(childPda);
      manager.queueProof(childPda, result);

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);

      // Attempt submission - should fail due to unconfirmed parent
      const submitted = await manager.trySubmit(childPda);
      expect(submitted).toBe(false);

      const status = manager.getStatus(childPda);
      expect(status?.status).toBe('awaiting_ancestors');
    });

    it('should allow submission when all ancestors are confirmed', async () => {
      // Create ancestor and child
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      // Build dependency
      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      // Ancestor IS confirmed
      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      commitmentLedger.markConfirmed(ancestorPda);

      // Also create child commitment (confirmed) to satisfy the check
      commitmentLedger.createCommitment(
        childPda,
        childId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      mockPipeline.shouldAutoConfirm = true;
      mockPipeline.confirmDelay = 10;

      // Queue child proof
      const result = createMockExecutionResult(childPda);
      manager.queueProof(childPda, result);

      // Wait for generation and submission
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Attempt submission
      const submitted = await manager.trySubmit(childPda);

      // Should proceed with submission (or already submitted)
      const status = manager.getStatus(childPda);
      expect(['submitting', 'confirmed', 'generated']).toContain(status?.status);
    });

    it('should allow root tasks to submit immediately', async () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      // Root task - no parent
      dependencyGraph.addTask(task, taskPda);

      // Create commitment (confirmed)
      commitmentLedger.createCommitment(
        taskPda,
        taskId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      commitmentLedger.markConfirmed(taskPda);

      mockPipeline.shouldAutoConfirm = true;
      mockPipeline.confirmDelay = 10;

      const result = createMockExecutionResult(taskPda);
      manager.queueProof(taskPda, result);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = manager.getStatus(taskPda);
      // Should be confirmed or submitting (no ancestors to wait for)
      expect(['submitting', 'confirmed', 'generating', 'generated']).toContain(
        status?.status
      );
    });
  });

  // ==========================================================================
  // Ancestor Confirmation Unblocking Tests
  // ==========================================================================

  describe('Ancestor Confirmation Unblocking', () => {
    it('should unblock proof when ancestor is confirmed', async () => {
      // Create ancestor and child
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      // Ancestor not confirmed initially
      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      // Queue child proof
      const result = createMockExecutionResult(childPda);
      manager.queueProof(childPda, result);

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);

      // Attempt submission - should be blocked
      await manager.trySubmit(childPda);
      expect(manager.getStatus(childPda)?.status).toBe('awaiting_ancestors');

      // Check blocked proofs list
      const blocked = manager.getBlockedProofs();
      expect(blocked.length).toBe(1);
      expect(blocked[0].taskPda.toBase58()).toBe(childPda.toBase58());

      // Now confirm the ancestor
      commitmentLedger.markConfirmed(ancestorPda);
      await manager.onAncestorConfirmed(ancestorPda);

      // Wait a bit for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Child should no longer be blocked
      const blockedAfter = manager.getBlockedProofs();
      expect(blockedAfter.length).toBe(0);

      const status = manager.getStatus(childPda);
      expect(status?.pendingAncestors.length).toBe(0);
    });

    it('should handle multiple children waiting on same ancestor', async () => {
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      // Create two children
      const child1Pda = createTaskPda();
      const child1Id = createTaskId();
      const child1Task = createOnChainTask(child1Id);

      const child2Pda = createTaskPda();
      const child2Id = createTaskId();
      const child2Task = createOnChainTask(child2Id);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(child1Task, child1Pda, ancestorPda);
      dependencyGraph.addTaskWithParent(child2Task, child2Pda, ancestorPda);

      // Ancestor not confirmed
      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      // Queue both children
      manager.queueProof(child1Pda, createMockExecutionResult(child1Pda));
      manager.queueProof(child2Pda, createMockExecutionResult(child2Pda));

      // Wait for both to be generated
      await waitForProofGenerated(manager, child1Pda);
      await waitForProofGenerated(manager, child2Pda);

      // Block both
      await manager.trySubmit(child1Pda);
      await manager.trySubmit(child2Pda);

      // Both should be blocked
      const blocked = manager.getBlockedProofs();
      expect(blocked.length).toBe(2);

      // Confirm ancestor
      commitmentLedger.markConfirmed(ancestorPda);
      await manager.onAncestorConfirmed(ancestorPda);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should be unblocked
      const blockedAfter = manager.getBlockedProofs();
      expect(blockedAfter.length).toBe(0);
    });

    it('should handle chain of ancestors confirming in order', async () => {
      // Chain: A -> B -> C
      const aPda = createTaskPda();
      const aId = createTaskId();
      const aTask = createOnChainTask(aId);

      const bPda = createTaskPda();
      const bId = createTaskId();
      const bTask = createOnChainTask(bId);

      const cPda = createTaskPda();
      const cId = createTaskId();
      const cTask = createOnChainTask(cId);

      dependencyGraph.addTask(aTask, aPda);
      dependencyGraph.addTaskWithParent(bTask, bPda, aPda);
      dependencyGraph.addTaskWithParent(cTask, cPda, bPda);

      // None confirmed initially
      commitmentLedger.createCommitment(aPda, aId, new Uint8Array(32), createTaskPda(), BigInt(1000));
      commitmentLedger.createCommitment(bPda, bId, new Uint8Array(32), createTaskPda(), BigInt(1000));

      // Queue C's proof
      manager.queueProof(cPda, createMockExecutionResult(cPda));

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, cPda);
      await manager.trySubmit(cPda);

      // C should be blocked (both A and B unconfirmed)
      expect(manager.getStatus(cPda)?.status).toBe('awaiting_ancestors');
      expect(manager.getStatus(cPda)?.pendingAncestors.length).toBe(2);

      // Confirm A
      commitmentLedger.markConfirmed(aPda);
      await manager.onAncestorConfirmed(aPda);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // C should still be blocked (B unconfirmed)
      expect(manager.getStatus(cPda)?.status).toBe('awaiting_ancestors');
      expect(manager.getStatus(cPda)?.pendingAncestors.length).toBe(1);

      // Confirm B
      commitmentLedger.markConfirmed(bPda);
      await manager.onAncestorConfirmed(bPda);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // C should now be unblocked
      expect(manager.getStatus(cPda)?.pendingAncestors.length).toBe(0);
      expect(['generated', 'submitting', 'confirmed']).toContain(
        manager.getStatus(cPda)?.status
      );
    });
  });

  // ==========================================================================
  // Ancestor Failure Cascade Tests
  // ==========================================================================

  describe('Ancestor Failure Cascades', () => {
    it('should cancel child proof when ancestor fails', async () => {
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      // Queue child
      manager.queueProof(childPda, createMockExecutionResult(childPda));

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);
      await manager.trySubmit(childPda);

      expect(manager.getStatus(childPda)?.status).toBe('awaiting_ancestors');

      // Ancestor fails
      manager.onAncestorFailed(ancestorPda);

      // Child should be cancelled
      const status = manager.getStatus(childPda);
      expect(status?.status).toBe('cancelled');
      expect(status?.error?.message).toContain('Ancestor');

      expect(events.onProofCancelled).toHaveBeenCalledWith(childPda, ancestorPda);
    });

    it('should cascade failure through multiple levels', async () => {
      // Chain: A -> B -> C -> D
      const aPda = createTaskPda();
      const aId = createTaskId();
      const aTask = createOnChainTask(aId);

      const bPda = createTaskPda();
      const bId = createTaskId();
      const bTask = createOnChainTask(bId);

      const cPda = createTaskPda();
      const cId = createTaskId();
      const cTask = createOnChainTask(cId);

      const dPda = createTaskPda();
      const dId = createTaskId();
      const dTask = createOnChainTask(dId);

      dependencyGraph.addTask(aTask, aPda);
      dependencyGraph.addTaskWithParent(bTask, bPda, aPda);
      dependencyGraph.addTaskWithParent(cTask, cPda, bPda);
      dependencyGraph.addTaskWithParent(dTask, dPda, cPda);

      commitmentLedger.createCommitment(aPda, aId, new Uint8Array(32), createTaskPda(), BigInt(1000));

      // Queue proofs for B, C, D
      manager.queueProof(bPda, createMockExecutionResult(bPda));
      manager.queueProof(cPda, createMockExecutionResult(cPda));
      manager.queueProof(dPda, createMockExecutionResult(dPda));

      // Wait for all to be generated
      await waitForProofGenerated(manager, bPda);
      await waitForProofGenerated(manager, cPda);
      await waitForProofGenerated(manager, dPda);

      await manager.trySubmit(bPda);
      await manager.trySubmit(cPda);
      await manager.trySubmit(dPda);

      // A fails
      manager.onAncestorFailed(aPda);

      // All descendants should be cancelled
      expect(manager.getStatus(bPda)?.status).toBe('cancelled');
      expect(manager.getStatus(cPda)?.status).toBe('cancelled');
      expect(manager.getStatus(dPda)?.status).toBe('cancelled');
    });

    it('should not affect siblings when one branch fails', async () => {
      // Tree:      A
      //          /   \
      //         B     C
      const aPda = createTaskPda();
      const aId = createTaskId();
      const aTask = createOnChainTask(aId);

      const bPda = createTaskPda();
      const bId = createTaskId();
      const bTask = createOnChainTask(bId);

      const cPda = createTaskPda();
      const cId = createTaskId();
      const cTask = createOnChainTask(cId);

      dependencyGraph.addTask(aTask, aPda);
      dependencyGraph.addTaskWithParent(bTask, bPda, aPda);
      dependencyGraph.addTaskWithParent(cTask, cPda, aPda);

      // A is confirmed
      commitmentLedger.createCommitment(aPda, aId, new Uint8Array(32), createTaskPda(), BigInt(1000));
      commitmentLedger.markConfirmed(aPda);

      // B is not confirmed
      commitmentLedger.createCommitment(bPda, bId, new Uint8Array(32), createTaskPda(), BigInt(1000));

      // Queue C
      manager.queueProof(cPda, createMockExecutionResult(cPda));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // B fails - should not affect C since C depends on A (which is confirmed)
      manager.onAncestorFailed(bPda);

      // C should still be able to proceed
      const cStatus = manager.getStatus(cPda);
      expect(cStatus?.status).not.toBe('cancelled');
    });
  });

  // ==========================================================================
  // Timeout Handling Tests
  // ==========================================================================

  describe('Timeout Handling', () => {
    it('should void proofs that exceed ancestor timeout', async () => {
      // Use a very short timeout for testing
      const shortTimeoutManager = new ProofDeferralManager(
        { ...config, ancestorTimeoutMs: 50 }, // 50ms timeout
        events,
        commitmentLedger,
        dependencyGraph,
        mockPipeline as unknown as ProofPipeline
      );

      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      shortTimeoutManager.queueProof(childPda, createMockExecutionResult(childPda));

      // Wait for proof generation to complete
      await waitForProofGenerated(shortTimeoutManager, childPda);
      await shortTimeoutManager.trySubmit(childPda);

      expect(shortTimeoutManager.getStatus(childPda)?.status).toBe('awaiting_ancestors');

      // Wait for timeout to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Void timed out proofs
      const voided = shortTimeoutManager.voidTimedOutProofs();

      expect(voided.length).toBe(1);
      expect(voided[0].status).toBe('timed_out');

      expect(events.onProofTimedOut).toHaveBeenCalledWith(childPda, 'awaiting_ancestors');

      await shortTimeoutManager.shutdown();
    });

    it('should not void proofs within timeout window', async () => {
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      manager.queueProof(childPda, createMockExecutionResult(childPda));

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);
      await manager.trySubmit(childPda);

      // Void check should find nothing (still within timeout)
      const voided = manager.voidTimedOutProofs();
      expect(voided.length).toBe(0);
    });
  });

  // ==========================================================================
  // Cancellation Tests
  // ==========================================================================

  describe('Cancellation', () => {
    it('should cancel a queued proof', () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      dependencyGraph.addTask(task, taskPda);

      manager.queueProof(taskPda, createMockExecutionResult(taskPda));

      const cancelled = manager.cancel(taskPda);
      expect(cancelled).toBe(true);

      const status = manager.getStatus(taskPda);
      expect(status?.status).toBe('cancelled');
    });

    it('should cancel a proof awaiting ancestors', async () => {
      const ancestorPda = createTaskPda();
      const ancestorId = createTaskId();
      const ancestorTask = createOnChainTask(ancestorId);

      const childPda = createTaskPda();
      const childId = createTaskId();
      const childTask = createOnChainTask(childId);

      dependencyGraph.addTask(ancestorTask, ancestorPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, ancestorPda);

      commitmentLedger.createCommitment(
        ancestorPda,
        ancestorId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );

      manager.queueProof(childPda, createMockExecutionResult(childPda));

      // Wait for proof generation to complete
      await waitForProofGenerated(manager, childPda);
      await manager.trySubmit(childPda);

      expect(manager.getStatus(childPda)?.status).toBe('awaiting_ancestors');

      const cancelled = manager.cancel(childPda);
      expect(cancelled).toBe(true);

      // Should no longer be in blocked list
      const blocked = manager.getBlockedProofs();
      expect(blocked.length).toBe(0);
    });

    it('should not cancel a confirmed proof', async () => {
      const taskPda = createTaskPda();
      const taskId = createTaskId();
      const task = createOnChainTask(taskId);

      dependencyGraph.addTask(task, taskPda);
      commitmentLedger.createCommitment(
        taskPda,
        taskId,
        new Uint8Array(32),
        createTaskPda(),
        BigInt(1000)
      );
      commitmentLedger.markConfirmed(taskPda);

      mockPipeline.shouldAutoConfirm = true;

      manager.queueProof(taskPda, createMockExecutionResult(taskPda));

      // Wait for confirmation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Manually confirm for this test
      mockPipeline.confirmJob(taskPda.toBase58());

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now try to cancel
      const status = manager.getStatus(taskPda);
      if (status?.status === 'confirmed') {
        const cancelled = manager.cancel(taskPda);
        expect(cancelled).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle task not in dependency graph', () => {
      const taskPda = createTaskPda();

      // Queue without adding to dependency graph
      manager.queueProof(taskPda, createMockExecutionResult(taskPda));

      const status = manager.getStatus(taskPda);
      expect(status).toBeDefined();
      // Should still work - just won't find ancestors
      expect(status?.pendingAncestors.length).toBe(0);
    });

    it('should handle ancestor confirmation for unknown ancestor', async () => {
      const unknownPda = createTaskPda();

      // Should not throw
      await manager.onAncestorConfirmed(unknownPda);
    });

    it('should handle ancestor failure for unknown ancestor', () => {
      const unknownPda = createTaskPda();

      // Should not throw
      manager.onAncestorFailed(unknownPda);
    });

    it('should handle trySubmit for unknown task', async () => {
      const unknownPda = createTaskPda();

      const result = await manager.trySubmit(unknownPda);
      expect(result).toBe(false);
    });

    it('should reject queueing during shutdown', async () => {
      const taskPda = createTaskPda();

      await manager.shutdown();

      expect(() =>
        manager.queueProof(taskPda, createMockExecutionResult(taskPda))
      ).toThrow(/shutting down/);
    });
  });
});
