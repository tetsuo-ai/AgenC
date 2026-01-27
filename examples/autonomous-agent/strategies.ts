/**
 * Example Claim Strategies
 *
 * Reference implementations showing different task claiming approaches.
 * Copy and modify these for your own use cases.
 *
 * @module
 */

import { Task, ClaimStrategy } from '@agenc/runtime';

/**
 * Greedy claim strategy - claim as many tasks as allowed concurrently
 *
 * @param maxConcurrent - Maximum number of tasks to work on simultaneously
 */
export function createGreedyStrategy(maxConcurrent: number): ClaimStrategy {
  return {
    shouldClaim: (_task: Task, pendingTasks: number) => pendingTasks < maxConcurrent,
    priority: (task: Task) => Number(task.reward),
  };
}

/**
 * Selective claim strategy - only claim high-value tasks
 *
 * @param minReward - Minimum reward in lamports to consider a task
 */
export function createSelectiveStrategy(minReward: bigint): ClaimStrategy {
  return {
    shouldClaim: (task: Task, _pendingTasks: number) => task.reward >= minReward,
    priority: (task: Task) => Number(task.reward),
  };
}

/**
 * Deadline-aware claim strategy - prioritize tasks closer to deadline
 *
 * Tasks with approaching deadlines get higher priority. Expired tasks
 * are given lowest priority (0). Tasks without deadlines are prioritized
 * by reward amount.
 *
 * @param maxConcurrent - Maximum concurrent tasks (default: 1)
 */
export function createDeadlineAwareStrategy(maxConcurrent: number = 1): ClaimStrategy {
  return {
    shouldClaim: (_task: Task, pendingTasks: number) => pendingTasks < maxConcurrent,
    priority: (task: Task) => {
      // Tasks with deadlines get higher priority as deadline approaches
      if (task.deadline > 0) {
        const now = Math.floor(Date.now() / 1000);
        const timeRemaining = task.deadline - now;
        // Invert: less time remaining = higher priority
        // But still factor in reward (reward / time remaining)
        if (timeRemaining > 0) {
          return Number(task.reward) / timeRemaining;
        }
        return 0; // Expired, lowest priority
      }
      // No deadline - just use reward
      return Number(task.reward);
    },
  };
}

/**
 * Capability-matched claim strategy - only claim tasks matching specific capabilities
 *
 * Filters tasks based on capability bitmask match before considering them.
 *
 * @param capabilities - Bitmask of capabilities this agent has
 * @param maxConcurrent - Maximum concurrent tasks (default: 1)
 */
export function createCapabilityMatchedStrategy(
  capabilities: bigint,
  maxConcurrent: number = 1
): ClaimStrategy {
  return {
    shouldClaim: (task: Task, pendingTasks: number) => {
      if (pendingTasks >= maxConcurrent) return false;
      // Only claim if we have all required capabilities
      return (task.requiredCapabilities & capabilities) === task.requiredCapabilities;
    },
    priority: (task: Task) => Number(task.reward),
  };
}
