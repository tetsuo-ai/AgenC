import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type ReplayBackfillInput,
  ReplayBackfillOutputSchema,
  type ReplayCompareInput,
  ReplayCompareOutputSchema,
  type ReplayIncidentInput,
  ReplayIncidentOutputSchema,
  ReplayToolErrorSchema,
} from './replay-types.js';
import {
  runReplayBackfillTool,
  runReplayCompareTool,
  runReplayIncidentTool,
  type ReplayPolicy,
  type ReplayToolRuntime,
} from './replay.js';
import { truncateOutput } from '../utils/truncation.js';

type FakeReplayStore = {
  save: (records: readonly Record<string, unknown>[]) => Promise<{ inserted: number; duplicates: number }>;
  query: (filter?: Record<string, unknown>) => Promise<readonly Record<string, unknown>[]>;
  getCursor: () => Promise<Record<string, unknown> | null>;
  saveCursor: (cursor: Record<string, unknown> | null) => Promise<void>;
  clear: () => Promise<void>;
};

type FakeBackfillFetcher = {
  fetchPage: () => Promise<{
    events: unknown[];
    nextCursor: Record<string, unknown> | null;
    done: boolean;
  }>;
};

type TestRuntime = {
  store: FakeReplayStore;
  fetcher?: FakeBackfillFetcher;
  trace?: string;
};

