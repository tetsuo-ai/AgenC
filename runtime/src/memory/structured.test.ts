import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatLogDate,
  DailyLogManager,
  CuratedMemoryManager,
  NoopEntityExtractor,
  type StructuredMemoryEntry,
} from "./structured.js";

// ---------------------------------------------------------------------------
// formatLogDate
// ---------------------------------------------------------------------------

describe("formatLogDate", () => {
  it("returns YYYY-MM-DD for a known date", () => {
    const d = new Date("2025-03-15T10:30:00Z");
    expect(formatLogDate(d)).toBe("2025-03-15");
  });

  it("defaults to current date when no argument given", () => {
    const result = formatLogDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses UTC to avoid timezone shifts", () => {
    // Jan 1 00:30 UTC — in UTC-5 this would still be Dec 31
    const d = new Date("2025-01-01T00:30:00Z");
    expect(formatLogDate(d)).toBe("2025-01-01");
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date("2025-02-03T12:00:00Z");
    expect(formatLogDate(d)).toBe("2025-02-03");
  });
});

// ---------------------------------------------------------------------------
// StructuredMemoryEntry
// ---------------------------------------------------------------------------

describe("StructuredMemoryEntry", () => {
  it("has all required fields", () => {
    const entry: StructuredMemoryEntry = {
      id: "e1",
      content: "Alice prefers dark mode",
      entityName: "Alice",
      entityType: "person",
      confidence: 0.9,
      source: "conversation",
      tags: ["preference"],
      createdAt: Date.now(),
    };
    expect(entry.id).toBe("e1");
    expect(entry.tags).toEqual(["preference"]);
  });
});

// ---------------------------------------------------------------------------
// DailyLogManager
// ---------------------------------------------------------------------------

describe("DailyLogManager", () => {
  let tmpDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "daily-log-"));
    logDir = join(tmpDir, "logs");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the log file on first append", async () => {
    const mgr = new DailyLogManager(logDir);
    await mgr.append("sess-1", "user", "Hello");
    const content = await mgr.readLog(formatLogDate());
    expect(content).toBeDefined();
    expect(content).toContain("**User:** Hello");
  });

  it("appends to the same file on subsequent calls", async () => {
    const mgr = new DailyLogManager(logDir);
    await mgr.append("sess-1", "user", "Hello");
    await mgr.append("sess-1", "assistant", "Hi there");
    const content = await mgr.readLog(formatLogDate());
    expect(content).toContain("**User:** Hello");
    expect(content).toContain("**Agent:** Hi there");
  });

  it("includes timestamp and session id in entries", async () => {
    const mgr = new DailyLogManager(logDir);
    await mgr.append("sess-42", "user", "test");
    const content = await mgr.readLog(formatLogDate());
    expect(content).toMatch(/## \d{2}:\d{2} \[sess-42\]/);
  });

  it("writes multiple sessions to the same day file", async () => {
    const mgr = new DailyLogManager(logDir);
    await mgr.append("sess-1", "user", "from session 1");
    await mgr.append("sess-2", "user", "from session 2");
    const content = await mgr.readLog(formatLogDate());
    expect(content).toContain("[sess-1]");
    expect(content).toContain("[sess-2]");
  });

  it("readLog returns undefined for missing date", async () => {
    const mgr = new DailyLogManager(logDir);
    const result = await mgr.readLog("1999-01-01");
    expect(result).toBeUndefined();
  });

  it("listDates returns sorted date strings", async () => {
    const mgr = new DailyLogManager(logDir);
    await mgr.append("s1", "user", "a");
    const dates = await mgr.listDates();
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("listDates returns empty array for missing dir", async () => {
    const mgr = new DailyLogManager(join(tmpDir, "nonexistent"));
    const dates = await mgr.listDates();
    expect(dates).toEqual([]);
  });

  it("todayPath uses current date", () => {
    const mgr = new DailyLogManager("/some/dir");
    expect(mgr.todayPath).toContain(formatLogDate());
    expect(mgr.todayPath).toMatch(/\.md$/);
  });

  it("truncates oversized log entries", async () => {
    const mgr = new DailyLogManager(logDir);
    const huge = "x".repeat(20_000);
    await mgr.append("sess-1", "assistant", huge);
    const content = await mgr.readLog(formatLogDate());
    expect(content).toBeDefined();
    expect(content!.length).toBeLessThan(13_000);
    expect(content).toContain("...");
  });
});

// ---------------------------------------------------------------------------
// CuratedMemoryManager
// ---------------------------------------------------------------------------

describe("CuratedMemoryManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "curated-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("load reads file content", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "MEMORY.md"));
    await mgr.addFact("sky is blue");
    const content = await mgr.load();
    expect(content).toContain("- sky is blue");
  });

  it("load returns empty string if file missing", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "nope.md"));
    expect(await mgr.load()).toBe("");
  });

  it("addFact appends a bullet line", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "MEMORY.md"));
    await mgr.addFact("first");
    await mgr.addFact("second");
    const content = await mgr.load();
    expect(content).toBe("- first\n- second\n");
  });

  it("removeFact removes matching line", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "MEMORY.md"));
    await mgr.addFact("keep");
    await mgr.addFact("remove me");
    await mgr.addFact("also keep");
    const removed = await mgr.removeFact("remove me");
    expect(removed).toBe(true);
    const content = await mgr.load();
    expect(content).toContain("- keep");
    expect(content).toContain("- also keep");
    expect(content).not.toContain("remove me");
  });

  it("removeFact returns false if not found", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "MEMORY.md"));
    await mgr.addFact("existing");
    expect(await mgr.removeFact("nonexistent")).toBe(false);
  });

  it("removeFact returns false if file missing", async () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "nope.md"));
    expect(await mgr.removeFact("anything")).toBe(false);
  });

  it("proposeAddition formats with source", () => {
    const mgr = new CuratedMemoryManager(join(tmpDir, "MEMORY.md"));
    expect(mgr.proposeAddition("sky is blue", "observation")).toBe(
      "- sky is blue (source: observation)",
    );
  });
});

// ---------------------------------------------------------------------------
// NoopEntityExtractor
// ---------------------------------------------------------------------------

describe("NoopEntityExtractor", () => {
  it("extract returns empty array", async () => {
    const extractor = new NoopEntityExtractor();
    const result = await extractor.extract("some text", "sess-1");
    expect(result).toEqual([]);
  });
});
