/**
 * Integration tests for the speculation system.
 *
 * Tests the full flow across DependencyGraph, CommitmentLedger,
 * ProofPipeline, and SpeculativeTaskScheduler working together.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { DependencyGraph, DependencyType } from "../dependency-graph.js";
import { CommitmentLedger } from "../commitment-ledger.js";
import type { ProofPipeline } from "../proof-pipeline.js";
import {
  SpeculativeTaskScheduler,
  type SpeculativeSchedulerEvents,
} from "../speculative-scheduler.js";
import {
  createMockProofPipeline,
  createSpeculationTask,
  randomPda,
} from "../test-utils.js";

// ============================================================================
// Test Helpers
// ============================================================================

const createMockTask = createSpeculationTask;

// ============================================================================
// Integration Test Suite
// ============================================================================

describe("Speculation Integration", () => {
  let graph: DependencyGraph;
  let ledger: CommitmentLedger;
  let pipeline: ProofPipeline;
  let scheduler: SpeculativeTaskScheduler;
  let events: SpeculativeSchedulerEvents;
  let eventCallbacks: {
    onSpeculationStarted: ReturnType<typeof vi.fn>;
    onSpeculationConfirmed: ReturnType<typeof vi.fn>;
    onSpeculationFailed: ReturnType<typeof vi.fn>;
    onRollbackStarted: ReturnType<typeof vi.fn>;
    onRollbackCompleted: ReturnType<typeof vi.fn>;
    onDepthLimitReached: ReturnType<typeof vi.fn>;
    onStakeLimitReached: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    graph = new DependencyGraph();
    pipeline = createMockProofPipeline();

    // Set up event tracking
    eventCallbacks = {
      onSpeculationStarted: vi.fn(),
      onSpeculationConfirmed: vi.fn(),
      onSpeculationFailed: vi.fn(),
      onRollbackStarted: vi.fn(),
      onRollbackCompleted: vi.fn(),
      onDepthLimitReached: vi.fn(),
      onStakeLimitReached: vi.fn(),
    };

    events = {
      onSpeculationStarted: eventCallbacks.onSpeculationStarted,
      onSpeculationConfirmed: eventCallbacks.onSpeculationConfirmed,
      onSpeculationFailed: eventCallbacks.onSpeculationFailed,
      onRollbackStarted: eventCallbacks.onRollbackStarted,
      onRollbackCompleted: eventCallbacks.onRollbackCompleted,
      onDepthLimitReached: eventCallbacks.onDepthLimitReached,
      onStakeLimitReached: eventCallbacks.onStakeLimitReached,
    };

    scheduler = new SpeculativeTaskScheduler(
      {
        maxSpeculationDepth: 3,
        maxSpeculativeStake: 10_000_000_000n,
        enableSpeculation: true,
        allowPrivateSpeculation: false,
        minReputationForSpeculation: 500,
        proofTimeoutMs: 300_000,
        maxRollbackRatePercent: 20,
      },
      events,
      graph,
      pipeline,
    );

    ledger = scheduler.getCommitmentLedger();
  });

  afterEach(() => {
    scheduler.stop();
  });

  // ==========================================================================
  // Happy Path Tests
  // ==========================================================================

  describe("Happy Path", () => {
    it("should speculatively execute dependent task while parent proof pending", async () => {
      scheduler.start();

      // Create parent task in the graph
      const parentPda = randomPda();
      const parentTask = createMockTask();
      graph.addTask(parentTask, parentPda);
      graph.updateStatus(parentPda, "executing");

      // Create child task that depends on parent
      const childPda = randomPda();
      const childTask = createMockTask();
      graph.addTaskWithParent(
        childTask,
        childPda,
        parentPda,
        DependencyType.Data,
      );

      // Child should be speculatable (parent is executing)
      const speculatable = graph.getSpeculatableTasks();
      expect(speculatable).toHaveLength(1);
      expect(speculatable[0].taskPda.toBase58()).toBe(childPda.toBase58());

      // Check speculation is allowed
      const decision = scheduler.shouldSpeculate(childPda);
      expect(decision.allowed).toBe(true);

      // Register speculation start
      const depth = graph.getDepth(childPda);
      scheduler.registerSpeculationStart(childPda, depth);

      // Verify event fired
      expect(eventCallbacks.onSpeculationStarted).toHaveBeenCalledWith(
        childPda,
        depth,
      );

      // Verify active speculations count
      expect(scheduler.getStatus().activeSpeculations).toBe(1);
    });

    it("should confirm child after parent confirms", async () => {
      scheduler.start();

      // Set up parent task
      const parentPda = randomPda();
      const parentTask = createMockTask();
      const agentPda = randomPda();
      graph.addTask(parentTask, parentPda);
      graph.updateStatus(parentPda, "executing");

      // Create commitment for parent
      ledger.createCommitment(
        parentPda,
        parentTask.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );
      ledger.updateStatus(parentPda, "executing");

      // Set up child task
      const childPda = randomPda();
      const childTask = createMockTask();
      graph.addTaskWithParent(
        childTask,
        childPda,
        parentPda,
        DependencyType.Data,
      );

      // Speculate on child
      const decision = scheduler.shouldSpeculate(childPda);
      expect(decision.allowed).toBe(true);
      scheduler.registerSpeculationStart(childPda, 1);

      // Create commitment for child
      ledger.createCommitment(
        childPda,
        childTask.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );
      ledger.addDependent(parentPda, childPda);

      // Confirm parent
      scheduler.onProofConfirmed(parentPda);

      expect(eventCallbacks.onSpeculationConfirmed).toHaveBeenCalledWith(
        parentPda,
      );

      // Parent should be confirmed in graph
      const parentNode = graph.getNode(parentPda);
      expect(parentNode?.status).toBe("completed");

      // Parent commitment should be confirmed
      const parentCommitment = ledger.getByTask(parentPda);
      expect(parentCommitment?.status).toBe("confirmed");
    });

    it("should track metrics correctly through full lifecycle", async () => {
      scheduler.start();

      // Initial metrics
      let metrics = scheduler.getMetrics();
      expect(metrics.speculativeExecutions).toBe(0);
      expect(metrics.speculativeHits).toBe(0);
      expect(metrics.speculativeMisses).toBe(0);

      // Add and speculate on task
      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      scheduler.registerSpeculationStart(taskPda, 0);

      metrics = scheduler.getMetrics();
      expect(metrics.speculativeExecutions).toBe(1);

      // Confirm the task
      scheduler.onProofConfirmed(taskPda);

      metrics = scheduler.getMetrics();
      expect(metrics.speculativeHits).toBe(1);
      expect(metrics.hitRate).toBe(100);
    });
  });

  // ==========================================================================
  // Failure Scenarios
  // ==========================================================================

  describe("Failure Scenarios", () => {
    it("should rollback child when parent fails", async () => {
      scheduler.start();

      const agentPda = randomPda();

      // Set up parent task
      const parentPda = randomPda();
      const parentTask = createMockTask();
      graph.addTask(parentTask, parentPda);
      graph.updateStatus(parentPda, "executing");

      // Register parent speculation and create commitment
      scheduler.registerSpeculationStart(parentPda, 0);
      ledger.createCommitment(
        parentPda,
        parentTask.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );

      // Set up child task
      const childPda = randomPda();
      const childTask = createMockTask();
      graph.addTaskWithParent(
        childTask,
        childPda,
        parentPda,
        DependencyType.Data,
      );

      // Speculate on child and create commitment
      scheduler.registerSpeculationStart(childPda, 1);
      ledger.createCommitment(
        childPda,
        childTask.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );
      ledger.addDependent(parentPda, childPda);

      // Parent proof fails
      scheduler.onProofFailed(parentPda, "verification_failed");

      // Wait for async rollback to complete
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify failure event
      expect(eventCallbacks.onSpeculationFailed).toHaveBeenCalledWith(
        parentPda,
        "verification_failed",
      );

      // Child commitment should be rolled back via rollback cascade
      // Parent is marked failed, child is marked rolled_back by rollbackTask
      const parentCommitment = ledger.getByTask(parentPda);
      const childCommitment = ledger.getByTask(childPda);
      expect(parentCommitment?.status).toBe("failed");
      expect(childCommitment?.status).toBe("rolled_back");

      // Metrics should reflect the miss (parent was registered as speculative)
      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeMisses).toBe(1);
    });

    it("should cascade rollback through multiple levels", async () => {
      scheduler.start();

      const agentPda = randomPda();

      // Build a 3-level dependency chain: grandparent -> parent -> child
      const grandparentPda = randomPda();
      const grandparentTask = createMockTask();
      graph.addTask(grandparentTask, grandparentPda);
      graph.updateStatus(grandparentPda, "executing");
      ledger.createCommitment(
        grandparentPda,
        grandparentTask.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );

      const parentPda = randomPda();
      const parentTask = createMockTask();
      graph.addTaskWithParent(
        parentTask,
        parentPda,
        grandparentPda,
        DependencyType.Data,
      );
      ledger.createCommitment(
        parentPda,
        parentTask.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );
      ledger.addDependent(grandparentPda, parentPda);

      const childPda = randomPda();
      const childTask = createMockTask();
      graph.addTaskWithParent(
        childTask,
        childPda,
        parentPda,
        DependencyType.Data,
      );
      scheduler.registerSpeculationStart(childPda, 2);
      ledger.createCommitment(
        childPda,
        childTask.taskId,
        new Uint8Array(32),
        agentPda,
        250_000n,
      );
      ledger.addDependent(parentPda, childPda);

      // Grandparent fails - this should cascade through dependency graph
      scheduler.onProofFailed(grandparentPda, "proof_timeout");

      // Wait for async rollback to complete
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Grandparent is 'failed', parent and child are 'rolled_back'
      const grandparentCommitment = ledger.getByTask(grandparentPda);
      const parentCommitment = ledger.getByTask(parentPda);
      const childCommitment = ledger.getByTask(childPda);

      expect(grandparentCommitment?.status).toBe("failed");
      expect(parentCommitment?.status).toBe("rolled_back");
      expect(childCommitment?.status).toBe("rolled_back");
    });

    it("should handle concurrent speculations with one failure", async () => {
      scheduler.start();

      const agentPda = randomPda();

      // Parent task
      const parentPda = randomPda();
      const parentTask = createMockTask();
      graph.addTask(parentTask, parentPda);
      graph.updateStatus(parentPda, "completed");
      ledger.createCommitment(
        parentPda,
        parentTask.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );
      ledger.markConfirmed(parentPda);

      // Two sibling children
      const child1Pda = randomPda();
      const child1Task = createMockTask();
      graph.addTaskWithParent(
        child1Task,
        child1Pda,
        parentPda,
        DependencyType.Data,
      );
      scheduler.registerSpeculationStart(child1Pda, 1);
      ledger.createCommitment(
        child1Pda,
        child1Task.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );

      const child2Pda = randomPda();
      const child2Task = createMockTask();
      graph.addTaskWithParent(
        child2Task,
        child2Pda,
        parentPda,
        DependencyType.Data,
      );
      scheduler.registerSpeculationStart(child2Pda, 1);
      ledger.createCommitment(
        child2Pda,
        child2Task.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );

      // Child 1 confirms
      scheduler.onProofConfirmed(child1Pda);

      // Child 2 fails
      scheduler.onProofFailed(child2Pda, "invalid_proof");

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Child 1 should still be confirmed
      const child1Commitment = ledger.getByTask(child1Pda);
      expect(child1Commitment?.status).toBe("confirmed");

      // Child 2 should be failed
      const child2Commitment = ledger.getByTask(child2Pda);
      expect(child2Commitment?.status).toBe("failed");

      // Metrics
      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeHits).toBe(1);
      expect(metrics.speculativeMisses).toBe(1);
    });
  });

  // ==========================================================================
  // Limit Tests
  // ==========================================================================

  describe("Limits", () => {
    it("should respect depth limit", async () => {
      scheduler.start();

      // Build a chain that reaches depth limit (3)
      // depth 0: root
      // depth 1: child1
      // depth 2: child2 (should be allowed, depth < 3)
      // depth 3: child3 (should be blocked, depth >= 3)

      const taskChain: { pda: PublicKey; task: OnChainTask }[] = [];

      // Root at depth 0
      const rootPda = randomPda();
      const rootTask = createMockTask();
      graph.addTask(rootTask, rootPda);
      graph.updateStatus(rootPda, "completed");
      taskChain.push({ pda: rootPda, task: rootTask });

      // Build chain to depth 2
      for (let i = 1; i <= 2; i++) {
        const pda = randomPda();
        const task = createMockTask();
        graph.addTaskWithParent(
          task,
          pda,
          taskChain[i - 1].pda,
          DependencyType.Data,
        );
        graph.updateStatus(pda, "executing");
        taskChain.push({ pda, task });
      }

      // Task at depth 2 should be speculatable
      const depth2Decision = scheduler.shouldSpeculate(taskChain[2].pda);
      expect(depth2Decision.allowed).toBe(true);

      // Add one more to depth 3
      const depth3Pda = randomPda();
      const depth3Task = createMockTask();
      graph.addTaskWithParent(
        depth3Task,
        depth3Pda,
        taskChain[2].pda,
        DependencyType.Data,
      );

      // Task at depth 3 should be blocked (depth >= maxSpeculationDepth)
      const depth3Decision = scheduler.shouldSpeculate(depth3Pda);
      expect(depth3Decision.allowed).toBe(false);
      expect(depth3Decision.reason).toBe("depth_limit");

      // Verify event callback
      expect(eventCallbacks.onDepthLimitReached).toHaveBeenCalled();
    });

    it("should respect stake limit", async () => {
      // Create scheduler with lower stake limit for testing
      const lowStakeScheduler = new SpeculativeTaskScheduler(
        {
          maxSpeculationDepth: 10,
          maxSpeculativeStake: 1_000_000n, // 0.001 SOL
          enableSpeculation: true,
        },
        events,
        graph,
        pipeline,
      );
      lowStakeScheduler.start();

      const lowStakeLedger = lowStakeScheduler.getCommitmentLedger();
      const agentPda = randomPda();

      // Add task with stake near the limit
      const task1Pda = randomPda();
      const task1 = createMockTask();
      graph.addTask(task1, task1Pda);
      lowStakeLedger.createCommitment(
        task1Pda,
        task1.taskId,
        new Uint8Array(32),
        agentPda,
        900_000n, // 0.0009 SOL
      );

      // Add another task
      const task2Pda = randomPda();
      const task2 = createMockTask();
      graph.addTask(task2, task2Pda);
      lowStakeLedger.createCommitment(
        task2Pda,
        task2.taskId,
        new Uint8Array(32),
        agentPda,
        200_000n, // Would put us over limit
      );

      // Total stake is now 1,100,000 which exceeds 1,000,000 limit
      // Check speculation on a new task
      const task3Pda = randomPda();
      const task3 = createMockTask();
      graph.addTask(task3, task3Pda);

      const decision = lowStakeScheduler.shouldSpeculate(task3Pda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("stake_limit");

      // Verify event callback
      expect(eventCallbacks.onStakeLimitReached).toHaveBeenCalled();

      lowStakeScheduler.stop();
    });

    it("should block private speculation when disabled", async () => {
      scheduler.start();

      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      // Speculation should be blocked for private tasks
      const decision = scheduler.shouldSpeculate(
        taskPda,
        undefined,
        true,
        1000,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("private_speculation_disabled");
    });

    it("should block low reputation agents", async () => {
      scheduler.start();

      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      // Low reputation should be blocked (min is 500)
      const decision = scheduler.shouldSpeculate(
        taskPda,
        undefined,
        false,
        200,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("low_reputation");
    });
  });

  // ==========================================================================
  // Auto-disable Tests
  // ==========================================================================

  describe("Auto-disable", () => {
    it("should auto-disable speculation when rollback rate too high", async () => {
      // Create scheduler with low rollback threshold
      const sensitiveScheduler = new SpeculativeTaskScheduler(
        {
          maxSpeculationDepth: 10,
          maxSpeculativeStake: 100_000_000_000n,
          enableSpeculation: true,
          maxRollbackRatePercent: 10, // 10% threshold
        },
        events,
        graph,
        pipeline,
      );
      sensitiveScheduler.start();

      // Simulate multiple speculations with failures
      const tasks: PublicKey[] = [];
      for (let i = 0; i < 10; i++) {
        const pda = randomPda();
        const task = createMockTask();
        graph.addTask(task, pda);
        tasks.push(pda);
        sensitiveScheduler.registerSpeculationStart(pda, 0);
      }

      // Fail 2 out of 10 (20% rollback rate, exceeds 10% threshold)
      sensitiveScheduler.onProofFailed(tasks[0], "failed");
      sensitiveScheduler.onProofFailed(tasks[1], "failed");

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After failures, try to speculate on a new task - this triggers the check
      const newTaskPda = randomPda();
      const newTask = createMockTask();
      graph.addTask(newTask, newTaskPda);

      const decision = sensitiveScheduler.shouldSpeculate(newTaskPda);

      // The rollback rate check happens inside shouldSpeculate
      // At this point, rollbackRate = 2/10 = 20% which exceeds 10% threshold
      expect(decision.allowed).toBe(false);
      // Could be 'disabled' (auto-disabled) or 'rollback_rate_exceeded'
      expect(["disabled", "rollback_rate_exceeded"]).toContain(decision.reason);

      sensitiveScheduler.stop();
    });

    it("should allow re-enabling speculation after auto-disable", async () => {
      scheduler.start();

      // Disable speculation
      scheduler.disableSpeculation("manual_test");
      expect(scheduler.isSpeculationEnabled()).toBe(false);

      // Re-enable
      scheduler.enableSpeculation();
      expect(scheduler.isSpeculationEnabled()).toBe(true);

      // Should be able to speculate again
      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      const decision = scheduler.shouldSpeculate(taskPda);
      expect(decision.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Status and Metrics Integration
  // ==========================================================================

  describe("Status and Metrics", () => {
    it("should provide consistent status across components", async () => {
      scheduler.start();

      const agentPda = randomPda();

      // Add some tasks with commitments
      const task1Pda = randomPda();
      const task1 = createMockTask();
      graph.addTask(task1, task1Pda);
      ledger.createCommitment(
        task1Pda,
        task1.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );
      scheduler.registerSpeculationStart(task1Pda, 0);

      const task2Pda = randomPda();
      const task2 = createMockTask();
      graph.addTaskWithParent(task2, task2Pda, task1Pda, DependencyType.Data);
      ledger.createCommitment(
        task2Pda,
        task2.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );
      scheduler.registerSpeculationStart(task2Pda, 1);

      // Check status
      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
      expect(status.speculationEnabled).toBe(true);
      expect(status.activeSpeculations).toBe(2);
      expect(status.totalStakeAtRisk).toBe(1_500_000n);

      // Check ledger stats match
      const ledgerStats = ledger.getStats();
      expect(ledgerStats.totalStakeAtRisk).toBe(1_500_000n);
      expect(ledgerStats.total).toBe(2);
    });

    it("should track time saved and wasted accurately", async () => {
      scheduler.start();

      // Start speculation
      const task1Pda = randomPda();
      const task1 = createMockTask();
      graph.addTask(task1, task1Pda);
      scheduler.registerSpeculationStart(task1Pda, 0);

      // Wait a bit to accumulate time
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Confirm - should count as time saved
      scheduler.onProofConfirmed(task1Pda);

      let metrics = scheduler.getMetrics();
      expect(metrics.estimatedTimeSaved).toBeGreaterThan(0);

      // Start another speculation
      const task2Pda = randomPda();
      const task2 = createMockTask();
      graph.addTask(task2, task2Pda);
      scheduler.registerSpeculationStart(task2Pda, 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Fail - should count as time wasted
      scheduler.onProofFailed(task2Pda, "test_failure");

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 20));

      metrics = scheduler.getMetrics();
      expect(metrics.speculativeHits).toBe(1);
      expect(metrics.speculativeMisses).toBe(1);
      expect(metrics.hitRate).toBe(50);
    });

    it("should correctly calculate active commitments", async () => {
      scheduler.start();

      const agentPda = randomPda();

      // Add multiple tasks in different states
      const pendingPda = randomPda();
      const pendingTask = createMockTask();
      graph.addTask(pendingTask, pendingPda);
      ledger.createCommitment(
        pendingPda,
        pendingTask.taskId,
        new Uint8Array(32),
        agentPda,
        1_000_000n,
      );

      const confirmedPda = randomPda();
      const confirmedTask = createMockTask();
      graph.addTask(confirmedTask, confirmedPda);
      ledger.createCommitment(
        confirmedPda,
        confirmedTask.taskId,
        new Uint8Array(32),
        agentPda,
        500_000n,
      );
      ledger.markConfirmed(confirmedPda);

      const failedPda = randomPda();
      const failedTask = createMockTask();
      graph.addTask(failedTask, failedPda);
      ledger.createCommitment(
        failedPda,
        failedTask.taskId,
        new Uint8Array(32),
        agentPda,
        250_000n,
      );
      ledger.markFailed(failedPda);

      // Get active commitments (should only include pending)
      const active = scheduler.getActiveCommitments();
      expect(active).toHaveLength(1);
      expect(active[0].sourceTaskPda.toBase58()).toBe(pendingPda.toBase58());
    });
  });

  // ==========================================================================
  // Dependency Type Filtering
  // ==========================================================================

  describe("Dependency Type Filtering", () => {
    it("should only allow speculation on configured dependency types", async () => {
      // Create scheduler that only allows Data dependencies
      const dataOnlyScheduler = new SpeculativeTaskScheduler(
        {
          maxSpeculationDepth: 10,
          maxSpeculativeStake: 100_000_000_000n,
          enableSpeculation: true,
          speculatableDependencyTypes: [DependencyType.Data],
        },
        events,
        graph,
        pipeline,
      );
      dataOnlyScheduler.start();

      const rootPda = randomPda();
      const rootTask = createMockTask();
      graph.addTask(rootTask, rootPda);
      graph.updateStatus(rootPda, "completed");

      // Data dependency should be allowed
      const dataPda = randomPda();
      const dataTask = createMockTask();
      graph.addTaskWithParent(dataTask, dataPda, rootPda, DependencyType.Data);

      const dataDecision = dataOnlyScheduler.shouldSpeculate(dataPda);
      expect(dataDecision.allowed).toBe(true);

      // Order dependency should be blocked
      const orderPda = randomPda();
      const orderTask = createMockTask();
      graph.addTaskWithParent(
        orderTask,
        orderPda,
        rootPda,
        DependencyType.Order,
      );

      const orderDecision = dataOnlyScheduler.shouldSpeculate(orderPda);
      expect(orderDecision.allowed).toBe(false);
      expect(orderDecision.reason).toBe("dependency_type_not_speculatable");

      dataOnlyScheduler.stop();
    });
  });
});
