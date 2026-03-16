/**
 * Typed SQLite inspection/query tools for @tetsuo-ai/runtime.
 *
 * Provides:
 * - system.sqliteSchema — inspect tables, views, indexes, and columns
 * - system.sqliteQuery — execute read-only SQL and return structured rows
 *
 * @module
 */

import { resolve } from "node:path";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { ensureLazyModule } from "../../utils/lazy-import.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import type { SystemSqliteToolConfig } from "./types.js";

const DEFAULT_MAX_SQL_CHARS = 20_000;
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_ROWS_CAP = 1_000;
const DEFAULT_MAX_CELL_CHARS = 4_000;

type SqliteValue = string | number | boolean | null | Uint8Array;

interface SqliteColumnInfo {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly dflt_value: string | null;
  readonly pk: 0 | 1;
}

interface SqliteIndexInfo {
  readonly seq: number;
  readonly name: string;
  readonly unique: 0 | 1;
  readonly origin: string;
  readonly partial: 0 | 1;
}

interface SqliteMasterRow {
  readonly type: "table" | "view" | "index";
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface SqliteStatement {
  readonly reader: boolean;
  columns(): Array<{ readonly name: string }>;
  iterate(params?: unknown): Iterable<Record<string, SqliteValue>>;
  all(params?: unknown): unknown[];
}

interface SqliteDatabase {
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteDatabaseConstructor = new (
  path: string,
  options?: {
    readonly readonly?: boolean;
    readonly fileMustExist?: boolean;
  },
) => SqliteDatabase;

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function createSqliteError(message: string): Error {
  return new Error(message);
}

async function loadSqliteDatabaseCtor(): Promise<SqliteDatabaseConstructor> {
  return ensureLazyModule<SqliteDatabaseConstructor>(
    "better-sqlite3",
    createSqliteError,
    (mod) => mod.default as SqliteDatabaseConstructor,
  );
}

function validateAllowedPaths(allowedPaths: readonly string[]): string[] {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new TypeError("allowedPaths must be a non-empty array of strings");
  }
  return allowedPaths.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError("Each allowedPaths entry must be a non-empty string");
    }
    return resolve(entry).normalize("NFC");
  });
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("Expected a positive finite integer");
  }
  return Math.min(Math.floor(value), maximum);
}

async function resolveSqlitePath(
  rawPath: unknown,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<string | ToolResult> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return errorResult("Missing or invalid path");
  }
  const safe = await safePath(rawPath, resolveToolAllowedPaths(allowedPaths, args));
  if (!safe.safe) {
    return errorResult(safe.reason ?? "Database path is outside allowed directories");
  }
  return safe.resolved;
}

function normalizeScalar(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError(
    "SQLite params only support string, number, boolean, or null values",
  );
}

function normalizeSqliteParams(
  rawParams: unknown,
): readonly unknown[] | Record<string, unknown> | undefined {
  if (rawParams === undefined) {
    return undefined;
  }
  if (Array.isArray(rawParams)) {
    return rawParams.map((value) => normalizeScalar(value));
  }
  if (rawParams && typeof rawParams === "object") {
    return Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [key, normalizeScalar(value)]),
    );
  }
  throw new TypeError("params must be an array, object, or omitted");
}

function normalizeSql(sql: unknown, maxSqlChars: number): string {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new TypeError("Missing or invalid sql");
  }
  const trimmed = sql.trim();
  if (trimmed.length > maxSqlChars) {
    throw new TypeError(`sql exceeds ${maxSqlChars} characters`);
  }
  const normalized = trimmed.replace(/;+\s*$/u, "");
  if (normalized.includes(";")) {
    throw new TypeError("Only a single SQL statement is allowed");
  }
  return normalized;
}

function previewSqliteValue(value: unknown, maxCellChars: number): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    const base64 = buffer.toString("base64");
    return {
      type: "base64",
      bytes: buffer.byteLength,
      truncated: base64.length > maxCellChars,
      value: base64.slice(0, maxCellChars),
    };
  }
  if (typeof value === "string") {
    return value.length > maxCellChars ? `${value.slice(0, maxCellChars)}…` : value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function extractRows(
  statement: SqliteStatement,
  params: readonly unknown[] | Record<string, unknown> | undefined,
  maxRows: number,
  maxCellChars: number,
): {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
} {
  const rows: Record<string, unknown>[] = [];
  const iterator = params === undefined ? statement.iterate() : statement.iterate(params);
  let truncated = false;
  for (const row of iterator) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          previewSqliteValue(value, maxCellChars),
        ]),
      ),
    );
  }
  return {
    columns: statement.columns().map((column) => column.name),
    rows,
    truncated,
  };
}

function parseTableName(rawName: string): string {
  return `"${rawName.replaceAll('"', '""')}"`;
}

