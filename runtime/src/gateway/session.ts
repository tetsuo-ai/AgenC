/**
 * Session management for the AgenC gateway.
 *
 * Provides scoping, reset policies, and conversation compaction.
 * Sessions are the unit of conversation state between a user and the agent.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { LLMMessage } from "../llm/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionScope =
  | "main"
  | "per-peer"
  | "per-channel-peer"
  | "per-account-channel-peer";

export type SessionResetMode = "never" | "daily" | "idle" | "weekday";

export type CompactionStrategy = "summarize" | "truncate" | "sliding-window";

export interface SessionResetConfig {
  readonly mode: SessionResetMode;
  /** Hour of day for daily reset (0-23). Default 4. */
  readonly dailyHour?: number;
  /** Idle timeout in minutes. Default 120. */
  readonly idleMinutes?: number;
}

export interface SessionConfig {
  readonly scope: SessionScope;
  readonly reset: SessionResetConfig;
  readonly overrides?: {
    readonly dm?: Partial<SessionConfig>;
    readonly group?: Partial<SessionConfig>;
    readonly thread?: Partial<SessionConfig>;
  };
  readonly channelOverrides?: Readonly<Record<string, Partial<SessionConfig>>>;
  /** Maximum history length before auto-compaction. Default 100. */
  readonly maxHistoryLength?: number;
  readonly compaction: CompactionStrategy;
}

export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  history: LLMMessage[];
  readonly createdAt: number;
  lastActiveAt: number;
  metadata: Record<string, unknown>;
}

export interface SessionLookupParams {
  readonly channel: string;
  readonly senderId: string;
  readonly scope: "dm" | "group" | "thread";
  readonly workspaceId: string;
  readonly guildId?: string;
  readonly threadId?: string;
}

export interface CompactionResult {
  readonly messagesRemoved: number;
  readonly messagesRetained: number;
  readonly summaryGenerated: boolean;
  /** Whether summary quality checks accepted/rejected generated content. */
  readonly summaryQuality?: "accepted" | "rejected" | "not_applicable";
  /** Final summary length when a summary message is retained. */
  readonly summaryChars?: number;
}

export type SessionCompactionPhase = "before" | "after" | "error";

export interface SessionCompactionHookPayload {
  readonly phase: SessionCompactionPhase;
  readonly sessionId: string;
  readonly strategy: CompactionStrategy;
  readonly historyLengthBefore: number;
  readonly historyLengthAfter?: number;
  readonly result?: CompactionResult;
  readonly error?: string;
}

export type SessionCompactionHook = (
  payload: SessionCompactionHookPayload,
) => Promise<void> | void;

export interface SessionInfo {
  readonly id: string;
  readonly channel: string;
  readonly senderId: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

/** Callback that summarizes messages into a single string. */
export type Summarizer = (messages: LLMMessage[]) => Promise<string>;

const MAX_COMPACTION_SUMMARY_CHARS = 800;
const MIN_COMPACTION_SUMMARY_CHARS = 24;
const MIN_SUMMARY_KEYWORD_OVERLAP = 1;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "was",
  "were",
  "are",
  "you",
  "your",
  "our",
  "but",
  "not",
  "can",
  "will",
  "into",
  "about",
  "after",
  "before",
  "they",
  "them",
  "their",
  "has",
  "had",
  "did",
  "done",
]);

function normalizeSummaryText(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_COMPACTION_SUMMARY_CHARS) return compact;
  if (MAX_COMPACTION_SUMMARY_CHARS <= 3) {
    return compact.slice(0, Math.max(0, MAX_COMPACTION_SUMMARY_CHARS));
  }
  return (
    compact.slice(0, MAX_COMPACTION_SUMMARY_CHARS - 3) +
    "..."
  );
}

function keywordSet(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const filtered = tokens.filter((token) => !STOPWORDS.has(token));
  return new Set(filtered);
}

