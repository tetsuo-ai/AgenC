/**
 * Memory store type definitions for @agenc/runtime
 */

import type { PublicKey } from '@solana/web3.js';
import type { Message } from './llm';
import type { OnChainTask, TaskResult, TaskHistoryEntry } from './task';

/**
 * Memory store interface
 */
export interface MemoryStore {
  // === Conversation ===

  /**
   * Add a message to conversation history
   */
  addMessage(message: Message): Promise<void>;

  /**
   * Get recent messages
   */
  getMessages(limit?: number): Promise<Message[]>;

  /**
   * Summarize the conversation history
   */
  summarize(): Promise<string>;

  /**
   * Clear conversation history
   */
  clearConversation(): Promise<void>;

  // === Task Context ===

  /**
   * Set the current task being worked on
   */
  setCurrentTask(task: OnChainTask | null): Promise<void>;

  /**
   * Get the current task
   */
  getCurrentTask(): Promise<OnChainTask | null>;

  /**
   * Add a completed task to history
   */
  addTaskResult(taskId: Buffer, taskAddress: PublicKey, result: TaskResult, txSignature: string, rewardReceived: bigint): Promise<void>;

  /**
   * Get task history
   */
  getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;

  /**
   * Get a specific task result
   */
  getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;

  // === Key-Value Store ===

  /**
   * Set a value in namespaced storage
   */
  set(namespace: string, key: string, value: unknown): Promise<void>;

  /**
   * Get a value from namespaced storage
   */
  get<T>(namespace: string, key: string): Promise<T | null>;

  /**
   * Delete a value from namespaced storage
   */
  delete(namespace: string, key: string): Promise<void>;

  /**
   * List all keys in a namespace
   */
  keys(namespace: string): Promise<string[]>;

  // === Persistence ===

  /**
   * Save state to persistent storage
   */
  save(): Promise<void>;

  /**
   * Load state from persistent storage
   */
  load(): Promise<void>;

  /**
   * Clear all data
   */
  clear(): Promise<void>;
}

/**
 * Memory backend interface (for pluggable storage)
 */
export interface MemoryBackend {
  // Conversation
  addMessage(message: Message): Promise<void>;
  getMessages(limit?: number): Promise<Message[]>;
  clearConversation(): Promise<void>;

  // Task context
  setCurrentTask(task: OnChainTask | null): Promise<void>;
  getCurrentTask(): Promise<OnChainTask | null>;
  addTaskResult(entry: TaskHistoryEntry): Promise<void>;
  getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
  getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;

  // Key-value
  set(namespace: string, key: string, value: unknown): Promise<void>;
  get<T>(namespace: string, key: string): Promise<T | null>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;

  // Persistence
  save(): Promise<void>;
  load(): Promise<void>;
  clear(): Promise<void>;
}

/**
 * In-memory backend configuration
 */
export interface InMemoryBackendConfig {
  /** Maximum messages to keep */
  maxMessages?: number;
  /** Maximum task history entries */
  maxTaskHistory?: number;
}

/**
 * SQLite backend configuration
 */
export interface SqliteBackendConfig {
  /** Database file path */
  path: string;
  /** Maximum messages to keep */
  maxMessages?: number;
  /** Maximum task history entries */
  maxTaskHistory?: number;
}

/**
 * Redis backend configuration
 */
export interface RedisBackendConfig {
  /** Redis URL */
  url: string;
  /** Key prefix */
  prefix?: string;
  /** Maximum messages to keep */
  maxMessages?: number;
  /** Maximum task history entries */
  maxTaskHistory?: number;
  /** TTL for conversation messages in seconds */
  conversationTtl?: number;
}

/**
 * Memory statistics
 */
export interface MemoryStats {
  /** Number of messages in conversation */
  messageCount: number;
  /** Estimated token count */
  tokenCount: number;
  /** Number of task history entries */
  taskHistoryCount: number;
  /** Total size in bytes (approximate) */
  sizeBytes: number;
}