function createInMemoryReplayStore(): FakeReplayStore {
  let cursor: Record<string, unknown> | null = null;
  const records: Record<string, unknown>[] = [];
  const index = new Set<string>();

  return {
    async save(input) {
      let inserted = 0;
      let duplicates = 0;
      for (const event of input) {
        const key = `${String(event.slot)}|${String(event.signature)}|${String(event.sourceEventType ?? event.type ?? '')}`;
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
      const typedFilter = filter as { taskPda?: string; disputePda?: string; fromSlot?: number; toSlot?: number };
      return records.filter((event) => {
        const slot = typeof event.slot === 'number' ? event.slot : Number(event.slot ?? 0);
        if (typedFilter.taskPda !== undefined && event.taskPda !== typedFilter.taskPda) {
          return false;
        }
        if (typedFilter.disputePda !== undefined && event.disputePda !== typedFilter.disputePda) {
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

function createReplayRuntime(runtime: TestRuntime): ReplayToolRuntime {
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
    readLocalTrace(path) {
      const trace = runtime.trace ?? '';
      if (path === trace) {
        return JSON.parse(readFileSync(trace, 'utf8'));
      }
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    async getCurrentSlot() {
      return 1_000;
    },
  };
}

function buildReplayPolicy(): ReplayPolicy {
  return {
    maxSlotWindow: 1_000_000,
    maxEventCount: 25_000,
    maxConcurrentJobs: 5,
    maxToolRuntimeMs: 60_000,
    allowlist: new Set<string>(),
    denylist: new Set<string>(),
    defaultRedactions: ['signature'],
    auditEnabled: false,
  };
}

async function runWithTempTrace<T>(trace: object, callback: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agenc-mcp-replay-truncation-test-'));
  const tracePath = join(dir, 'trace.json');
  try {
    writeFileSync(tracePath, JSON.stringify(trace));
    return callback(tracePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildStoreRecord(index: number): Record<string, unknown> {
  const signature = `sig-${String(index).padStart(6, '0')}`;
  const slot = 10 + index;
  const eventType = index % 2 === 0 ? 'discovered' : 'claimed';
  return {
    seq: index + 1,
    type: eventType,
    sourceEventName: eventType,
    sourceEventType: eventType,
    taskPda: 'AGENTtask',
    disputePda: undefined,
    signature,
    slot,
    timestampMs: 1_000 + index,
    payload: {
      onchain: {
        signature,
        slot,
        trace: {
          traceId: 'incident-trace',
          spanId: `span-${index}`,
          sampled: true,
        },
      },
    },
    projectionHash: `hash-${index}`,
  };
}

test('truncateOutput: within budget', () => {
  const result = truncateOutput(
    { status: 'ok', items: ['a', 'b'] },
    1_000,
    (value) => ({ ...value, items: [] }),
  );

  assert.equal(result.truncated, false);
  assert.equal(result.reason, null);
  assert.equal(result.originalBytes, result.finalBytes);
});

test('truncateOutput: needs trim', () => {
  const result = truncateOutput(
    { status: 'ok', payload: 'x'.repeat(512) },
    80,
    (value) => ({ ...value, payload: '' }),
  );

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'trimmed_to_minimum');
  assert.equal(result.finalBytes <= 80, true);
});

test('truncateOutput: exceeds even after trim', () => {
  const result = truncateOutput(
    { status: 'ok', payload: 'x'.repeat(512) },
    8,
    (value) => ({ ...value, payload: 'still-too-large' }),
  );

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'payload_limit_exceeded');
  assert.equal(result.finalBytes > 8, true);
});

test('truncation: incident large window', async () => {
  const store = createInMemoryReplayStore();
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    records.push(buildStoreRecord(i));
  }
  await store.save(records);

  const output = await runReplayIncidentTool(
    {
      task_pda: 'AGENTtask',
      store_type: 'memory',
      strict_mode: false,
      max_payload_bytes: 5_000,
    } as ReplayIncidentInput,
    createReplayRuntime({ store }),
    buildReplayPolicy(),
  );

  assert.equal(output.isError, false);
  const success = ReplayIncidentOutputSchema.parse(output.structuredContent);
  assert.equal(success.truncated, true);
  assert.equal(success.truncation_reason !== null, true);
});

test('truncation: incident small window', async () => {
  const store = createInMemoryReplayStore();
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(buildStoreRecord(i));
  }
  await store.save(records);

  const output = await runReplayIncidentTool(
    {
      task_pda: 'AGENTtask',
      store_type: 'memory',
      strict_mode: false,
      max_payload_bytes: 120_000,
    } as ReplayIncidentInput,
    createReplayRuntime({ store }),
    buildReplayPolicy(),
  );

  assert.equal(output.isError, false);
  const success = ReplayIncidentOutputSchema.parse(output.structuredContent);
  assert.equal(success.truncated, false);
  assert.equal(success.truncation_reason, null);
});

test('truncation: compare large anomalies', async () => {
  const trace = {
    schemaVersion: 1,
    traceId: 'compare-large-anomalies',
    seed: 0,
    createdAtMs: 1,
    events: [{
      seq: 1,
      type: 'discovered',
      taskPda: 'AGENTtask',
      timestampMs: 1_000,
      payload: {
        onchain: {
          signature: 'sig-local-001',
          slot: 10,
          trace: {
            traceId: 'compare-large-anomalies',
            spanId: 'span-local-001',
          },
        },
      },
    }],
  };

  const output = await runWithTempTrace(trace, async (tracePath) => {
    const store = createInMemoryReplayStore();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 500; i += 1) {
      records.push(buildStoreRecord(i));
    }
    await store.save(records);

    return runReplayCompareTool(
      {
        local_trace_path: tracePath,
        store_type: 'memory',
        strict_mode: false,
        max_payload_bytes: 5_000,
      } as ReplayCompareInput,
      createReplayRuntime({ store, trace: tracePath }),
      buildReplayPolicy(),
    );
  });

  if (output.isError) {
    const failure = ReplayToolErrorSchema.parse(output.structuredContent);
    assert.equal(failure.command, 'agenc_replay_compare');
    assert.equal(failure.code, 'replay.compare_failed');
    return;
  }

  const success = ReplayCompareOutputSchema.parse(output.structuredContent);
  assert.equal(success.truncated, true);
});

test('truncation: backfill cursor preserved', async () => {
  const store = createInMemoryReplayStore();
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
      max_payload_bytes: 1,
    } as ReplayBackfillInput,
    createReplayRuntime({
      store,
      fetcher: {
        async fetchPage() {
          return {
            events: [{
              eventName: 'discovered',
              event: { payload: 'x'.repeat(2048) },
              slot: 10,
              signature: 'sig-001',
              sourceEventSequence: 0,
            }],
            nextCursor: {
              slot: 10,
              signature: 'sig-001',
              eventName: 'discovered',
            },
            done: true,
          };
        },
      },
    }),
    buildReplayPolicy(),
  );

  assert.equal(output.isError, false);
  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.truncated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(success.result, 'cursor'), true);
  assert.equal(success.result.cursor, null);
});
