/**
 * DependencyGraph - Task relationship tracking for speculative execution
 *
 * Maintains a directed acyclic graph (DAG) of task dependencies, enabling the
 * speculative scheduler to reason about task relationships.
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "../utils/encoding.js";
import type { OnChainTask } from "./types.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Type of dependency relationship between tasks.
 */
export enum DependencyType {
  /** Standard data dependency - output flows to input */
  Data = 0,
  /** Ordering constraint only - no data flow */
  Order = 1,
  /** Resource dependency - shared resource lock */
  Resource = 2,
}

/**
 * Status of a task node in the dependency graph.
 */
export type TaskNodeStatus = "pending" | "executing" | "completed" | "failed";

/**
 * Represents a task node in the dependency graph.
 * Contains all metadata needed for speculative execution decisions.
 */
export interface TaskNode {
  /** Task account PDA */
  readonly taskPda: PublicKey;
  /** Unique 32-byte task identifier */
  readonly taskId: Uint8Array;
  /** Parent task PDA this task depends on (null for root tasks) */
  readonly dependsOn: PublicKey | null;
  /** Type of dependency relationship */
  readonly dependencyType: DependencyType;
  /** Depth in the dependency chain (0 = root, increments per level) */
  depth: number;
  /** Current task status */
  status: TaskNodeStatus;
}

/**
 * Represents a directed edge in the dependency graph.
 */
export interface DependencyEdge {
  /** Source task PDA (parent/dependency) */
  readonly from: PublicKey;
  /** Target task PDA (child/dependent) */
  readonly to: PublicKey;
  /** Type of dependency */
  readonly type: DependencyType;
}

/**
 * Statistics about the dependency graph.
 */
export interface DependencyGraphStats {
  /** Total number of nodes in the graph */
  nodeCount: number;
  /** Total number of edges in the graph */
  edgeCount: number;
  /** Maximum depth in the graph */
  maxDepth: number;
  /** Number of root nodes (no dependencies) */
  rootCount: number;
}

/**
 * Result of validating graph consistency invariants.
 */
export interface GraphConsistencyResult {
  /** Whether graph invariants are valid. */
  valid: boolean;
  /** All detected cycles, represented as arrays of task PDAs in order. */
  cycles: PublicKey[][];
  /** Edges that reference missing nodes. */
  danglingEdges: Array<{ from: string; to: string }>;
  /** Nodes whose depth no longer matches parent depth + 1. */
  depthMismatches: Array<{ taskPda: string; expected: number; actual: number }>;
}

// ============================================================================
// DependencyGraph Implementation
// ============================================================================

/**
 * Manages task dependencies as a directed acyclic graph (DAG).
 *
 * Supports O(1) parent/child lookups and O(n) topological traversal.
 * Used by the speculative execution system to track task relationships
 * and determine execution order.
 *
 * @example
 * ```typescript
 * const graph = new DependencyGraph();
 *
 * // Add a root task
 * graph.addTask(rootTask, rootTaskPda);
 *
 * // Add dependent task
 * graph.addTask(childTask, childTaskPda);
 *
 * // Get tasks ready for speculative execution
 * const ready = graph.getSpeculatableTasks();
 * ```
 */
export class DependencyGraph {
  /** Map from task PDA (base58) to TaskNode */
  private nodes: Map<string, TaskNode> = new Map();

  /** Map from parent PDA (base58) to array of child edges */
  private edges: Map<string, DependencyEdge[]> = new Map();

  /** Map from child PDA (base58) to parent PDA (base58) */
  private reverseEdges: Map<string, string> = new Map();

