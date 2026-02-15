/**
 * Session management — scoping, reset, and compaction.
 *
 * Sessions are the unit of conversation state between a user and the agent.
 * Handles session creation, resumption, expiry, scoping rules, automatic
 * reset policies, and conversation compaction.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { LLMMessage } from '../llm/types.js';

// ============================================================================
// Types
// ============================================================================

/** Session scoping strategy. */
export type SessionScope =
  | 'main'
  | 'per-peer'
  | 'per-channel-peer'
  | 'per-account-channel-peer';

/** Session reset mode. */
export type SessionResetMode = 'never' | 'daily' | 'idle' | 'weekday';

/** Compaction strategy for long conversations. */
export type CompactionStrategy = 'summarize' | 'truncate' | 'sliding-window';

/** Session reset configuration. */
export interface SessionResetConfig {
  readonly mode: SessionResetMode;
  /** For 'daily': hour to reset (0-23, default: 4). */
  readonly dailyHour?: number;
  /** For 'idle': minutes of inactivity before reset (default: 120). */
  readonly idleMinutes?: number;
}

/** Session configuration. */
export interface SessionConfig {
  /** How sessions are scoped. */
  readonly scope: SessionScope;
  /** When sessions auto-reset. */
  readonly reset: SessionResetConfig;
  /** Per-scope overrides. */
  readonly overrides?: {
    readonly dm?: Partial<SessionConfig>;
    readonly group?: Partial<SessionConfig>;
    readonly thread?: Partial<SessionConfig>;
  };
  /** Per-channel overrides. */
  readonly channelOverrides?: Readonly<Record<string, Partial<SessionConfig>>>;
  /** Max conversation history before compaction (default: 100). */
  readonly maxHistoryLength?: number;
  /** Compaction strategy. */
  readonly compaction: CompactionStrategy;
}

/** A conversation session. */
export interface Session {
  /** Unique session ID. */
  readonly id: string;
  /** Resolved workspace ID for this session. */
  readonly workspaceId: string;
  /** Conversation history (compacted as needed). */
  history: LLMMessage[];
  /** Session creation timestamp (ms). */
  readonly createdAt: number;
  /** Last activity timestamp (ms). */
  lastActiveAt: number;
  /** Session metadata. */
  metadata: Record<string, unknown>;
}

/** Parameters for session lookup. */
export interface SessionLookupParams {
  readonly channel: string;
  readonly senderId: string;
  readonly scope: 'dm' | 'group' | 'thread';
  readonly workspaceId: string;
  readonly guildId?: string;
  readonly threadId?: string;
}

/** Result of a compaction operation. */
export interface CompactionResult {
  readonly messagesRemoved: number;
  readonly messagesRetained: number;
  readonly summaryGenerated: boolean;
}

/** Summary info about a session. */
export interface SessionInfo {
  readonly id: string;
  readonly channel: string;
  readonly senderId: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

/** Callback for summarize compaction — produces a summary of messages. */
export type SummarizeCallback = (messages: LLMMessage[]) => Promise<string>;

// ============================================================================
// Session ID Derivation
// ============================================================================

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Derive a session ID from scope parameters. */
export function deriveSessionId(
  params: SessionLookupParams,
  scope: SessionScope,
): string {
  switch (scope) {
    case 'main':
      return `session:main:${params.workspaceId}`;
    case 'per-peer':
      return `session:peer:${hashString(params.senderId)}`;
    case 'per-channel-peer':
      return `session:cp:${hashString(params.channel + ':' + params.senderId)}`;
    case 'per-account-channel-peer':
      return `session:acp:${hashString(params.workspaceId + ':' + params.channel + ':' + params.senderId)}`;
  }
}

// ============================================================================
// Config Resolution
// ============================================================================

function resolveConfig(
  base: SessionConfig,
  params: SessionLookupParams,
): SessionConfig {
  // Channel override takes precedence
  const channelOverride = base.channelOverrides?.[params.channel];
  if (channelOverride) {
    base = { ...base, ...channelOverride } as SessionConfig;
  }

  // Scope override
  const scopeOverride = base.overrides?.[params.scope];
  if (scopeOverride) {
    base = { ...base, ...scopeOverride } as SessionConfig;
  }

  return base;
}

// ============================================================================
// SessionManager
// ============================================================================

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_IDLE_MINUTES = 120;
const DEFAULT_DAILY_HOUR = 4;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionMeta = new Map<
    string,
    { channel: string; senderId: string }
  >();
  private readonly config: SessionConfig;
  private readonly summarizer?: SummarizeCallback;

  constructor(config: SessionConfig, summarizer?: SummarizeCallback) {
    this.config = config;
    this.summarizer = summarizer;
  }

  /** Get or create a session for the given scope parameters. */
  async getOrCreate(params: SessionLookupParams): Promise<Session> {
    const resolved = resolveConfig(this.config, params);
    const id = deriveSessionId(params, resolved.scope);

    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const session: Session = {
      id,
      workspaceId: params.workspaceId,
      history: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
    };

    this.sessions.set(id, session);
    this.sessionMeta.set(id, {
      channel: params.channel,
      senderId: params.senderId,
    });

    return session;
  }

