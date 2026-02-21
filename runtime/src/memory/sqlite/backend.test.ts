import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryConnectionError,
  MemorySerializationError,
  MemoryBackendError,
} from "../errors.js";

// Mock better-sqlite3
const mockRun = vi.fn().mockReturnValue({ changes: 0 });
const mockGet = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi
  .fn()
  .mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockClose = vi.fn();

const MockDatabase = vi.fn().mockImplementation(() => ({
  prepare: mockPrepare,
  exec: mockExec,
  pragma: mockPragma,
  close: mockClose,
}));

vi.mock("better-sqlite3", () => {
  return { default: MockDatabase };
});

// Import after mock
import { SqliteBackend } from "./backend.js";

describe("SqliteBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the default mock return values
    mockRun.mockReturnValue({ changes: 0 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
  });

  describe("lazy loading", () => {
    it("creates database on first operation", async () => {
      const backend = new SqliteBackend({ dbPath: ":memory:" });
      mockAll.mockReturnValue([]);

      await backend.getThread("s1");

      expect(MockDatabase).toHaveBeenCalledWith(":memory:");
      expect(mockExec).toHaveBeenCalled(); // Schema creation
    });

    it("does not enable WAL for :memory: databases", async () => {
      const backend = new SqliteBackend({ dbPath: ":memory:", walMode: true });
      await backend.getThread("s1");

      // pragma should not be called for WAL on :memory:
      expect(mockPragma).not.toHaveBeenCalledWith("journal_mode = WAL");
    });

    it("enables WAL for file-based databases", async () => {
      const backend = new SqliteBackend({
        dbPath: "/tmp/test.db",
        walMode: true,
      });
      await backend.getThread("s1");

      expect(mockPragma).toHaveBeenCalledWith("journal_mode = WAL");
    });
  });

  describe("missing dependency", () => {
    it("throws MemoryConnectionError when better-sqlite3 is missing", async () => {
      // Override the mock to simulate missing module
      vi.doUnmock("better-sqlite3");
      vi.doMock("better-sqlite3", () => {
        throw new Error("Cannot find module");
      });

      // Need a fresh import to get the new mock
      const { SqliteBackend: FreshSqlite } = await import("./backend.js");
      const backend = new FreshSqlite();

      await expect(backend.getThread("s1")).rejects.toThrow(
        MemoryConnectionError,
      );

      // Restore original mock
      vi.doMock("better-sqlite3", () => ({ default: MockDatabase }));
    });
  });

  describe("schema creation", () => {
    it("creates tables and indexes on first connect", async () => {
      const backend = new SqliteBackend();
      await backend.getThread("s1");

      expect(mockExec).toHaveBeenCalledTimes(1);
      const schema = mockExec.mock.calls[0][0];
      expect(schema).toContain("CREATE TABLE IF NOT EXISTS memory_entries");
      expect(schema).toContain("CREATE TABLE IF NOT EXISTS memory_kv");
      expect(schema).toContain(
        "CREATE INDEX IF NOT EXISTS idx_entries_session_id",
      );
      expect(schema).toContain(
        "CREATE INDEX IF NOT EXISTS idx_entries_timestamp",
      );
      expect(schema).toContain(
        "CREATE INDEX IF NOT EXISTS idx_entries_task_pda",
      );
    });
  });

  describe("cleanupOnConnect", () => {
    it("deletes expired rows on connect when enabled", async () => {
      const backend = new SqliteBackend({ cleanupOnConnect: true });
      mockRun.mockReturnValue({ changes: 5 });

      await backend.getThread("s1");

      // cleanupExpired runs 2 DELETEs (entries + kv), then getThread runs a SELECT
      // The prepare calls include: 2 for cleanup + 1 for the actual query
      const deleteCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("DELETE") &&
          c[0].includes("expires_at"),
      );
      expect(deleteCalls.length).toBe(2);
    });

    it("skips cleanup when disabled", async () => {
      const backend = new SqliteBackend({ cleanupOnConnect: false });
      await backend.getThread("s1");

      const deleteCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("DELETE") &&
          c[0].includes("expires_at"),
      );
      expect(deleteCalls.length).toBe(0);
    });
  });

  describe("addEntry", () => {
    it("inserts entry with correct parameters", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      const entry = await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "Hello",
        taskPda: "task-pda",
        metadata: { key: "val" },
      });

      expect(entry.sessionId).toBe("s1");
      expect(entry.role).toBe("user");
      expect(entry.content).toBe("Hello");
      expect(entry.taskPda).toBe("task-pda");
      expect(entry.metadata).toEqual({ key: "val" });
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);

      // Check the INSERT was called
      const insertCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("INSERT INTO memory_entries"),
      );
      expect(insertCalls.length).toBe(1);
    });

    it("passes TTL as expires_at", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      const before = Date.now();
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "temp",
        ttlMs: 5000,
      });

      // The last call to run should have an expires_at value
      const runArgs = mockRun.mock.calls[mockRun.mock.calls.length - 1];
      const expiresAt = runArgs[9]; // 10th parameter
      expect(expiresAt).toBeGreaterThanOrEqual(before + 5000);
    });

    it("passes null expires_at when no TTL", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "perm",
      });

      const runArgs = mockRun.mock.calls[mockRun.mock.calls.length - 1];
      const expiresAt = runArgs[9];
      expect(expiresAt).toBeNull();
    });
  });

  describe("getThread", () => {
    it("queries by session_id with expiry filter", async () => {
      const backend = new SqliteBackend();
      mockAll.mockReturnValue([
        {
          id: "1",
          session_id: "s1",
          role: "user",
          content: "hi",
          timestamp: 100,
        },
      ]);

      const thread = await backend.getThread("s1");

      expect(thread).toHaveLength(1);
      expect(thread[0].sessionId).toBe("s1");

      const selectCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("SELECT") &&
          c[0].includes("session_id"),
      );
      expect(selectCalls.length).toBeGreaterThan(0);
    });

    it("applies limit as subquery", async () => {
      const backend = new SqliteBackend();
      mockAll.mockReturnValue([]);

      await backend.getThread("s1", 10);

      const selectCalls = mockPrepare.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("LIMIT"),
      );
      expect(selectCalls.length).toBeGreaterThan(0);
    });
  });

  describe("query", () => {
    it("builds query with all filters", async () => {
      const backend = new SqliteBackend();
      mockAll.mockReturnValue([]);

      await backend.query({
        sessionId: "s1",
        taskPda: "task-1",
        after: 100,
        before: 200,
        role: "user",
        limit: 5,
        order: "desc",
      });

      const selectCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("SELECT") &&
          c[0].includes("memory_entries WHERE"),
      );
      expect(selectCalls.length).toBeGreaterThan(0);
      const sql = selectCalls[selectCalls.length - 1][0];
      expect(sql).toContain("session_id = ?");
      expect(sql).toContain("task_pda = ?");
      expect(sql).toContain("timestamp > ?");
      expect(sql).toContain("timestamp < ?");
      expect(sql).toContain("role = ?");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("DESC");
    });
  });

  describe("deleteThread", () => {
    it("deletes entries and returns count", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 3 });

      const count = await backend.deleteThread("s1");
      expect(count).toBe(3);
    });
  });

  describe("listSessions", () => {
    it("returns distinct session IDs", async () => {
      const backend = new SqliteBackend();
      mockAll.mockReturnValue([{ session_id: "a" }, { session_id: "b" }]);

      const sessions = await backend.listSessions();
      expect(sessions).toEqual(["a", "b"]);
    });

    it("filters by prefix using LIKE", async () => {
      const backend = new SqliteBackend();
      mockAll.mockReturnValue([{ session_id: "task-1" }]);

      await backend.listSessions("task-");

      const selectCalls = mockPrepare.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("LIKE"),
      );
      expect(selectCalls.length).toBeGreaterThan(0);
    });
  });

  describe("KV operations", () => {
    it("set uses INSERT OR REPLACE", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      await backend.set("mykey", { foo: "bar" });

      const insertCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("INSERT OR REPLACE INTO memory_kv"),
      );
      expect(insertCalls.length).toBe(1);
    });

    it("get deserializes JSON value", async () => {
      const backend = new SqliteBackend();
      mockGet.mockReturnValue({ value: '{"foo":"bar"}' });

      const result = await backend.get<{ foo: string }>("mykey");
      expect(result).toEqual({ foo: "bar" });
    });

    it("get returns undefined for missing key", async () => {
      const backend = new SqliteBackend();
      mockGet.mockReturnValue(undefined);

      const result = await backend.get("missing");
      expect(result).toBeUndefined();
    });

    it("delete returns true when row deleted", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      expect(await backend.delete("key")).toBe(true);
    });

    it("delete returns false when no row", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 0 });

      expect(await backend.delete("missing")).toBe(false);
    });

    it("has checks existence with expiry filter", async () => {
      const backend = new SqliteBackend();
      mockGet.mockReturnValue({ 1: 1 });

      expect(await backend.has("key")).toBe(true);
    });
  });

  describe("lifecycle", () => {
    it("clear deletes from both tables", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 0 });

      await backend.clear();

      const deleteCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" && c[0] === "DELETE FROM memory_entries",
      );
      const kvDeleteCalls = mockPrepare.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" && c[0] === "DELETE FROM memory_kv",
      );
      expect(deleteCalls.length).toBe(1);
      expect(kvDeleteCalls.length).toBe(1);
    });

    it("close calls db.close()", async () => {
      const backend = new SqliteBackend();
      // Trigger lazy init
      await backend.getThread("s1");

      await backend.close();
      expect(mockClose).toHaveBeenCalled();
    });

    it("operations throw after close", async () => {
      const backend = new SqliteBackend();
      await backend.getThread("s1"); // init
      await backend.close();

      await expect(
        backend.addEntry({ sessionId: "s1", role: "user", content: "x" }),
      ).rejects.toThrow(MemoryBackendError);
    });

    it("healthCheck returns false when closed", async () => {
      const backend = new SqliteBackend();
      await backend.close();
      expect(await backend.healthCheck()).toBe(false);
    });

    it("healthCheck returns true when db responds", async () => {
      const backend = new SqliteBackend();
      mockGet.mockReturnValue({ 1: 1 });
      await backend.getThread("s1"); // init

      expect(await backend.healthCheck()).toBe(true);
    });
  });

  describe("serialization errors", () => {
    it("throws MemorySerializationError for non-serializable metadata", async () => {
      const backend = new SqliteBackend();
      mockRun.mockReturnValue({ changes: 1 });

      const circular: any = {};
      circular.self = circular;

      await expect(
        backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "x",
          metadata: circular,
        }),
      ).rejects.toThrow(MemorySerializationError);
    });

    it("throws MemorySerializationError for non-serializable KV value", async () => {
      const backend = new SqliteBackend();

      const circular: any = {};
      circular.self = circular;

      await expect(backend.set("key", circular)).rejects.toThrow(
        MemorySerializationError,
      );
    });
  });
});
