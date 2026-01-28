/**
 * RollbackController tests
 * @module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import { RollbackController, type RollbackEvents, type RollbackReason } from './rollback-controller.js';
import { DependencyGraph } from './dependency-graph.js';
import { CommitmentLedger } from './commitment-ledger.js';
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

// ============================================================================
// Test Suite
// ============================================================================

describe('RollbackController', () => {
  let dependencyGraph: DependencyGraph;
  let commitmentLedger: CommitmentLedger;
  let controller: RollbackController;
  let events: RollbackEvents;

  beforeEach(() => {
    dependencyGraph = new DependencyGraph();
    commitmentLedger = new CommitmentLedger({ maxCommitments: 1000 });
    events = {
      onRollbackStarted: vi.fn(),
      onTaskRolledBack: vi.fn(),
      onRollbackCompleted: vi.fn(),
      onRetryScheduled: vi.fn(),
    };
    controller = new RollbackController(
      { enableEvents: true },
      dependencyGraph,
      commitmentLedger,
      events
    );
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const ctrl = new RollbackController({}, dependencyGraph, commitmentLedger);
      expect(ctrl).toBeDefined();
    });

    it('should accept partial config', () => {
      const ctrl = new RollbackController(
        { allowRetry: true, maxRetries: 3 },
        dependencyGraph,
        commitmentLedger
      );
      expect(ctrl).toBeDefined();
    });
  });

  describe('registerActiveTask / unregisterActiveTask', () => {
    it('should register and unregister active tasks', () => {
      const taskPda = createTaskPda();
      const abortController = new AbortController();

      controller.registerActiveTask(taskPda, abortController);
      expect(controller.isRolledBack(taskPda)).toBe(false);

      controller.unregisterActiveTask(taskPda);
    });

    it('should track commitment ID when provided', () => {
      const taskPda = createTaskPda();
      const abortController = new AbortController();
      const commitmentId = 'test-commitment-id';

      controller.registerActiveTask(taskPda, abortController, commitmentId);
      controller.unregisterActiveTask(taskPda);
    });
  });

  describe('isRolledBack', () => {
    it('should return false for tasks not rolled back', () => {
      const taskPda = createTaskPda();
      expect(controller.isRolledBack(taskPda)).toBe(false);
    });

    it('should return true after rollback', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      await controller.rollback(rootPda, 'proof_failed');

      expect(controller.isRolledBack(rootPda)).toBe(true);
    });
  });

  describe('rollback - single task', () => {
    it('should rollback a single root task with no descendants', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      const result = await controller.rollback(rootPda, 'proof_failed');

      expect(result.rootTaskPda.equals(rootPda)).toBe(true);
      expect(result.reason).toBe('proof_failed');
      expect(result.rolledBackTasks).toHaveLength(0); // No descendants
      expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should update dependency graph status on rollback', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      await controller.rollback(rootPda, 'proof_failed');

      const node = dependencyGraph.getNode(rootPda);
      expect(node?.status).toBe('failed');
    });

    it('should emit events during rollback', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      await controller.rollback(rootPda, 'manual');

      expect(events.onRollbackStarted).toHaveBeenCalledWith(rootPda, 0);
      expect(events.onRollbackCompleted).toHaveBeenCalled();
    });
  });

  describe('rollback - cascade (chain)', () => {
    it('should rollback all tasks in a linear chain', async () => {
      // Create chain: A -> B -> C
      const pdaA = createTaskPda();
      const pdaB = createTaskPda();
      const pdaC = createTaskPda();

      const taskA = createMockTask();
      const taskB = createMockTask();
      const taskC = createMockTask();

      dependencyGraph.addTask(taskA, pdaA);
      dependencyGraph.addTaskWithParent(taskB, pdaB, pdaA);
      dependencyGraph.addTaskWithParent(taskC, pdaC, pdaB);

      // Create commitments
      const producerAgent = createTaskPda();
      commitmentLedger.createCommitment(pdaB, taskB.taskId, randomBytes(32), producerAgent, 1000n);
      commitmentLedger.createCommitment(pdaC, taskC.taskId, randomBytes(32), producerAgent, 2000n);

      // Rollback from A (root failure)
      const result = await controller.rollback(pdaA, 'proof_failed');

      expect(result.rolledBackTasks).toHaveLength(2);
      expect(controller.isRolledBack(pdaA)).toBe(true);
      expect(controller.isRolledBack(pdaB)).toBe(true);
      expect(controller.isRolledBack(pdaC)).toBe(true);

      // Verify stake calculation
      expect(result.stakeAtRisk).toBe(3000n);
    });

    it('should abort executing tasks in chain', async () => {
      // Create chain: A -> B
      const pdaA = createTaskPda();
      const pdaB = createTaskPda();

      const taskA = createMockTask();
      const taskB = createMockTask();

      dependencyGraph.addTask(taskA, pdaA);
      dependencyGraph.addTaskWithParent(taskB, pdaB, pdaA);

      // Register B as actively executing
      const abortController = new AbortController();
      controller.registerActiveTask(pdaB, abortController);

      // Rollback from A
      await controller.rollback(pdaA, 'proof_failed');

      // Verify abort was called
      expect(abortController.signal.aborted).toBe(true);

      // Verify B was recorded as aborted
      const result = controller.getRollbackHistory()[0];
      const rolledBackB = result.rolledBackTasks.find(t => t.taskPda.equals(pdaB));
      expect(rolledBackB?.action).toBe('aborted');
      expect(rolledBackB?.state).toBe('executing');
    });
  });

  describe('rollback - cascade (DAG)', () => {
    it('should rollback all branches in a DAG', async () => {
      // Create DAG:
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
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
      // Note: DependencyGraph only supports single parent, so D depends on B only
      dependencyGraph.addTaskWithParent(taskD, pdaD, pdaB);

      // Rollback from A
      const result = await controller.rollback(pdaA, 'proof_failed');

      // Should rollback B, C, D (3 descendants)
      expect(result.rolledBackTasks).toHaveLength(3);
      expect(controller.isRolledBack(pdaA)).toBe(true);
      expect(controller.isRolledBack(pdaB)).toBe(true);
      expect(controller.isRolledBack(pdaC)).toBe(true);
      expect(controller.isRolledBack(pdaD)).toBe(true);
    });

    it('should rollback partial DAG from middle node', async () => {
      // Create chain: A -> B -> C
      const pdaA = createTaskPda();
      const pdaB = createTaskPda();
      const pdaC = createTaskPda();

      const taskA = createMockTask();
      const taskB = createMockTask();
      const taskC = createMockTask();

      dependencyGraph.addTask(taskA, pdaA);
      dependencyGraph.addTaskWithParent(taskB, pdaB, pdaA);
      dependencyGraph.addTaskWithParent(taskC, pdaC, pdaB);

      // Rollback from B (middle)
      const result = await controller.rollback(pdaB, 'proof_timeout');

      // Should only rollback C (B's descendant)
      expect(result.rolledBackTasks).toHaveLength(1);
      expect(controller.isRolledBack(pdaA)).toBe(false); // A is ancestor, not affected
      expect(controller.isRolledBack(pdaB)).toBe(true);
      expect(controller.isRolledBack(pdaC)).toBe(true);
    });
  });

  describe('rollback - idempotency', () => {
    it('should return cached result on repeated rollback', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      const result1 = await controller.rollback(rootPda, 'proof_failed');
      const result2 = await controller.rollback(rootPda, 'proof_failed');

      // Same object should be returned
      expect(result1).toBe(result2);

      // Events should only fire once
      expect(events.onRollbackCompleted).toHaveBeenCalledTimes(1);
    });

    it('should handle idempotent rollback with different reasons', async () => {
      const rootPda = createTaskPda();
      const rootTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);

      const result1 = await controller.rollback(rootPda, 'proof_failed');
      const result2 = await controller.rollback(rootPda, 'manual');

      // First result should be cached regardless of different reason
      expect(result1).toBe(result2);
      expect(result2.reason).toBe('proof_failed'); // Original reason preserved
    });
  });

  describe('rollback - commitment status updates', () => {
    it('should update commitment status to rolled_back', async () => {
      const pdaA = createTaskPda();
      const pdaB = createTaskPda();

      const taskA = createMockTask();
      const taskB = createMockTask();

      dependencyGraph.addTask(taskA, pdaA);
      dependencyGraph.addTaskWithParent(taskB, pdaB, pdaA);

      // Create commitment for B
      const producerAgent = createTaskPda();
      commitmentLedger.createCommitment(pdaB, taskB.taskId, randomBytes(32), producerAgent, 1000n);

      // Rollback from A
      await controller.rollback(pdaA, 'proof_failed');

      // Verify commitment status
      const commitment = commitmentLedger.getByTask(pdaB);
      expect(commitment?.status).toBe('rolled_back');
    });

    it('should handle tasks without commitments gracefully', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      // No commitments created - should not throw
      const result = await controller.rollback(rootPda, 'proof_failed');

      expect(result.rolledBackTasks).toHaveLength(1);
    });
  });

  describe('rollback - different states', () => {
    it('should handle task in pending state', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      const producerAgent = createTaskPda();
      const commitment = commitmentLedger.createCommitment(
        childPda, childTask.taskId, randomBytes(32), producerAgent, 1000n
      );
      expect(commitment.status).toBe('pending');

      const result = await controller.rollback(rootPda, 'proof_failed');

      const rolledBack = result.rolledBackTasks.find(t => t.taskPda.equals(childPda));
      expect(rolledBack?.state).toBe('executing');
    });

    it('should handle task in proof_generating state', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      const producerAgent = createTaskPda();
      commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, 1000n);
      commitmentLedger.updateStatus(childPda, 'proof_generating');

      const result = await controller.rollback(rootPda, 'proof_failed');

      const rolledBack = result.rolledBackTasks.find(t => t.taskPda.equals(childPda));
      expect(rolledBack?.state).toBe('proof_generating');
      expect(rolledBack?.action).toBe('cancelled');
    });

    it('should handle task in proof_generated state', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const rootTask = createMockTask();
      const childTask = createMockTask();

      dependencyGraph.addTask(rootTask, rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      const producerAgent = createTaskPda();
      commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producerAgent, 1000n);
      commitmentLedger.updateStatus(childPda, 'proof_generated');

      const result = await controller.rollback(rootPda, 'proof_failed');

      const rolledBack = result.rolledBackTasks.find(t => t.taskPda.equals(childPda));
      expect(rolledBack?.state).toBe('proof_generated');
      expect(rolledBack?.action).toBe('cancelled');
    });
  });

  describe('getRollbackHistory', () => {
    it('should return empty array initially', () => {
      const history = controller.getRollbackHistory();
      expect(history).toHaveLength(0);
    });

    it('should return history in newest-first order', async () => {
      const pda1 = createTaskPda();
      const pda2 = createTaskPda();

      dependencyGraph.addTask(createMockTask(), pda1);
      dependencyGraph.addTask(createMockTask(), pda2);

      await controller.rollback(pda1, 'proof_failed');
      await controller.rollback(pda2, 'proof_timeout');

      const history = controller.getRollbackHistory();

      expect(history).toHaveLength(2);
      expect(history[0].rootTaskPda.equals(pda2)).toBe(true); // Newest first
      expect(history[1].rootTaskPda.equals(pda1)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const pdas = [createTaskPda(), createTaskPda(), createTaskPda()];

      for (const pda of pdas) {
        dependencyGraph.addTask(createMockTask(), pda);
        await controller.rollback(pda, 'proof_failed');
      }

      const history = controller.getRollbackHistory(2);
      expect(history).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('should return zero stats initially', () => {
      const stats = controller.getStats();

      expect(stats.totalRollbacks).toBe(0);
      expect(stats.totalTasksRolledBack).toBe(0);
      expect(stats.totalWastedComputeMs).toBe(0);
      expect(stats.totalStakeLost).toBe(0n);
    });

    it('should track cumulative statistics', async () => {
      // Create two chains
      const pda1 = createTaskPda();
      const pda1Child = createTaskPda();
      const pda2 = createTaskPda();

      dependencyGraph.addTask(createMockTask(), pda1);
      dependencyGraph.addTaskWithParent(createMockTask(), pda1Child, pda1);
      dependencyGraph.addTask(createMockTask(), pda2);

      // Create commitments
      const producer = createTaskPda();
      const task1Child = createMockTask();
      commitmentLedger.createCommitment(pda1Child, task1Child.taskId, randomBytes(32), producer, 1000n);

      await controller.rollback(pda1, 'proof_failed');
      await controller.rollback(pda2, 'proof_timeout');

      const stats = controller.getStats();

      expect(stats.totalRollbacks).toBe(2);
      expect(stats.totalTasksRolledBack).toBe(1); // Only pda1Child was a descendant
      expect(stats.totalStakeLost).toBe(1000n);
      expect(stats.rollbacksByReason.proof_failed).toBe(1);
      expect(stats.rollbacksByReason.proof_timeout).toBe(1);
    });
  });

  describe('clear', () => {
    it('should reset all state', async () => {
      const pda = createTaskPda();
      dependencyGraph.addTask(createMockTask(), pda);

      await controller.rollback(pda, 'proof_failed');

      expect(controller.isRolledBack(pda)).toBe(true);
      expect(controller.getStats().totalRollbacks).toBe(1);

      controller.clear();

      expect(controller.isRolledBack(pda)).toBe(false);
      expect(controller.getStats().totalRollbacks).toBe(0);
      expect(controller.getRollbackHistory()).toHaveLength(0);
    });
  });

  describe('rollback - events disabled', () => {
    it('should not emit events when disabled', async () => {
      const noEventsController = new RollbackController(
        { enableEvents: false },
        dependencyGraph,
        commitmentLedger,
        events
      );

      const pda = createTaskPda();
      dependencyGraph.addTask(createMockTask(), pda);

      await noEventsController.rollback(pda, 'proof_failed');

      expect(events.onRollbackStarted).not.toHaveBeenCalled();
      expect(events.onRollbackCompleted).not.toHaveBeenCalled();
    });
  });

  describe('rollback - all reasons', () => {
    const reasons: RollbackReason[] = ['proof_failed', 'proof_timeout', 'ancestor_failed', 'manual'];

    for (const reason of reasons) {
      it(`should handle reason: ${reason}`, async () => {
        const pda = createTaskPda();
        dependencyGraph.addTask(createMockTask(), pda);

        const result = await controller.rollback(pda, reason);

        expect(result.reason).toBe(reason);
      });
    }
  });

  describe('rollback - wasted compute calculation', () => {
    it('should calculate compute time for active tasks', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      dependencyGraph.addTask(createMockTask(), rootPda);
      dependencyGraph.addTaskWithParent(createMockTask(), childPda, rootPda);

      // Register child as actively executing
      const abortController = new AbortController();
      controller.registerActiveTask(childPda, abortController);

      // Wait a bit to accumulate compute time
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await controller.rollback(rootPda, 'proof_failed');

      // Should have some wasted compute time
      expect(result.wastedComputeMs).toBeGreaterThan(0);
    });

    it('should calculate compute time from commitment creation', async () => {
      const rootPda = createTaskPda();
      const childPda = createTaskPda();

      const childTask = createMockTask();

      dependencyGraph.addTask(createMockTask(), rootPda);
      dependencyGraph.addTaskWithParent(childTask, childPda, rootPda);

      // Create commitment
      const producer = createTaskPda();
      commitmentLedger.createCommitment(childPda, childTask.taskId, randomBytes(32), producer, 1000n);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await controller.rollback(rootPda, 'proof_failed');

      // Should have compute time from commitment age
      const childRolledBack = result.rolledBackTasks.find(t => t.taskPda.equals(childPda));
      expect(childRolledBack?.computeTimeMs).toBeGreaterThan(0);
    });
  });

  describe('integration - large cascade', () => {
    it('should handle deep dependency chains', async () => {
      // Create chain of depth 10
      const pdas: PublicKey[] = [];
      const tasks: OnChainTask[] = [];

      for (let i = 0; i < 10; i++) {
        pdas.push(createTaskPda());
        tasks.push(createMockTask());
      }

      // Build chain
      dependencyGraph.addTask(tasks[0], pdas[0]);
      for (let i = 1; i < 10; i++) {
        dependencyGraph.addTaskWithParent(tasks[i], pdas[i], pdas[i - 1]);
      }

      // Rollback from root
      const result = await controller.rollback(pdas[0], 'proof_failed');

      // Should rollback all 9 descendants
      expect(result.rolledBackTasks).toHaveLength(9);

      // All should be marked as rolled back
      for (const pda of pdas) {
        expect(controller.isRolledBack(pda)).toBe(true);
      }
    });

    it('should handle wide branching factor', async () => {
      // Create root with 20 children
      const rootPda = createTaskPda();
      const rootTask = createMockTask();
      dependencyGraph.addTask(rootTask, rootPda);

      const childPdas: PublicKey[] = [];
      for (let i = 0; i < 20; i++) {
        const childPda = createTaskPda();
        childPdas.push(childPda);
        dependencyGraph.addTaskWithParent(createMockTask(), childPda, rootPda);
      }

      const result = await controller.rollback(rootPda, 'proof_failed');

      expect(result.rolledBackTasks).toHaveLength(20);
    });
  });
});