async function withReadonlyDatabase<T>(
  dbPath: string,
  fn: (db: SqliteDatabase) => T,
): Promise<T> {
  const Database = await loadSqliteDatabaseCtor();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function createSqliteSchemaTool(
  allowedPaths: readonly string[],
  maxCellChars: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.sqliteSchema",
    description:
      "Inspect a local SQLite database with a typed schema view of tables, views, indexes, and columns.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the SQLite database file.",
        },
        includeIndexes: {
          type: "boolean",
          description: "Include index definitions alongside tables and views.",
          default: true,
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveSqlitePath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      const includeIndexes = args.includeIndexes !== false;
      try {
        return await withReadonlyDatabase(resolved, (db) => {
          const master = db
            .prepare(
              [
                "SELECT type, name, tbl_name, sql",
                "FROM sqlite_master",
                "WHERE type IN ('table','view','index')",
                "AND name NOT LIKE 'sqlite_%'",
                "ORDER BY CASE type",
                "  WHEN 'table' THEN 0",
                "  WHEN 'view' THEN 1",
                "  ELSE 2 END, name ASC",
              ].join(" "),
            )
            .all() as SqliteMasterRow[];

          const objects = master
            .filter((row) => includeIndexes || row.type !== "index")
            .map((row) => {
              if (row.type === "index") {
                return {
                  type: row.type,
                  name: row.name,
                  tableName: row.tbl_name,
                  sql: row.sql,
                };
              }
              const columns = db
                .prepare(`PRAGMA table_info(${parseTableName(row.name)})`)
                .all() as SqliteColumnInfo[];
              const indexes = includeIndexes
                ? ((db
                    .prepare(`PRAGMA index_list(${parseTableName(row.name)})`)
                    .all() as SqliteIndexInfo[]).map((index) => ({
                    name: index.name,
                    unique: index.unique === 1,
                    origin: index.origin,
                    partial: index.partial === 1,
                  })))
                : [];
              return {
                type: row.type,
                name: row.name,
                sql:
                  typeof row.sql === "string"
                    ? previewSqliteValue(row.sql, maxCellChars)
                    : row.sql,
                columns: columns.map((column) => ({
                  cid: column.cid,
                  name: column.name,
                  type: column.type,
                  notNull: column.notnull === 1,
                  defaultValue: column.dflt_value,
                  primaryKey: column.pk === 1,
                })),
                indexes,
              };
            });

          return {
            content: safeStringify({
              path: resolved,
              objects,
            }),
          };
        });
      } catch (error) {
        logger.warn?.("system.sqliteSchema failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "Failed to inspect SQLite schema",
        );
      }
    },
  };
}

function createSqliteQueryTool(
  allowedPaths: readonly string[],
  maxSqlChars: number,
  defaultMaxRows: number,
  maxRowsCap: number,
  maxCellChars: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.sqliteQuery",
    description:
      "Execute a single read-only SQL statement against a local SQLite database and return structured rows.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the SQLite database file.",
        },
        sql: {
          type: "string",
          description:
            "Single read-only SQL statement. Mutating statements are rejected.",
        },
        params: {
          description:
            "Optional positional array or named-object query parameters using only scalar JSON values.",
          oneOf: [
            { type: "array", items: {} },
            { type: "object", additionalProperties: true },
          ],
        },
        maxRows: {
          type: "number",
          description: `Maximum rows to return (default ${defaultMaxRows}, capped at ${maxRowsCap}).`,
        },
      },
      required: ["path", "sql"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveSqlitePath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }

      let sql: string;
      let params: readonly unknown[] | Record<string, unknown> | undefined;
      let maxRows: number;
      try {
        sql = normalizeSql(args.sql, maxSqlChars);
        params = normalizeSqliteParams(args.params);
        maxRows = normalizePositiveInteger(args.maxRows, defaultMaxRows, maxRowsCap);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Invalid SQLite query input");
      }

      try {
        return await withReadonlyDatabase(resolved, (db) => {
          const statement = db.prepare(sql);
          if (!statement.reader) {
            return errorResult("Only read-only SQLite statements are allowed");
          }
          const { columns, rows, truncated } = extractRows(
            statement,
            params,
            maxRows,
            maxCellChars,
          );
          return {
            content: safeStringify({
              path: resolved,
              sql,
              columns,
              rows,
              rowCount: rows.length,
              truncated,
            }),
          };
        });
      } catch (error) {
        logger.warn?.("system.sqliteQuery failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "SQLite query failed",
        );
      }
    },
  };
}

export function createSqliteTools(config: SystemSqliteToolConfig): Tool[] {
  const allowedPaths = validateAllowedPaths(config.allowedPaths);
  const maxSqlChars = normalizePositiveInteger(
    config.maxSqlChars,
    DEFAULT_MAX_SQL_CHARS,
    Number.MAX_SAFE_INTEGER,
  );
  const defaultMaxRows = normalizePositiveInteger(
    config.defaultMaxRows,
    DEFAULT_MAX_ROWS,
    DEFAULT_MAX_ROWS_CAP,
  );
  const maxRowsCap = normalizePositiveInteger(
    config.maxRowsCap,
    Math.max(DEFAULT_MAX_ROWS_CAP, defaultMaxRows),
    Number.MAX_SAFE_INTEGER,
  );
  const maxCellChars = normalizePositiveInteger(
    config.maxCellChars,
    DEFAULT_MAX_CELL_CHARS,
    Number.MAX_SAFE_INTEGER,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createSqliteSchemaTool(allowedPaths, maxCellChars, logger),
    createSqliteQueryTool(
      allowedPaths,
      maxSqlChars,
      defaultMaxRows,
      maxRowsCap,
      maxCellChars,
      logger,
    ),
  ];
}
