/**
 * Tests for SpeculativeTaskScheduler
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  SpeculativeTaskScheduler,
  type SpeculativeSchedulerConfig,
  type SpeculativeSchedulerEvents,
} from './speculative-scheduler.js';
import { DependencyGraph, DependencyType } from './dependency-graph.js';
import type { ProofPipeline } from './proof-pipeline.js';
import type { OnChainTask } from './types.js';
import { OnChainTaskStatus, TaskType } from './types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function randomPda(): PublicKey {
  return Keypair.generate().publicKey;
}

function createMockTask(): OnChainTask {
  return {
    taskId: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
    creator: randomPda(),
    requiredCapabilities: 0n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: Math.floor(Date.now() / 1000),
    deadline: 0,
    completedAt: 0,
    escrow: randomPda(),
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
  };
}

function createMockProofPipeline(): ProofPipeline {
  return {
    queueProofGeneration: vi.fn(),
    submitProof: vi.fn().mockResolvedValue('mock-signature'),
    getQueuedJobs: vi.fn().mockReturnValue([]),
    getActiveJobs: vi.fn().mockReturnValue([]),
    getCompletedJobs: vi.fn().mockReturnValue([]),
    getFailedJobs: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      queued: 0,
      generating: 0,
      generated: 0,
      submitting: 0,
      confirmed: 0,
      failed: 0,
      totalProcessed: 0,
      averageGenerationTimeMs: 0,
      averageSubmissionTimeMs: 0,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    isShuttingDown: vi.fn().mockReturnValue(false),
    cancel: vi.fn(),
  } as unknown as ProofPipeline;
}

function createScheduler(
  configOverrides: Partial<SpeculativeSchedulerConfig> = {},
  events: SpeculativeSchedulerEvents = {},
  dependencyGraph?: DependencyGraph
): {
  scheduler: SpeculativeTaskScheduler;
  graph: DependencyGraph;
  pipeline: ProofPipeline;
} {
  const graph = dependencyGraph ?? new DependencyGraph();
  const pipeline = createMockProofPipeline();

  const scheduler = new SpeculativeTaskScheduler(
    {
      maxSpeculationDepth: 3,
      maxSpeculativeStake: 10_000_000_000n,
      enableSpeculation: true,
      ...configOverrides,
    },
    events,
    graph,
    pipeline
  );

  return { scheduler, graph, pipeline };
}

// ============================================================================
// Tests
// ============================================================================

describe('SpeculativeTaskScheduler', () => {
  describe('constructor', () => {
    it('should create scheduler with default config', () => {
      const { scheduler } = createScheduler();

      const status = scheduler.getStatus();
      expect(status.running).toBe(false);
      expect(status.speculationEnabled).toBe(true);
      expect(status.activeSpeculations).toBe(0);
    });

    it('should respect enableSpeculation config', () => {
      const { scheduler } = createScheduler({ enableSpeculation: false });

      const status = scheduler.getStatus();
      expect(status.speculationEnabled).toBe(false);
    });

    it('should wire up component accessors', () => {
      const { scheduler, graph } = createScheduler();

      expect(scheduler.getDependencyGraph()).toBe(graph);
      expect(scheduler.getCommitmentLedger()).toBeDefined();
      expect(scheduler.getProofDeferralManager()).toBeDefined();
      expect(scheduler.getRollbackController()).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    it('should start and stop correctly', () => {
      const { scheduler } = createScheduler();

      expect(scheduler.getStatus().running).toBe(false);

      scheduler.start();
      expect(scheduler.getStatus().running).toBe(true);

      scheduler.stop();
      expect(scheduler.getStatus().running).toBe(false);
    });

    it('should handle multiple start calls gracefully', () => {
      const { scheduler } = createScheduler();

      scheduler.start();
      scheduler.start(); // Should not throw
      expect(scheduler.getStatus().running).toBe(true);
    });

    it('should handle multiple stop calls gracefully', () => {
      const { scheduler } = createScheduler();

      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // Should not throw
      expect(scheduler.getStatus().running).toBe(false);
    });
  });

  describe('shouldSpeculate - global enable', () => {
    it('should allow speculation when enabled', () => {
      const { scheduler, graph } = createScheduler({ enableSpeculation: true });

      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      const decision = scheduler.shouldSpeculate(taskPda);
      expect(decision.allowed).toBe(true);
    });

    it('should deny speculation when disabled', () => {
      const { scheduler, graph } = createScheduler({ enableSpeculation: false });

      const taskPda = randomPda();
      const task = createMockTask();
      graph.addTask(task, taskPda);

      const decision = scheduler.shouldSpeculate(taskPda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('disabled');
    });

    it('should deny when task not found in graph', () => {
      const { scheduler } = createScheduler();

      const taskPda = randomPda();
      const decision = scheduler.shouldSpeculate(taskPda);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('task_not_found');
    });
  });

  describe('shouldSpeculate - depth limiting', () => {
    it('should allow speculation within depth limit', () => {
      const { scheduler, graph } = createScheduler({ maxSpeculationDepth: 3 });

      // Create chain: root -> child1 -> child2 (depth 2)
      const rootPda = randomPda();
      const child1Pda = randomPda();
      const child2Pda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), child1Pda, rootPda);
      graph.addTaskWithParent(createMockTask(), child2Pda, child1Pda);

      // Depth 2 should be allowed (limit is 3)
      const decision = scheduler.shouldSpeculate(child2Pda);
      expect(decision.allowed).toBe(true);
    });

    it('should deny speculation when at depth limit', () => {
      const { scheduler, graph } = createScheduler({ maxSpeculationDepth: 2 });

      // Create chain: root -> child1 -> child2 (depth 2)
      const rootPda = randomPda();
      const child1Pda = randomPda();
      const child2Pda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), child1Pda, rootPda);
      graph.addTaskWithParent(createMockTask(), child2Pda, child1Pda);

      // Depth 2 == limit of 2, should be denied
      const decision = scheduler.shouldSpeculate(child2Pda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('depth_limit');
    });

    it('should fire onDepthLimitReached event', () => {
      const onDepthLimitReached = vi.fn();

      const { scheduler, graph } = createScheduler(
        { maxSpeculationDepth: 1 },
        { onDepthLimitReached }
      );

      const rootPda = randomPda();
      const childPda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), childPda, rootPda);

      scheduler.shouldSpeculate(childPda);

      expect(onDepthLimitReached).toHaveBeenCalledWith(childPda, 1);
    });
  });

  describe('shouldSpeculate - stake limiting', () => {
    it('should deny speculation when stake limit reached', () => {
      const { scheduler, graph } = createScheduler({
        maxSpeculativeStake: 1_000_000n, // 0.001 SOL
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      // Create commitments to exceed stake limit
      const ledger = scheduler.getCommitmentLedger();
      const task1Pda = randomPda();
      ledger.createCommitment(
        task1Pda,
        new Uint8Array(32),
        new Uint8Array(32),
        randomPda(),
        2_000_000n // Exceeds limit
      );

      const decision = scheduler.shouldSpeculate(taskPda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('stake_limit');
    });

    it('should fire onStakeLimitReached event', () => {
      const onStakeLimitReached = vi.fn();

      const { scheduler, graph } = createScheduler(
        { maxSpeculativeStake: 1_000_000n },
        { onStakeLimitReached }
      );

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      // Exceed stake limit
      const ledger = scheduler.getCommitmentLedger();
      ledger.createCommitment(
        randomPda(),
        new Uint8Array(32),
        new Uint8Array(32),
        randomPda(),
        2_000_000n
      );

      scheduler.shouldSpeculate(taskPda);

      expect(onStakeLimitReached).toHaveBeenCalledWith(2_000_000n, 1_000_000n);
    });
  });

  describe('shouldSpeculate - dependency type filtering', () => {
    it('should allow speculation for allowed dependency types', () => {
      const { scheduler, graph } = createScheduler({
        speculatableDependencyTypes: [DependencyType.Data],
      });

      const rootPda = randomPda();
      const childPda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), childPda, rootPda, DependencyType.Data);

      const decision = scheduler.shouldSpeculate(childPda);
      expect(decision.allowed).toBe(true);
    });

    it('should deny speculation for disallowed dependency types', () => {
      const { scheduler, graph } = createScheduler({
        speculatableDependencyTypes: [DependencyType.Data], // Only Data
      });

      const rootPda = randomPda();
      const childPda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), childPda, rootPda, DependencyType.Resource);

      const decision = scheduler.shouldSpeculate(childPda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('dependency_type_not_speculatable');
    });
  });

  describe('shouldSpeculate - private task policy', () => {
    it('should deny private speculation when disabled', () => {
      const { scheduler, graph } = createScheduler({
        allowPrivateSpeculation: false,
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const decision = scheduler.shouldSpeculate(taskPda, undefined, true);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('private_speculation_disabled');
    });

    it('should allow private speculation when enabled', () => {
      const { scheduler, graph } = createScheduler({
        allowPrivateSpeculation: true,
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const decision = scheduler.shouldSpeculate(taskPda, undefined, true);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('shouldSpeculate - reputation threshold', () => {
    it('should deny speculation for low reputation agents', () => {
      const { scheduler, graph } = createScheduler({
        minReputationForSpeculation: 500,
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const decision = scheduler.shouldSpeculate(taskPda, undefined, false, 400);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('low_reputation');
    });

    it('should allow speculation for high reputation agents', () => {
      const { scheduler, graph } = createScheduler({
        minReputationForSpeculation: 500,
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const decision = scheduler.shouldSpeculate(taskPda, undefined, false, 600);
      expect(decision.allowed).toBe(true);
    });

    it('should allow speculation at exact threshold', () => {
      const { scheduler, graph } = createScheduler({
        minReputationForSpeculation: 500,
      });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const decision = scheduler.shouldSpeculate(taskPda, undefined, false, 500);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('speculation enable/disable', () => {
    it('should enable speculation via method', () => {
      const { scheduler } = createScheduler({ enableSpeculation: false });

      expect(scheduler.isSpeculationEnabled()).toBe(false);

      scheduler.enableSpeculation();
      expect(scheduler.isSpeculationEnabled()).toBe(true);
    });

    it('should disable speculation via method', () => {
      const { scheduler } = createScheduler({ enableSpeculation: true });

      expect(scheduler.isSpeculationEnabled()).toBe(true);

      scheduler.disableSpeculation('test_reason');
      expect(scheduler.isSpeculationEnabled()).toBe(false);
    });

    it('should fire onSpeculationDisabled event', () => {
      const onSpeculationDisabled = vi.fn();

      const { scheduler } = createScheduler(
        { enableSpeculation: true },
        { onSpeculationDisabled }
      );

      scheduler.disableSpeculation('manual_disable');

      expect(onSpeculationDisabled).toHaveBeenCalledWith('manual_disable');
    });

    it('should fire onSpeculationEnabled event', () => {
      const onSpeculationEnabled = vi.fn();

      const { scheduler } = createScheduler(
        { enableSpeculation: false },
        { onSpeculationEnabled }
      );

      scheduler.enableSpeculation();

      expect(onSpeculationEnabled).toHaveBeenCalled();
    });
  });

  describe('registerSpeculationStart', () => {
    it('should track active speculations', () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      scheduler.registerSpeculationStart(taskPda, 1);

      const status = scheduler.getStatus();
      expect(status.activeSpeculations).toBe(1);
    });

    it('should increment speculativeExecutions metric', () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const metricsBefore = scheduler.getMetrics();
      expect(metricsBefore.speculativeExecutions).toBe(0);

      scheduler.registerSpeculationStart(taskPda, 1);

      const metricsAfter = scheduler.getMetrics();
      expect(metricsAfter.speculativeExecutions).toBe(1);
    });

    it('should fire onSpeculationStarted event', () => {
      const onSpeculationStarted = vi.fn();

      const { scheduler, graph } = createScheduler({}, { onSpeculationStarted });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      scheduler.registerSpeculationStart(taskPda, 2);

      expect(onSpeculationStarted).toHaveBeenCalledWith(taskPda, 2);
    });
  });

  describe('onProofConfirmed', () => {
    it('should update metrics on confirmation', () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      // Start speculation
      scheduler.registerSpeculationStart(taskPda, 1);

      // Confirm proof
      scheduler.onProofConfirmed(taskPda);

      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeHits).toBe(1);
      expect(metrics.hitRate).toBe(100);
    });

    it('should fire onSpeculationConfirmed event', () => {
      const onSpeculationConfirmed = vi.fn();

      const { scheduler, graph } = createScheduler({}, { onSpeculationConfirmed });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      scheduler.registerSpeculationStart(taskPda, 1);
      scheduler.onProofConfirmed(taskPda);

      expect(onSpeculationConfirmed).toHaveBeenCalledWith(taskPda);
    });

    it('should remove from active speculations', () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      scheduler.registerSpeculationStart(taskPda, 1);
      expect(scheduler.getStatus().activeSpeculations).toBe(1);

      scheduler.onProofConfirmed(taskPda);
      expect(scheduler.getStatus().activeSpeculations).toBe(0);
    });
  });

  describe('onProofFailed', () => {
    it('should update metrics on failure', () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      // Start speculation
      scheduler.registerSpeculationStart(taskPda, 1);

      // Fail proof
      scheduler.onProofFailed(taskPda, 'test_failure');

      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeMisses).toBe(1);
      expect(metrics.hitRate).toBe(0);
    });

    it('should fire onSpeculationFailed event', () => {
      const onSpeculationFailed = vi.fn();

      const { scheduler, graph } = createScheduler({}, { onSpeculationFailed });

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      scheduler.registerSpeculationStart(taskPda, 1);
      scheduler.onProofFailed(taskPda, 'verification_failed');

      expect(onSpeculationFailed).toHaveBeenCalledWith(taskPda, 'verification_failed');
    });

    it('should calculate rollback rate correctly', () => {
      const { scheduler, graph } = createScheduler();

      // Register multiple speculations
      const taskPdas = [randomPda(), randomPda(), randomPda(), randomPda()];
      for (const pda of taskPdas) {
        graph.addTask(createMockTask(), pda);
        scheduler.registerSpeculationStart(pda, 0);
      }

      // 2 succeed, 2 fail
      scheduler.onProofConfirmed(taskPdas[0]);
      scheduler.onProofConfirmed(taskPdas[1]);
      scheduler.onProofFailed(taskPdas[2]);
      scheduler.onProofFailed(taskPdas[3]);

      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeExecutions).toBe(4);
      expect(metrics.speculativeHits).toBe(2);
      expect(metrics.speculativeMisses).toBe(2);
      expect(metrics.hitRate).toBe(50);
      expect(metrics.rollbackRate).toBe(50);
    });
  });

  describe('rollback rate auto-disable', () => {
    it('should auto-disable speculation when rollback rate exceeds threshold', () => {
      const onSpeculationDisabled = vi.fn();

      const { scheduler, graph } = createScheduler(
        { maxRollbackRatePercent: 30 }, // 30% threshold
        { onSpeculationDisabled }
      );

      // Create 10 speculations
      const taskPdas: PublicKey[] = [];
      for (let i = 0; i < 10; i++) {
        const pda = randomPda();
        taskPdas.push(pda);
        graph.addTask(createMockTask(), pda);
        scheduler.registerSpeculationStart(pda, 0);
      }

      // Fail 4 of them (40% > 30% threshold)
      scheduler.onProofConfirmed(taskPdas[0]);
      scheduler.onProofConfirmed(taskPdas[1]);
      scheduler.onProofConfirmed(taskPdas[2]);
      scheduler.onProofConfirmed(taskPdas[3]);
      scheduler.onProofConfirmed(taskPdas[4]);
      scheduler.onProofConfirmed(taskPdas[5]);
      scheduler.onProofFailed(taskPdas[6]);
      scheduler.onProofFailed(taskPdas[7]);
      scheduler.onProofFailed(taskPdas[8]);
      scheduler.onProofFailed(taskPdas[9]);

      // Rollback rate is now 40%, next shouldSpeculate should disable
      const newTaskPda = randomPda();
      graph.addTask(createMockTask(), newTaskPda);

      const decision = scheduler.shouldSpeculate(newTaskPda);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('rollback_rate_exceeded');
      expect(onSpeculationDisabled).toHaveBeenCalled();
      expect(scheduler.isSpeculationEnabled()).toBe(false);
    });
  });

  describe('metrics', () => {
    it('should return correct metrics structure', () => {
      const { scheduler } = createScheduler();

      const metrics = scheduler.getMetrics();

      expect(typeof metrics.speculativeExecutions).toBe('number');
      expect(typeof metrics.speculativeHits).toBe('number');
      expect(typeof metrics.speculativeMisses).toBe('number');
      expect(typeof metrics.hitRate).toBe('number');
      expect(typeof metrics.estimatedTimeSaved).toBe('number');
      expect(typeof metrics.timeWastedOnRollbacks).toBe('number');
      expect(typeof metrics.rollbackRate).toBe('number');
    });

    it('should return defensive copy of metrics', () => {
      const { scheduler } = createScheduler();

      const metrics1 = scheduler.getMetrics();
      metrics1.speculativeExecutions = 999;

      const metrics2 = scheduler.getMetrics();
      expect(metrics2.speculativeExecutions).toBe(0);
    });
  });

  describe('status', () => {
    it('should return correct status structure', () => {
      const { scheduler } = createScheduler({ maxSpeculationDepth: 5 });

      const status = scheduler.getStatus();

      expect(typeof status.running).toBe('boolean');
      expect(typeof status.speculationEnabled).toBe('boolean');
      expect(typeof status.activeSpeculations).toBe('number');
      expect(typeof status.maxDepthReached).toBe('number');
      expect(status.currentMaxDepth).toBe(5);
      expect(typeof status.totalStakeAtRisk).toBe('bigint');
      expect(typeof status.pendingProofs).toBe('number');
      expect(typeof status.awaitingAncestors).toBe('number');
    });
  });

  describe('forceRollback', () => {
    it('should trigger rollback via controller', async () => {
      const { scheduler, graph } = createScheduler();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      const result = await scheduler.forceRollback(taskPda, 'manual');

      expect(result).toBeDefined();
      expect(result.reason).toBe('manual');
      expect(result.rootTaskPda).toEqual(taskPda);
    });
  });

  describe('addDependency', () => {
    it('should warn when downstream task not in graph', () => {
      const { scheduler, graph } = createScheduler();

      const upstreamPda = randomPda();
      const downstreamPda = randomPda();

      // Add upstream first
      graph.addTask(createMockTask(), upstreamPda);

      // Add dependency via scheduler - should not throw
      scheduler.addDependency(upstreamPda, downstreamPda, DependencyType.Data);

      // Downstream should NOT be in graph (scheduler warns but doesn't add)
      const node = graph.getNode(downstreamPda);
      expect(node).toBeUndefined();
    });

    it('should be no-op when downstream already exists', () => {
      const { scheduler, graph } = createScheduler();

      const upstreamPda = randomPda();
      const downstreamPda = randomPda();

      // Add both tasks
      graph.addTask(createMockTask(), upstreamPda);
      graph.addTaskWithParent(createMockTask(), downstreamPda, upstreamPda);

      // addDependency should be no-op since downstream exists
      scheduler.addDependency(upstreamPda, downstreamPda, DependencyType.Data);

      // Check downstream still exists with original parent
      const node = graph.getNode(downstreamPda);
      expect(node).toBeDefined();
      expect(node?.dependsOn).toEqual(upstreamPda);
    });
  });

  describe('component accessors', () => {
    it('should return all components', () => {
      const { scheduler, graph } = createScheduler();

      expect(scheduler.getDependencyGraph()).toBe(graph);
      expect(scheduler.getCommitmentLedger()).toBeDefined();
      expect(scheduler.getProofDeferralManager()).toBeDefined();
      expect(scheduler.getRollbackController()).toBeDefined();
    });

    it('should return active commitments from ledger', () => {
      const { scheduler } = createScheduler();

      const commitments = scheduler.getActiveCommitments();
      expect(Array.isArray(commitments)).toBe(true);
    });

    it('should return blocked proofs from deferral manager', () => {
      const { scheduler } = createScheduler();

      const blocked = scheduler.getBlockedProofs();
      expect(Array.isArray(blocked)).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete speculation lifecycle', () => {
      const onSpeculationStarted = vi.fn();
      const onSpeculationConfirmed = vi.fn();

      const { scheduler, graph } = createScheduler(
        {},
        { onSpeculationStarted, onSpeculationConfirmed }
      );

      scheduler.start();

      const taskPda = randomPda();
      graph.addTask(createMockTask(), taskPda);

      // Check policy
      const decision = scheduler.shouldSpeculate(taskPda);
      expect(decision.allowed).toBe(true);

      // Start speculation
      scheduler.registerSpeculationStart(taskPda, 0);
      expect(onSpeculationStarted).toHaveBeenCalled();

      // Confirm
      scheduler.onProofConfirmed(taskPda);
      expect(onSpeculationConfirmed).toHaveBeenCalled();

      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeExecutions).toBe(1);
      expect(metrics.speculativeHits).toBe(1);
      expect(metrics.hitRate).toBe(100);

      scheduler.stop();
    });

    it('should handle multi-level speculation chain', () => {
      const { scheduler, graph } = createScheduler({ maxSpeculationDepth: 5 });

      // Create chain: root -> child1 -> child2 -> child3
      const rootPda = randomPda();
      const child1Pda = randomPda();
      const child2Pda = randomPda();
      const child3Pda = randomPda();

      graph.addTask(createMockTask(), rootPda);
      graph.addTaskWithParent(createMockTask(), child1Pda, rootPda);
      graph.addTaskWithParent(createMockTask(), child2Pda, child1Pda);
      graph.addTaskWithParent(createMockTask(), child3Pda, child2Pda);

      // All should be allowed (depth 3 < 5)
      expect(scheduler.shouldSpeculate(rootPda).allowed).toBe(true);
      expect(scheduler.shouldSpeculate(child1Pda).allowed).toBe(true);
      expect(scheduler.shouldSpeculate(child2Pda).allowed).toBe(true);
      expect(scheduler.shouldSpeculate(child3Pda).allowed).toBe(true);
    });

    it('should handle mixed success/failure scenarios', () => {
      const { scheduler, graph } = createScheduler();

      // Create multiple speculative executions
      const taskPdas: PublicKey[] = [];
      for (let i = 0; i < 5; i++) {
        const pda = randomPda();
        taskPdas.push(pda);
        graph.addTask(createMockTask(), pda);
        scheduler.registerSpeculationStart(pda, 0);
      }

      // 3 succeed, 2 fail
      scheduler.onProofConfirmed(taskPdas[0]);
      scheduler.onProofConfirmed(taskPdas[1]);
      scheduler.onProofFailed(taskPdas[2], 'verification_failed');
      scheduler.onProofConfirmed(taskPdas[3]);
      scheduler.onProofFailed(taskPdas[4], 'timeout');

      const metrics = scheduler.getMetrics();
      expect(metrics.speculativeExecutions).toBe(5);
      expect(metrics.speculativeHits).toBe(3);
      expect(metrics.speculativeMisses).toBe(2);
      expect(metrics.hitRate).toBe(60);
      expect(metrics.rollbackRate).toBe(40);
    });
  });
});
