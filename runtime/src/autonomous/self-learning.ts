/**
 * Self-learning loop — heartbeat action for pattern analysis.
 *
 * Periodically reviews recent task completions and failures from memory,
 * uses the LLM to identify patterns, and stores learned strategies
 * in structured KV memory for future reference.
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

export interface SelfLearningConfig {
  /** LLM provider for analysis. */
  llm: LLMProvider;
  /** Memory backend for reading history and storing learnings. */
  memory: MemoryBackend;
  /** Session IDs to analyze (default: all recent). */
  sessionIds?: string[];
  /** Lookback window in ms (default: 86_400_000 = 24 hours). */
  lookbackMs?: number;
  /** Max entries to analyze per cycle (default: 100). */
  maxEntries?: number;
  /** KV key prefix for stored learnings (default: "learning:"). */
  keyPrefix?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LOOKBACK_MS = 86_400_000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_KEY_PREFIX = "learning:";

const ANALYSIS_SYSTEM_PROMPT = `You are an AI agent analyzing your own past interactions to improve future performance.

Review the conversation history below and produce a JSON analysis:
{
  "patterns": [
    {
      "type": "success" | "failure" | "improvement",
      "description": "What happened",
      "lesson": "What to do differently next time",
      "confidence": 0.0-1.0
    }
  ],
  "strategies": [
    {
      "name": "short-strategy-name",
      "description": "When to apply this strategy",
      "steps": ["step1", "step2"]
    }
  ],
  "preferences": {
    "key": "value"
  }
}

Focus on:
- Tool usage patterns (which tools worked, which failed)
- Communication style that got good responses
- Common error recovery techniques
- Task completion patterns

Return ONLY valid JSON. No markdown code blocks.`;

// ============================================================================
// Action
// ============================================================================

interface LearningRecord {
  timestamp: number;
  patterns: Array<{
    type: string;
    description: string;
    lesson: string;
    confidence: number;
  }>;
  strategies: Array<{
    name: string;
    description: string;
    steps: string[];
  }>;
  preferences: Record<string, string>;
}

export function createSelfLearningAction(
  config: SelfLearningConfig,
): HeartbeatAction {
  const { llm, memory } = config;
  const lookbackMs = config.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;

  return {
    name: "self-learning",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        // Gather recent interactions from memory
        const entries = await memory.query({
          after: Date.now() - lookbackMs,
          limit: maxEntries,
          order: "asc",
        });

        if (entries.length < 5) {
          // Not enough data to analyze
          return { hasOutput: false, quiet: true };
        }

        // Format entries for analysis
        const messages = entries.map(entryToMessage);
        const formatted = messages
          .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
          .join("\n");

        // Run LLM analysis
        const response = await llm.chat([
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze these ${entries.length} recent interactions:\n\n${formatted}`,
          },
        ]);

        if (!response.content) {
          return { hasOutput: false, quiet: true };
        }

        // Parse the analysis
        let analysis: LearningRecord;
        try {
          const parsed = JSON.parse(response.content) as Partial<LearningRecord>;
          analysis = {
            timestamp: Date.now(),
            patterns: parsed.patterns ?? [],
            strategies: parsed.strategies ?? [],
            preferences: parsed.preferences ?? {},
          };
        } catch {
          context.logger.warn("Self-learning: failed to parse LLM analysis");
          return { hasOutput: false, quiet: true };
        }

        // Store learnings in memory KV
        const storageKey = `${keyPrefix}${Date.now()}`;
        await memory.set(storageKey, analysis);

        // Store individual strategies for quick lookup
        for (const strategy of analysis.strategies) {
          const stratKey = `${keyPrefix}strategy:${strategy.name}`;
          await memory.set(stratKey, strategy);
        }

        // Store preferences
        for (const [key, value] of Object.entries(analysis.preferences)) {
          await memory.set(`${keyPrefix}pref:${key}`, value);
        }

        const patternCount = analysis.patterns.length;
        const strategyCount = analysis.strategies.length;
        const prefCount = Object.keys(analysis.preferences).length;

        if (patternCount === 0 && strategyCount === 0) {
          return { hasOutput: false, quiet: true };
        }

        return {
          hasOutput: true,
          output:
            `Self-learning cycle complete: ` +
            `${patternCount} pattern(s), ${strategyCount} strategy(ies), ${prefCount} preference(s) learned`,
          quiet: false,
        };
      } catch (err) {
        context.logger.error("Self-learning action failed:", err);
        return { hasOutput: false, quiet: true };
      }
    },
  };
}
