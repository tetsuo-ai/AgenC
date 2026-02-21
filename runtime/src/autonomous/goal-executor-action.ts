/**
 * Goal Executor Action — Heartbeat
 *
 * A HeartbeatAction that dequeues goals from GoalManager, executes them
 * via DesktopExecutor, and feeds results back into memory for self-learning.
 *
 * Replaces the inline `desktop-goal-executor` heartbeat in daemon.ts.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { MemoryBackend } from "../memory/types.js";
import type { DesktopExecutor } from "./desktop-executor.js";
import type { GoalManager } from "./goal-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface GoalExecutorActionConfig {
  goalManager: GoalManager;
  desktopExecutor: DesktopExecutor;
  memory: MemoryBackend;
  /** Only execute goals whose description matches desktop keywords. Default: true. */
  desktopOnly?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DESKTOP_KEYWORD_RE =
  /\b(open|click|type|navigate|launch|browse|search|download|dismiss|close|quit|force\s*quit|relaunch|schedule)\b/i;

// ============================================================================
// Factory
// ============================================================================

export function createGoalExecutorAction(
  config: GoalExecutorActionConfig,
): HeartbeatAction {
  const { goalManager, desktopExecutor, memory } = config;
  const desktopOnly = config.desktopOnly ?? true;

  return {
    name: "desktop-goal-executor",
    enabled: true,

    async execute(_context: HeartbeatContext): Promise<HeartbeatResult> {
      // Skip if executor already running
      if (desktopExecutor.isRunning) {
        return { hasOutput: false, quiet: true };
      }

      // Get next goal by priority
      const goal = await goalManager.getNextGoal();
      if (!goal) {
        return { hasOutput: false, quiet: true };
      }

      // Filter for desktop-applicable goals if configured
      if (desktopOnly && !DESKTOP_KEYWORD_RE.test(goal.description)) {
        return { hasOutput: false, quiet: true };
      }

      // Mark executing
      await goalManager.markExecuting(goal.id);

      try {
        // Map source to DesktopExecutor's accepted sources
        const executorSource: "user" | "meta-planner" =
          goal.source === "user" ? "user" : "meta-planner";

        const result = await desktopExecutor.executeGoal(
          goal.description,
          executorSource,
        );

        const goalResult = {
          success: result.success,
          summary: result.summary,
          durationMs: result.durationMs,
        };

        if (result.success) {
          await goalManager.markCompleted(goal.id, goalResult);
        } else {
          await goalManager.markFailed(goal.id, goalResult);
        }

        // Store result in memory for self-learning
        await memory
          .addEntry({
            sessionId: "goal-executor:results",
            role: "assistant",
            content: `[GoalExecutor] ${result.success ? "Completed" : "Failed"}: "${goal.title}" (source=${goal.source}, priority=${goal.priority})\nSummary: ${result.summary}\nDuration: ${result.durationMs}ms`,
            metadata: {
              type: "goal-execution-result",
              goalId: goal.id,
              goalTitle: goal.title,
              goalSource: goal.source,
              goalPriority: goal.priority,
              success: result.success,
              durationMs: result.durationMs,
              attempts: goal.attempts + 1,
              timestamp: Date.now(),
            },
          })
          .catch(() => {});

        return {
          hasOutput: true,
          output: `Desktop goal ${result.success ? "completed" : "failed"}: ${result.summary}`,
          quiet: false,
        };
      } catch (err) {
        // Unexpected error — mark failed
        const errorMsg =
          err instanceof Error ? err.message : "Unknown error";
        await goalManager.markFailed(goal.id, {
          success: false,
          summary: errorMsg,
          durationMs: 0,
        });

        return {
          hasOutput: true,
          output: `Desktop goal error: ${errorMsg}`,
          quiet: false,
        };
      }
    },
  };
}
