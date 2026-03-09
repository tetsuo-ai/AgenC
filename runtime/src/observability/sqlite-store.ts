import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { safeStringify } from "../tools/types.js";
import { ensureLazyModule } from "../utils/lazy-import.js";
import { ObservabilityStoreError } from "./errors.js";
import type {
  ObservabilityArtifactResponse,
  ObservabilityEventRecord,
  ObservabilityLogResponse,
  ObservabilitySummary,
  ObservabilitySummaryQuery,
  ObservabilityTraceDetail,
  ObservabilityTraceQuery,
  ObservabilityTraceSummary,
} from "./types.js";

interface BetterSqlite3Database {
  pragma(source: string): void;
  exec(source: string): void;
  prepare(source: string): {
    run(params?: Record<string, unknown>): { changes: number; lastInsertRowid?: number };
    get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
    all(params?: Record<string, unknown>): Array<Record<string, unknown>>;
  };
  close(): void;
}

interface SqliteEventRow {
  id: string;
  event_name: string;
  level: "info" | "error";
  trace_id: string;
  parent_trace_id: string | null;
  session_id: string | null;
  channel: string | null;
  timestamp_ms: number;
  call_index: number | null;
  call_phase: string | null;
  provider: string | null;
  model: string | null;
  tool_name: string | null;
  stop_reason: string | null;
  duration_ms: number | null;
  routing_miss: number;
  completion_gate_decision: string | null;
  payload_preview: string;
  artifact_path: string | null;
  artifact_sha256: string | null;
  artifact_bytes: number | null;
}

interface TraceSummaryRow {
  trace_id: string;
  session_id: string | null;
  started_at: number;
  updated_at: number;
  event_count: number;
  error_count: number;
  last_event_name: string;
  stop_reason: string | null;
  status: "open" | "completed" | "error";
}

const DEFAULT_DB_PATH = join(homedir(), ".agenc", "observability.sqlite");
const DEFAULT_DAEMON_LOG_PATH = join(homedir(), ".agenc", "daemon.log");
const TRACE_ARTIFACT_ROOT = resolvePath(homedir(), ".agenc", "trace-payloads");
const DEFAULT_LOG_TAIL_BYTES = 256 * 1024;
const DEFAULT_LOG_LINES = 200;

function normalizeSessionIds(
  sessionIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!sessionIds) return undefined;
  return [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
}

function isCompletedTraceEventName(eventName: string): boolean {
  return (
    eventName.endsWith(".chat.response") ||
    eventName.endsWith(".command.handled") ||
    eventName === "background_run.cycle.working_applied" ||
    eventName === "background_run.cycle.terminal_applied"
  );
}

function isTerminalTraceEventName(eventName: string): boolean {
  return (
    isCompletedTraceEventName(eventName) ||
    eventName.endsWith(".chat.error")
  );
}

export interface SqliteObservabilityStoreConfig {
  readonly dbPath?: string;
  readonly daemonLogPath?: string;
}

export class SqliteObservabilityStore {
  private readonly dbPath: string;
  private readonly daemonLogPath: string;
  private db: BetterSqlite3Database | null = null;

  constructor(config: SqliteObservabilityStoreConfig = {}) {
    this.dbPath = config.dbPath ?? DEFAULT_DB_PATH;
    this.daemonLogPath = config.daemonLogPath ?? DEFAULT_DAEMON_LOG_PATH;
  }

