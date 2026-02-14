/**
 * Redis backend for conversation and key-value storage.
 *
 * Uses `ioredis` loaded lazily on first use (optional dependency).
 * Threads stored as sorted sets (score=timestamp), KV as regular keys.
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
} from '../types.js';
import type { RedisBackendConfig } from './types.js';
import { MemoryBackendError, MemoryConnectionError, MemorySerializationError } from '../errors.js';
import { ensureLazyBackend } from '../lazy-import.js';
import type { MetricsProvider } from '../../task/types.js';
import { TELEMETRY_METRIC_NAMES } from '../../telemetry/metric-names.js';

export class RedisBackend implements MemoryBackend {
  readonly name = 'redis';

  private client: any = null;
  private readonly config: RedisBackendConfig;
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;
  private readonly prefix: string;
  private readonly metrics?: MetricsProvider;
  private closed = false;

  constructor(config: RedisBackendConfig = {}) {
    this.config = config;
    this.logger = config.logger ?? silentLogger;
    this.defaultTtlMs = config.defaultTtlMs ?? 0;
    this.prefix = config.keyPrefix ?? 'agenc:memory:';
    this.metrics = config.metrics;
  }

  // ---------- Key Helpers ----------

  private threadKey(sessionId: string): string {
    return `${this.prefix}thread:${sessionId}`;
  }

  private kvKey(key: string): string {
    return `${this.prefix}kv:${key}`;
  }

  private get sessionsKey(): string {
    return `${this.prefix}sessions`;
  }

  // ---------- Thread Operations ----------

  async addEntry(options: AddEntryOptions): Promise<MemoryEntry> {
    const client = await this.ensureClient();
    const start = Date.now();
    const now = Date.now();
    const id = randomUUID();
    const ttl = options.ttlMs ?? this.defaultTtlMs;

    const entry: MemoryEntry = {
      id,
      sessionId: options.sessionId,
      role: options.role,
      content: options.content,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      timestamp: now,
      taskPda: options.taskPda,
      metadata: options.metadata,
    };

    let json: string;
    try {
      json = JSON.stringify(entry);
    } catch (err) {
      throw new MemorySerializationError(this.name, `Failed to serialize entry: ${(err as Error).message}`);
    }

    const key = this.threadKey(options.sessionId);

    // ZADD with score=timestamp, member=JSON (UUID ensures uniqueness)
    await client.zadd(key, now, json);
    // Track session
    await client.sadd(this.sessionsKey, options.sessionId);

    // Set TTL on the sorted set key if configured
    if (ttl > 0) {
      await client.pexpire(key, ttl);
    }

    this.logger.debug(`Added entry ${id} to session ${options.sessionId}`);
    this.recordMemoryMetrics('addEntry', Date.now() - start);
    return entry;
  }

  async getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]> {
    const client = await this.ensureClient();
    const start = Date.now();
    const key = this.threadKey(sessionId);

    let members: string[];
    if (limit !== undefined && limit > 0) {
      // Get the most recent `limit` entries, then reverse to chronological
      members = await client.zrevrangebyscore(key, '+inf', '-inf', 'LIMIT', 0, limit);
      members.reverse();
    } else {
      members = await client.zrangebyscore(key, '-inf', '+inf');
    }

    const result = members.map((m: string) => this.parseEntry(m)).filter(Boolean) as MemoryEntry[];
    this.recordMemoryMetrics('getThread', Date.now() - start);
    return result;
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const client = await this.ensureClient();
    const start = Date.now();
    const minScore = query.after !== undefined ? `(${query.after}` : '-inf';
    const maxScore = query.before !== undefined ? `(${query.before}` : '+inf';

    let allEntries: MemoryEntry[] = [];

    if (query.sessionId) {
      const key = this.threadKey(query.sessionId);
      const members = await client.zrangebyscore(key, minScore, maxScore);
      allEntries = members.map((m: string) => this.parseEntry(m)).filter(Boolean) as MemoryEntry[];
    } else {
      // Scan all sessions
      const sessions = await client.smembers(this.sessionsKey);
      for (const sessionId of sessions) {
        const key = this.threadKey(sessionId);
        const members = await client.zrangebyscore(key, minScore, maxScore);
        const entries = members.map((m: string) => this.parseEntry(m)).filter(Boolean) as MemoryEntry[];
        allEntries.push(...entries);
      }
    }

    // Apply remaining filters
    let results = allEntries.filter((e) => {
      if (query.taskPda && e.taskPda !== query.taskPda) return false;
      if (query.role && e.role !== query.role) return false;
      return true;
    });

    // Sort
    const order = query.order ?? 'asc';
    results.sort((a, b) =>
      order === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
    );

    // Limit
    if (query.limit !== undefined && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    this.recordMemoryMetrics('query', Date.now() - start);
    return results;
  }

  async deleteThread(sessionId: string): Promise<number> {
    const client = await this.ensureClient();
    const key = this.threadKey(sessionId);

    const count = await client.zcard(key);
    if (count > 0) {
      await client.del(key);
      await client.srem(this.sessionsKey, sessionId);
    }

    this.logger.debug(`Deleted thread ${sessionId} (${count} entries)`);
    return count;
  }

  async listSessions(prefix?: string): Promise<string[]> {
    const client = await this.ensureClient();
    const sessions: string[] = await client.smembers(this.sessionsKey);

    if (!prefix) return sessions;
    return sessions.filter((s: string) => s.startsWith(prefix));
  }

  // ---------- Key-Value Operations ----------

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const client = await this.ensureClient();
    const redisKey = this.kvKey(key);
    const ttl = ttlMs ?? this.defaultTtlMs;

    let json: string;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      throw new MemorySerializationError(this.name, `Failed to serialize value: ${(err as Error).message}`);
    }

    if (ttl > 0) {
      await client.set(redisKey, json, 'PX', ttl);
    } else {
      await client.set(redisKey, json);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const client = await this.ensureClient();
    const redisKey = this.kvKey(key);
    const value = await client.get(redisKey);

    if (value === null) return undefined;

    try {
      return JSON.parse(value) as T;
    } catch (err) {
      throw new MemorySerializationError(this.name, `Failed to deserialize value for key "${key}": ${(err as Error).message}`);
    }
  }

  async delete(key: string): Promise<boolean> {
    const client = await this.ensureClient();
    const redisKey = this.kvKey(key);
    const count = await client.del(redisKey);
    return count > 0;
  }

  async has(key: string): Promise<boolean> {
    const client = await this.ensureClient();
    const redisKey = this.kvKey(key);
    const exists = await client.exists(redisKey);
    return exists > 0;
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const client = await this.ensureClient();
    const pattern = prefix
      ? `${this.prefix}kv:${prefix}*`
      : `${this.prefix}kv:*`;

    const keys: string[] = await client.keys(pattern);
    const kvPrefixLen = `${this.prefix}kv:`.length;
    return keys.map((k: string) => k.slice(kvPrefixLen));
  }

  // ---------- Lifecycle ----------

  async clear(): Promise<void> {
    const client = await this.ensureClient();

    // Delete all thread keys
    const sessions: string[] = await client.smembers(this.sessionsKey);
    for (const sessionId of sessions) {
      await client.del(this.threadKey(sessionId));
    }
    await client.del(this.sessionsKey);

    // Delete all KV keys
    const kvKeys: string[] = await client.keys(`${this.prefix}kv:*`);
    if (kvKeys.length > 0) {
      await client.del(...kvKeys);
    }

    this.logger.debug('Cleared all memory');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    this.logger.debug('Redis backend closed');
  }

  async healthCheck(): Promise<boolean> {
    if (this.closed || !this.client) return false;
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  getDurability(): import('../types.js').DurabilityInfo {
    return {
      level: 'async',
      supportsFlush: true,
      description: 'Data is persisted asynchronously via Redis AOF/RDB. flush() triggers BGSAVE.',
    };
  }

  async flush(): Promise<void> {
    const client = await this.ensureClient();
    await (client as any).call('BGSAVE');
  }

  // ---------- Internals ----------

  private recordMemoryMetrics(operation: string, durationMs: number): void {
    if (!this.metrics) return;
    const labels = { operation, backend: 'redis' };
    this.metrics.counter(TELEMETRY_METRIC_NAMES.MEMORY_OPS_TOTAL, 1, labels);
    this.metrics.histogram(TELEMETRY_METRIC_NAMES.MEMORY_OP_DURATION, durationMs, labels);
  }

  private async ensureClient(): Promise<any> {
    if (this.closed) {
      throw new MemoryBackendError(this.name, 'Backend is closed');
    }
    if (this.client) return this.client;

    const Redis = await ensureLazyBackend('ioredis', this.name, (mod) => {
      return (mod.default ?? mod) as any;
    });

    const opts: Record<string, unknown> = {
      lazyConnect: true,
      maxRetriesPerRequest: this.config.maxReconnectAttempts ?? 3,
    };

    if (this.config.password) opts.password = this.config.password;
    if (this.config.db !== undefined) opts.db = this.config.db;
    if (this.config.connectTimeoutMs) opts.connectTimeout = this.config.connectTimeoutMs;

    if (this.config.url) {
      this.client = new Redis(this.config.url, opts);
    } else {
      this.client = new Redis({
        host: this.config.host ?? 'localhost',
        port: this.config.port ?? 6379,
        ...opts,
      });
    }

    try {
      await this.client.connect();
    } catch (err) {
      this.client = null;
      throw new MemoryConnectionError(this.name, `Failed to connect: ${(err as Error).message}`);
    }

    return this.client;
  }

  private parseEntry(json: string): MemoryEntry | null {
    try {
      return JSON.parse(json) as MemoryEntry;
    } catch {
      this.logger.warn(`Failed to parse entry: ${json.slice(0, 100)}`);
      return null;
    }
  }
}