function hasUsefulSummaryOverlap(
  summary: string,
  sourceMessages: readonly LLMMessage[],
): boolean {
  const summaryKeywords = keywordSet(summary);
  if (summary.length < MIN_COMPACTION_SUMMARY_CHARS) return false;
  if (summaryKeywords.size === 0) return false;

  const sourceText = sourceMessages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" "),
    )
    .join(" ");
  const sourceKeywords = keywordSet(sourceText);
  if (sourceKeywords.size === 0) return true;

  let overlap = 0;
  for (const token of summaryKeywords) {
    if (sourceKeywords.has(token)) {
      overlap += 1;
      if (overlap >= MIN_SUMMARY_KEYWORD_OVERLAP) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session ID derivation
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Derive a deterministic session ID from lookup params and scope.
 */
export function deriveSessionId(
  params: SessionLookupParams,
  scope: SessionScope,
): string {
  const workspacePrefix = `${params.workspaceId}\x00`;
  switch (scope) {
    case "main":
      return `session:${sha256hex(workspacePrefix + "main")}`;
    case "per-peer":
      return `session:${sha256hex(workspacePrefix + params.senderId)}`;
    case "per-channel-peer":
      return `session:${sha256hex(
        workspacePrefix + params.channel + "\x00" + params.senderId,
      )}`;
    case "per-account-channel-peer":
      return `session:${sha256hex(
        workspacePrefix +
          params.channel +
          "\x00" +
          params.senderId +
          "\x00" +
          (params.guildId ?? "") +
          "\x00" +
          (params.threadId ?? ""),
      )}`;
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_DAILY_HOUR = 4;
const DEFAULT_IDLE_MINUTES = 120;

interface SessionManagerOptions {
  summarizer?: Summarizer;
  compactionHook?: SessionCompactionHook;
}

export class SessionManager {
  private readonly config: SessionConfig;
  private readonly sessions = new Map<string, Session>();
  private readonly lookups = new Map<string, SessionLookupParams>();
  private readonly summarizer?: Summarizer;
  private readonly compactionHook?: SessionCompactionHook;

  constructor(config: SessionConfig, options?: SessionManagerOptions) {
    this.config = config;
    this.summarizer = options?.summarizer;
    this.compactionHook = options?.compactionHook;
  }

  /** Number of active sessions. */
  get count(): number {
    return this.sessions.size;
  }

  /**
   * Return an existing session or create a new one for the given params.
   */
  getOrCreate(params: SessionLookupParams): Session {
    const effective = this.resolveConfig(params);
    const id = deriveSessionId(params, effective.scope);

    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const session: Session = {
      id,
      workspaceId: params.workspaceId,
      history: [],
      createdAt: now,
      lastActiveAt: now,
      metadata: {},
    };

    this.sessions.set(id, session);
    this.lookups.set(id, params);
    return session;
  }

  /** Lookup a session by ID. */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Clear a session's history but preserve metadata. */
  reset(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.history = [];
    session.lastActiveAt = Date.now();
    return true;
  }

  /** Remove a session completely. */
  destroy(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    this.lookups.delete(sessionId);
    return existed;
  }

  /** Append a message and auto-compact if history exceeds maxHistoryLength. */
  appendMessage(sessionId: string, message: LLMMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.history.push(message);
    session.lastActiveAt = Date.now();

    const maxHistory =
      this.resolveConfigForId(sessionId).maxHistoryLength ??
      DEFAULT_MAX_HISTORY;

    if (session.history.length > maxHistory) {
      void this.compact(sessionId);
    }

    return true;
  }

  /**
   * Compact a session's history using the configured strategy.
   * Returns null if session not found.
   */
  async compact(sessionId: string): Promise<CompactionResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const strategy = this.resolveConfigForId(sessionId).compaction;
    const history = session.history;
    const historyLengthBefore = history.length;

    await this.emitCompactionHook({
      phase: "before",
      sessionId,
      strategy,
      historyLengthBefore,
    });

    try {
      let result: CompactionResult;

      if (history.length <= 1) {
        result = {
          messagesRemoved: 0,
          messagesRetained: history.length,
          summaryGenerated: false,
        };
      } else {
        const keepCount = Math.ceil(history.length / 2);
        const dropCount = history.length - keepCount;

        switch (strategy) {
          case "truncate": {
            session.history = history.slice(dropCount);
            result = {
              messagesRemoved: dropCount,
              messagesRetained: keepCount,
              summaryGenerated: false,
              summaryQuality: "not_applicable",
            };
            break;
          }

          case "sliding-window": {
            const toSummarize = history.slice(0, dropCount);
            let summaryText: string;
            let summaryGenerated = false;
            let summaryQuality: CompactionResult["summaryQuality"] =
              "not_applicable";

            if (this.summarizer) {
              summaryText = normalizeSummaryText(
                await this.summarizer(toSummarize),
              );
              if (hasUsefulSummaryOverlap(summaryText, toSummarize)) {
                summaryGenerated = true;
                summaryQuality = "accepted";
              } else {
                summaryText = `[Compacted: ${dropCount} earlier messages removed]`;
                summaryQuality = "rejected";
              }
            } else {
              summaryText = `[Compacted: ${dropCount} earlier messages removed]`;
            }

            const summaryMsg: LLMMessage = {
              role: "system",
              content: summaryText,
            };
            session.history = [summaryMsg, ...history.slice(dropCount)];
            result = {
              messagesRemoved: dropCount,
              messagesRetained: keepCount + 1,
              summaryGenerated,
              summaryQuality,
              summaryChars: summaryText.length,
            };
            break;
          }

          case "summarize": {
            if (!this.summarizer) {
              // Fall back to truncate
              session.history = history.slice(dropCount);
              result = {
                messagesRemoved: dropCount,
                messagesRetained: keepCount,
                summaryGenerated: false,
                summaryQuality: "not_applicable",
              };
              break;
            }

            const toSummarize = history.slice(0, dropCount);
            const summary = normalizeSummaryText(
              await this.summarizer(toSummarize),
            );
            if (!hasUsefulSummaryOverlap(summary, toSummarize)) {
              session.history = history.slice(dropCount);
              result = {
                messagesRemoved: dropCount,
                messagesRetained: keepCount,
                summaryGenerated: false,
                summaryQuality: "rejected",
              };
            } else {
              const summaryMsg: LLMMessage = { role: "system", content: summary };
              session.history = [summaryMsg, ...history.slice(dropCount)];
              result = {
                messagesRemoved: dropCount,
                messagesRetained: keepCount + 1,
                summaryGenerated: true,
                summaryQuality: "accepted",
                summaryChars: summary.length,
              };
            }
            break;
          }
        }
      }

      await this.emitCompactionHook({
        phase: "after",
        sessionId,
        strategy,
        historyLengthBefore,
        historyLengthAfter: session.history.length,
        result,
      });

      return result;
    } catch (error) {
      await this.emitCompactionHook({
        phase: "error",
        sessionId,
        strategy,
        historyLengthBefore,
        historyLengthAfter: session.history.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check all sessions for reset conditions. Returns IDs of sessions that were reset.
   */
  checkResets(): string[] {
    const resetIds: string[] = [];
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      const effective = this.resolveConfigForId(id);
      const resetCfg = effective.reset ?? this.config.reset;

      switch (resetCfg.mode) {
        case "never":
          break;

        case "idle": {
          const idleMs =
            (resetCfg.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
          if (now - session.lastActiveAt >= idleMs) {
            session.history = [];
            session.lastActiveAt = now;
            resetIds.push(id);
          }
          break;
        }

        case "daily": {
          const hour = resetCfg.dailyHour ?? DEFAULT_DAILY_HOUR;
          const todayReset = new Date();
          todayReset.setHours(hour, 0, 0, 0);
          const resetEpoch = todayReset.getTime();

          // Reset if session's last activity was before today's reset time
          // and we are now past the reset time
          if (session.lastActiveAt < resetEpoch && now >= resetEpoch) {
            session.history = [];
            session.lastActiveAt = now;
            resetIds.push(id);
          }
          break;
        }

        case "weekday": {
          const lastDate = new Date(session.lastActiveAt);
          const nowDate = new Date(now);
          // Different calendar day AND different weekday (Mon=1..Sun=0)
          const lastDay = lastDate.getDay();
          const nowDay = nowDate.getDay();
          const lastDateStr = lastDate.toDateString();
          const nowDateStr = nowDate.toDateString();

          if (lastDateStr !== nowDateStr && lastDay !== nowDay) {
            session.history = [];
            session.lastActiveAt = now;
            resetIds.push(id);
          }
          break;
        }
      }
    }

    return resetIds;
  }

  /** Return info for all active sessions. */
  listActive(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const [id, session] of this.sessions) {
      const params = this.lookups.get(id);
      result.push({
        id,
        channel: params?.channel ?? "",
        senderId: params?.senderId ?? "",
        messageCount: session.history.length,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective SessionConfig for given lookup params
   * by merging base → channelOverrides → scope overrides.
   */
  private resolveConfig(params: SessionLookupParams): SessionConfig {
    let merged: SessionConfig = { ...this.config };

    // Channel overrides
    if (this.config.channelOverrides?.[params.channel]) {
      merged = mergeConfig(
        merged,
        this.config.channelOverrides[params.channel],
      );
    }

    // Scope overrides (dm/group/thread)
    const scopeOverride = merged.overrides?.[params.scope];
    if (scopeOverride) {
      merged = mergeConfig(merged, scopeOverride);
    }

    return merged;
  }

  /**
   * Resolve config for a session by its ID, using stored lookup params.
   * Falls back to base config if params not found.
   */
  private resolveConfigForId(sessionId: string): SessionConfig {
    const params = this.lookups.get(sessionId);
    if (!params) return this.config;
    return this.resolveConfig(params);
  }

  private async emitCompactionHook(
    payload: SessionCompactionHookPayload,
  ): Promise<void> {
    if (!this.compactionHook) return;
    await this.compactionHook(payload);
  }
}

// ---------------------------------------------------------------------------
// Config merge helper
// ---------------------------------------------------------------------------

function mergeConfig(
  base: SessionConfig,
  override: Partial<SessionConfig>,
): SessionConfig {
  return {
    scope: override.scope ?? base.scope,
    reset: override.reset ?? base.reset,
    compaction: override.compaction ?? base.compaction,
    maxHistoryLength: override.maxHistoryLength ?? base.maxHistoryLength,
    overrides: override.overrides ?? base.overrides,
    channelOverrides: override.channelOverrides ?? base.channelOverrides,
  };
}
