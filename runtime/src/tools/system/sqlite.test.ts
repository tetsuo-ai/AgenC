import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createSqliteTools } from "./sqlite.js";

let Database: (new (path: string) => {
  exec(sql: string): unknown;
  close(): void;
}) | null = null;

const cleanupPaths: string[] = [];

beforeAll(async () => {
  const mod = await import("better-sqlite3");
  Database = mod.default as typeof Database;
});

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()!;
    await rm(path, { recursive: true, force: true });
  }
});

function makeDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-system-sqlite-test-"));
  cleanupPaths.push(dir);
  return join(dir, name);
}

function findTool(name: string) {
  const tool = createSqliteTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

function createSampleDatabase(path: string): void {
  if (!Database) {
    throw new Error("better-sqlite3 did not load for tests");
  }
  const db = new Database(path);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL
    );
    INSERT INTO users (name, role) VALUES
      ('Ada', 'admin'),
      ('Linus', 'user'),
      ('Grace', 'analyst');
  `);
  db.close();
}

describe("system.sqlite tools", () => {
  it("creates the typed SQLite tools", () => {
    const tools = createSqliteTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.sqliteSchema",
      "system.sqliteQuery",
    ]);
  });

  it("returns typed schema information", async () => {
    const dbPath = makeDbPath("schema.db");
    createSampleDatabase(dbPath);

    const result = await findTool("system.sqliteSchema").execute({ path: dbPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const objects = parsed.objects as Array<Record<string, unknown>>;
    const users = objects.find((entry) => entry.name === "users");

    expect(users).toMatchObject({
      type: "table",
      name: "users",
    });
    expect(users?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", primaryKey: true }),
        expect.objectContaining({ name: "name", type: "TEXT", notNull: true }),
      ]),
    );
  });

  it("executes read-only queries and returns structured rows", async () => {
    const dbPath = makeDbPath("query.db");
    createSampleDatabase(dbPath);

    const result = await findTool("system.sqliteQuery").execute({
      path: dbPath,
      sql: "SELECT name, role FROM users WHERE role = ? ORDER BY name ASC",
      params: ["admin"],
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.columns).toEqual(["name", "role"]);
    expect(parsed.rows).toEqual([{ name: "Ada", role: "admin" }]);
    expect(parsed.truncated).toBe(false);
  });

  it("caps row output deterministically", async () => {
    const dbPath = makeDbPath("truncate.db");
    createSampleDatabase(dbPath);

    const result = await findTool("system.sqliteQuery").execute({
      path: dbPath,
      sql: "SELECT id, name FROM users ORDER BY id ASC",
      maxRows: 2,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.rows).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Linus" },
    ]);
    expect(parsed.truncated).toBe(true);
  });

  it("rejects mutating statements", async () => {
    const dbPath = makeDbPath("mutate.db");
    createSampleDatabase(dbPath);

    const result = await findTool("system.sqliteQuery").execute({
      path: dbPath,
      sql: "DELETE FROM users",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Only read-only SQLite statements are allowed");
  });

  it("blocks paths outside the allowlist", async () => {
    const dbPath = makeDbPath("blocked.db");
    createSampleDatabase(dbPath);

    const tools = createSqliteTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });
    const result = await tools[1].execute({
      path: dbPath,
      sql: "SELECT 1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