  /**
   * Adds a task to the dependency graph as a root task (no parent).
   *
   * @param task - The on-chain task data
   * @param taskPda - Task account PDA
   * @throws Error if task already exists in graph
   *
   * @example
   * ```typescript
   * const task = await fetchTask(taskPda);
   * graph.addTask(task, taskPda);
   * ```
   */
  addTask(task: OnChainTask, taskPda: PublicKey): void {
    const pdaKey = taskPda.toBase58();

    if (this.nodes.has(pdaKey)) {
      throw new Error(`Task ${pdaKey} already exists in graph`);
    }

    // Root tasks have no parent and depth 0
    const node: TaskNode = {
      taskPda,
      taskId: task.taskId,
      dependsOn: null,
      dependencyType: DependencyType.Data,
      depth: 0,
      status: "pending",
    };

    this.nodes.set(pdaKey, node);
  }

  /**
   * Adds a task with an explicit parent dependency.
   *
   * @param task - The on-chain task data
   * @param taskPda - Task account PDA
   * @param parentPda - Parent task PDA
   * @param dependencyType - Type of dependency (default: Data)
   * @throws Error if task already exists or parent not found
   */
  addTaskWithParent(
    task: OnChainTask,
    taskPda: PublicKey,
    parentPda: PublicKey,
    dependencyType: DependencyType = DependencyType.Data,
  ): void {
    const pdaKey = taskPda.toBase58();
    const parentKey = parentPda.toBase58();

    if (this.nodes.has(pdaKey)) {
      throw new Error(`Task ${pdaKey} already exists in graph`);
    }

    const parentNode = this.nodes.get(parentKey);
    if (!parentNode) {
      throw new Error(`Parent task ${parentKey} not found in graph`);
    }

    // Check for cycles
    if (this.wouldCreateCycle(parentPda, taskPda)) {
      throw new Error("Adding this dependency would create a cycle");
    }

    const depth = parentNode.depth + 1;

    const node: TaskNode = {
      taskPda,
      taskId: task.taskId,
      dependsOn: parentPda,
      dependencyType,
      depth,
      status: "pending",
    };

    this.nodes.set(pdaKey, node);

    // Add edge
    const existingEdges = this.edges.get(parentKey) || [];
    existingEdges.push({
      from: parentPda,
      to: taskPda,
      type: dependencyType,
    });
    this.edges.set(parentKey, existingEdges);

    // Add reverse edge
    this.reverseEdges.set(pdaKey, parentKey);
  }

  /**
   * Removes a task from the graph.
   *
   * @param taskPda - Task account PDA to remove
   * @throws Error if task has dependents (children)
   *
   * @example
   * ```typescript
   * graph.removeTask(completedTaskPda);
   * ```
   */
  removeTask(taskPda: PublicKey): void {
    const pdaKey = taskPda.toBase58();
    const node = this.nodes.get(pdaKey);

    if (!node) {
      return; // Task doesn't exist, nothing to remove
    }

    // Check if task has dependents
    const dependents = this.edges.get(pdaKey);
    if (dependents && dependents.length > 0) {
      throw new Error(
        `Cannot remove task ${pdaKey}: has ${dependents.length} dependent(s)`,
      );
    }

    // Remove from parent's edges
    if (node.dependsOn) {
      const parentKey = node.dependsOn.toBase58();
      const parentEdges = this.edges.get(parentKey);
      if (parentEdges) {
        const filtered = parentEdges.filter((e) => e.to.toBase58() !== pdaKey);
        if (filtered.length === 0) {
          this.edges.delete(parentKey);
        } else {
          this.edges.set(parentKey, filtered);
        }
      }
    }

    // Remove reverse edge
    this.reverseEdges.delete(pdaKey);

    // Remove node
    this.nodes.delete(pdaKey);
  }

  /**
   * Gets all tasks that depend on the given task (direct children only).
   *
   * @param taskPda - Task account PDA
   * @returns Array of dependent task nodes
   */
  getDependents(taskPda: PublicKey): TaskNode[] {
    const pdaKey = taskPda.toBase58();
    const edges = this.edges.get(pdaKey);

    if (!edges || edges.length === 0) {
      return [];
    }

    const dependents: TaskNode[] = [];
    for (const edge of edges) {
      const node = this.nodes.get(edge.to.toBase58());
      if (node) {
        dependents.push(node);
      }
    }

    return dependents;
  }

