import assert from 'node:assert/strict';
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
} from './replay.js';
import { truncateOutput } from '../utils/truncation.js';
import {
  createInMemoryReplayStore,
  createReplayRuntime,
  buildReplayPolicy,
  runWithTempTrace,
} from './replay-test-utils.js';

const replayPolicy = () => buildReplayPolicy({ maxEventCount: 25_000 });

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
    replayPolicy(),
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
    replayPolicy(),
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
      replayPolicy(),
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
    replayPolicy(),
  );

  assert.equal(output.isError, false);
  const success = ReplayBackfillOutputSchema.parse(output.structuredContent);
  assert.equal(success.truncated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(success.result, 'cursor'), true);
  assert.equal(success.result.cursor, null);
});
