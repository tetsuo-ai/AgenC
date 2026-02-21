/**
 * Awareness → Goal Bridge
 *
 * Pattern-matching bridge that converts desktop awareness observations
 * into managed goals. When the desktop-awareness heartbeat produces
 * noteworthy output (error dialogs, crashes, ANR), this bridge matches
 * patterns and auto-generates goals for the GoalManager.
 *
 * @module
 */

import type { GoalManager, ManagedGoal } from "./goal-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface AwarenessPattern {
  /** Regex to match against awareness output text. */
  pattern: RegExp;
  /** Goal title template. */
  titleTemplate: string;
  /** Goal description template. */
  descriptionTemplate: string;
  /** Priority to assign. */
  priority: ManagedGoal["priority"];
  /** Optional: only match if ALL keywords present in text. */
  requiredKeywords?: string[];
}

export interface AwarenessGoalBridgeConfig {
  goalManager: GoalManager;
  patterns?: AwarenessPattern[];
}

// ============================================================================
// Default patterns
// ============================================================================

export const DEFAULT_AWARENESS_PATTERNS: AwarenessPattern[] = [
  {
    pattern: /error\s+dialog|error\s+message|application\s+error/i,
    titleTemplate: "Dismiss error dialog",
    descriptionTemplate:
      "Click OK/Close on the error dialog detected on screen",
    priority: "high",
  },
  {
    pattern: /not\s+responding|ANR|application.*hung|frozen/i,
    titleTemplate: "Handle unresponsive application",
    descriptionTemplate:
      "Force quit or wait for the unresponsive application detected on screen",
    priority: "critical",
  },
  {
    pattern: /crash\s+report|unexpected.*quit|has\s+quit/i,
    titleTemplate: "Handle application crash",
    descriptionTemplate:
      "Dismiss crash dialog and relaunch the crashed application",
    priority: "high",
  },
  {
    pattern: /update\s+available|software\s+update|restart.*update/i,
    titleTemplate: "Acknowledge update notification",
    descriptionTemplate:
      "Dismiss or schedule the software update notification",
    priority: "low",
  },
];

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a callback that converts awareness output text into goals.
 *
 * Returns a function: `(awarenessOutput: string) => Promise<ManagedGoal | null>`
 * When a pattern matches and the goal isn't a duplicate, it's added to GoalManager.
 */
export function createAwarenessGoalBridge(
  config: AwarenessGoalBridgeConfig,
): (awarenessOutput: string) => Promise<ManagedGoal | null> {
  const { goalManager } = config;
  const patterns = config.patterns ?? DEFAULT_AWARENESS_PATTERNS;

  return async (awarenessOutput: string): Promise<ManagedGoal | null> => {
    for (const p of patterns) {
      if (!p.pattern.test(awarenessOutput)) continue;

      // Check required keywords if specified
      if (p.requiredKeywords) {
        const lower = awarenessOutput.toLowerCase();
        const allPresent = p.requiredKeywords.every((kw) =>
          lower.includes(kw.toLowerCase()),
        );
        if (!allPresent) continue;
      }

      // Check dedup
      const active = await goalManager.getActiveGoals();
      if (goalManager.isDuplicate(p.descriptionTemplate, active)) {
        return null;
      }

      return goalManager.addGoal({
        title: p.titleTemplate,
        description: p.descriptionTemplate,
        priority: p.priority,
        source: "awareness",
        maxAttempts: 2,
      });
    }

    return null;
  };
}