  /**
   * Gets the parent task that this task depends on.
   *
   * @param taskPda - Task account PDA
   * @returns Parent task node or null if root task
   */
  getParent(taskPda: PublicKey): TaskNode | null {
    const pdaKey = taskPda.toBase58();
    const parentKey = this.reverseEdges.get(pdaKey);

    if (!parentKey) {
      return null;
    }

    return this.nodes.get(parentKey) || null;
  }

  /**
   * Gets the depth of a task in the dependency chain.
   *
   * @param taskPda - Task account PDA
   * @returns Depth (0 = root), or -1 if task not found
   */
  getDepth(taskPda: PublicKey): number {
    const node = this.nodes.get(taskPda.toBase58());
    return node ? node.depth : -1;
  }

  /**
   * Checks if adding a dependency from parent to child would create a cycle.
   *
   * @param parent - Potential parent task PDA
   * @param child - Potential child task PDA
   * @returns True if adding the dependency would create a cycle
   */
  wouldCreateCycle(parent: PublicKey, child: PublicKey): boolean {
    const parentKey = parent.toBase58();
    const childKey = child.toBase58();

    // If they're the same, it's a self-loop
    if (parentKey === childKey) {
      return true;
    }

    // Check for any path from child to parent through dependency edges.
    // Adding parent -> child would create a cycle if such a path exists.
    const visited = new Set<string>();
    const stack = [childKey];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (current === parentKey) {
        return true;
      }

      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const children = this.edges.get(current) ?? [];
      for (const edge of children) {
        stack.push(edge.to.toBase58());
      }
    }

