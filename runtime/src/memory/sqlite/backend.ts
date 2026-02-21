/**
 * SQLite backend for conversation and key-value storage.
 *
 * Uses `better-sqlite3` loaded lazily on first use (optional dependency).
 * Data persists across restarts when using a file-based path.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryQuery,
  AddEntryOptions,
} from "../types.js";
import type { SqliteBackendConfig } from "./types.js";
import {
  MemoryBackendError,
  MemoryEncryptionError,
  MemorySerializationError,
} from "../errors.js";
import { ensureLazyBackend } from "../lazy-import.js";
import type { MetricsProvider } from "../../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../../telemetry/metric-names.js";
import type { EncryptionProvider } from "../encryption.js";
import { createAES256GCMProvider } from "../encryption.js";

export class SqliteBackend implements MemoryBackend {
  readonly name = "sqlite";

  private db: any = null;
  private readonly config: Required<
    Pick<SqliteBackendConfig, "dbPath" | "walMode" | "cleanupOnConnect">
  > &
    SqliteBackendConfig;
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;
  private readonly metrics?: MetricsProvider;
  private readonly encryptor?: EncryptionProvider;
  private closed = false;

  constructor(config: SqliteBackendConfig = {}) {
    this.config = {
      ...config,
      dbPath: config.dbPath ?? ":memory:",
      walMode: config.walMode ?? true,
      cleanupOnConnect: config.cleanupOnConnect ?? true,
    };
    this.logger = config.logger ?? silentLogger;
    this.defaultTtlMs = config.defaultTtlMs ?? 0;
    this.metrics = config.metrics;
    if (config.encryption) {
      this.encryptor = createAES256GCMProvider(config.encryption);
    }
  }

  // ---------- Thread Operations ----------

  async addEntry(options: AddEntryOptions): Promise<MemoryEntry> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();
    const id = randomUUID();
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? now + ttl : null;

    let metadataJson: string | null = null;
    if (options.metadata) {
      try {
        metadataJson = JSON.stringify(options.metadata);
      } catch (err) {
        throw new MemorySerializationError(
          this.name,
          `Failed to serialize metadata: ${(err as Error).message}`,
        );
      }
    }

    const storedContent = this.encryptField(options.content);

    db.prepare(
      `INSERT INTO memory_entries (id, session_id, role, content, tool_call_id, tool_name, task_pda, metadata, timestamp, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      options.sessionId,
      options.role,
      storedContent,
      options.toolCallId ?? null,
      options.toolName ?? null,
      options.taskPda ?? null,
      metadataJson,
      now,
      expiresAt,
    );

    this.logger.debug(`Added entry ${id} to session ${options.sessionId}`);
    this.recordMemoryMetrics("addEntry", Date.now() - start);

    return {
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
  }

  async getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();

    let sql = `SELECT * FROM memory_entries
               WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY timestamp ASC`;
    const params: unknown[] = [sessionId, now];

    if (limit !== undefined && limit > 0) {
      // Get the most recent `limit` entries by using a subquery
      sql = `SELECT * FROM (
               SELECT * FROM memory_entries
               WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY timestamp DESC
               LIMIT ?
             ) sub ORDER BY timestamp ASC`;
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params);
    this.recordMemoryMetrics("getThread", Date.now() - start);
    return rows.map((row: any) => this.rowToEntry(row));
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const db = await this.ensureDb();
    const start = Date.now();
    const now = Date.now();
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [now];

    if (query.sessionId) {
      conditions.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.taskPda) {
      conditions.push("task_pda = ?");
      params.push(query.taskPda);
    }
    if (query.after !== undefined) {
      conditions.push("timestamp > ?");
      params.push(query.after);
    }
    if (query.before !== undefined) {
      conditions.push("timestamp < ?");
      params.push(query.before);
    }
    if (query.role) {
      conditions.push("role = ?");
      params.push(query.role);
    }

    const validOrders = { asc: "ASC", desc: "DESC" } as const;
    const direction = validOrders[query.order ?? "asc"] ?? "ASC";
    let sql = `SELECT * FROM memory_entries WHERE ${conditions.join(" AND ")} ORDER BY timestamp ${direction}`;

    if (query.limit !== undefined && query.limit > 0) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = db.prepare(sql).all(...params);
    this.recordMemoryMetrics("query", Date.now() - start);
    return rows.map((row: any) => this.rowToEntry(row));
  }

  async deleteThread(sessionId: string): Promise<number> {
    const db = await this.ensureDb();
    const result = db
      .prepare("DELETE FROM memory_entries WHERE session_id = ?")
      .run(sessionId);
    this.logger.debug(
      `Deleted thread ${sessionId} (${result.changes} entries)`,
    );
    return result.changes;
  }

  async listSessions(prefix?: string): Promise<string[]> {
    const db = await this.ensureDb();
    const now = Date.now();

    if (prefix) {
      const rows = db
        .prepare(
          `SELECT DISTINCT session_id FROM memory_entries
         WHERE (expires_at IS NULL OR expires_at > ?) AND session_id LIKE ?`,
        )
        .all(now, `${prefix}%`);
      return rows.map((r: any) => r.session_id);
    }

    const rows = db
      .prepare(
        "SELECT DISTINCT session_id FROM memory_entries WHERE (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now);
    return rows.map((r: any) => r.session_id);
  }

  // ---------- Key-Value Operations ----------

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const db = await this.ensureDb();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;

    let valueJson: string;
    try {
      valueJson = JSON.stringify(value);
    } catch (err) {
      throw new MemorySerializationError(
        this.name,
        `Failed to serialize value: ${(err as Error).message}`,
      );
    }

    const storedValue = this.encryptField(valueJson);

    db.prepare(
      `INSERT OR REPLACE INTO memory_kv (key, value, expires_at) VALUES (?, ?, ?)`,
    ).run(key, storedValue, expiresAt);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.ensureDb();
    const now = Date.now();
    const row = db
      .prepare(
        "SELECT value FROM memory_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(key, now);

    if (!row) return undefined;

    try {
      const rawValue = this.decryptField((row as any).value);
      return JSON.parse(rawValue) as T;
    } catch (err) {
      if (err instanceof MemoryEncryptionError) throw err;
      throw new MemorySerializationError(
        this.name,
        `Failed to deserialize value for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    const db = await this.ensureDb();
    const result = db.prepare("DELETE FROM memory_kv WHERE key = ?").run(key);
    return result.changes > 0;
  }

  async has(key: string): Promise<boolean> {
    const db = await this.ensureDb();
    const now = Date.now();
    const row = db
      .prepare(
        "SELECT 1 FROM memory_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(key, now);
    return row !== undefined;
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const db = await this.ensureDb();
    const now = Date.now();

    if (prefix) {
      const rows = db
        .prepare(
          "SELECT key FROM memory_kv WHERE (expires_at IS NULL OR expires_at > ?) AND key LIKE ?",
        )
        .all(now, `${prefix}%`);
      return rows.map((r: any) => r.key);
    }

    const rows = db
      .prepare(
        "SELECT key FROM memory_kv WHERE (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now);
    return rows.map((r: any) => r.key);
  }

  // ---------- Lifecycle ----------

  async clear(): Promise<void> {
    const db = await this.ensureDb();
    db.prepare("DELETE FROM memory_entries").run();
    db.prepare("DELETE FROM memory_kv").run();
    this.logger.debug("Cleared all memory");
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.logger.debug("SQLite backend closed");
  }

  async healthCheck(): Promise<boolean> {
    if (this.closed || !this.db) return false;
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  getDurability(): import("../types.js").DurabilityInfo {
    return {
      level: "sync",
      supportsFlush: true,
      description:
        "Data is persisted synchronously to disk via SQLite WAL. flush() forces a WAL checkpoint.",
    };
  }

  async flush(): Promise<void> {
    const db = await this.ensureDb();
    db.pragma("wal_checkpoint(TRUNCATE)");
  }

  // ---------- Internals ----------

  private recordMemoryMetrics(operation: string, durationMs: number): void {
    if (!this.metrics) return;
    const labels = { operation, backend: "sqlite" };
    this.metrics.counter(TELEMETRY_METRIC_NAMES.MEMORY_OPS_TOTAL, 1, labels);
    this.metrics.histogram(
      TELEMETRY_METRIC_NAMES.MEMORY_OP_DURATION,
      durationMs,
      labels,
    );
  }

  private async ensureDb(): Promise<any> {
    if (this.closed) {
      throw new MemoryBackendError(this.name, "Backend is closed");
    }
    if (this.db) return this.db;

    this.db = await ensureLazyBackend("better-sqlite3", this.name, (mod) => {
      const Database = (mod.default ?? mod) as any;
      return new Database(this.config.dbPath);
    });

    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }

    this.createSchema();

    if (this.config.cleanupOnConnect) {
      this.cleanupExpired();
    }

    return this.db;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        task_pda TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_entries_session_id ON memory_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON memory_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_task_pda ON memory_entries(task_pda);

      CREATE TABLE IF NOT EXISTS memory_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
    `);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const entriesResult = this.db
      .prepare(
        "DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);
    const kvResult = this.db
      .prepare(
        "DELETE FROM memory_kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);

    const total = entriesResult.changes + kvResult.changes;
    if (total > 0) {
      this.logger.debug(`Cleaned up ${total} expired rows on connect`);
    }
  }

  private rowToEntry(row: any): MemoryEntry {
    const entry: MemoryEntry = {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: this.decryptField(row.content),
      timestamp: row.timestamp,
    };

    if (row.tool_call_id) (entry as any).toolCallId = row.tool_call_id;
    if (row.tool_name) (entry as any).toolName = row.tool_name;
    if (row.task_pda) (entry as any).taskPda = row.task_pda;
    if (row.metadata) {
      try {
        (entry as any).metadata = JSON.parse(row.metadata);
      } catch {
        // Ignore corrupt metadata
      }
    }

    return entry;
  }

  private encryptField(plaintext: string): string {
    if (!this.encryptor) return plaintext;
    try {
      return this.encryptor.encrypt(plaintext);
    } catch (err) {
      throw new MemoryEncryptionError(
        this.name,
        `Encryption failed: ${(err as Error).message}`,
      );
    }
  }

  private decryptField(value: string): string {
    if (!this.encryptor) return value;
    try {
      return this.encryptor.decrypt(value);
    } catch (err) {
      throw new MemoryEncryptionError(
        this.name,
        `Decryption failed: ${(err as Error).message}`,
      );
    }
  }
}
