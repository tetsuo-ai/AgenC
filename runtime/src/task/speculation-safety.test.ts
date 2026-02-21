/**
 * Safety-net integration tests for speculative execution.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DependencyGraph,
  DependencyType,
  type TaskNode,
} from "./dependency-graph.js";
import { CommitmentLedger } from "./commitment-ledger.js";
import { RollbackController } from "./rollback-controller.js";
import {
  SpeculativeTaskScheduler,
  type SpeculativeSchedulerConfig,
  type SpeculativeSchedulerEvents,
} from "./speculative-scheduler.js";
import type { OnChainTask } from "./types.js";
import { OnChainTaskStatus, TaskType } from "./types.js";
import type { ProofPipeline } from "./proof-pipeline.js";
import { randomBytes } from "crypto";

function randomPda(): PublicKey {
  return Keypair.generate().publicKey;
}

function createMockTask(overrides?: Partial<OnChainTask>): OnChainTask {
  const taskId = new Uint8Array(32);
  taskId.fill(1);

  return {
    taskId,
    creator: randomPda(),
    requiredCapabilities: 0n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1000000n,
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
    ...overrides,
  };
}

function createRollbackCompatibleTask(
  overrides?: Partial<OnChainTask>,
): OnChainTask {
  return createMockTask(overrides);
}

function createMockProofPipeline(): ProofPipeline {
  return {
    queueProofGeneration: () => undefined,
    submitProof: async () => "mock-signature",
    getQueuedJobs: () => [],
    getActiveJobs: () => [],
    getCompletedJobs: () => [],
    getFailedJobs: () => [],
    getStats: () => ({
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
    stop: async () => undefined,
    start: () => undefined,
    isShuttingDown: () => false,
    cancel: () => undefined,
    enqueue: () => ({ id: randomBytes(16).toString("hex") }),
    waitForConfirmation: async () => ({
      status: "queued",
      proofBytes: new Uint8Array(),
      taskPda: randomPda(),
      transactionSignature: "mock-signature",
    }),
    shutdown: async () => undefined,
    enqueueRetry: () => undefined,
  } as unknown as ProofPipeline;
}

describe("speculation-safety: dependency graph validation", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  it("wouldCreateCycle rejects self-loop", () => {
    const task = randomPda();
    graph.addTask(createMockTask(), task);

    expect(graph.wouldCreateCycle(task, task)).toBe(true);
  });

  it("wouldCreateCycle rejects A -> B -> A cycle", () => {
    const a = randomPda();
    const b = randomPda();

    graph.addTask(createMockTask(), a);
    graph.addTaskWithParent(createMockTask(), b, a);

    expect(graph.wouldCreateCycle(b, a)).toBe(true);
  });

  it("detectCycles finds cycles introduced into the graph", () => {
    const root = randomPda();
    const child = randomPda();
    const grandChild = randomPda();

    graph.addTask(createMockTask(), root);
    graph.addTaskWithParent(createMockTask(), child, root);
    graph.addTaskWithParent(createMockTask(), grandChild, child);

    const internal = graph as unknown as {
      edges: Map<
        string,
        { to: PublicKey; type: DependencyType; from: PublicKey }[]
      >;
    };
    const grandChildKey = grandChild.toBase58();
    const existing = internal.edges.get(grandChildKey) ?? [];
    internal.edges.set(grandChildKey, [
      ...existing,
      { from: grandChild, to: root, type: DependencyType.Data },
    ]);

    const cycles = graph.detectCycles();
    expect(cycles.length).toBe(1);
    expect(cycles[0]!.map((n) => n.toBase58())).toContain(root.toBase58());
  });

  it("validateConsistency reports dangling edges and depth mismatches", () => {
    const root = randomPda();
    const child = randomPda();
    const missing = randomPda();

    graph.addTask(createMockTask(), root);
    graph.addTaskWithParent(createMockTask(), child, root);

    const internal = graph as unknown as {
      edges: Map<
        string,
        { to: PublicKey; type: DependencyType; from: PublicKey }[]
      >;
      nodes: Map<string, TaskNode>;
    };
    const internalChild = internal.nodes.get(child.toBase58());
    if (!internalChild) {
      throw new Error("child node should exist");
    }
    internalChild.depth = 3;

    const missingFromKey = missing.toBase58();
    internal.edges.set(missingFromKey, [
      { from: missing, to: root, type: DependencyType.Data },
    ]);

    const result = graph.validateConsistency();
    expect(result.valid).toBe(false);
    expect(result.danglingEdges.length).toBeGreaterThan(0);
    expect(result.depthMismatches.length).toBe(1);
  });
});

describe("speculation-safety: rollback chain validation", () => {
  let dependencyGraph: DependencyGraph;
  let commitmentLedger: CommitmentLedger;
  let controller: RollbackController;

  beforeEach(() => {
    dependencyGraph = new DependencyGraph();
    commitmentLedger = new CommitmentLedger();
    controller = new RollbackController({}, dependencyGraph, commitmentLedger, {
      onRollbackStarted: () => undefined,
      onRollbackCompleted: () => undefined,
    } as never);
  });

  it("validateRollbackChain reports no orphans for complete rollback", async () => {
    const root = randomPda();
    const child = randomPda();
    const grandChild = randomPda();
    const producer = randomPda();

    dependencyGraph.addTask(createRollbackCompatibleTask(), root);
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      child,
      root,
    );
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      grandChild,
      child,
    );

    commitmentLedger.createCommitment(
      child,
      randomBytes(32),
      randomBytes(32),
      producer,
      1000n,
    );
    commitmentLedger.createCommitment(
      grandChild,
      randomBytes(32),
      randomBytes(32),
      producer,
      2000n,
    );

    const result = await controller.rollback(root, "proof_failed");
    const validation = controller.validateRollbackChain(root);

    expect(result.wastedComputeMs).toBeGreaterThanOrEqual(0);
    expect(validation.valid).toBe(true);
    expect(validation.orphans).toHaveLength(0);
    expect(validation.maxChainDepth).toBe(2);
    expect(result.rolledBackTasks.map((t) => t.taskPda.toBase58())).toContain(
      child.toBase58(),
    );
    expect(result.rolledBackTasks.map((t) => t.taskPda.toBase58())).toContain(
      grandChild.toBase58(),
    );
  });

  it("cleanupOrphans rolls back explicitly provided nodes", async () => {
    const root = randomPda();
    const child = randomPda();

    dependencyGraph.addTask(createRollbackCompatibleTask(), root);
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      child,
      root,
    );

    const cleaned = await controller.cleanupOrphans([child]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].taskPda.toBase58()).toBe(child.toBase58());
    expect(controller.isRolledBack(child)).toBe(true);
  });

  it("handles overlapping rollback calls without deadlock", async () => {
    const root = randomPda();
    const child1 = randomPda();
    const child2 = randomPda();
    const shared = randomPda();

    dependencyGraph.addTask(createRollbackCompatibleTask(), root);
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      child1,
      root,
    );
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      child2,
      root,
    );
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      shared,
      child1,
    );

    const [r1, r2] = await Promise.all([
      controller.rollback(child1, "proof_failed"),
      controller.rollback(root, "proof_failed"),
    ]);

    expect(r1.rolledBackTasks.length).toBeGreaterThan(0);
    expect(r2.rolledBackTasks.length).toBeGreaterThan(0);
    expect(controller.isRolledBack(shared)).toBe(true);
    expect(controller.isRolledBack(child1)).toBe(true);
  });

  it("idempotent re-rollback does not double count stats", async () => {
    const root = randomPda();
    const child = randomPda();

    dependencyGraph.addTask(createRollbackCompatibleTask(), root);
    dependencyGraph.addTaskWithParent(
      createRollbackCompatibleTask(),
      child,
      root,
    );

    await controller.rollback(root, "proof_failed");
    const cached = await controller.rollback(root, "proof_failed");

    expect(cached.rolledBackTasks.length).toBeGreaterThanOrEqual(0);
    expect(controller.getStats().totalRollbacks).toBe(1);
  });

  it("deep rollback chain completes without overflow", async () => {
    const tasks = Array.from({ length: 6 }, () => randomPda());

    dependencyGraph.addTask(createRollbackCompatibleTask(), tasks[0]!);
    for (let i = 1; i < tasks.length; i += 1) {
      dependencyGraph.addTaskWithParent(
        createRollbackCompatibleTask(),
        tasks[i]!,
        tasks[i - 1]!,
      );
    }

    const result = await controller.rollback(tasks[0]!, "proof_failed");
    const validation = controller.validateRollbackChain(tasks[0]!);

    expect(result.rolledBackTasks).toHaveLength(5);
    expect(validation.valid).toBe(true);
    expect(validation.maxChainDepth).toBe(5);
  });
});

describe("speculation-safety: commitment ledger integrity", () => {
  let ledger: CommitmentLedger;

  beforeEach(() => {
    ledger = new CommitmentLedger();
  });

  it("findOrphanedCommitments detects missing parent commitments", () => {
    const orphanTask = randomPda();
    const parentReference = randomPda();

    const orphan = ledger.createCommitment(
      orphanTask,
      randomBytes(32),
      randomBytes(32),
      randomPda(),
      1000n,
    );

    const internal = ledger as unknown as {
      byParentTask: Map<string, string>;
    };
    internal.byParentTask.set(
      orphanTask.toBase58(),
      parentReference.toBase58(),
    );
    (orphan as { depth: number }).depth = 1;

    const result = ledger.findOrphanedCommitments();
    expect(result).toHaveLength(1);
    expect(result[0].sourceTaskPda.toBase58()).toBe(orphanTask.toBase58());
  });

  it("validateChainIntegrity flags failed ancestor", () => {
    const parent = randomPda();
    const child = randomPda();

    const parentCommitment = ledger.createCommitment(
      parent,
      randomBytes(32),
      randomBytes(32),
      randomPda(),
      1000n,
    );
    ledger.addDependent(parent, child);
    const childCommitment = ledger.createCommitment(
      child,
      randomBytes(32),
      randomBytes(32),
      randomPda(),
      2000n,
    );

    expect(parentCommitment.depth).toBe(0);
    expect(childCommitment.depth).toBe(1);

    ledger.markFailed(parent);

    const result = ledger.validateChainIntegrity(child);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("failed_ancestor");
  });
});

describe("speculation-safety: scheduler cancellation", () => {
  let scheduler: SpeculativeTaskScheduler;
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
    const pipeline = createMockProofPipeline();
    scheduler = new SpeculativeTaskScheduler(
      {
        maxSpeculationDepth: 3,
        maxRollbackRatePercent: 100,
      } as SpeculativeSchedulerConfig,
      {} as SpeculativeSchedulerEvents,
      graph,
      pipeline,
    );
  });

  it("cancels subtree without affecting rollback metrics", () => {
    const root = randomPda();
    const child = randomPda();
    const producer = randomPda();
    const ledger = scheduler.getCommitmentLedger();

    graph.addTask(createMockTask(), root);
    graph.addTaskWithParent(createMockTask(), child, root);

    ledger.createCommitment(
      root,
      randomBytes(32),
      randomBytes(32),
      producer,
      1000n,
    );
    ledger.createCommitment(
      child,
      randomBytes(32),
      randomBytes(32),
      producer,
      2000n,
    );
    ledger.addDependent(root, child);

    scheduler.registerSpeculationStart(root, 0);
    scheduler.registerSpeculationStart(child, 1);

    const result = scheduler.cancelSpeculation(root, "manual");

    expect(result.cancelledTaskPda.toBase58()).toBe(root.toBase58());
    expect(result.abortedDescendants).toHaveLength(1);
    expect(result.abortedDescendants[0].toBase58()).toBe(child.toBase58());
    expect(result.stakeReleased).toBe(3000n);
    expect(result.cancelledProofs).toBe(0);

    const metrics = scheduler.getMetrics();
    expect(metrics.speculativeMisses).toBe(0);
    expect(metrics.rollbackRate).toBe(0);

    expect(ledger.getByTask(root)?.status).toBe("rolled_back");
    expect(ledger.getByTask(child)?.status).toBe("rolled_back");
  });
});