    return false;
  }

  /**
   * Detect all cycles in the dependency graph.
   *
   * Uses DFS coloring (white/gray/black) to find back edges.
   *
   * @returns Array of cycles (each represented by task PDAs in order)
   */
  detectCycles(): PublicKey[][] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const cycles: PublicKey[][] = [];

    for (const key of this.nodes.keys()) {
      color.set(key, WHITE);
      parent.set(key, null);
    }

    const dfs = (nodeKey: string): void => {
      color.set(nodeKey, GRAY);
      const children = this.edges.get(nodeKey) ?? [];

      for (const edge of children) {
        const childKey = edge.to.toBase58();
        const childColor = color.get(childKey) ?? WHITE;

        if (childColor === GRAY) {
          const cycle: PublicKey[] = [];
          let currentKey: string | null = nodeKey;
          while (currentKey !== null && currentKey !== childKey) {
            const node = this.nodes.get(currentKey);
            if (node) {
              cycle.unshift(node.taskPda);
            }
            currentKey = parent.get(currentKey) ?? null;
          }

          const closingNode = this.nodes.get(childKey);
          if (closingNode) {
            cycle.unshift(closingNode.taskPda);
          }

          if (cycle.length > 0) {
            cycles.push(cycle);
          }
          continue;
        }

        if (childColor === WHITE) {
          parent.set(childKey, nodeKey);
          dfs(childKey);
        }
      }

      color.set(nodeKey, BLACK);
    };

    for (const key of this.nodes.keys()) {
      if (color.get(key) === WHITE) {
        dfs(key);
      }
    }

    return cycles;
  }

  /**
   * Validates graph invariants (acyclic, no dangling edges, depth consistency).
   *
   * @returns Graph consistency result object
   */
  validateConsistency(): GraphConsistencyResult {
    const cycles = this.detectCycles();
    const danglingEdges: Array<{ from: string; to: string }> = [];
    const depthMismatches: Array<{
      taskPda: string;
      expected: number;
      actual: number;
    }> = [];

    // Validate edges
    for (const [fromKey, edges] of this.edges.entries()) {
      if (!this.nodes.has(fromKey)) {
        for (const edge of edges) {
          danglingEdges.push({ from: fromKey, to: edge.to.toBase58() });
        }
      }

      for (const edge of edges) {
        const toKey = edge.to.toBase58();
        if (!this.nodes.has(toKey)) {
          danglingEdges.push({ from: fromKey, to: toKey });
        }
      }
    }

    // Validate node depths
    for (const node of this.nodes.values()) {
      const expectedDepth = node.dependsOn
        ? (this.nodes.get(node.dependsOn.toBase58())?.depth ?? -1) + 1
        : 0;

      if (node.depth !== expectedDepth) {
        depthMismatches.push({
          taskPda: node.taskPda.toBase58(),
          expected: expectedDepth,
          actual: node.depth,
        });
      }
    }

    return {
      valid:
        cycles.length === 0 &&
        danglingEdges.length === 0 &&
        depthMismatches.length === 0,
      cycles,
      danglingEdges,
      depthMismatches,
    };
  }

  /**
   * Gets all tasks at a given depth level.
   *
   * @param depth - Depth level (0 = roots)
   * @returns Array of task nodes at the specified depth
   */
  getTasksAtDepth(depth: number): TaskNode[] {
    const tasks: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.depth === depth) {
        tasks.push(node);
      }
    }
    return tasks;
  }

  /**
   * Gets all root tasks (tasks with no dependencies).
   *
   * @returns Array of root task nodes
   */
  getRoots(): TaskNode[] {
    const roots: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.dependsOn === null) {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * Gets all leaf tasks (tasks with no dependents).
   *
   * @returns Array of leaf task nodes
   */
  getLeaves(): TaskNode[] {
    const leaves: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      const pdaKey = node.taskPda.toBase58();
      const children = this.edges.get(pdaKey);
      if (!children || children.length === 0) {
        leaves.push(node);
      }
    }
    return leaves;
  }

  /**
   * Returns all tasks in topological order (dependencies before dependents).
   * Uses Kahn's algorithm for topological sorting.
   *
   * @returns Array of task nodes in topological order
   */
  topologicalSort(): TaskNode[] {
    const result: TaskNode[] = [];
    const inDegree = new Map<string, number>();

    // Calculate in-degree for each node
    for (const [pdaKey] of this.nodes) {
      inDegree.set(pdaKey, 0);
    }
    for (const edges of this.edges.values()) {
      for (const edge of edges) {
        const toKey = edge.to.toBase58();
        inDegree.set(toKey, (inDegree.get(toKey) || 0) + 1);
      }
    }

    // Start with nodes that have no dependencies (in-degree = 0)
    const queue: string[] = [];
    for (const [pdaKey, degree] of inDegree) {
      if (degree === 0) {
        queue.push(pdaKey);
      }
    }

    // Process nodes in topological order
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.nodes.get(current);
      if (node) {
        result.push(node);
      }

      // Reduce in-degree of children
      const children = this.edges.get(current);
      if (children) {
        for (const edge of children) {
          const childKey = edge.to.toBase58();
          const newDegree = (inDegree.get(childKey) || 1) - 1;
          inDegree.set(childKey, newDegree);
          if (newDegree === 0) {
            queue.push(childKey);
          }
        }
      }
    }

    return result;
  }

  /**
   * Updates the status of a task.
   *
   * @param taskPda - Task account PDA
   * @param status - New status
   * @returns True if update succeeded, false if task not found
   */
  updateStatus(taskPda: PublicKey, status: TaskNodeStatus): boolean {
    const node = this.nodes.get(taskPda.toBase58());
    if (!node) {
      return false;
    }
    node.status = status;
    return true;
  }

  /**
   * Gets tasks ready for speculative execution.
   * A task is speculatable if its parent is completed or executing.
   *
   * @returns Array of task nodes eligible for speculative execution
   */
  getSpeculatableTasks(): TaskNode[] {
    const speculatable: TaskNode[] = [];

    for (const node of this.nodes.values()) {
      // Skip tasks that are already executing, completed, or failed
      if (node.status !== "pending") {
        continue;
      }

      // Root tasks are always speculatable
      if (node.dependsOn === null) {
        speculatable.push(node);
        continue;
      }

      // Check parent status
      const parent = this.nodes.get(node.dependsOn.toBase58());
      if (
        parent &&
        (parent.status === "completed" || parent.status === "executing")
      ) {
        speculatable.push(node);
      }
    }

    return speculatable;
  }

  /**
   * Gets a task node by PDA.
   *
   * @param taskPda - Task account PDA
   * @returns Task node or undefined if not found
   */
  getNode(taskPda: PublicKey): TaskNode | undefined {
    return this.nodes.get(taskPda.toBase58());
  }

  /**
   * Checks if a task exists in the graph.
   *
   * @param taskPda - Task account PDA
   * @returns True if task exists in the graph
   */
  hasTask(taskPda: PublicKey): boolean {
    return this.nodes.has(taskPda.toBase58());
  }

  /**
   * Gets all descendants of a task (children, grandchildren, etc.).
   *
   * @param taskPda - Task account PDA
   * @returns Array of descendant task nodes in BFS order
   */
  getDescendants(taskPda: PublicKey): TaskNode[] {
    const pdaKey = taskPda.toBase58();
    const descendants: TaskNode[] = [];
    const visited = new Set<string>();
    const queue = [pdaKey];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const children = this.edges.get(current);
      if (children) {
        for (const edge of children) {
          const childKey = edge.to.toBase58();
          const childNode = this.nodes.get(childKey);
          if (childNode && !visited.has(childKey)) {
            descendants.push(childNode);
            queue.push(childKey);
          }
        }
      }
    }

    return descendants;
  }

  /**
   * Gets all ancestors of a task (parent, grandparent, etc.).
   *
   * @param taskPda - Task account PDA
   * @returns Array of ancestor task nodes, nearest first
   */
  getAncestors(taskPda: PublicKey): TaskNode[] {
    const ancestors: TaskNode[] = [];
    let currentKey = taskPda.toBase58();

    while (true) {
      const parentKey = this.reverseEdges.get(currentKey);
      if (!parentKey) {
        break;
      }

      const parent = this.nodes.get(parentKey);
      if (parent) {
        ancestors.push(parent);
        currentKey = parentKey;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Serializes the graph to a JSON-compatible object.
   *
   * @returns Serialized graph data
   */
  toJSON(): object {
    const nodes: Array<{
      taskPda: string;
      taskId: string;
      dependsOn: string | null;
      dependencyType: DependencyType;
      depth: number;
      status: TaskNodeStatus;
    }> = [];

    for (const node of this.nodes.values()) {
      nodes.push({
        taskPda: node.taskPda.toBase58(),
        taskId: bytesToHex(node.taskId),
        dependsOn: node.dependsOn?.toBase58() || null,
        dependencyType: node.dependencyType,
        depth: node.depth,
        status: node.status,
      });
    }

    const edges: Array<{
      from: string;
      to: string;
      type: DependencyType;
    }> = [];

    for (const edgeList of this.edges.values()) {
      for (const edge of edgeList) {
        edges.push({
          from: edge.from.toBase58(),
          to: edge.to.toBase58(),
          type: edge.type,
        });
      }
    }

    return {
      nodes,
      edges,
      stats: this.getStats(),
    };
  }

  /**
   * Gets statistics about the graph.
   *
   * @returns Graph statistics
   */
  getStats(): DependencyGraphStats {
    let edgeCount = 0;
    for (const edges of this.edges.values()) {
      edgeCount += edges.length;
    }

    let maxDepth = 0;
    let rootCount = 0;
    for (const node of this.nodes.values()) {
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
      if (node.dependsOn === null) {
        rootCount++;
      }
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount,
      maxDepth,
      rootCount,
    };
  }

  /**
   * Clears all tasks from the graph.
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.reverseEdges.clear();
  }
}
