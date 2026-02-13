import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ReplayBackfillOutputSchema,
  ReplayCompareOutputSchema,
  ReplayIncidentOutputSchema,
  ReplayStatusOutputSchema,
  ReplayToolErrorSchema,
  type ReplayBackfillInput,
  type ReplayCompareInput,
  type ReplayIncidentInput,
  type ReplayStatusInput,
} from './replay-types.js';
import {
  runReplayBackfillTool,
  runReplayCompareTool,
  runReplayIncidentTool,
  runReplayStatusTool,
  type ReplayToolRuntime,
  type ReplayPolicy,
} from './replay.js';

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
      return records.filter((event) => {
        if (filter.taskPda !== undefined && event.taskPda !== filter.taskPda) {
          return false;
        }
        if (filter.disputePda !== undefined && event.disputePda !== filter.disputePda) {
          return false;
        }
        if (filter.fromSlot !== undefined && event.slot < filter.fromSlot) {
          return false;
        }
        if (filter.toSlot !== undefined && event.slot > filter.toSlot) {
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

function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const neverResolveBackfillFetcher: FakeBackfillFetcher = {
  async fetchPage() {
    return neverResolve();
  },
};

const deniedReplayExtra = {
  authInfo: { clientId: 'policy-denied-actor' },
  requestId: 'policy-deny-test',
};

const allowlistedReplayExtra = {
  authInfo: { clientId: 'policy-allowed-actor' },
  requestId: 'policy-allow-test',
};

const sessionReplayExtra = {
  sessionId: 'policy-session-001',
  requestId: 'policy-session-test',
};

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
        return JSON.parse(readFileSyncUtf8(trace));
      }
      return JSON.parse(readFileSyncUtf8(path));
    },
    async getCurrentSlot() {
      return 1_000;
    },
  };
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

function buildReplayPolicy(): ReplayPolicy {
  return {
    maxSlotWindow: 1_000_000,
    maxEventCount: 100,
    maxConcurrentJobs: 5,
    maxToolRuntimeMs: 60_000,
    allowlist: new Set<string>(),
    denylist: new Set<string>(),
    defaultRedactions: ['signature'],
    auditEnabled: false,
  };
}