  /** Get an existing session by ID. */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Reset a session (clear history, keep metadata). */
  reset(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.history = [];
      session.lastActiveAt = Date.now();
    }
  }

  /** Destroy a session completely. */
  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionMeta.delete(sessionId);
  }

  /** Append a message to session history, triggering compaction if needed. */
  async appendMessage(sessionId: string, message: LLMMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.history.push(message);
    session.lastActiveAt = Date.now();

    const maxHistory = this.config.maxHistoryLength ?? DEFAULT_MAX_HISTORY;
    if (session.history.length > maxHistory) {
      await this.compact(sessionId);
    }
  }

  /** Force compaction on a session. */
  async compact(sessionId: string): Promise<CompactionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { messagesRemoved: 0, messagesRetained: 0, summaryGenerated: false };
    }

    const maxHistory = this.config.maxHistoryLength ?? DEFAULT_MAX_HISTORY;
    const strategy = this.config.compaction;

    switch (strategy) {
      case 'truncate':
        return this.compactTruncate(session, maxHistory);
      case 'sliding-window':
        return this.compactSlidingWindow(session, maxHistory);
      case 'summarize':
        return this.compactSummarize(session, maxHistory);
    }
  }

  private compactTruncate(
    session: Session,
    maxHistory: number,
  ): CompactionResult {
    if (session.history.length <= maxHistory) {
      return {
        messagesRemoved: 0,
        messagesRetained: session.history.length,
        summaryGenerated: false,
      };
    }

    const toRemove = session.history.length - maxHistory;
    session.history = session.history.slice(toRemove);

    return {
      messagesRemoved: toRemove,
      messagesRetained: session.history.length,
      summaryGenerated: false,
    };
  }

  private compactSlidingWindow(
    session: Session,
    maxHistory: number,
  ): CompactionResult {
    if (session.history.length <= maxHistory) {
      return {
        messagesRemoved: 0,
        messagesRetained: session.history.length,
        summaryGenerated: false,
      };
    }

    const toRemove = session.history.length - maxHistory;
    const removed = session.history.slice(0, toRemove);

    const summaryMsg: LLMMessage = {
      role: 'system',
      content: `[Compacted: ${removed.length} earlier messages removed]`,
    };

    session.history = [summaryMsg, ...session.history.slice(toRemove)];

    return {
      messagesRemoved: toRemove,
      messagesRetained: session.history.length,
      summaryGenerated: true,
    };
  }

  private async compactSummarize(
    session: Session,
    maxHistory: number,
  ): Promise<CompactionResult> {
    if (session.history.length <= maxHistory) {
      return {
        messagesRemoved: 0,
        messagesRetained: session.history.length,
        summaryGenerated: false,
      };
    }

    const toRemove = session.history.length - maxHistory;
    const removed = session.history.slice(0, toRemove);

    let summaryContent: string;
    if (this.summarizer) {
      summaryContent = await this.summarizer(removed);
    } else {
      summaryContent = `[Summary of ${removed.length} earlier messages]`;
    }

    const summaryMsg: LLMMessage = {
      role: 'system',
      content: summaryContent,
    };

    session.history = [summaryMsg, ...session.history.slice(toRemove)];

    return {
      messagesRemoved: toRemove,
      messagesRetained: session.history.length,
      summaryGenerated: true,
    };
  }

  /** Check all sessions for reset conditions. Returns IDs of reset sessions. */
  checkResets(): string[] {
    const now = Date.now();
    const resetIds: string[] = [];

    for (const [id, session] of this.sessions) {
      if (this.shouldReset(session, now)) {
        session.history = [];
        session.lastActiveAt = now;
        resetIds.push(id);
      }
    }

    return resetIds;
  }

  private shouldReset(session: Session, now: number): boolean {
    const resetConfig = this.config.reset;

    switch (resetConfig.mode) {
      case 'never':
        return false;

      case 'idle': {
        const idleMs =
          (resetConfig.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60 * 1000;
        return now - session.lastActiveAt > idleMs;
      }

      case 'daily': {
        const hour = resetConfig.dailyHour ?? DEFAULT_DAILY_HOUR;
        const nowDate = new Date(now);

        // Reset if lastActive was before today's reset hour and now is after it
        const todayResetTime = new Date(nowDate);
        todayResetTime.setHours(hour, 0, 0, 0);

        return (
          session.lastActiveAt < todayResetTime.getTime() &&
          now >= todayResetTime.getTime()
        );
      }

      case 'weekday': {
        const hour = resetConfig.dailyHour ?? DEFAULT_DAILY_HOUR;
        const nowDate = new Date(now);
        const day = nowDate.getDay();
        // Only reset Mon-Fri (1-5)
        if (day === 0 || day === 6) return false;

        const todayResetTime = new Date(nowDate);
        todayResetTime.setHours(hour, 0, 0, 0);

        return (
          session.lastActiveAt < todayResetTime.getTime() &&
          now >= todayResetTime.getTime()
        );
      }
    }
  }

  /** List active sessions. */
  listActive(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const [id, session] of this.sessions) {
      const meta = this.sessionMeta.get(id);
      result.push({
        id,
        channel: meta?.channel ?? 'unknown',
        senderId: meta?.senderId ?? 'unknown',
        messageCount: session.history.length,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      });
    }
    return result;
  }

  /** Get session count. */
  get count(): number {
    return this.sessions.size;
  }
}
