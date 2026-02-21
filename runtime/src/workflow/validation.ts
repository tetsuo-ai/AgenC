/**
 * Workflow DAG validation.
 *
 * Validates that a WorkflowDefinition is a valid tree topology that can be
 * submitted on-chain. The on-chain `depends_on: Option<Pubkey>` supports
 * at most one parent per task, so multi-parent fan-in is rejected.
 *
 * @module
 */

import type { WorkflowDefinition } from "./types.js";
import { OnChainDependencyType } from "./types.js";
import { WorkflowValidationError } from "./errors.js";

/**
 * Validate a workflow definition.
 *
 * Checks:
 * 1. Non-empty task array
 * 2. No duplicate task names
 * 3. All edge references point to existing task names
 * 4. No multi-parent nodes (each name appears as `to` in at most one edge)
 * 5. No cycles (DFS back-edge detection)
 * 6. No self-loops
 * 7. Edge dependency types must be 1, 2, or 3 (not 0/None)
 *
 * @throws WorkflowValidationError on any violation
 */
export function validateWorkflow(definition: WorkflowDefinition): void {
  const { tasks, edges } = definition;

  // 1. Non-empty
  if (!tasks || tasks.length === 0) {
    throw new WorkflowValidationError("Workflow must have at least one task");
  }

  // 2. No duplicate names
  const names = new Set<string>();
  for (const task of tasks) {
    if (!task.name || task.name.trim().length === 0) {
      throw new WorkflowValidationError("Task name must be a non-empty string");
    }
    if (names.has(task.name)) {
      throw new WorkflowValidationError(`Duplicate task name: "${task.name}"`);
    }
    names.add(task.name);
  }

  // 3. All edge references exist + 6. No self-loops + 7. Valid dependency types
  for (const edge of edges) {
    if (!names.has(edge.from)) {
      throw new WorkflowValidationError(
        `Edge references unknown task "${edge.from}" in "from" field`,
      );
    }
    if (!names.has(edge.to)) {
      throw new WorkflowValidationError(
        `Edge references unknown task "${edge.to}" in "to" field`,
      );
    }
    if (edge.from === edge.to) {
      throw new WorkflowValidationError(
        `Self-loop detected: task "${edge.from}" depends on itself`,
      );
    }
    if (
      edge.dependencyType !== OnChainDependencyType.Data &&
      edge.dependencyType !== OnChainDependencyType.Ordering &&
      edge.dependencyType !== OnChainDependencyType.Proof
    ) {
      throw new WorkflowValidationError(
        `Invalid dependency type ${edge.dependencyType} on edge "${edge.from}" -> "${edge.to}". ` +
          "Must be Data (1), Ordering (2), or Proof (3)",
      );
    }
  }

  // 4. No multi-parent nodes
  const childSeen = new Set<string>();
  for (const edge of edges) {
    if (childSeen.has(edge.to)) {
      throw new WorkflowValidationError(
        `Multi-parent detected: task "${edge.to}" has more than one incoming edge. ` +
          "On-chain tasks support only one parent (depends_on: Option<Pubkey>)",
      );
    }
    childSeen.add(edge.to);
  }

  // 5. Cycle detection via DFS
  // Build adjacency list (parent -> children)
  const adj = new Map<string, string[]>();
  for (const name of names) {
    adj.set(name, []);
  }
  for (const edge of edges) {
    adj.get(edge.from)!.push(edge.to);
  }

  const WHITE = 0; // unvisited
  const GRAY = 1; // in current DFS path
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const name of names) {
    color.set(name, WHITE);
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const child of adj.get(node)!) {
      const c = color.get(child)!;
      if (c === GRAY) return true; // back edge → cycle
      if (c === WHITE && dfs(child)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const name of names) {
    if (color.get(name) === WHITE) {
      if (dfs(name)) {
        throw new WorkflowValidationError("Cycle detected in workflow edges");
      }
    }
  }
}

/**
 * Topological sort of workflow nodes using Kahn's algorithm.
 * Returns task names in submission order (parents before children).
 *
 * @param definition - Validated workflow definition
 * @returns Array of task names in topological order
 */
export function topologicalSort(definition: WorkflowDefinition): string[] {
  const { tasks, edges } = definition;
  const names = tasks.map((t) => t.name).sort((a, b) => a.localeCompare(b));

  // Build in-degree map and adjacency list
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const name of names) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }
  for (const edge of edges) {
    adj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
  }

  // Deterministic child visitation order.
  for (const children of adj.values()) {
    children.sort((a, b) => a.localeCompare(b));
  }

  // Seed queue with roots (in-degree 0)
  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) {
      queue.push(name);
    }
  }
  queue.sort((a, b) => a.localeCompare(b));

  const sorted: string[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => a.localeCompare(b));
    const node = queue.shift()!;
    sorted.push(node);
    for (const child of adj.get(node)!) {
      const newDegree = inDegree.get(child)! - 1;
      inDegree.set(child, newDegree);
      if (newDegree === 0) {
        queue.push(child);
      }
    }
  }

  return sorted;
}
