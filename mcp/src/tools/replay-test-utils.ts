import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReplayBackfillTool, type ReplayPolicy } from "./replay.js";

type ReplayToolRuntime = Parameters<typeof runReplayBackfillTool>[1];

export type FakeReplayStore = {
  save: (
    records: readonly Record<string, unknown>[],
  ) => Promise<{ inserted: number; duplicates: number }>;
  query: (
    filter?: Record<string, unknown>,
  ) => Promise<readonly Record<string, unknown>[]>;
  getCursor: () => Promise<Record<string, unknown> | null>;
  saveCursor: (cursor: Record<string, unknown> | null) => Promise<void>;
  clear: () => Promise<void>;
};

export type FakeBackfillFetcher = {
  fetchPage: () => Promise<{
    events: unknown[];
    nextCursor: Record<string, unknown> | null;
    done: boolean;
  }>;
};

export type TestRuntime = {
  store: FakeReplayStore;
  fetcher?: FakeBackfillFetcher;
  trace?: string;
};

export function createInMemoryReplayStore(): FakeReplayStore {
  let cursor: Record<string, unknown> | null = null;
  const records: Record<string, unknown>[] = [];
  const index = new Set<string>();

  return {
    async save(input) {
      let inserted = 0;
      let duplicates = 0;
      for (const event of input) {
        const key = `${String(event.slot)}|${String(event.signature)}|${String(event.sourceEventType ?? event.type ?? "")}`;
        if (index.has(key)) {
          duplicates += 1;
          continue;
        }
        index.add(key);
        records.push(event);
        inserted += 1;
      }
      return { inserted, duplicates };
    },
    async query(filter = {}) {
      const typedFilter = filter as {
        taskPda?: string;
        disputePda?: string;
        fromSlot?: number;
        toSlot?: number;
      };
      return records.filter((event) => {
        const slot =
          typeof event.slot === "number" ? event.slot : Number(event.slot ?? 0);
        if (
          typedFilter.taskPda !== undefined &&
          event.taskPda !== typedFilter.taskPda
        ) {
          return false;
        }
        if (
          typedFilter.disputePda !== undefined &&
          event.disputePda !== typedFilter.disputePda
        ) {
          return false;
        }
        if (typedFilter.fromSlot !== undefined && slot < typedFilter.fromSlot) {
          return false;
        }
        if (typedFilter.toSlot !== undefined && slot > typedFilter.toSlot) {
          return false;
        }
        return true;
      });
    },
    async getCursor() {
      return cursor;
    },
    async saveCursor(value) {
      cursor = value;
    },
    async clear() {
      records.length = 0;
      index.clear();
      cursor = null;
    },
  };
}

export function createReplayRuntime(runtime: TestRuntime): ReplayToolRuntime {
  return {
    createStore: () => runtime.store,
    createBackfillFetcher: () => {
      if (!runtime.fetcher) {
        return {
          async fetchPage() {
            return { events: [], nextCursor: null, done: true };
          },
        };
      }
      return runtime.fetcher;
    },
    readLocalTrace(path: string) {
      const trace = runtime.trace ?? "";
      if (path === trace) {
        return JSON.parse(readFileSync(trace, "utf8"));
      }
      return JSON.parse(readFileSync(path, "utf8"));
    },
    async getCurrentSlot() {
      return 1_000;
    },
  } as unknown as ReplayToolRuntime;
}

export function buildReplayPolicy(
  overrides: Partial<ReplayPolicy> = {},
): ReplayPolicy {
  return {
    maxSlotWindow: overrides.maxSlotWindow ?? 1_000_000,
    maxEventCount: overrides.maxEventCount ?? 100,
    maxConcurrentJobs: overrides.maxConcurrentJobs ?? 5,
    maxToolRuntimeMs: overrides.maxToolRuntimeMs ?? 60_000,
    allowlist: overrides.allowlist ?? new Set<string>(),
    denylist: overrides.denylist ?? new Set<string>(),
    defaultRedactions: overrides.defaultRedactions ?? ["signature"],
    auditEnabled: overrides.auditEnabled ?? false,
  };
}

export async function runWithTempTrace<T>(
  trace: object,
  callback: (path: string) => Promise<T>,
  prefix = "agenc-mcp-replay-test-",
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const tracePath = join(dir, "trace.json");
  try {
    writeFileSync(tracePath, JSON.stringify(trace));
    return callback(tracePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