async function runWithTempTrace(trace: object, callback: (path: string) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'agenc-mcp-replay-test-'));
  const tracePath = join(dir, 'trace.json');
  try {
    writeFileSync(tracePath, JSON.stringify(trace));
    return callback(tracePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const storeRecord = {
  seq: 1,
  type: 'discovered',
  sourceEventName: 'discovered',
  sourceEventType: 'discovered',
  taskPda: 'AGENTtask',
  disputePda: undefined,
  signature: 'sig-001',
  slot: 10,
  timestampMs: 1_000,
  payload: {
    onchain: {
      signature: 'sig-001',
      slot: 10,
      trace: {
        traceId: 'incident-trace',
        spanId: 'span-001',
        sampled: true,
      },
    },
  },
  projectionHash: 'hash-001',
};

test('replay backfill returns schema-stable success and policy-trimmed payload', async () => {
  const store = createInMemoryReplayStore();
  const runtime = createReplayRuntime({
    store,
    fetcher: {
      async fetchPage() {
        return {
          events: [{
            eventName: 'discovered',
            event: { test: true },
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
  });

  const args: ReplayBackfillInput = {
    rpc: 'http://localhost:8899',
    to_slot: 100,
    store_type: 'memory',
  };

  const output = await runReplayBackfillTool(args, runtime, buildReplayPolicy());
  assert.equal(output.structuredContent.status, 'ok');
  assert.equal(output.content.length, 1);
  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.result.processed >= 0, true);
  assert.equal(success.result.cursor?.signature, '[REDACTED]');
  assert.equal(success.redactions.includes('signature'), true);
  assert.equal(success.sections.includes('result'), true);
});

test('replay backfill validates malformed input to failure schema', async () => {
  const output = await runReplayBackfillTool(
    { rpc: '', to_slot: -1, store_type: 'memory' },
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );
  assert.equal(output.structuredContent.status, 'error');
  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.code, 'replay.invalid_input');
  assert.equal(failure.schema, 'replay.backfill.output.v1');
});

test('replay compare returns schema-stable mismatch result', async () => {
  const trace = {
    schemaVersion: 1,
    traceId: 'trace-compare',
    seed: 0,
    createdAtMs: 1,
    events: [
      {
        seq: 1,
        type: 'discovered',
        taskPda: 'AGENTtask',
        timestampMs: 1_000,
        payload: {
          onchain: {
            signature: 'sig-001',
            slot: 10,
            trace: {
              traceId: 'trace-compare',
              spanId: 'span-001',
            },
          },
        },
      },
    ],
  };

  await runWithTempTrace(trace, async (tracePath) => {
    const store = createInMemoryReplayStore();
    await store.save([storeRecord]);

    const runtime = createReplayRuntime({
      store,
      trace: tracePath,
      fetcher: {
        async fetchPage() {
          return { events: [], nextCursor: null, done: true };
        },
      },
    });

    const args: ReplayCompareInput = {
      local_trace_path: tracePath,
      store_type: 'memory',
      strict_mode: false,
      max_payload_bytes: 1,
    };

    const output = await runReplayCompareTool(args, runtime, buildReplayPolicy());
    const success = ReplayCompareOutputSchema.parse(output.structuredContent);
    assert.equal(success.command, 'agenc_replay_compare');
    assert.equal(success.status, 'ok');
    assert.equal(success.truncated, true);
  });
});

test('replay incident returns schema-stable reconstruction summary', async () => {
  const store = createInMemoryReplayStore();
  await store.save([
    storeRecord,
    {
      ...storeRecord,
      seq: 2,
      sourceEventName: 'claimed',
      sourceEventType: 'claimed',
      type: 'claimed',
      slot: 11,
      signature: 'sig-002',
      timestampMs: 1_100,
      payload: {
        ...storeRecord.payload,
        onchain: {
          ...storeRecord.payload.onchain,
          signature: 'sig-002',
          slot: 11,
        },
      },
      projectionHash: 'hash-002',
    },
  ]);

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

  const success = ReplayIncidentOutputSchema.parse(output.structuredContent);
  assert.equal(success.command, 'agenc_replay_incident');
  assert.equal(success.status, 'ok');
  assert.equal(success.summary?.total_events, 2);
  assert.equal(success.validation?.replay_task_count, 1);
});

test('replay status returns schema-stable store snapshot', async () => {
  const store = createInMemoryReplayStore();
  await store.save([storeRecord]);

  const output = await runReplayStatusTool(
    {
      store_type: 'memory',
      max_payload_bytes: 120_000,
    } as ReplayStatusInput,
    createReplayRuntime({ store }),
    buildReplayPolicy(),
  );

  const success = ReplayStatusOutputSchema.parse(output.structuredContent);
  assert.equal(success.command, 'agenc_replay_status');
  assert.equal(success.status, 'ok');
  assert.equal(success.event_count, 1);
  assert.equal(success.unique_task_count, 1);
});

test('replay incident rejects missing filters with deterministic error', async () => {
  const output = await runReplayIncidentTool(
    {
      store_type: 'memory',
      strict_mode: false,
    } as ReplayIncidentInput,
    createReplayRuntime({ store: createInMemoryReplayStore() }),
    buildReplayPolicy(),
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.missing_filter');
});

test('replay compare rejects invalid slot window order', async () => {
  const trace = {
    schemaVersion: 1,
    traceId: 'window-policy-invalid-order',
    seed: 0,
    createdAtMs: 1,
    events: [],
  };

  const output = await runWithTempTrace(trace, async (tracePath) => {
    return runReplayCompareTool(
      {
        local_trace_path: tracePath,
        store_type: 'memory',
        strict_mode: false,
        from_slot: 10,
        to_slot: 5,
      },
      createReplayRuntime({
        store: createInMemoryReplayStore(),
        trace: tracePath,
      }),
      {
        ...buildReplayPolicy(),
        maxSlotWindow: 1,
      },
    );
  });

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.slot_window_exceeded');
});

test('replay policy blocks denylisted actors', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      denylist: new Set(['policy-denied-actor']),
    },
    deniedReplayExtra,
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.access_denied');
});

test('replay policy enforces allowlist', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(['approved-actor']),
    },
    allowlistedReplayExtra,
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.access_denied');
});

test('replay policy denies anonymous actor when allowlist is enabled', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(['known-actor']),
    },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.access_denied');
  assert.equal(failure.retriable, false);
});

