/**
 * SQLite-backed replay timeline store for production persistence.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureLazyBackend } from '../memory/lazy-import.js';
import {
  ReplayEventCursor,
  ReplayTimelineCompactionPolicy,
  ReplayTimelineQuery,
  ReplayTimelineRecord,
  ReplayTimelineRetentionPolicy,
  ReplayTimelineStore,
  ReplayStorageWriteResult,
  type ReplayTimelineStoreConfig,
} from './types.js';

interface ReplayTimelineRow {
  id: number;
  slot: number;
  signature: string;
  source_event_name: string;
  source_event_type: string;
  source_event_sequence: number;
  seq: number;
  task_pda: string | null;
  dispute_pda: string | null;
  timestamp_ms: number;
  projection_hash: string;
  trace_id: string | null;
  trace_span_id: string | null;
  trace_parent_span_id: string | null;
  trace_sampled: number;
  payload: string;
}

interface ReplayTimelineCursorRow {
  slot: number | null;
  signature: string | null;
  event_name: string | null;
  trace_id: string | null;
  trace_span_id: string | null;
}

const SQL_SCHEMA_VERSION = 1;

export class SqliteReplayTimelineStore implements ReplayTimelineStore {
  private readonly dbPath: string;
  private readonly retention: ReplayTimelineRetentionPolicy | undefined;
  private readonly compaction: ReplayTimelineCompactionPolicy | undefined;
  private db: any = null;
  private writeCounter = 0;

  constructor(dbPath: string, config: ReplayTimelineStoreConfig = {}) {
    this.dbPath = dbPath;
    this.retention = config.retention;
    this.compaction = config.compaction;
  }

  async save(records: readonly ReplayTimelineRecord[]): Promise<ReplayStorageWriteResult> {
    const db = await this.getDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO replay_timeline_events (
        slot,
        signature,
        source_event_name,
        source_event_type,
        source_event_sequence,
        seq,
        task_pda,
        dispute_pda,
        timestamp_ms,
        projection_hash,
        trace_id,
        trace_span_id,
        trace_parent_span_id,
        trace_sampled,
        payload
      )
      VALUES (
        @slot,
        @signature,
        @sourceEventName,
        @sourceEventType,
        @sourceEventSequence,
        @seq,
        @taskPda,
        @disputePda,
        @timestampMs,
        @projectionHash,
        @traceId,
        @traceSpanId,
        @traceParentSpanId,
        @traceSampled,
        @payload
      )
    `);

    let inserted = 0;
    let duplicates = 0;

    for (const event of records) {
      const result = insert.run({
        slot: event.slot,
        signature: event.signature,
        sourceEventName: event.sourceEventName,
        sourceEventType: event.sourceEventType,
        sourceEventSequence: event.sourceEventSequence,
        seq: event.seq,
        taskPda: event.taskPda,
        disputePda: event.disputePda ?? null,
        timestampMs: event.timestampMs,
        projectionHash: event.projectionHash,
        traceId: event.traceId ?? null,
        traceSpanId: event.traceSpanId ?? null,
        traceParentSpanId: event.traceParentSpanId ?? null,
        traceSampled: event.traceSampled === true ? 1 : 0,
        payload: JSON.stringify(event.payload),
      });

      if (result.changes === 1) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }

    await this.applyRetentionPolicy(db);

    this.writeCounter += 1;
    await this.compact(db);

    return {
      inserted,
      duplicates,
    };
  }

  async query(filter: ReplayTimelineQuery = {}): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    const db = await this.getDb();

    const queryParts = ['1 = 1'];
    const params: Record<string, string | number | null> = {};

    if (filter.taskPda !== undefined) {
      queryParts.push('task_pda = @taskPda');
      params.taskPda = filter.taskPda;
    }

    if (filter.disputePda !== undefined) {
      queryParts.push('dispute_pda = @disputePda');
      params.disputePda = filter.disputePda;
    }

    if (filter.fromSlot !== undefined) {
      queryParts.push('slot >= @fromSlot');
      params.fromSlot = filter.fromSlot;
    }

    if (filter.toSlot !== undefined) {
      queryParts.push('slot <= @toSlot');
      params.toSlot = filter.toSlot;
    }

    if (filter.fromTimestampMs !== undefined) {
      queryParts.push('timestamp_ms >= @fromTimestampMs');
      params.fromTimestampMs = filter.fromTimestampMs;
    }

    if (filter.toTimestampMs !== undefined) {
      queryParts.push('timestamp_ms <= @toTimestampMs');
      params.toTimestampMs = filter.toTimestampMs;
    }

    const orderBy =
      'slot ASC, signature ASC, seq ASC, source_event_type ASC';

    const limitClause =
      filter.limit !== undefined && filter.limit > 0
        ? ' LIMIT @limit OFFSET @offset'
        : '';

    if (filter.limit === undefined || filter.limit > 0) {
      params.offset = filter.offset ?? 0;
    }
    if (filter.limit !== undefined && filter.limit > 0) {
      params.limit = filter.limit;
    }

    const sql = `
      SELECT *
      FROM replay_timeline_events
      WHERE ${queryParts.join(' AND ')}
      ORDER BY ${orderBy}${limitClause}
    `;

    const rows = db.prepare(sql).all(params);

    return rows.map((row: ReplayTimelineRow) => this.rowToRecord(row));
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    const db = await this.getDb();
    const cursor = db
      .prepare('SELECT slot, signature, event_name, trace_id, trace_span_id FROM replay_timeline_cursor WHERE id = 1')
      .get() as ReplayTimelineCursorRow | undefined;

    if (!cursor || cursor.slot === null || cursor.signature === null) {
      return null;
    }

    return {
      slot: cursor.slot,
      signature: cursor.signature,
      eventName: cursor.event_name ?? undefined,
      traceId: cursor.trace_id ?? undefined,
      traceSpanId: cursor.trace_span_id ?? undefined,
    };
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    const db = await this.getDb();
    const statement = db.prepare(`
      INSERT OR REPLACE INTO replay_timeline_cursor (
        id,
        slot,
        signature,
        event_name,
        trace_id,
        trace_span_id
      ) VALUES (1, @slot, @signature, @eventName, @traceId, @traceSpanId)
    `);

    statement.run({
      slot: cursor?.slot ?? null,
      signature: cursor?.signature ?? null,
      eventName: cursor?.eventName ?? null,
      traceId: cursor?.traceId ?? null,
      traceSpanId: cursor?.traceSpanId ?? null,
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    db.prepare('DELETE FROM replay_timeline_events').run();
    await this.saveCursor(null);
  }

  private async getDb(): Promise<any> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPath !== ':memory:') {
      await mkdir(dirname(this.dbPath), { recursive: true });
    }

    this.db = await ensureLazyBackend('better-sqlite3', 'sqlite', (mod) => {
      const Database = (mod.default ?? mod) as new (...args: unknown[]) => any;
      return new Database(this.dbPath);
    });

    if (this.dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }

    await this.ensureSchema(this.db);
    return this.db;
  }

  private ensureSchema(db: any): void {
    const versionRow = db.pragma('user_version', { simple: true }) as number;
    if (versionRow > SQL_SCHEMA_VERSION) {
      throw new Error(`Replay timeline schema version ${versionRow} is newer than supported ${SQL_SCHEMA_VERSION}`);
    }

    if (versionRow > 0 && versionRow !== SQL_SCHEMA_VERSION) {
      throw new Error(`Unsupported replay timeline schema version: ${versionRow}`);
    }

    if (versionRow === SQL_SCHEMA_VERSION) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS replay_timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot INTEGER NOT NULL,
        signature TEXT NOT NULL,
        source_event_name TEXT NOT NULL,
        source_event_type TEXT NOT NULL,
        source_event_sequence INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        task_pda TEXT,
        dispute_pda TEXT,
        timestamp_ms INTEGER NOT NULL,
        projection_hash TEXT NOT NULL,
        trace_id TEXT,
        trace_span_id TEXT,
        trace_parent_span_id TEXT,
        trace_sampled INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_timeline_events_uniq
        ON replay_timeline_events(slot, signature, source_event_type);

      CREATE INDEX IF NOT EXISTS idx_replay_timeline_events_task_lookup
        ON replay_timeline_events(task_pda, slot, signature, seq, source_event_type);

      CREATE INDEX IF NOT EXISTS idx_replay_timeline_events_dispute_lookup
        ON replay_timeline_events(dispute_pda, slot, signature, seq, source_event_type);

      CREATE INDEX IF NOT EXISTS idx_replay_timeline_events_slot_signature_seq
        ON replay_timeline_events(slot, signature, seq, source_event_type);

      CREATE TABLE IF NOT EXISTS replay_timeline_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        slot INTEGER,
        signature TEXT,
        event_name TEXT,
        trace_id TEXT,
        trace_span_id TEXT
      );
    `);

    db.prepare(
      'INSERT OR IGNORE INTO replay_timeline_cursor (id, slot, signature, event_name, trace_id, trace_span_id) VALUES (1, NULL, NULL, NULL, NULL, NULL)',
    ).run();

    db.pragma(`user_version = ${SQL_SCHEMA_VERSION}`);
  }

  private rowToRecord(row: ReplayTimelineRow): ReplayTimelineRecord {
    return {
      seq: row.seq,
      type: row.source_event_type,
      taskPda: row.task_pda ?? undefined,
      timestampMs: row.timestamp_ms,
      payload: JSON.parse(row.payload),
      slot: row.slot,
      signature: row.signature,
      sourceEventName: row.source_event_name,
      sourceEventSequence: row.source_event_sequence,
      sourceEventType: row.source_event_type,
      disputePda: row.dispute_pda ?? undefined,
      projectionHash: row.projection_hash,
      traceId: row.trace_id ?? undefined,
      traceSpanId: row.trace_span_id ?? undefined,
      traceParentSpanId: row.trace_parent_span_id ?? undefined,
      traceSampled: row.trace_sampled === 1,
    };
  }

  private async applyRetentionPolicy(db: any): Promise<void> {
    if (!this.retention) {
      return;
    }

    const now = Date.now();

    if (this.retention.ttlMs !== undefined && this.retention.ttlMs > 0) {
      const cutoff = now - this.retention.ttlMs;
      db.prepare('DELETE FROM replay_timeline_events WHERE timestamp_ms < ?').run(cutoff);
    }

    if (this.retention.maxEventsPerTask !== undefined && this.retention.maxEventsPerTask > 0) {
      const limit = this.retention.maxEventsPerTask;
      db.exec(`
        DELETE FROM replay_timeline_events
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY task_pda
                     ORDER BY slot DESC, signature DESC, seq DESC, source_event_type DESC
                   ) AS seq_num
            FROM replay_timeline_events
            WHERE task_pda IS NOT NULL
          )
          WHERE seq_num > ${limit}
        );
      `);
    }

    if (this.retention.maxEventsPerDispute !== undefined && this.retention.maxEventsPerDispute > 0) {
      const limit = this.retention.maxEventsPerDispute;
      db.exec(`
        DELETE FROM replay_timeline_events
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY dispute_pda
                     ORDER BY slot DESC, signature DESC, seq DESC, source_event_type DESC
                   ) AS seq_num
            FROM replay_timeline_events
            WHERE dispute_pda IS NOT NULL
          )
          WHERE seq_num > ${limit}
        );
      `);
    }

    if (this.retention.maxEventsTotal !== undefined && this.retention.maxEventsTotal > 0) {
      const limit = this.retention.maxEventsTotal;
      db.exec(`
        DELETE FROM replay_timeline_events
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     ORDER BY slot DESC, signature DESC, seq DESC, source_event_type DESC
                   ) AS seq_num
            FROM replay_timeline_events
          )
          WHERE seq_num > ${limit}
        );
      `);
    }
  }

  private async compact(db: any): Promise<void> {
    if (this.compaction?.enabled !== true) {
      return;
    }

    const compactAfterWrites = this.compaction.compactAfterWrites ?? 0;
    if (compactAfterWrites <= 0) {
      return;
    }

    if (this.writeCounter % compactAfterWrites !== 0) {
      return;
    }

    db.exec('VACUUM');
  }
}
