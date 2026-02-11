/**
 * Memory backend types for @agenc/runtime
 *
 * Defines the core interface for pluggable memory storage backends
 * that manage conversation history, task context, and key-value state.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import type { LLMMessage } from '../llm/types.js';
import type { MetricsProvider } from '../task/types.js';

/**
 * Message role in a memory entry
 */
export type MemoryRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A stored memory entry representing a single message in a conversation thread
 */
export interface MemoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MemoryRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly timestamp: number;
  readonly taskPda?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Query parameters for filtering memory entries
 */
export interface MemoryQuery {
  sessionId?: string;
  taskPda?: string;
  after?: number;
  before?: number;
  role?: MemoryRole;
  limit?: number;
  /** Sort order by timestamp. Default: 'asc' */
  order?: 'asc' | 'desc';
}

/**
 * Options for adding a new memory entry
 */
export interface AddEntryOptions {
  sessionId: string;
  role: MemoryRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  taskPda?: string;
  metadata?: Record<string, unknown>;
  /** Time-to-live in milliseconds. 0 or undefined = no expiry */
  ttlMs?: number;
}

/**
 * Core memory backend interface that all storage implementations provide
 */
export interface MemoryBackend {
  readonly name: string;

  // Thread operations
  addEntry(options: AddEntryOptions): Promise<MemoryEntry>;
  getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]>;
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  deleteThread(sessionId: string): Promise<number>;
  listSessions(prefix?: string): Promise<string[]>;

  // Key-value operations
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Returns the stored value or undefined. Performs an unchecked cast to T. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<string[]>;

  // Lifecycle
  clear(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

/**
 * Shared configuration for all memory backends
 */
export interface MemoryBackendConfig {
  logger?: Logger;
  /** Default TTL in milliseconds. 0 = no expiry */
  defaultTtlMs?: number;
  /** Optional metrics provider for instrumentation */
  metrics?: MetricsProvider;
}

// ============================================================================
// LLM Interop Helpers
// ============================================================================

/**
 * Convert a MemoryEntry to an LLMMessage for use with LLM providers
 */
export function entryToMessage(entry: MemoryEntry): LLMMessage {
  const msg: LLMMessage = {
    role: entry.role,
    content: entry.content,
  };
  if (entry.toolCallId) msg.toolCallId = entry.toolCallId;
  if (entry.toolName) msg.toolName = entry.toolName;
  return msg;
}

/**
 * Convert an LLMMessage to AddEntryOptions (caller provides sessionId)
 */
export function messageToEntryOptions(
  msg: LLMMessage,
  sessionId: string,
): Omit<AddEntryOptions, 'taskPda' | 'metadata' | 'ttlMs'> {
  const opts: Omit<AddEntryOptions, 'taskPda' | 'metadata' | 'ttlMs'> = {
    sessionId,
    role: msg.role,
    content: msg.content,
  };
  if (msg.toolCallId) (opts as AddEntryOptions).toolCallId = msg.toolCallId;
  if (msg.toolName) (opts as AddEntryOptions).toolName = msg.toolName;
  return opts;
}
