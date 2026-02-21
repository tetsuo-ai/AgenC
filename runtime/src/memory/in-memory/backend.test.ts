import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryBackend } from "./backend.js";
import { MemoryBackendError } from "../errors.js";

describe("InMemoryBackend", () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
  });

  // ---------- Entry CRUD ----------

  describe("addEntry", () => {
    it("creates an entry with UUID id and timestamp", async () => {
      const entry = await backend.addEntry({
        sessionId: "sess-1",
        role: "user",
        content: "Hello",
      });

      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(entry.sessionId).toBe("sess-1");
      expect(entry.role).toBe("user");
      expect(entry.content).toBe("Hello");
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    it("stores optional fields", async () => {
      const entry = await backend.addEntry({
        sessionId: "sess-1",
        role: "tool",
        content: '{"result": 42}',
        toolCallId: "call_123",
        toolName: "calculator",
        taskPda: "ABC123",
        metadata: { foo: "bar" },
      });

      expect(entry.toolCallId).toBe("call_123");
      expect(entry.toolName).toBe("calculator");
      expect(entry.taskPda).toBe("ABC123");
      expect(entry.metadata).toEqual({ foo: "bar" });
    });
  });

  describe("getThread", () => {
    it("returns entries in chronological order", async () => {
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "first",
      });
      await backend.addEntry({
        sessionId: "s1",
        role: "assistant",
        content: "second",
      });
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "third",
      });

      const thread = await backend.getThread("s1");
      expect(thread).toHaveLength(3);
      expect(thread[0].content).toBe("first");
      expect(thread[2].content).toBe("third");
    });

    it("returns empty array for unknown session", async () => {
      const thread = await backend.getThread("nonexistent");
      expect(thread).toEqual([]);
    });

    it("respects limit parameter (returns most recent)", async () => {
      for (let i = 0; i < 10; i++) {
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: `msg-${i}`,
        });
      }

      const thread = await backend.getThread("s1", 3);
      expect(thread).toHaveLength(3);
      expect(thread[0].content).toBe("msg-7");
      expect(thread[2].content).toBe("msg-9");
    });

    it("isolates sessions", async () => {
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "session 1",
      });
      await backend.addEntry({
        sessionId: "s2",
        role: "user",
        content: "session 2",
      });

      const t1 = await backend.getThread("s1");
      const t2 = await backend.getThread("s2");
      expect(t1).toHaveLength(1);
      expect(t2).toHaveLength(1);
      expect(t1[0].content).toBe("session 1");
      expect(t2[0].content).toBe("session 2");
    });
  });

  // ---------- Query ----------

  describe("query", () => {
    beforeEach(async () => {
      // Create entries with small time gaps
      const base = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(base);
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "a",
        taskPda: "task-1",
      });
      vi.setSystemTime(base + 100);
      await backend.addEntry({
        sessionId: "s1",
        role: "assistant",
        content: "b",
        taskPda: "task-1",
      });
      vi.setSystemTime(base + 200);
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "c",
        taskPda: "task-2",
      });
      vi.setSystemTime(base + 300);
      await backend.addEntry({ sessionId: "s2", role: "user", content: "d" });
      vi.useRealTimers();
    });

    it("filters by sessionId", async () => {
      const results = await backend.query({ sessionId: "s1" });
      expect(results).toHaveLength(3);
    });

    it("filters by taskPda", async () => {
      const results = await backend.query({ taskPda: "task-1" });
      expect(results).toHaveLength(2);
    });

    it("filters by role", async () => {
      const results = await backend.query({ role: "assistant" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("b");
    });

    it("filters by time range (after/before)", async () => {
      const all = await backend.query({});
      const afterTime = all[0].timestamp;
      const beforeTime = all[2].timestamp;

      const results = await backend.query({
        after: afterTime,
        before: beforeTime,
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("b");
    });

    it("supports desc order", async () => {
      const results = await backend.query({ sessionId: "s1", order: "desc" });
      expect(results[0].content).toBe("c");
      expect(results[2].content).toBe("a");
    });

    it("supports limit", async () => {
      const results = await backend.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("returns all entries when no filters provided", async () => {
      const results = await backend.query({});
      expect(results).toHaveLength(4);
    });
  });

  // ---------- deleteThread ----------

  describe("deleteThread", () => {
    it("deletes thread and returns count", async () => {
      await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
      await backend.addEntry({
        sessionId: "s1",
        role: "assistant",
        content: "b",
      });

      const count = await backend.deleteThread("s1");
      expect(count).toBe(2);

      const thread = await backend.getThread("s1");
      expect(thread).toEqual([]);
    });

    it("returns 0 for nonexistent session", async () => {
      const count = await backend.deleteThread("nope");
      expect(count).toBe(0);
    });
  });

  // ---------- listSessions ----------

  describe("listSessions", () => {
    it("lists all session IDs", async () => {
      await backend.addEntry({
        sessionId: "alpha",
        role: "user",
        content: "a",
      });
      await backend.addEntry({ sessionId: "beta", role: "user", content: "b" });

      const sessions = await backend.listSessions();
      expect(sessions).toContain("alpha");
      expect(sessions).toContain("beta");
    });

    it("filters by prefix", async () => {
      await backend.addEntry({
        sessionId: "task-1-sess",
        role: "user",
        content: "a",
      });
      await backend.addEntry({
        sessionId: "task-2-sess",
        role: "user",
        content: "b",
      });
      await backend.addEntry({
        sessionId: "other",
        role: "user",
        content: "c",
      });

      const sessions = await backend.listSessions("task-");
      expect(sessions).toHaveLength(2);
    });
  });

  // ---------- KV Operations ----------

  describe("key-value operations", () => {
    it("set and get", async () => {
      await backend.set("key1", { data: "value" });
      const result = await backend.get<{ data: string }>("key1");
      expect(result).toEqual({ data: "value" });
    });

    it("get returns undefined for missing key", async () => {
      const result = await backend.get("missing");
      expect(result).toBeUndefined();
    });

    it("delete returns true for existing key", async () => {
      await backend.set("key1", "val");
      expect(await backend.delete("key1")).toBe(true);
      expect(await backend.get("key1")).toBeUndefined();
    });

    it("delete returns false for missing key", async () => {
      expect(await backend.delete("nope")).toBe(false);
    });

    it("has returns correct state", async () => {
      await backend.set("key1", "val");
      expect(await backend.has("key1")).toBe(true);
      expect(await backend.has("nope")).toBe(false);
    });

    it("listKeys returns all keys", async () => {
      await backend.set("a:1", 1);
      await backend.set("a:2", 2);
      await backend.set("b:1", 3);

      const all = await backend.listKeys();
      expect(all).toHaveLength(3);
    });

    it("listKeys filters by prefix", async () => {
      await backend.set("a:1", 1);
      await backend.set("a:2", 2);
      await backend.set("b:1", 3);

      const filtered = await backend.listKeys("a:");
      expect(filtered).toHaveLength(2);
    });

    it("stores various value types", async () => {
      await backend.set("str", "hello");
      await backend.set("num", 42);
      await backend.set("arr", [1, 2, 3]);
      await backend.set("null", null);
      await backend.set("bool", true);

      expect(await backend.get("str")).toBe("hello");
      expect(await backend.get("num")).toBe(42);
      expect(await backend.get("arr")).toEqual([1, 2, 3]);
      expect(await backend.get("null")).toBeNull();
      expect(await backend.get("bool")).toBe(true);
    });
  });

  // ---------- TTL ----------

  describe("TTL expiry", () => {
    it("expires entries after ttlMs", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "ephemeral",
        ttlMs: 1000,
      });
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "permanent",
      });

      let thread = await backend.getThread("s1");
      expect(thread).toHaveLength(2);

      // Advance past TTL
      vi.setSystemTime(now + 1001);
      thread = await backend.getThread("s1");
      expect(thread).toHaveLength(1);
      expect(thread[0].content).toBe("permanent");

      vi.useRealTimers();
    });

    it("expires KV entries after ttlMs", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      await backend.set("temp", "value", 500);
      expect(await backend.get("temp")).toBe("value");
      expect(await backend.has("temp")).toBe(true);

      vi.setSystemTime(now + 501);
      expect(await backend.get("temp")).toBeUndefined();
      expect(await backend.has("temp")).toBe(false);

      vi.useRealTimers();
    });

    it("uses defaultTtlMs when entry ttlMs not specified", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const b = new InMemoryBackend({ defaultTtlMs: 200 });
      await b.addEntry({
        sessionId: "s1",
        role: "user",
        content: "auto-expire",
      });

      vi.setSystemTime(now + 201);
      const thread = await b.getThread("s1");
      expect(thread).toHaveLength(0);

      vi.useRealTimers();
    });

    it("expires KV entries from listKeys", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      await backend.set("temp", "val", 500);
      await backend.set("perm", "val");

      vi.setSystemTime(now + 501);
      const keys = await backend.listKeys();
      expect(keys).toEqual(["perm"]);

      vi.useRealTimers();
    });
  });

  // ---------- Capacity Limits ----------

  describe("capacity limits", () => {
    it("evicts oldest entry when session hits maxEntriesPerSession", async () => {
      const b = new InMemoryBackend({ maxEntriesPerSession: 3 });

      await b.addEntry({ sessionId: "s1", role: "user", content: "msg-0" });
      await b.addEntry({ sessionId: "s1", role: "user", content: "msg-1" });
      await b.addEntry({ sessionId: "s1", role: "user", content: "msg-2" });
      await b.addEntry({ sessionId: "s1", role: "user", content: "msg-3" });

      const thread = await b.getThread("s1");
      expect(thread).toHaveLength(3);
      expect(thread[0].content).toBe("msg-1");
      expect(thread[2].content).toBe("msg-3");
    });

    it("evicts globally when maxTotalEntries is reached", async () => {
      const b = new InMemoryBackend({ maxTotalEntries: 3 });

      await b.addEntry({ sessionId: "s1", role: "user", content: "a" });
      await b.addEntry({ sessionId: "s2", role: "user", content: "b" });
      await b.addEntry({ sessionId: "s3", role: "user", content: "c" });
      // This should evict the oldest entry globally
      await b.addEntry({ sessionId: "s4", role: "user", content: "d" });

      // s1 should have been evicted (oldest)
      const t1 = await b.getThread("s1");
      expect(t1).toHaveLength(0);
    });
  });

  // ---------- Lifecycle ----------

  describe("lifecycle", () => {
    it("clear removes all data", async () => {
      await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
      await backend.set("key1", "val");

      await backend.clear();

      expect(await backend.getThread("s1")).toEqual([]);
      expect(await backend.get("key1")).toBeUndefined();
      expect(await backend.listSessions()).toEqual([]);
    });

    it("close prevents further operations", async () => {
      await backend.close();

      await expect(
        backend.addEntry({ sessionId: "s1", role: "user", content: "a" }),
      ).rejects.toThrow(MemoryBackendError);
      await expect(backend.getThread("s1")).rejects.toThrow(MemoryBackendError);
      await expect(backend.set("k", "v")).rejects.toThrow(MemoryBackendError);
      await expect(backend.get("k")).rejects.toThrow(MemoryBackendError);
    });

    it("healthCheck returns true when open", async () => {
      expect(await backend.healthCheck()).toBe(true);
    });

    it("healthCheck returns false when closed", async () => {
      await backend.close();
      expect(await backend.healthCheck()).toBe(false);
    });
  });

  // ---------- Edge Cases ----------

  describe("edge cases", () => {
    it("handles empty content", async () => {
      const entry = await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "",
      });
      expect(entry.content).toBe("");
    });

    it("returned entries do not expose internal _expiresAt", async () => {
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "x",
        ttlMs: 5000,
      });
      const thread = await backend.getThread("s1");
      expect(thread[0]).not.toHaveProperty("_expiresAt");
    });

    it("query respects expired entries", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "temp",
        ttlMs: 100,
      });
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "perm",
      });

      vi.setSystemTime(now + 101);
      const results = await backend.query({ sessionId: "s1" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("perm");

      vi.useRealTimers();
    });
  });
});
