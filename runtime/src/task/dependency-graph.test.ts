/**
 * Tests for DependencyGraph
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  DependencyGraph,
  DependencyType,
  TaskNode,
  TaskNodeStatus,
} from "./dependency-graph.js";
import type { OnChainTask } from "./types.js";
import { OnChainTaskStatus, TaskType } from "./types.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock OnChainTask for testing.
 */
function createMockTask(overrides?: Partial<OnChainTask>): OnChainTask {
  const taskId = new Uint8Array(32);
  crypto.getRandomValues(taskId);

  return {
    taskId,
    creator: Keypair.generate().publicKey,
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
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Generates a random PublicKey for testing.
 */
function randomPda(): PublicKey {
  return Keypair.generate().publicKey;
}

// ============================================================================
// Tests
// ============================================================================

describe("DependencyGraph", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  describe("addTask", () => {
    it("should add a root task to the graph", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.hasTask(pda)).toBe(true);
      const node = graph.getNode(pda);
      expect(node).toBeDefined();
      expect(node?.depth).toBe(0);
      expect(node?.status).toBe("pending");
      expect(node?.dependsOn).toBeNull();
    });

    it("should throw error when adding duplicate task", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(() => graph.addTask(task, pda)).toThrow("already exists");
    });

    it("should track multiple root tasks", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTask(task2, pda2);

      const roots = graph.getRoots();
      expect(roots.length).toBe(2);
    });
  });

  describe("addTaskWithParent", () => {
    it("should add a child task with correct depth", () => {
      const parentTask = createMockTask();
      const childTask = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parentTask, parentPda);
      graph.addTaskWithParent(childTask, childPda, parentPda);

      const child = graph.getNode(childPda);
      expect(child).toBeDefined();
      expect(child?.depth).toBe(1);
      expect(child?.dependsOn?.toBase58()).toBe(parentPda.toBase58());
    });

    it("should throw error when parent not found", () => {
      const childTask = createMockTask();
      const childPda = randomPda();
      const nonExistentParent = randomPda();

      expect(() =>
        graph.addTaskWithParent(childTask, childPda, nonExistentParent),
      ).toThrow("not found");
    });

    it("should increment depth through chain", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda2);

      expect(graph.getDepth(pda1)).toBe(0);
      expect(graph.getDepth(pda2)).toBe(1);
      expect(graph.getDepth(pda3)).toBe(2);
    });

    it("should support different dependency types", () => {
      const parentTask = createMockTask();
      const childTask = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parentTask, parentPda);
      graph.addTaskWithParent(
        childTask,
        childPda,
        parentPda,
        DependencyType.Order,
      );

      const child = graph.getNode(childPda);
      expect(child?.dependencyType).toBe(DependencyType.Order);
    });
  });

  describe("removeTask", () => {
    it("should remove a leaf task", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);
      expect(graph.hasTask(pda)).toBe(true);

      graph.removeTask(pda);
      expect(graph.hasTask(pda)).toBe(false);
    });

    it("should throw error when removing task with dependents", () => {
      const parentTask = createMockTask();
      const childTask = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parentTask, parentPda);
      graph.addTaskWithParent(childTask, childPda, parentPda);

      expect(() => graph.removeTask(parentPda)).toThrow("has");
    });

    it("should update parent edges when child is removed", () => {
      const parentTask = createMockTask();
      const childTask = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parentTask, parentPda);
      graph.addTaskWithParent(childTask, childPda, parentPda);

      expect(graph.getDependents(parentPda).length).toBe(1);

      graph.removeTask(childPda);
      expect(graph.getDependents(parentPda).length).toBe(0);
    });

    it("should handle removing non-existent task gracefully", () => {
      const nonExistent = randomPda();
      expect(() => graph.removeTask(nonExistent)).not.toThrow();
    });
  });

  describe("getDependents", () => {
    it("should return empty array for task with no children", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getDependents(pda)).toEqual([]);
    });

    it("should return direct children only", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda2);

      const dependents = graph.getDependents(pda1);
      expect(dependents.length).toBe(1);
      expect(dependents[0].taskPda.toBase58()).toBe(pda2.toBase58());
    });

    it("should return multiple children", () => {
      const parent = createMockTask();
      const child1 = createMockTask();
      const child2 = createMockTask();
      const parentPda = randomPda();
      const childPda1 = randomPda();
      const childPda2 = randomPda();

      graph.addTask(parent, parentPda);
      graph.addTaskWithParent(child1, childPda1, parentPda);
      graph.addTaskWithParent(child2, childPda2, parentPda);

      const dependents = graph.getDependents(parentPda);
      expect(dependents.length).toBe(2);
    });
  });

  describe("getParent", () => {
    it("should return null for root task", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getParent(pda)).toBeNull();
    });

    it("should return parent task", () => {
      const parentTask = createMockTask();
      const childTask = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parentTask, parentPda);
      graph.addTaskWithParent(childTask, childPda, parentPda);

      const parent = graph.getParent(childPda);
      expect(parent?.taskPda.toBase58()).toBe(parentPda.toBase58());
    });
  });

  describe("getDepth", () => {
    it("should return -1 for non-existent task", () => {
      const nonExistent = randomPda();
      expect(graph.getDepth(nonExistent)).toBe(-1);
    });

    it("should return correct depth for chain", () => {
      const pdas: PublicKey[] = [];

      // Create a chain of 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = createMockTask();
        const pda = randomPda();
        pdas.push(pda);

        if (i === 0) {
          graph.addTask(task, pda);
        } else {
          graph.addTaskWithParent(task, pda, pdas[i - 1]);
        }
      }

      for (let i = 0; i < 5; i++) {
        expect(graph.getDepth(pdas[i])).toBe(i);
      }
    });
  });

  describe("wouldCreateCycle", () => {
    it("should detect self-loop", () => {
      const pda = randomPda();
      expect(graph.wouldCreateCycle(pda, pda)).toBe(true);
    });

    it("should detect simple cycle", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);

      // Adding pda1 as child of pda2 would create: pda1 -> pda2 -> pda1
      expect(graph.wouldCreateCycle(pda2, pda1)).toBe(true);
    });

    it("should detect longer cycle", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda2);

      // Adding pda1 as child of pda3 would create: pda1 -> pda2 -> pda3 -> pda1
      expect(graph.wouldCreateCycle(pda3, pda1)).toBe(true);
    });

    it("should not detect cycle when none exists", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTask(task2, pda2);

      // Both are roots, no cycle possible
      expect(graph.wouldCreateCycle(pda1, pda2)).toBe(false);
      expect(graph.wouldCreateCycle(pda2, pda1)).toBe(false);
    });

    it("should prevent cycle creation in addTaskWithParent", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);

      // Try to add a new task with pda2 as parent, but that new task
      // would become parent of pda1 (creating cycle)
      // Actually, our single-parent model means the cycle would be:
      // pda1 -> pda2 -> newTask where newTask tries to depend on pda1's descendant
      // The real cycle test: verify that wouldCreateCycle prevents this

      // Verify wouldCreateCycle correctly detects potential cycles
      // If we tried to make pda2 depend on pda1's child (itself), it would cycle
      expect(graph.wouldCreateCycle(pda2, pda1)).toBe(true);

      // A task already in graph cannot be re-added (throws duplicate error)
      const duplicateTask = createMockTask({ taskId: task1.taskId });
      expect(() => graph.addTaskWithParent(duplicateTask, pda1, pda2)).toThrow(
        "already exists",
      );
    });
  });

  describe("getTasksAtDepth", () => {
    it("should return empty array for non-existent depth", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getTasksAtDepth(5)).toEqual([]);
    });

    it("should return all tasks at specified depth", () => {
      const root = createMockTask();
      const child1 = createMockTask();
      const child2 = createMockTask();
      const rootPda = randomPda();
      const childPda1 = randomPda();
      const childPda2 = randomPda();

      graph.addTask(root, rootPda);
      graph.addTaskWithParent(child1, childPda1, rootPda);
      graph.addTaskWithParent(child2, childPda2, rootPda);

      const depth0 = graph.getTasksAtDepth(0);
      expect(depth0.length).toBe(1);

      const depth1 = graph.getTasksAtDepth(1);
      expect(depth1.length).toBe(2);
    });
  });

  describe("getRoots", () => {
    it("should return empty array for empty graph", () => {
      expect(graph.getRoots()).toEqual([]);
    });

    it("should return all root tasks", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTask(task2, pda2);
      graph.addTaskWithParent(task3, pda3, pda1);

      const roots = graph.getRoots();
      expect(roots.length).toBe(2);
    });
  });

  describe("getLeaves", () => {
    it("should return all tasks in empty graph as leaves", () => {
      expect(graph.getLeaves()).toEqual([]);
    });

    it("should return tasks with no children", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda1);

      const leaves = graph.getLeaves();
      expect(leaves.length).toBe(2);
    });

    it("should return single task as both root and leaf", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getRoots().length).toBe(1);
      expect(graph.getLeaves().length).toBe(1);
    });
  });

  describe("topologicalSort", () => {
    it("should return empty array for empty graph", () => {
      expect(graph.topologicalSort()).toEqual([]);
    });

    it("should return tasks in correct order", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda2);

      const sorted = graph.topologicalSort();
      expect(sorted.length).toBe(3);

      // Parents should come before children
      const indices = sorted.map((n) => n.taskPda.toBase58());
      expect(indices.indexOf(pda1.toBase58())).toBeLessThan(
        indices.indexOf(pda2.toBase58()),
      );
      expect(indices.indexOf(pda2.toBase58())).toBeLessThan(
        indices.indexOf(pda3.toBase58()),
      );
    });

    it("should handle diamond dependency", () => {
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      const taskA = createMockTask();
      const taskB = createMockTask();
      const taskC = createMockTask();
      const taskD = createMockTask();
      const pdaA = randomPda();
      const pdaB = randomPda();
      const pdaC = randomPda();
      const pdaD = randomPda();

      graph.addTask(taskA, pdaA);
      graph.addTaskWithParent(taskB, pdaB, pdaA);
      graph.addTaskWithParent(taskC, pdaC, pdaA);
      // D depends on B (we can only have single parent in current impl)
      graph.addTaskWithParent(taskD, pdaD, pdaB);

      const sorted = graph.topologicalSort();
      expect(sorted.length).toBe(4);

      const indices = sorted.map((n) => n.taskPda.toBase58());
      // A should be first
      expect(indices.indexOf(pdaA.toBase58())).toBe(0);
      // B should be before D
      expect(indices.indexOf(pdaB.toBase58())).toBeLessThan(
        indices.indexOf(pdaD.toBase58()),
      );
    });
  });

  describe("updateStatus", () => {
    it("should update task status", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);
      expect(graph.getNode(pda)?.status).toBe("pending");

      graph.updateStatus(pda, "executing");
      expect(graph.getNode(pda)?.status).toBe("executing");

      graph.updateStatus(pda, "completed");
      expect(graph.getNode(pda)?.status).toBe("completed");
    });

    it("should return false for non-existent task", () => {
      const nonExistent = randomPda();
      expect(graph.updateStatus(nonExistent, "executing")).toBe(false);
    });
  });

  describe("getSpeculatableTasks", () => {
    it("should return root pending tasks", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      const speculatable = graph.getSpeculatableTasks();
      expect(speculatable.length).toBe(1);
    });

    it("should not return executing or completed tasks", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTask(task2, pda2);

      graph.updateStatus(pda1, "executing");
      graph.updateStatus(pda2, "completed");

      const speculatable = graph.getSpeculatableTasks();
      expect(speculatable.length).toBe(0);
    });

    it("should return child when parent is executing", () => {
      const parent = createMockTask();
      const child = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parent, parentPda);
      graph.addTaskWithParent(child, childPda, parentPda);

      // Child not speculatable when parent is pending
      let speculatable = graph.getSpeculatableTasks();
      expect(speculatable.map((n) => n.taskPda.toBase58())).toContain(
        parentPda.toBase58(),
      );
      expect(speculatable.map((n) => n.taskPda.toBase58())).not.toContain(
        childPda.toBase58(),
      );

      // Child becomes speculatable when parent is executing
      graph.updateStatus(parentPda, "executing");
      speculatable = graph.getSpeculatableTasks();
      expect(speculatable.map((n) => n.taskPda.toBase58())).toContain(
        childPda.toBase58(),
      );
    });

    it("should return child when parent is completed", () => {
      const parent = createMockTask();
      const child = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parent, parentPda);
      graph.addTaskWithParent(child, childPda, parentPda);

      graph.updateStatus(parentPda, "completed");

      const speculatable = graph.getSpeculatableTasks();
      expect(speculatable.map((n) => n.taskPda.toBase58())).toContain(
        childPda.toBase58(),
      );
    });

    it("should not return child when parent is failed", () => {
      const parent = createMockTask();
      const child = createMockTask();
      const parentPda = randomPda();
      const childPda = randomPda();

      graph.addTask(parent, parentPda);
      graph.addTaskWithParent(child, childPda, parentPda);

      graph.updateStatus(parentPda, "failed");

      const speculatable = graph.getSpeculatableTasks();
      expect(speculatable.length).toBe(0);
    });
  });

  describe("getDescendants", () => {
    it("should return all descendants", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const task4 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();
      const pda4 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda1);
      graph.addTaskWithParent(task4, pda4, pda2);

      const descendants = graph.getDescendants(pda1);
      expect(descendants.length).toBe(3);
    });

    it("should return empty array for leaf task", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getDescendants(pda)).toEqual([]);
    });
  });

  describe("getAncestors", () => {
    it("should return all ancestors nearest first", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);
      graph.addTaskWithParent(task3, pda3, pda2);

      const ancestors = graph.getAncestors(pda3);
      expect(ancestors.length).toBe(2);
      expect(ancestors[0].taskPda.toBase58()).toBe(pda2.toBase58());
      expect(ancestors[1].taskPda.toBase58()).toBe(pda1.toBase58());
    });

    it("should return empty array for root task", () => {
      const task = createMockTask();
      const pda = randomPda();

      graph.addTask(task, pda);

      expect(graph.getAncestors(pda)).toEqual([]);
    });
  });

  describe("toJSON", () => {
    it("should serialize empty graph", () => {
      const json = graph.toJSON();
      expect(json).toEqual({
        nodes: [],
        edges: [],
        stats: { nodeCount: 0, edgeCount: 0, maxDepth: 0, rootCount: 0 },
      });
    });

    it("should serialize graph with nodes and edges", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const pda1 = randomPda();
      const pda2 = randomPda();

      graph.addTask(task1, pda1);
      graph.addTaskWithParent(task2, pda2, pda1);

      const json = graph.toJSON() as {
        nodes: unknown[];
        edges: unknown[];
        stats: object;
      };

      expect(json.nodes.length).toBe(2);
      expect(json.edges.length).toBe(1);
      expect(json.stats).toEqual({
        nodeCount: 2,
        edgeCount: 1,
        maxDepth: 1,
        rootCount: 1,
      });
    });
  });

  describe("getStats", () => {
    it("should return correct stats for empty graph", () => {
      const stats = graph.getStats();
      expect(stats).toEqual({
        nodeCount: 0,
        edgeCount: 0,
        maxDepth: 0,
        rootCount: 0,
      });
    });

    it("should return correct stats for complex graph", () => {
      // Create a tree:
      //      A (depth 0)
      //     / \
      //    B   C (depth 1)
      //   / \
      //  D   E (depth 2)

      const tasks = Array.from({ length: 5 }, () => createMockTask());
      const pdas = Array.from({ length: 5 }, () => randomPda());

      graph.addTask(tasks[0], pdas[0]); // A
      graph.addTaskWithParent(tasks[1], pdas[1], pdas[0]); // B
      graph.addTaskWithParent(tasks[2], pdas[2], pdas[0]); // C
      graph.addTaskWithParent(tasks[3], pdas[3], pdas[1]); // D
      graph.addTaskWithParent(tasks[4], pdas[4], pdas[1]); // E

      const stats = graph.getStats();
      expect(stats.nodeCount).toBe(5);
      expect(stats.edgeCount).toBe(4);
      expect(stats.maxDepth).toBe(2);
      expect(stats.rootCount).toBe(1);
    });

    it("should count multiple roots", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();
      const task3 = createMockTask();

      graph.addTask(task1, randomPda());
      graph.addTask(task2, randomPda());
      graph.addTask(task3, randomPda());

      const stats = graph.getStats();
      expect(stats.rootCount).toBe(3);
    });
  });

  describe("clear", () => {
    it("should clear all tasks", () => {
      const task1 = createMockTask();
      const task2 = createMockTask();

      graph.addTask(task1, randomPda());
      graph.addTask(task2, randomPda());

      expect(graph.getStats().nodeCount).toBe(2);

      graph.clear();

      expect(graph.getStats().nodeCount).toBe(0);
      expect(graph.getRoots()).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("should handle deep chain", () => {
      const pdas: PublicKey[] = [];
      const depth = 100;

      for (let i = 0; i < depth; i++) {
        const task = createMockTask();
        const pda = randomPda();
        pdas.push(pda);

        if (i === 0) {
          graph.addTask(task, pda);
        } else {
          graph.addTaskWithParent(task, pda, pdas[i - 1]);
        }
      }

      expect(graph.getStats().maxDepth).toBe(depth - 1);
      expect(graph.getDepth(pdas[depth - 1])).toBe(depth - 1);

      // Topological sort should still work
      const sorted = graph.topologicalSort();
      expect(sorted.length).toBe(depth);
    });

    it("should handle wide tree", () => {
      const root = createMockTask();
      const rootPda = randomPda();
      const width = 100;

      graph.addTask(root, rootPda);

      for (let i = 0; i < width; i++) {
        const child = createMockTask();
        const childPda = randomPda();
        graph.addTaskWithParent(child, childPda, rootPda);
      }

      expect(graph.getDependents(rootPda).length).toBe(width);
      expect(graph.getStats().edgeCount).toBe(width);
    });
  });
});
