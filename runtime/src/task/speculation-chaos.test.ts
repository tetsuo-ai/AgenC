/**
 * Speculation Chaos Tests
 *
 * Stress tests and fuzz tests for speculative execution rollback scenarios.
 * These tests verify system invariants under chaotic conditions.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import { DependencyGraph } from './dependency-graph.js';
import { CommitmentLedger } from './commitment-ledger.js';
import { RollbackController, type RollbackEvents } from './rollback-controller.js';
import type { OnChainTask } from './types.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a mock OnChainTask with the given task ID.
 */
function createMockTask(taskIdBytes?: Uint8Array): OnChainTask {
  const taskId = taskIdBytes ?? randomBytes(32);
  return {
    taskId,
    status: 0,
    constraintHash: randomBytes(32),
    reward: 100_000_000n,
    deadline: BigInt(Date.now() + 3600000),
    claimDeadline: 0n,
    requiredCapabilities: 0n,
    outputHash: null,
    claimedBy: null,
    completedBy: null,
    proofUri: null,
  } as unknown as OnChainTask;
}

/**
 * Creates a Keypair and returns its public key.
 */
function createTaskPda(): PublicKey {
  return Keypair.generate().publicKey;
}

/**
 * Simple seeded random number generator for reproducibility.
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    // LCG parameters
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextBool(probability: number = 0.5): boolean {
    return this.next() < probability;
  }

  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Speculation Chaos Tests', () => {
  let dependencyGraph: DependencyGraph;
  let commitmentLedger: CommitmentLedger;
  let controller: RollbackController;
  let events: RollbackEvents;

  beforeEach(() => {
    dependencyGraph = new DependencyGraph();
    commitmentLedger = new CommitmentLedger({ maxCommitments: 10000 });
    events = {
      onRollbackStarted: vi.fn(),
      onTaskRolledBack: vi.fn(),
      onRollbackCompleted: vi.fn(),
    };
    controller = new RollbackController(
      { enableEvents: true },
      dependencyGraph,
      commitmentLedger,
      events
    );
  });

  describe('Random Failures', () => {
    it('should handle random proof failures gracefully', async () => {
      const rng = new SeededRandom(12345);
      const producerAgent = createTaskPda();

      // Create chain of 10 tasks
      const pdas: PublicKey[] = [];
      const tasks: OnChainTask[] = [];

      for (let i = 0; i < 10; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);
        tasks.push(task);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        // Create commitment with random stake
        const stake = BigInt(rng.nextInt(100, 10000));
        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, stake);
      }

      // Randomly fail 3 proofs
      const failureIndices = rng.shuffle([...Array(10).keys()]).slice(0, 3);

      for (const idx of failureIndices) {
        const result = await controller.rollback(pdas[idx], 'proof_failed');

        // Verify all descendants were rolled back
        const expectedDescendants = 10 - idx - 1;
        // May be fewer if some were already rolled back
        expect(result.rolledBackTasks.length).toBeLessThanOrEqual(expectedDescendants);

        // Verify the root is marked rolled back
        expect(controller.isRolledBack(pdas[idx])).toBe(true);
      }

      // Verify invariants maintained
      const stats = controller.getStats();
      expect(stats.totalRollbacks).toBe(3);
    });

    it('should maintain consistency under concurrent-like failures', async () => {
      const rng = new SeededRandom(54321);
      const producerAgent = createTaskPda();

      // Create a forest of 5 independent chains
      const chains: PublicKey[][] = [];

      for (let c = 0; c < 5; c++) {
        const chain: PublicKey[] = [];
        for (let i = 0; i < 5; i++) {
          const pda = createTaskPda();
          const task = createMockTask();
          chain.push(pda);

          if (i === 0) {
            dependencyGraph.addTask(task, pda);
          } else {
            dependencyGraph.addTaskWithParent(task, pda, chain[i - 1]);
          }

          const stake = BigInt(rng.nextInt(100, 1000));
          commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, stake);
        }
        chains.push(chain);
      }

      // Fail random tasks from different chains in interleaved order
      const failures: { chainIdx: number; taskIdx: number }[] = [];
      for (let i = 0; i < 10; i++) {
        failures.push({
          chainIdx: rng.nextInt(0, 4),
          taskIdx: rng.nextInt(0, 4),
        });
      }

      for (const failure of failures) {
        const pda = chains[failure.chainIdx][failure.taskIdx];
        await controller.rollback(pda, 'proof_failed');
      }

      // Verify each chain's rollback state is consistent
      for (const chain of chains) {
        let foundRolledBack = false;
        for (let i = 0; i < chain.length; i++) {
          const isRolledBack = controller.isRolledBack(chain[i]);
          if (foundRolledBack) {
            // Once we find a rolled back task, all descendants must be rolled back
            expect(isRolledBack).toBe(true);
          }
          if (isRolledBack) {
            foundRolledBack = true;
          }
        }
      }
    });

    it('should handle rapid sequential rollbacks without corruption', async () => {
      const rng = new SeededRandom(98765);
      const producerAgent = createTaskPda();

      // Create a wide tree: 1 root with 50 children
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);
      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 1000n);

      const childPdas: PublicKey[] = [];
      for (let i = 0; i < 50; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        childPdas.push(pda);
        dependencyGraph.addTaskWithParent(task, pda, rootPda);
        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, BigInt(rng.nextInt(100, 500)));
      }

      // Rapidly roll back random children
      const shuffledChildren = rng.shuffle(childPdas).slice(0, 25);
      for (const childPda of shuffledChildren) {
        await controller.rollback(childPda, 'proof_failed');
      }

      // Now roll back root - should cascade to remaining children
      const result = await controller.rollback(rootPda, 'proof_failed');

      // All children should be rolled back now
      for (const childPda of childPdas) {
        expect(controller.isRolledBack(childPda)).toBe(true);
      }

      // Stats should be consistent
      const stats = controller.getStats();
      expect(stats.totalRollbacks).toBeGreaterThan(0);
    });
  });

  describe('Cascade Stress', () => {
    it('should handle deep cascade rollback (depth 50)', async () => {
      const producerAgent = createTaskPda();

      // Create deep chain of 50 tasks
      const pdas: PublicKey[] = [];

      for (let i = 0; i < 50; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, 100n);
      }

      // Register some tasks as actively executing
      const abortControllers: AbortController[] = [];
      for (let i = 25; i < 40; i++) {
        const ac = new AbortController();
        abortControllers.push(ac);
        controller.registerActiveTask(pdas[i], ac);
      }

      // Fail root - verify all cascade
      const result = await controller.rollback(pdas[0], 'proof_failed');

      // Should rollback all 49 descendants
      expect(result.rolledBackTasks.length).toBe(49);

      // All tasks should be marked rolled back
      for (const pda of pdas) {
        expect(controller.isRolledBack(pda)).toBe(true);
      }

      // All abort controllers should have been aborted
      for (const ac of abortControllers) {
        expect(ac.signal.aborted).toBe(true);
      }

      // Graph should show all tasks as failed
      for (const pda of pdas) {
        const node = dependencyGraph.getNode(pda);
        expect(node?.status).toBe('failed');
      }
    });

    it('should handle wide cascade rollback (1 parent, 100 children)', async () => {
      const producerAgent = createTaskPda();

      // Create root
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);
      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 10000n);

      // Create 100 children
      const childPdas: PublicKey[] = [];
      for (let i = 0; i < 100; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        childPdas.push(pda);
        dependencyGraph.addTaskWithParent(task, pda, rootPda);
        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, BigInt(i + 1));
      }

      // Fail parent - verify all children rolled back
      const result = await controller.rollback(rootPda, 'proof_failed');

      expect(result.rolledBackTasks.length).toBe(100);

      // Calculate expected stake (sum of 1 to 100)
      const expectedStake = (100n * 101n) / 2n;
      expect(result.stakeAtRisk).toBe(expectedStake);

      // All children should be rolled back
      for (const childPda of childPdas) {
        expect(controller.isRolledBack(childPda)).toBe(true);
        const commitment = commitmentLedger.getByTask(childPda);
        expect(commitment?.status).toBe('rolled_back');
      }
    });

    it('should handle diamond dependency pattern', async () => {
      const producerAgent = createTaskPda();

      // Create diamond: A -> B, A -> C, B -> D, C depends on B implicitly via shared ancestor
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D (depends only on B in our single-parent model)
      const pdaA = createTaskPda();
      const pdaB = createTaskPda();
      const pdaC = createTaskPda();
      const pdaD = createTaskPda();

      const taskA = createMockTask();
      const taskB = createMockTask();
      const taskC = createMockTask();
      const taskD = createMockTask();

      dependencyGraph.addTask(taskA, pdaA);
      dependencyGraph.addTaskWithParent(taskB, pdaB, pdaA);
      dependencyGraph.addTaskWithParent(taskC, pdaC, pdaA);
      dependencyGraph.addTaskWithParent(taskD, pdaD, pdaB);

      for (const [pda, task, stake] of [
        [pdaA, taskA, 1000n],
        [pdaB, taskB, 500n],
        [pdaC, taskC, 500n],
        [pdaD, taskD, 250n],
      ] as const) {
        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, stake);
      }

      // Fail A - should cascade to B, C, D
      const result = await controller.rollback(pdaA, 'proof_failed');

      expect(result.rolledBackTasks.length).toBe(3);
      expect(controller.isRolledBack(pdaA)).toBe(true);
      expect(controller.isRolledBack(pdaB)).toBe(true);
      expect(controller.isRolledBack(pdaC)).toBe(true);
      expect(controller.isRolledBack(pdaD)).toBe(true);

      // Total stake at risk should be B + C + D = 1250
      expect(result.stakeAtRisk).toBe(1250n);
    });

    it('should handle mixed depth tree with varying branch factors', async () => {
      const rng = new SeededRandom(11111);
      const producerAgent = createTaskPda();

      // Build a randomized tree structure
      const allPdas: PublicKey[] = [];
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);
      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 1000n);
      allPdas.push(rootPda);

      // BFS to build tree with random branch factors
      const queue = [rootPda];
      let totalTasks = 1;
      const maxTasks = 200;

      while (queue.length > 0 && totalTasks < maxTasks) {
        const parentPda = queue.shift()!;
        const branchFactor = rng.nextInt(1, 5);

        for (let i = 0; i < branchFactor && totalTasks < maxTasks; i++) {
          const childPda = createTaskPda();
          const childTask = createMockTask();
          dependencyGraph.addTaskWithParent(childTask, childPda, parentPda);
          commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, BigInt(rng.nextInt(10, 100)));
          allPdas.push(childPda);
          queue.push(childPda);
          totalTasks++;
        }
      }

      // Fail the root
      const result = await controller.rollback(rootPda, 'proof_failed');

      // All descendants should be rolled back
      expect(result.rolledBackTasks.length).toBe(allPdas.length - 1);

      for (const pda of allPdas) {
        expect(controller.isRolledBack(pda)).toBe(true);
      }
    });
  });

  describe('Invariants', () => {
    it('should never have orphaned commitments after rollback', async () => {
      const rng = new SeededRandom(22222);
      const producerAgent = createTaskPda();

      // Create a chain with commitments
      const pdas: PublicKey[] = [];

      for (let i = 0; i < 20; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, BigInt(rng.nextInt(100, 1000)));
      }

      // Fail at middle
      await controller.rollback(pdas[10], 'proof_failed');

      // Check for orphaned commitments - all rolled back commitments should have matching graph status
      for (let i = 10; i < 20; i++) {
        const commitment = commitmentLedger.getByTask(pdas[i]);
        const node = dependencyGraph.getNode(pdas[i]);

        if (commitment) {
          // If commitment is rolled_back, node should be failed
          if (commitment.status === 'rolled_back') {
            expect(node?.status).toBe('failed');
          }
        }
      }

      // Upstream tasks should not be affected
      for (let i = 0; i < 10; i++) {
        const commitment = commitmentLedger.getByTask(pdas[i]);
        expect(commitment?.status).not.toBe('rolled_back');
        expect(controller.isRolledBack(pdas[i])).toBe(false);
      }
    });

    it('should maintain consistent stake accounting', async () => {
      const producerAgent = createTaskPda();

      // Create tree with known stake values
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);
      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 1000n);

      let totalChildStake = 0n;
      const childPdas: PublicKey[] = [];

      for (let i = 0; i < 10; i++) {
        const childPda = createTaskPda();
        const childTask = createMockTask();
        const stake = BigInt((i + 1) * 100); // 100, 200, ..., 1000
        totalChildStake += stake;

        childPdas.push(childPda);
        dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);
        commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, stake);
      }

      const result = await controller.rollback(rootPda, 'proof_failed');

      // Total stake at risk should match sum of child stakes
      expect(result.stakeAtRisk).toBe(totalChildStake);

      // Stats should reflect the same
      const stats = controller.getStats();
      expect(stats.totalStakeLost).toBe(totalChildStake);
    });

    it('should maintain idempotency under repeated rollback attempts', async () => {
      const producerAgent = createTaskPda();

      // Create a simple chain
      const pdas: PublicKey[] = [];
      for (let i = 0; i < 5; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, 100n);
      }

      // Roll back the same task multiple times
      const result1 = await controller.rollback(pdas[0], 'proof_failed');
      const result2 = await controller.rollback(pdas[0], 'proof_failed');
      const result3 = await controller.rollback(pdas[0], 'proof_timeout');

      // All results should be the same object (cached)
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);

      // Stats should only count one rollback
      const stats = controller.getStats();
      expect(stats.totalRollbacks).toBe(1);
    });

    it('should preserve graph structure after rollback', async () => {
      const producerAgent = createTaskPda();

      // Create a chain
      const pdas: PublicKey[] = [];
      for (let i = 0; i < 10; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, 100n);
      }

      // Capture structure before rollback
      const depthsBefore = pdas.map((pda) => dependencyGraph.getDepth(pda));
      const parentsBefore = pdas.map((pda) => dependencyGraph.getParent(pda)?.taskPda.toBase58() ?? null);

      // Roll back from middle
      await controller.rollback(pdas[5], 'proof_failed');

      // Verify structure is preserved (only status changes)
      const depthsAfter = pdas.map((pda) => dependencyGraph.getDepth(pda));
      const parentsAfter = pdas.map((pda) => dependencyGraph.getParent(pda)?.taskPda.toBase58() ?? null);

      expect(depthsAfter).toEqual(depthsBefore);
      expect(parentsAfter).toEqual(parentsBefore);
    });

    it('should handle empty graph gracefully', async () => {
      // Try to rollback a non-existent task
      const fakePda = createTaskPda();

      // Should not throw, but result won't have descendants
      const result = await controller.rollback(fakePda, 'proof_failed');

      expect(result.rolledBackTasks).toHaveLength(0);
      expect(controller.isRolledBack(fakePda)).toBe(true);
    });
  });

  describe('Fuzz Testing', () => {
    it('should survive 1000 random operations without crashing', async () => {
      const rng = new SeededRandom(99999);
      const producerAgent = createTaskPda();
      const allPdas: PublicKey[] = [];

      // Perform 1000 random operations
      for (let op = 0; op < 1000; op++) {
        const opType = rng.nextInt(0, 3);

        switch (opType) {
          case 0: {
            // Add a new task
            const pda = createTaskPda();
            const task = createMockTask();

            if (allPdas.length === 0 || rng.nextBool(0.3)) {
              // Add as root
              dependencyGraph.addTask(task, pda);
            } else {
              // Add with random parent
              const parentIdx = rng.nextInt(0, allPdas.length - 1);
              try {
                dependencyGraph.addTaskWithParent(task, pda, allPdas[parentIdx]);
              } catch {
                // Parent might not exist anymore, ignore
                continue;
              }
            }

            commitmentLedger.createCommitment(
              pda,
              task.taskId,
              randomBytes(32),
              producerAgent,
              BigInt(rng.nextInt(1, 1000))
            );
            allPdas.push(pda);
            break;
          }

          case 1: {
            // Register active task
            if (allPdas.length > 0) {
              const idx = rng.nextInt(0, allPdas.length - 1);
              const ac = new AbortController();
              controller.registerActiveTask(allPdas[idx], ac);
            }
            break;
          }

          case 2: {
            // Trigger rollback
            if (allPdas.length > 0) {
              const idx = rng.nextInt(0, allPdas.length - 1);
              const reasons = ['proof_failed', 'proof_timeout', 'ancestor_failed', 'manual'] as const;
              const reason = reasons[rng.nextInt(0, 3)];
              await controller.rollback(allPdas[idx], reason);
            }
            break;
          }

          case 3: {
            // Query operations (should never fail)
            if (allPdas.length > 0) {
              const idx = rng.nextInt(0, allPdas.length - 1);
              controller.isRolledBack(allPdas[idx]);
              dependencyGraph.getNode(allPdas[idx]);
              dependencyGraph.getDescendants(allPdas[idx]);
              commitmentLedger.getByTask(allPdas[idx]);
            }
            controller.getStats();
            controller.getRollbackHistory();
            dependencyGraph.getStats();
            break;
          }
        }
      }

      // Final invariant checks
      const stats = controller.getStats();
      expect(stats.totalRollbacks).toBeGreaterThanOrEqual(0);
      expect(stats.totalStakeLost).toBeGreaterThanOrEqual(0n);

      // All rolled back tasks should have consistent state
      for (const pda of allPdas) {
        if (controller.isRolledBack(pda)) {
          const node = dependencyGraph.getNode(pda);
          // Node might not exist if graph was modified, but if it exists, status should be failed
          if (node) {
            expect(node.status).toBe('failed');
          }
        }
      }
    });

    it('should handle pathological case: all tasks depend on one root', async () => {
      const producerAgent = createTaskPda();

      // Create star topology: 1 root, 500 children
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);
      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 10000n);

      const childPdas: PublicKey[] = [];
      for (let i = 0; i < 500; i++) {
        const childPda = createTaskPda();
        const childTask = createMockTask();
        childPdas.push(childPda);
        dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);
        commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, 10n);
      }

      // Time the rollback
      const start = performance.now();
      const result = await controller.rollback(rootPda, 'proof_failed');
      const elapsed = performance.now() - start;

      // Should complete in reasonable time (< 1 second)
      expect(elapsed).toBeLessThan(1000);

      // All 500 children should be rolled back
      expect(result.rolledBackTasks.length).toBe(500);
      expect(result.stakeAtRisk).toBe(5000n);
    });

    it('should handle pathological case: linear chain of 100 tasks', async () => {
      const producerAgent = createTaskPda();

      // Create linear chain: T0 -> T1 -> T2 -> ... -> T99
      const pdas: PublicKey[] = [];

      for (let i = 0; i < 100; i++) {
        const pda = createTaskPda();
        const task = createMockTask();
        pdas.push(pda);

        if (i === 0) {
          dependencyGraph.addTask(task, pda);
        } else {
          dependencyGraph.addTaskWithParent(task, pda, pdas[i - 1]);
        }

        commitmentLedger.createCommitment(pda, task.taskId, randomBytes(32), producerAgent, 100n);
      }

      // Time the rollback from root
      const start = performance.now();
      const result = await controller.rollback(pdas[0], 'proof_failed');
      const elapsed = performance.now() - start;

      // Should complete quickly
      expect(elapsed).toBeLessThan(500);

      // All 99 descendants should be rolled back
      expect(result.rolledBackTasks.length).toBe(99);

      // Verify depth is correctly tracked
      expect(dependencyGraph.getDepth(pdas[99])).toBe(99);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rollback when commitment status is already terminal', async () => {
      const producerAgent = createTaskPda();

      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      commitmentLedger.createCommitment(rootPda, rootTask.taskId, randomBytes(32), producerAgent, 1000n);
      commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, 500n);

      // Set child to confirmed status
      commitmentLedger.updateStatus(childPda, 'confirmed');

      // Rolling back root should still work
      const result = await controller.rollback(rootPda, 'proof_failed');

      // Child should still be tracked as rolled back by controller
      expect(result.rolledBackTasks.length).toBe(1);
    });

    it('should handle abort controller that is already aborted', async () => {
      const producerAgent = createTaskPda();

      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, 500n);

      // Pre-abort the controller
      const ac = new AbortController();
      ac.abort();
      controller.registerActiveTask(childPda, ac);

      // Rollback should still work
      const result = await controller.rollback(rootPda, 'proof_failed');

      expect(result.rolledBackTasks.length).toBe(1);
      expect(ac.signal.aborted).toBe(true);
    });

    it('should handle multiple roots with overlapping descendants', async () => {
      const producerAgent = createTaskPda();

      // Create two separate roots
      const root1Pda = createTaskPda();
      const root2Pda = createTaskPda();

      const root1Task = createMockTask();
      const root2Task = createMockTask();

      dependencyGraph.addTask(root1Task, root1Pda);
      dependencyGraph.addTask(root2Task, root2Pda);

      // Each root has children
      const children1: PublicKey[] = [];
      const children2: PublicKey[] = [];

      for (let i = 0; i < 5; i++) {
        const child1Pda = createTaskPda();
        const child2Pda = createTaskPda();

        const child1Task = createMockTask();
        const child2Task = createMockTask();

        children1.push(child1Pda);
        children2.push(child2Pda);

        dependencyGraph.addTaskWithParent(child1Task, child1Pda, root1Pda);
        dependencyGraph.addTaskWithParent(child2Task, child2Pda, root2Pda);

        commitmentLedger.createCommitment(child1Pda, child1Task.taskId, randomBytes(32), producerAgent, 100n);
        commitmentLedger.createCommitment(child2Pda, child2Task.taskId, randomBytes(32), producerAgent, 100n);
      }

      // Rollback root1
      const result1 = await controller.rollback(root1Pda, 'proof_failed');

      // Only root1's children should be rolled back
      expect(result1.rolledBackTasks.length).toBe(5);

      for (const child of children1) {
        expect(controller.isRolledBack(child)).toBe(true);
      }

      for (const child of children2) {
        expect(controller.isRolledBack(child)).toBe(false);
      }
    });
  });
});
