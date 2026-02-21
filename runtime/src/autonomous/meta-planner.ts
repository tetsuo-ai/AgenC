/**
 * Meta-planner — self-directed goal generation.
 *
 * Uses the memory graph and recent activity to understand current state,
 * feeds a state summary to the LLM with a meta-planning prompt, and
 * generates structured goals with priority and rationale.
 *
 * Goals pass through the PolicyEngine before execution and can
 * optionally feed into GoalCompiler → on-chain workflow.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { LLMProvider } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import { entryToMessage } from "../memory/types.js";

// ============================================================================
// Types
// ============================================================================

export interface MetaPlannerConfig {
  /** LLM provider for goal generation. */
  llm: LLMProvider;
  /** Memory backend for reading state and storing goals. */
  memory: MemoryBackend;
  /** Agent's stated purpose/mission (used in planning prompt). */
  agentMission?: string;
  /** Max goals to generate per cycle (default: 3). */
  maxGoals?: number;
  /** Lookback window for state summary (default: 86_400_000 = 24h). */
  lookbackMs?: number;
  /** KV key prefix for stored goals (default: "goal:"). */
  keyPrefix?: string;
}

export interface GeneratedGoal {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  rationale: string;
  suggestedActions: string[];
  estimatedComplexity: "simple" | "moderate" | "complex";
  createdAt: number;
  status: "proposed" | "approved" | "in-progress" | "completed" | "rejected";
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_GOALS = 3;
const DEFAULT_LOOKBACK_MS = 86_400_000;
const DEFAULT_KEY_PREFIX = "goal:";

const META_PLANNING_PROMPT = `You are an autonomous AI agent's strategic planning module.

Your mission: {MISSION}

Based on recent activity and current state, generate strategic goals that would advance your mission.

Rules:
- Goals should be specific, measurable, and actionable
- Prioritize goals that build on recent successes or address recent failures
- Include both short-term tactical and longer-term strategic goals
- Each goal should have a clear rationale explaining WHY it matters

Return a JSON array of goals:
[
  {
    "title": "Short goal title",
    "description": "Detailed description of what to achieve",
    "priority": "critical" | "high" | "medium" | "low",
    "rationale": "Why this goal matters now",
    "suggestedActions": ["action1", "action2"],
    "estimatedComplexity": "simple" | "moderate" | "complex"
  }
]

Return ONLY valid JSON. No markdown code blocks.`;

// ============================================================================
// Action
// ============================================================================

export function createMetaPlannerAction(
  config: MetaPlannerConfig,
): HeartbeatAction {
  const { llm, memory } = config;
  const agentMission =
    config.agentMission ??
    "Coordinate tasks, assist users, and continuously improve capabilities";
  const maxGoals = config.maxGoals ?? DEFAULT_MAX_GOALS;
  const lookbackMs = config.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;

  return {
    name: "meta-planner",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        // Build state summary from recent activity
        const entries = await memory.query({
          after: Date.now() - lookbackMs,
          limit: 50,
          order: "desc",
        });

        // Load recent learnings if available
        let learnings = "";
        try {
          const recentLearning = await memory.get<{
            patterns: Array<{ lesson: string }>;
            strategies: Array<{ name: string; description: string }>;
          }>("learning:latest");
          if (recentLearning) {
            const lessons = recentLearning.patterns
              ?.map((p) => `- ${p.lesson}`)
              .join("\n");
            const strategies = recentLearning.strategies
              ?.map((s) => `- ${s.name}: ${s.description}`)
              .join("\n");
            learnings = `\n\nRecent Learnings:\n${lessons}\n\nKnown Strategies:\n${strategies}`;
          }
        } catch {
          // no learnings available
        }

        // Load existing active goals
        let activeGoals = "";
        try {
          const goals = await memory.get<GeneratedGoal[]>(`${keyPrefix}active`);
          if (goals && goals.length > 0) {
            activeGoals =
              "\n\nActive Goals:\n" +
              goals
                .map(
                  (g) =>
                    `- [${g.priority}] ${g.title} (${g.status}): ${g.description}`,
                )
                .join("\n");
          }
        } catch {
          // no active goals
        }

        const messages = entries.map(entryToMessage);
        const activitySummary = messages
          .slice(0, 30)
          .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
          .join("\n");

        const prompt = META_PLANNING_PROMPT.replace("{MISSION}", agentMission);

        const response = await llm.chat([
          { role: "system", content: prompt },
          {
            role: "user",
            content:
              `Current state:\n` +
              `- ${entries.length} interactions in the last ${Math.round(lookbackMs / 3600000)}h\n` +
              `${activeGoals}${learnings}\n\n` +
              `Recent Activity:\n${activitySummary}\n\n` +
              `Generate up to ${maxGoals} new strategic goals.`,
          },
        ]);

        if (!response.content) {
          return { hasOutput: false, quiet: true };
        }

        // Parse goals
        let rawGoals: Array<{
          title: string;
          description: string;
          priority: string;
          rationale: string;
          suggestedActions: string[];
          estimatedComplexity: string;
        }>;
        try {
          rawGoals = JSON.parse(response.content) as typeof rawGoals;
          if (!Array.isArray(rawGoals)) {
            return { hasOutput: false, quiet: true };
          }
        } catch {
          context.logger.warn("MetaPlanner: failed to parse LLM goals");
          return { hasOutput: false, quiet: true };
        }

        // Structure and store goals
        const goals: GeneratedGoal[] = rawGoals
          .slice(0, maxGoals)
          .map((raw, i) => ({
            id: `${Date.now()}-${i}`,
            title: raw.title ?? "Untitled",
            description: raw.description ?? "",
            priority: (["critical", "high", "medium", "low"].includes(raw.priority)
              ? raw.priority
              : "medium") as GeneratedGoal["priority"],
            rationale: raw.rationale ?? "",
            suggestedActions: raw.suggestedActions ?? [],
            estimatedComplexity: (
              ["simple", "moderate", "complex"].includes(raw.estimatedComplexity)
                ? raw.estimatedComplexity
                : "moderate"
            ) as GeneratedGoal["estimatedComplexity"],
            createdAt: Date.now(),
            status: "proposed" as const,
          }));

        if (goals.length === 0) {
          return { hasOutput: false, quiet: true };
        }

        // Store generated goals
        await memory.set(`${keyPrefix}batch:${Date.now()}`, goals);

        // Merge into active goals list
        try {
          const existing =
            (await memory.get<GeneratedGoal[]>(`${keyPrefix}active`)) ?? [];
          const merged = [...existing, ...goals].slice(-20); // keep last 20
          await memory.set(`${keyPrefix}active`, merged);
        } catch {
          await memory.set(`${keyPrefix}active`, goals);
        }

        // Store in memory thread for audit trail
        await memory.addEntry({
          sessionId: "meta-planner:goals",
          role: "assistant",
          content:
            `[META-PLANNER] Generated ${goals.length} goal(s):\n` +
            goals
              .map(
                (g) =>
                  `- [${g.priority}] ${g.title}: ${g.description}\n  Rationale: ${g.rationale}`,
              )
              .join("\n"),
          metadata: {
            type: "meta-planner",
            goalCount: goals.length,
            timestamp: Date.now(),
          },
        });

        const summary = goals
          .map((g) => `[${g.priority}] ${g.title}`)
          .join(", ");

        return {
          hasOutput: true,
          output: `MetaPlanner: generated ${goals.length} goal(s): ${summary}`,
          quiet: false,
        };
      } catch (err) {
        context.logger.error("MetaPlanner action failed:", err);
        return { hasOutput: false, quiet: true };
      }
    },
  };
}
