/**
 * In-memory backend for conversation and key-value storage.
 *
 * Zero external dependencies — uses Map-based storage with lazy TTL expiry.
 * Suitable for development, testing, and short-lived agent sessions.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../utils/logger.js';
import { silentLogger } from '../../utils/logger.js';
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryQuery,
  AddEntryOptions,
  MemoryBackendConfig,
} from '../types.js';
import { MemoryBackendError } from '../errors.js';

/**
 * Configuration for the in-memory backend
 */
export interface InMemoryBackendConfig extends MemoryBackendConfig {
  /** Maximum entries per session before oldest are evicted. Default: 1000 */
  maxEntriesPerSession?: number;
  /** Maximum total entries across all sessions. Default: 100_000 */
  maxTotalEntries?: number;
}

interface KVEntry {
  value: unknown;
  expiresAt?: number;
}

export class InMemoryBackend implements MemoryBackend {
  readonly name = 'in-memory';

  private readonly threads = new Map<string, MemoryEntry[]>();
  private readonly kv = new Map<string, KVEntry>();
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;
  private readonly maxEntriesPerSession: number;
  private readonly maxTotalEntries: number;
  private totalEntries = 0;
  private closed = false;

  constructor(config: InMemoryBackendConfig = {}) {
    this.logger = config.logger ?? silentLogger;
    this.defaultTtlMs = config.defaultTtlMs ?? 0;
    this.maxEntriesPerSession = config.maxEntriesPerSession ?? 1000;
    this.maxTotalEntries = config.maxTotalEntries ?? 100_000;
  }

  async addEntry(options: AddEntryOptions): Promise<MemoryEntry> {
    this.ensureOpen();

    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const now = Date.now();

    const entry: MemoryEntry = {
      id: randomUUID(),
      sessionId: options.sessionId,
      role: options.role,
      content: options.content,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      timestamp: now,
      taskPda: options.taskPda,
      metadata: options.metadata,
    };

    // Store with optional expiry marker in metadata (for lazy filtering)
    const stored: MemoryEntry & { _expiresAt?: number } = { ...entry };
    if (ttl > 0) {
      (stored as any)._expiresAt = now + ttl;
    }

    let thread = this.threads.get(options.sessionId);
    if (!thread) {
      thread = [];
      this.threads.set(options.sessionId, thread);
    }

    // Evict oldest entries if session is at capacity
    while (thread.length >= this.maxEntriesPerSession) {
      thread.shift();
      this.totalEntries--;
    }

    // Evict globally if at total capacity (remove oldest from largest thread)
    if (this.totalEntries >= this.maxTotalEntries) {
      this.evictOldest();
    }

    thread.push(stored);
    this.totalEntries++;

    this.logger.debug(`Added entry ${entry.id} to session ${options.sessionId}`);
    return entry;
  }

  async getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]> {
    this.ensureOpen();
    const thread = this.threads.get(sessionId);
    if (!thread) return [];

    const now = Date.now();
    const alive = thread.filter((e) => !this.isExpired(e, now));

    if (limit !== undefined && limit > 0) {
      // Return the most recent `limit` entries
      return alive.slice(-limit).map((e) => this.stripInternal(e));
    }
    return alive.map((e) => this.stripInternal(e));
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    this.ensureOpen();
    const now = Date.now();
    let results: MemoryEntry[] = [];

    // Determine which threads to scan
    const threadsToScan: MemoryEntry[][] = [];
    if (query.sessionId) {
      const thread = this.threads.get(query.sessionId);
      if (thread) threadsToScan.push(thread);
    } else {
      for (const thread of this.threads.values()) {
        threadsToScan.push(thread);
      }
    }

    for (const thread of threadsToScan) {
      for (const entry of thread) {
        if (this.isExpired(entry, now)) continue;
        if (query.taskPda && entry.taskPda !== query.taskPda) continue;
        if (query.after !== undefined && entry.timestamp <= query.after) continue;
        if (query.before !== undefined && entry.timestamp >= query.before) continue;
        if (query.role && entry.role !== query.role) continue;
        results.push(this.stripInternal(entry));
      }
    }

    // Sort
    const order = query.order ?? 'asc';
    results.sort((a, b) =>
      order === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
    );

    // Limit
    if (query.limit !== undefined && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async deleteThread(sessionId: string): Promise<number> {
    this.ensureOpen();
    const thread = this.threads.get(sessionId);
    if (!thread) return 0;

    const count = thread.length;
    this.threads.delete(sessionId);
    this.totalEntries -= count;
    this.logger.debug(`Deleted thread ${sessionId} (${count} entries)`);
    return count;
  }

  async listSessions(prefix?: string): Promise<string[]> {
    this.ensureOpen();
    const sessions = Array.from(this.threads.keys());
    if (!prefix) return sessions;
    return sessions.filter((s) => s.startsWith(prefix));
  }

  // ---------- Key-Value Operations ----------

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.ensureOpen();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const entry: KVEntry = { value };
    if (ttl > 0) {
      entry.expiresAt = Date.now() + ttl;
    }
    this.kv.set(key, entry);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    this.ensureOpen();
    const entry = this.kv.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async delete(key: string): Promise<boolean> {
    this.ensureOpen();
    return this.kv.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.ensureOpen();
    const entry = this.kv.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.kv.delete(key);
      return false;
    }
    return true;
  }

  async listKeys(prefix?: string): Promise<string[]> {
    this.ensureOpen();
    const now = Date.now();
    const keys: string[] = [];
    for (const [key, entry] of this.kv) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.kv.delete(key);
        continue;
      }
      if (prefix && !key.startsWith(prefix)) continue;
      keys.push(key);
    }
    return keys;
  }

  // ---------- Lifecycle ----------

  async clear(): Promise<void> {
    this.ensureOpen();
    this.threads.clear();
    this.kv.clear();
    this.totalEntries = 0;
    this.logger.debug('Cleared all memory');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.threads.clear();
    this.kv.clear();
    this.totalEntries = 0;
    this.logger.debug('In-memory backend closed');
  }

  async healthCheck(): Promise<boolean> {
    return !this.closed;
  }

  // ---------- Internals ----------

  private ensureOpen(): void {
    if (this.closed) {
      throw new MemoryBackendError(this.name, 'Backend is closed');
    }
  }

  private isExpired(entry: MemoryEntry, now: number): boolean {
    const expiresAt = (entry as any)._expiresAt;
    return expiresAt !== undefined && expiresAt <= now;
  }

  private stripInternal(entry: MemoryEntry): MemoryEntry {
    // Remove internal _expiresAt field from returned entries
    if ('_expiresAt' in entry) {
      const { _expiresAt, ...clean } = entry as any;
      return clean as MemoryEntry;
    }
    return entry;
  }

  private evictOldest(): void {
    let oldestTime = Infinity;
    let oldestSession: string | null = null;

    for (const [sessionId, thread] of this.threads) {
      if (thread.length > 0 && thread[0].timestamp < oldestTime) {
        oldestTime = thread[0].timestamp;
        oldestSession = sessionId;
      }
    }

    if (oldestSession) {
      const thread = this.threads.get(oldestSession)!;
      thread.shift();
      this.totalEntries--;
      if (thread.length === 0) {
        this.threads.delete(oldestSession);
      }
    }
  }
}
