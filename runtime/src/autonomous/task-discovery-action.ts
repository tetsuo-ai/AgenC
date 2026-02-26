/**
 * Task Discovery Action — Heartbeat
 *
 * A HeartbeatAction that scans for on-chain tasks, scores their risk,
 * and queues viable ones as goals in GoalManager.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { TaskScanner } from "./scanner.js";
import type { GoalManager, ManagedGoal } from "./goal-manager.js";
import { scoreTaskRisk, type RiskTier } from "./risk-scoring.js";
import type { Logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface TaskDiscoveryActionConfig {
  scanner: TaskScanner;
  goalManager: GoalManager;
  /** Maximum tasks to evaluate per heartbeat cycle (default: 5). */
  maxTasksPerScan?: number;
  /** Maximum acceptable risk score (0-1). Tasks above this are skipped (default: 0.70). */
  maxRiskScore?: number;
  logger?: Logger;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_TASKS_PER_SCAN = 5;
const DEFAULT_MAX_RISK_SCORE = 0.7;

const RISK_TIER_TO_PRIORITY: Record<
  RiskTier,
  ManagedGoal["priority"] | null
> = {
  low: "medium",
  medium: "low",
  high: null, // skip
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a heartbeat action that discovers on-chain tasks and feeds
 * them to GoalManager as goals.
 */
export function createTaskDiscoveryAction(
  config: TaskDiscoveryActionConfig,
): HeartbeatAction {
  const { scanner, goalManager } = config;
  const maxTasksPerScan =
    config.maxTasksPerScan ?? DEFAULT_MAX_TASKS_PER_SCAN;
  const maxRiskScore = config.maxRiskScore ?? DEFAULT_MAX_RISK_SCORE;
  const logger = config.logger;

  // Tracks PDAs already queued to avoid duplicates across heartbeat cycles
  const queuedPdas = new Set<string>();

  return {
    name: "task-discovery",
    enabled: true,

    async execute(_context: HeartbeatContext): Promise<HeartbeatResult> {
      let tasks;
      try {
        tasks = await scanner.scan();
      } catch (err) {
        logger?.error?.("Task discovery scan failed:", err);
        return { hasOutput: false, quiet: true };
      }

      if (tasks.length === 0) {
        return { hasOutput: false, quiet: true };
      }

      // Limit work per heartbeat
      const batch = tasks.slice(0, maxTasksPerScan);
      let queued = 0;
      let skippedRisk = 0;

      for (const task of batch) {
        const pdaKey = task.pda.toBase58();
        if (queuedPdas.has(pdaKey)) continue;

        const riskResult = scoreTaskRisk(task);

        if (riskResult.score > maxRiskScore) {
          skippedRisk++;
          continue;
        }

        const priority = RISK_TIER_TO_PRIORITY[riskResult.tier];
        if (priority === null) {
          skippedRisk++;
          continue;
        }

        try {
          await goalManager.addGoal({
            title: "On-chain task",
            description: `Task PDA: ${pdaKey}, reward: ${task.reward}`,
            priority,
            source: "meta-planner",
            maxAttempts: 2,
          });
          queuedPdas.add(pdaKey);
          queued++;
        } catch (err) {
          logger?.warn?.(
            `Failed to queue goal for task ${pdaKey}:`,
            err,
          );
        }
      }

      const output = `Discovered ${tasks.length} tasks, queued ${queued} goals (skipped ${skippedRisk} high-risk)`;
      logger?.debug?.(output);

      return {
        hasOutput: queued > 0,
        output,
        quiet: true,
      };
    },
  };
}
