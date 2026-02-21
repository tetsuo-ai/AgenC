/**
 * Task filter and ranking utilities for task discovery.
 *
 * Provides functions to filter tasks based on agent capabilities, reward bounds,
 * task type, deadline constraints, and privacy requirements, then rank them by
 * a configurable scoring function.
 *
 * @module
 */

import type { DiscoveredTask, TaskFilterConfig, TaskScorer, OnChainTask } from './types.js';
import { OnChainTaskStatus, isPrivateTask } from './types.js';

/** Default time remaining (1 day in seconds) for tasks with no deadline. */
const DEFAULT_NO_DEADLINE_SECONDS = 86_400;

/**
 * Checks if an agent has all required capabilities using bitwise AND.
 *
 * @param agentCapabilities - The agent's capability bitmask
 * @param requiredCapabilities - The required capability bitmask
 * @returns True if the agent has all required capabilities
 *
 * @example
 * ```typescript
 * const agentCaps = AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE;
 * const required = AgentCapabilities.COMPUTE;
 * hasRequiredCapabilities(agentCaps, required); // true
 * ```
 */
export function hasRequiredCapabilities(
  agentCapabilities: bigint,
  requiredCapabilities: bigint,
): boolean {
  return (agentCapabilities & requiredCapabilities) === requiredCapabilities;
}

/**
 * Checks if a task passes all filter criteria.
 *
 * Implements a 9-step filter chain with early return on first failure:
 * 1. Status check (Open or InProgress)
 * 2. Capability match
 * 3. Slots available
 * 4. Min reward
 * 5. Max reward
 * 6. Task type
 * 7. Deadline buffer
 * 8. Privacy filter
 * 9. Custom filter
 *
 * @param task - The on-chain task to check
 * @param agentCapabilities - The agent's capability bitmask
 * @param filter - Filter configuration
 * @returns True if the task passes all filter criteria
 *
 * @example
 * ```typescript
 * const passes = matchesFilter(task, agentCaps, {
 *   minRewardLamports: 1_000_000n,
 *   taskTypes: [TaskType.Exclusive],
 * });
 * ```
 */
export function matchesFilter(
  task: OnChainTask,
  agentCapabilities: bigint,
  filter: TaskFilterConfig,
): boolean {
  // 1. Status: must be Open or InProgress
  if (
    task.status !== OnChainTaskStatus.Open &&
    task.status !== OnChainTaskStatus.InProgress
  ) {
    return false;
  }

  // 2. Capabilities: agent must have all required capabilities
  if (!hasRequiredCapabilities(agentCapabilities, task.requiredCapabilities)) {
    return false;
  }

  // 3. Slots: must have capacity for more workers
  if (task.currentWorkers >= task.maxWorkers) {
    return false;
  }

  // 4. Min Reward
  if (
    filter.minRewardLamports !== undefined &&
    task.rewardAmount < filter.minRewardLamports
  ) {
    return false;
  }

  // 5. Max Reward
  if (
    filter.maxRewardLamports !== undefined &&
    task.rewardAmount > filter.maxRewardLamports
  ) {
    return false;
  }

  // 6. Task Type
  if (
    filter.taskTypes !== undefined &&
    filter.taskTypes.length > 0 &&
    !filter.taskTypes.includes(task.taskType)
  ) {
    return false;
  }

  // 7. Deadline Buffer
  if (
    filter.minDeadlineBufferSeconds !== undefined &&
    filter.minDeadlineBufferSeconds > 0 &&
    task.deadline > 0
  ) {
    const now = Math.floor(Date.now() / 1000);
    const timeRemaining = task.deadline - now;
    if (timeRemaining < filter.minDeadlineBufferSeconds) {
      return false;
    }
  }

  // 8. Privacy filter
  if (filter.privateOnly && !isPrivateTask(task)) {
    return false;
  }
  if (filter.publicOnly && isPrivateTask(task)) {
    return false;
  }

  // 9. Custom filter
  if (filter.customFilter) {
    const discoveredTask: DiscoveredTask = {
      task,
      relevanceScore: 0,
      canClaim: true,
    };
    if (!filter.customFilter(discoveredTask)) {
      return false;
    }
  }

  return true;
}

/**
 * Default task scoring function that ranks by reward/urgency ratio.
 *
 * Score = reward / max(1, timeRemaining).
 * Tasks with higher reward and shorter deadlines score higher.
 * Tasks with no deadline use DEFAULT_NO_DEADLINE_SECONDS (1 day) as the default time remaining.
 *
 * @param task - The discovered task to score
 * @returns Numeric score (higher = higher priority)
 *
 * @example
 * ```typescript
 * const score = defaultTaskScorer(discoveredTask);
 * ```
 */
export const defaultTaskScorer: TaskScorer = (task: DiscoveredTask): number => {
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining =
    task.task.deadline > 0 ? task.task.deadline - now : DEFAULT_NO_DEADLINE_SECONDS;

  const denominator = Math.max(1, timeRemaining);
  return Number(task.task.rewardAmount) / denominator;
};

/**
 * Ranks tasks by score in descending order using the provided scorer.
 * Returns a new array (non-mutating).
 *
 * @param tasks - Array of discovered tasks to rank
 * @param scorer - Scoring function (defaults to defaultTaskScorer)
 * @returns New array sorted by score descending (highest score first)
 *
 * @example
 * ```typescript
 * const ranked = rankTasks(tasks);
 * console.log(ranked[0].relevanceScore); // highest score
 * ```
 */
export function rankTasks(
  tasks: DiscoveredTask[],
  scorer: TaskScorer = defaultTaskScorer,
): DiscoveredTask[] {
  return [...tasks]
    .map((t) => ({ ...t, relevanceScore: scorer(t) }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Filters tasks by criteria, then ranks them by score.
 * Combines matchesFilter + rankTasks in one pass.
 *
 * @param tasks - Array of on-chain tasks with their PDAs
 * @param agentCapabilities - The agent's capability bitmask
 * @param filter - Filter configuration
 * @param scorer - Optional custom scoring function (defaults to defaultTaskScorer)
 * @returns Filtered and ranked array of discovered tasks
 *
 * @example
 * ```typescript
 * const results = filterAndRank(
 *   tasks,
 *   agentCaps,
 *   { minRewardLamports: 1_000_000n },
 * );
 * ```
 */
export function filterAndRank(
  tasks: OnChainTask[],
  agentCapabilities: bigint,
  filter: TaskFilterConfig,
  scorer: TaskScorer = defaultTaskScorer,
): DiscoveredTask[] {
  const filtered: DiscoveredTask[] = [];

  for (const task of tasks) {
    if (matchesFilter(task, agentCapabilities, filter)) {
      filtered.push({
        task,
        relevanceScore: 0,
        canClaim: true,
      });
    }
  }

  return rankTasks(filtered, scorer);
}