test('replay policy allows matching session actor via sessionId', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: {
        async fetchPage() {
          return {
            events: [],
            nextCursor: null,
            done: true,
          };
        },
      },
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(['session:policy-session-001']),
    },
    sessionReplayExtra,
  );

  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.status, 'ok');
});

test('replay policy honors denylist precedence over allowlist', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
    }),
    {
      ...buildReplayPolicy(),
      allowlist: new Set(['policy-override-actor']),
      denylist: new Set(['policy-override-actor']),
    },
    { ...allowlistedReplayExtra, authInfo: { clientId: 'policy-override-actor' }, requestId: 'policy-deny-overrides-allow' },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.access_denied');
});

test('replay compare rejects slot windows exceeding policy', async () => {
  const trace = {
    schemaVersion: 1,
    traceId: 'window-policy',
    seed: 0,
    createdAtMs: 1,
    events: [],
  };

  const output = await runWithTempTrace(trace, async (tracePath) => {
    return runReplayCompareTool(
      {
        local_trace_path: tracePath,
        store_type: 'memory',
        strict_mode: false,
        from_slot: 1,
        to_slot: 1_000_001,
      },
      createReplayRuntime({
        store: createInMemoryReplayStore(),
        trace: tracePath,
      }),
      {
        ...buildReplayPolicy(),
        maxSlotWindow: 10,
      },
    );
  });

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.slot_window_exceeded');
});

test('replay backfill enforces execution timeout policy', async () => {
  const output = await runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: neverResolveBackfillFetcher,
    }),
    {
      ...buildReplayPolicy(),
      maxToolRuntimeMs: 25,
    },
  );

  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.timeout');
});

test('replay backfill supports abort signal cancellation', async () => {
  const abortController = new AbortController();
  const outputPromise = runReplayBackfillTool(
    {
      rpc: 'http://localhost:8899',
      to_slot: 100,
      store_type: 'memory',
    },
    createReplayRuntime({
      store: createInMemoryReplayStore(),
      fetcher: neverResolveBackfillFetcher,
    }),
    {
      ...buildReplayPolicy(),
      maxToolRuntimeMs: 10_000,
    },
    { ...allowlistedReplayExtra, signal: abortController.signal },
  );

  await setTimeout(10);
  abortController.abort();
  const output = await outputPromise;
  const failure = ReplayToolErrorSchema.parse(output.structuredContent);
  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'replay.cancelled');
});

test('replay backfill enforces concurrency controls', async () => {
  const store = createInMemoryReplayStore();
  const policy = {
    ...buildReplayPolicy(),
    maxConcurrentJobs: 1,
    maxToolRuntimeMs: 200,
  };
  const runtime = createReplayRuntime({
    store,
    fetcher: neverResolveBackfillFetcher,
  });
  const args: ReplayBackfillInput = {
    rpc: 'http://localhost:8899',
    to_slot: 100,
    store_type: 'memory',
  };

  const slowFirst = runReplayBackfillTool(args, runtime, policy);
  await setTimeout(10);
  const second = runReplayBackfillTool(args, runtime, policy);
  const secondFailure = ReplayToolErrorSchema.parse((await second).structuredContent);
  assert.equal(secondFailure.code, 'replay.concurrency_limit');
  const firstResult = await slowFirst;
  const firstFailure = ReplayToolErrorSchema.parse(firstResult.structuredContent);
  assert.equal(firstFailure.code, 'replay.timeout');
});
