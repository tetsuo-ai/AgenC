/**
 * ProgressTracker — cross-session continuity via persistent progress entries.
 *
 * Stores timestamped progress entries in a MemoryBackend KV store, keyed by
 * `progress:{sessionId}`. Implements `MemoryRetriever` so it plugs into the
 * existing `injectContext()` chain in ChatExecutor.
 *
 * @module
 */

import type { MemoryBackend } from "../memory/types.js";
import type { MemoryRetriever } from "../llm/chat-executor.js";
import type { Logger } from "../utils/logger.js";
import { safeStringify } from "../tools/types.js";
import { SEVEN_DAYS_MS } from "../utils/async.js";

// ============================================================================
// Constants
// ============================================================================

/** Default maximum entries retained per session. */
const DEFAULT_MAX_ENTRIES = 50;

/** Maximum entries returned by retrieve() for token efficiency. */
const RETRIEVE_LIMIT = 5;

/** Maximum chars for a single summary line. */
const MAX_SUMMARY_CHARS = 200;

/** Maximum chars for tool result preview. */
const MAX_RESULT_PREVIEW_CHARS = 80;

/** Maximum chars for tool args preview. */
const MAX_ARGS_PREVIEW_CHARS = 60;

// ============================================================================
// Types
// ============================================================================

export type ProgressEntryType =
  | "task_started"
  | "task_completed"
  | "tool_result"
  | "error"
  | "decision";

export interface ProgressEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly type: ProgressEntryType;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProgressTrackerConfig {
  readonly memoryBackend: MemoryBackend;
  readonly maxEntriesPerSession?: number;
  readonly ttlMs?: number;
  readonly logger?: Logger;
}

// ============================================================================
// Helpers
// ============================================================================

function progressKey(sessionId: string): string {
  return `progress:${sessionId}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Produce a one-liner summary from a tool call result.
 * Truncates long args/output for compact storage.
 */
export function summarizeToolResult(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  durationMs: number,
): string {
  const argStr = truncate(safeStringify(args), MAX_ARGS_PREVIEW_CHARS);
  const resultStr = truncate(result, MAX_RESULT_PREVIEW_CHARS);
  return `${toolName}(${argStr}) -> ${resultStr} [${durationMs}ms]`;
}

// ============================================================================
// ProgressTracker
// ============================================================================

/**
 * Cross-session progress tracker.
 *
 * Stores progress entries in a MemoryBackend KV store and implements
 * `MemoryRetriever` for injection into ChatExecutor context.
 */
export class ProgressTracker implements MemoryRetriever {
  private readonly backend: MemoryBackend;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger?: Logger;

  /**
   * Per-session promise chains to serialize concurrent appends.
   * Each session gets its own chain to avoid read-modify-write races.
   */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(config: ProgressTrackerConfig) {
    this.backend = config.memoryBackend;
    this.maxEntries = config.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = config.ttlMs ?? SEVEN_DAYS_MS;
    this.logger = config.logger;
  }

  /**
   * Append a progress entry. Auto-sets timestamp, prunes old entries.
   * Uses per-session promise chain to serialize concurrent appends.
   */
  async append(entry: Omit<ProgressEntry, "timestamp">): Promise<void> {
    const { sessionId } = entry;
    const chain = this.chains.get(sessionId) ?? Promise.resolve();
    const next = chain.then(async () => {
      try {
        const key = progressKey(sessionId);
        const existing =
          (await this.backend.get<ProgressEntry[]>(key)) ?? [];

        const full: ProgressEntry = {
          ...entry,
          timestamp: Date.now(),
          summary: truncate(entry.summary, MAX_SUMMARY_CHARS),
        };
        existing.push(full);

        // Prune to max entries (keep most recent)
        while (existing.length > this.maxEntries) {
          existing.shift();
        }

        await this.backend.set(key, existing, this.ttlMs);
      } catch (err) {
        this.logger?.error("ProgressTracker.append failed:", err);
      }
    });

    this.chains.set(sessionId, next);
    await next;
  }

  /** Get recent entries for a session. */
  async getRecent(
    sessionId: string,
    limit?: number,
  ): Promise<readonly ProgressEntry[]> {
    const key = progressKey(sessionId);
    const entries = (await this.backend.get<ProgressEntry[]>(key)) ?? [];
    if (limit !== undefined && limit < entries.length) {
      return entries.slice(-limit);
    }
    return entries;
  }

  /** Get formatted Markdown summary for /progress command. */
  async getSummary(sessionId: string): Promise<string | undefined> {
    const entries = await this.getRecent(sessionId);
    if (entries.length === 0) return undefined;

    const grouped = new Map<ProgressEntryType, ProgressEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.type);
      if (list) {
        list.push(entry);
      } else {
        grouped.set(entry.type, [entry]);
      }
    }

    const sections: string[] = [];
    for (const [type, items] of grouped) {
      const lines = items.map(
        (e) => `- [${formatTimestamp(e.timestamp)}] ${e.summary}`,
      );
      sections.push(`### ${type}\n${lines.join("\n")}`);
    }

    return `## Session Progress\n\n${sections.join("\n\n")}`;
  }

  /** Clear all progress entries for a session. */
  async clear(sessionId: string): Promise<void> {
    const key = progressKey(sessionId);
    await this.backend.delete(key);
    this.chains.delete(sessionId);
  }

  /**
   * MemoryRetriever implementation.
   * Returns a concise last-N entries as system context, or undefined when empty.
   */
  async retrieve(
    _message: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const entries = await this.getRecent(sessionId, RETRIEVE_LIMIT);
    if (entries.length === 0) return undefined;

    const lines = entries.map(
      (e) => `- [${e.type}] ${e.summary}`,
    );
    return `## Recent Progress\n\n${lines.join("\n")}`;
  }
}