  async recordEvent(event: ObservabilityEventRecord): Promise<void> {
    const db = await this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO observability_events (
        id,
        event_name,
        level,
        trace_id,
        parent_trace_id,
        session_id,
        channel,
        timestamp_ms,
        call_index,
        call_phase,
        provider,
        model,
        tool_name,
        stop_reason,
        duration_ms,
        routing_miss,
        completion_gate_decision,
        payload_preview,
        artifact_path,
        artifact_sha256,
        artifact_bytes
      ) VALUES (
        @id,
        @eventName,
        @level,
        @traceId,
        @parentTraceId,
        @sessionId,
        @channel,
        @timestampMs,
        @callIndex,
        @callPhase,
        @provider,
        @model,
        @toolName,
        @stopReason,
        @durationMs,
        @routingMiss,
        @completionGateDecision,
        @payloadPreview,
        @artifactPath,
        @artifactSha256,
        @artifactBytes
      )
    `).run({
      id: event.id,
      eventName: event.eventName,
      level: event.level,
      traceId: event.traceId,
      parentTraceId: event.parentTraceId ?? null,
      sessionId: event.sessionId ?? null,
      channel: event.channel ?? null,
      timestampMs: event.timestampMs,
      callIndex: event.callIndex ?? null,
      callPhase: event.callPhase ?? null,
      provider: event.provider ?? null,
      model: event.model ?? null,
      toolName: event.toolName ?? null,
      stopReason: event.stopReason ?? null,
      durationMs: event.durationMs ?? null,
      routingMiss: event.routingMiss ? 1 : 0,
      completionGateDecision: event.completionGateDecision ?? null,
      payloadPreview: safeStringify(event.payloadPreview),
      artifactPath: event.artifact?.path ?? null,
      artifactSha256: event.artifact?.sha256 ?? null,
      artifactBytes: event.artifact?.bytes ?? null,
    });
  }

  async listTraces(
    query: ObservabilityTraceQuery = {},
  ): Promise<readonly ObservabilityTraceSummary[]> {
    const db = await this.getDb();
    const where: string[] = ["trace_id IS NOT NULL"];
    const params: Record<string, unknown> = {
      limit: Math.max(1, Math.min(200, query.limit ?? 100)),
      offset: Math.max(0, query.offset ?? 0),
    };

    this.applySessionScope(where, params, query);
    if (query.search) {
      where.push(
        "(trace_id LIKE @search OR session_id LIKE @search OR event_name LIKE @search OR tool_name LIKE @search OR stop_reason LIKE @search)",
      );
      params.search = `%${query.search}%`;
    }

    const summaryQuery = `
      WITH trace_rollups AS (
        SELECT
          trace_id,
          MAX(session_id) AS session_id,
          MIN(timestamp_ms) AS started_at,
          MAX(timestamp_ms) AS updated_at,
          COUNT(*) AS event_count,
          SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
          (
            SELECT oe2.event_name
            FROM observability_events oe2
            WHERE oe2.trace_id = oe.trace_id
            ORDER BY oe2.timestamp_ms DESC, oe2.id DESC
            LIMIT 1
          ) AS last_event_name,
          (
            SELECT oe2.stop_reason
            FROM observability_events oe2
            WHERE oe2.trace_id = oe.trace_id AND oe2.stop_reason IS NOT NULL
            ORDER BY oe2.timestamp_ms DESC, oe2.id DESC
            LIMIT 1
          ) AS stop_reason,
          CASE
            WHEN SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
            WHEN SUM(CASE WHEN event_name LIKE '%.chat.response' OR event_name LIKE '%.command.handled' OR event_name = 'background_run.cycle.working_applied' OR event_name = 'background_run.cycle.terminal_applied' THEN 1 ELSE 0 END) > 0 THEN 'completed'
            ELSE 'open'
          END AS status
        FROM observability_events oe
        WHERE ${where.join(" AND ")}
        GROUP BY trace_id
      )
      SELECT *
      FROM trace_rollups
      ${query.status && query.status !== "all" ? "WHERE status = @status" : ""}
      ORDER BY updated_at DESC
      LIMIT @limit OFFSET @offset
    `;
    if (query.status && query.status !== "all") {
      params.status = query.status;
    }

    return db
      .prepare(summaryQuery)
      .all(params)
      .map((row) => this.toTraceSummary(row as unknown as TraceSummaryRow));
  }

  async getTrace(traceId: string): Promise<ObservabilityTraceDetail | null> {
    const db = await this.getDb();
    const rows = db
      .prepare(`
        SELECT *
        FROM observability_events
        WHERE trace_id = @traceId
        ORDER BY timestamp_ms ASC, id ASC
      `)
      .all({ traceId })
      .map((row) => this.toEventRecord(row as unknown as SqliteEventRow));

    if (rows.length === 0) {
      return null;
    }

    const summary = this.summarizeTrace(rows);
    return {
      summary,
      completeness: this.computeCompleteness(rows),
      events: rows,
    };
  }

  async getSummary(
    query: ObservabilitySummaryQuery = {},
  ): Promise<ObservabilitySummary> {
    const db = await this.getDb();
    const windowMs = query.windowMs ?? 86_400_000;
    const sinceMs = Date.now() - windowMs;
    const baseParams: Record<string, unknown> = { sinceMs };
    const where = ["timestamp_ms >= @sinceMs"];
    this.applySessionScope(where, baseParams, query);
    const whereSql = where.join(" AND ");

    const traceCounts = db
      .prepare(`
        WITH trace_rollups AS (
          SELECT
            trace_id,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(CASE WHEN event_name LIKE '%.chat.response' OR event_name LIKE '%.command.handled' OR event_name = 'background_run.cycle.working_applied' OR event_name = 'background_run.cycle.terminal_applied' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN event_name LIKE '%.chat.response' OR event_name LIKE '%.command.handled' OR event_name = 'background_run.cycle.working_applied' OR event_name = 'background_run.cycle.terminal_applied' OR level = 'error' THEN 1 ELSE 0 END) AS terminal_count
          FROM observability_events
          WHERE ${whereSql}
          GROUP BY trace_id
        )
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN error_count = 0 AND completed_count > 0 THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN terminal_count = 0 THEN 1 ELSE 0 END) AS open
        FROM trace_rollups
      `)
      .get(baseParams) as Record<string, number> | undefined;

    const providerErrors = this.scalarCount(
      db,
      `
        SELECT COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql} AND event_name LIKE '%.provider.error'
      `,
      baseParams,
    );
    const toolRejections = this.scalarCount(
      db,
      `
        SELECT COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql} AND event_name LIKE '%.executor.tool_rejected'
      `,
      baseParams,
    );
    const routeMisses = this.scalarCount(
      db,
      `
        SELECT COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql} AND routing_miss = 1
      `,
      baseParams,
    );
    const completionGateFailures = this.scalarCount(
      db,
      `
        SELECT COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql}
          AND event_name LIKE '%.executor.completion_gate_checked'
          AND completion_gate_decision = 'fail'
      `,
      baseParams,
    );

    const topTools = this.namedCounts(
      db,
      `
        SELECT tool_name AS name, COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql}
          AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY count DESC
        LIMIT 5
      `,
      baseParams,
    );
    const topStopReasons = this.namedCounts(
      db,
      `
        SELECT stop_reason AS name, COUNT(*) AS count
        FROM observability_events
        WHERE ${whereSql}
          AND stop_reason IS NOT NULL
        GROUP BY stop_reason
        ORDER BY count DESC
        LIMIT 5
      `,
      baseParams,
    );

    const total = Number(traceCounts?.total ?? 0);
    const completed = Number(traceCounts?.completed ?? 0);
    const errors = Number(traceCounts?.errors ?? 0);
    const open = Number(traceCounts?.open ?? 0);

    return {
      windowMs,
      traces: {
        total,
        completed,
        errors,
        open,
        completenessRate: total > 0 ? (completed + errors) / total : 1,
      },
      events: {
        providerErrors,
        toolRejections,
        routeMisses,
        completionGateFailures,
      },
      topTools,
      topStopReasons,
    };
  }

  async getArtifact(path: string): Promise<ObservabilityArtifactResponse> {
    const resolved = resolvePath(path);
    if (!resolved.startsWith(TRACE_ARTIFACT_ROOT)) {
      throw new ObservabilityStoreError("Artifact path is outside trace payload root");
    }
    const bodyText = await readFile(resolved, "utf8");
    return {
      path: resolved,
      body: JSON.parse(bodyText) as unknown,
    };
  }

  async getLogTail(params: {
    readonly lines?: number;
    readonly traceId?: string;
  }): Promise<ObservabilityLogResponse> {
    const lineLimit = Math.max(10, Math.min(1000, params.lines ?? DEFAULT_LOG_LINES));
    const fileStats = await stat(this.daemonLogPath);
    const bytesToRead = Math.min(DEFAULT_LOG_TAIL_BYTES, fileStats.size);
    const content = await readFile(this.daemonLogPath, "utf8");
    const sliced = content.slice(Math.max(0, content.length - bytesToRead));
    const filtered = sliced
      .split(/\r?\n/)
      .filter((line) =>
        params.traceId
          ? line.includes(params.traceId)
          : line.trim().length > 0,
      );
    return {
      path: this.daemonLogPath,
      lines: filtered.slice(-lineLimit),
    };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private async getDb(): Promise<BetterSqlite3Database> {
    if (this.db) {
      return this.db;
    }
    await mkdir(dirname(this.dbPath), { recursive: true });
    const Database = await ensureLazyModule(
      "better-sqlite3",
      (message) => new ObservabilityStoreError(message),
      (mod) => (mod.default ?? mod) as new (path: string) => BetterSqlite3Database,
    );
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observability_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        level TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        session_id TEXT,
        channel TEXT,
        timestamp_ms INTEGER NOT NULL,
        call_index INTEGER,
        call_phase TEXT,
        provider TEXT,
        model TEXT,
        tool_name TEXT,
        stop_reason TEXT,
        duration_ms INTEGER,
        routing_miss INTEGER NOT NULL DEFAULT 0,
        completion_gate_decision TEXT,
        payload_preview TEXT NOT NULL,
        artifact_path TEXT,
        artifact_sha256 TEXT,
        artifact_bytes INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_observability_trace_time
        ON observability_events(trace_id, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_observability_updated
        ON observability_events(timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_session
        ON observability_events(session_id, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_event_name
        ON observability_events(event_name, timestamp_ms DESC);
    `);
    return this.db;
  }

  private scalarCount(
    db: BetterSqlite3Database,
    sql: string,
    params: Record<string, unknown>,
  ): number {
    const row = db.prepare(sql).get(params) as Record<string, number> | undefined;
    return Number(row?.count ?? 0);
  }

  private namedCounts(
    db: BetterSqlite3Database,
    sql: string,
    params: Record<string, unknown>,
  ) {
    return db.prepare(sql).all(params).map((row) => ({
      name: String(row.name),
      count: Number(row.count ?? 0),
    }));
  }

  private applySessionScope(
    where: string[],
    params: Record<string, unknown>,
    scope: {
      readonly sessionId?: string;
      readonly sessionIds?: readonly string[];
    },
  ): void {
    const sessionId =
      typeof scope.sessionId === "string" && scope.sessionId.trim().length > 0
        ? scope.sessionId.trim()
        : undefined;
    const sessionIds = normalizeSessionIds(scope.sessionIds);

    if (sessionId) {
      if (scope.sessionIds !== undefined && !(sessionIds ?? []).includes(sessionId)) {
        where.push("1 = 0");
        return;
      }
      where.push("session_id = @sessionId");
      params.sessionId = sessionId;
      return;
    }

    if (scope.sessionIds === undefined) return;
    if (!sessionIds || sessionIds.length === 0) {
      where.push("1 = 0");
      return;
    }

    const placeholders = sessionIds.map((_, index) => `@sessionScope${index}`);
    where.push(`session_id IN (${placeholders.join(", ")})`);
    sessionIds.forEach((value, index) => {
      params[`sessionScope${index}`] = value;
    });
  }

  private toEventRecord(row: SqliteEventRow): ObservabilityEventRecord {
    return {
      id: row.id,
      eventName: row.event_name,
      level: row.level,
      traceId: row.trace_id,
      ...(row.parent_trace_id ? { parentTraceId: row.parent_trace_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.channel ? { channel: row.channel } : {}),
      timestampMs: row.timestamp_ms,
      ...(row.call_index !== null ? { callIndex: row.call_index } : {}),
      ...(row.call_phase ? { callPhase: row.call_phase } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      routingMiss: row.routing_miss === 1,
      ...(row.completion_gate_decision
        ? { completionGateDecision: row.completion_gate_decision }
        : {}),
      payloadPreview: JSON.parse(row.payload_preview) as unknown,
      ...(row.artifact_path
        ? {
            artifact: {
              path: row.artifact_path,
              sha256: row.artifact_sha256 ?? "",
              bytes: Number(row.artifact_bytes ?? 0),
            },
          }
        : {}),
    };
  }

  private toTraceSummary(row: TraceSummaryRow): ObservabilityTraceSummary {
    return {
      traceId: row.trace_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      eventCount: Number(row.event_count),
      errorCount: Number(row.error_count),
      status: row.status,
      lastEventName: row.last_event_name,
      ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    };
  }

  private summarizeTrace(
    events: readonly ObservabilityEventRecord[],
  ): ObservabilityTraceSummary {
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const errorCount = events.filter((event) => event.level === "error").length;
    const completed = events.some((event) =>
      isCompletedTraceEventName(event.eventName),
    );
    return {
      traceId: first.traceId,
      ...(first.sessionId ? { sessionId: first.sessionId } : {}),
      startedAt: first.timestampMs,
      updatedAt: last.timestampMs,
      eventCount: events.length,
      errorCount,
      status: errorCount > 0 ? "error" : completed ? "completed" : "open",
      lastEventName: last.eventName,
      ...(last.stopReason ? { stopReason: last.stopReason } : {}),
    };
  }

  private computeCompleteness(events: readonly ObservabilityEventRecord[]) {
    const issues: string[] = [];
    const hasInbound = events.some((event) => event.eventName.endsWith(".inbound"));
    const hasTerminal = events.some(
      (event) => isTerminalTraceEventName(event.eventName),
    );
    if (hasInbound && !hasTerminal) {
      issues.push(
        "Trace has inbound activity but no terminal chat/command response or error event",
      );
    }
    return {
      complete: issues.length === 0,
      issues,
    };
  }
}
