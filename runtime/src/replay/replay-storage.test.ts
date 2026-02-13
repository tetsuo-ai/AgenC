import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BackfillFetcher,
  computeProjectionHash,
  FileReplayTimelineStore,
  InMemoryReplayTimelineStore,
  buildReplayTraceContext,
  ReplayBackfillService,
  type ReplayTimelineRecord,
  stableReplayCursorString,
} from './index.js';
import type { ReplayAnomalyAlert, ReplayAlertContext, ReplayAlertDispatcher } from './alerting.js';
import { REPLAY_QUALITY_FIXTURE_V1 } from '../../tests/fixtures/replay-quality-fixture.v1.ts';

function makeRecord(
  seq: number,
  type: string,
  slot: number,
  signature: string,
): ReplayTimelineRecord {
  const event = {
    seq,
    type,
    taskPda: 'task-1',
    timestampMs: slot * 10,
    payload: { value: seq, onchain: { signature, slot, eventType: type } },
    slot,
    signature,
    sourceEventName: type === 'discovered' ? 'taskCreated' : 'taskClaimed',
    sourceEventSequence: seq - 1,
    sourceEventType: type,
    disputePda: undefined,
    projectionHash: '',
  };

  return {
    ...event,
    projectionHash: computeProjectionHash({
      seq,
      type: event.type,
      taskPda: event.taskPda,
      timestampMs: event.timestampMs,
      payload: event.payload,
      slot,
      signature,
      sourceEventName: event.sourceEventName,
      sourceEventSequence: event.sourceEventSequence,
    }),
  };
}

describe('replay storage', () => {
  it('stores deterministic timeline and deduplicates duplicate stream entries', async () => {
    const store = new InMemoryReplayTimelineStore();
    await store.save([makeRecord(1, 'discovered', 1, 'AAA')]);
    await store.save([makeRecord(1, 'discovered', 1, 'AAA'), makeRecord(2, 'claimed', 1, 'AAA')]);

    const timeline = await store.query({ taskPda: 'task-1' });
    expect(timeline).toHaveLength(2);
    expect(timeline[0].sourceEventType).toBe('discovered');
    expect(timeline[1].sourceEventType).toBe('claimed');
  });

  it('persists and restores cursor and events from disk', async () => {
    const file = join(tmpdir(), `replay-store-${randomUUID()}.json`);
    const first = new FileReplayTimelineStore(file);
    const records = [makeRecord(1, 'discovered', 3, 'SIG_A'), makeRecord(2, 'claimed', 3, 'SIG_B')];

    await first.save(records);
    await first.saveCursor({ slot: 10, signature: 'SIG_CURSOR', eventName: 'taskClaimed' });
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.parse(raw).records).toHaveLength(2);

    const second = new FileReplayTimelineStore(file);
    const restored = await second.query();
    const restoredCursor = await second.getCursor();

    expect(restoredCursor).toEqual({ slot: 10, signature: 'SIG_CURSOR', eventName: 'taskClaimed' });
    expect(restored).toHaveLength(2);
    expect(restored.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(restored.map((entry) => entry.slot)).toEqual([3, 3]);
  });

  it('persists trace identifiers in cursor and projected records through backfill', async () => {
    const store = new InMemoryReplayTimelineStore();

    const fetcher: BackfillFetcher = {
      async fetchPage(cursor, toSlot, pageSize) {
        expect(toSlot).toBe(50);
        expect(pageSize).toBeGreaterThan(0);
        if (!cursor) {
          return {
            events: [
              {
                eventName: 'taskCreated',
                slot: 10,
                signature: 'SIG_A',
                event: {
                  taskId: new Uint8Array(32).fill(1),
                  creator: new Uint8Array(32).fill(1),
                  requiredCapabilities: 1n,
                  rewardAmount: 1n,
                  taskType: 0,
                  deadline: 1,
                  minReputation: 0,
                  rewardMint: null,
                  timestamp: 1,
                },
                traceContext: buildReplayTraceContext({
                  traceId: 'trace-932',
                  eventName: 'taskCreated',
                  slot: 10,
                  signature: 'SIG_A',
                  eventSequence: 0,
                  sampleRate: 1,
                }),
            },
            ],
            nextCursor: { slot: 10, signature: 'SIG_A', eventName: 'taskCreated' },
            done: true,
          };
        }

        return {
          events: [],
          nextCursor: null,
          done: true,
        };
      },
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 50,
      fetcher,
      tracePolicy: { traceId: 'trace-932', sampleRate: 1 },
    });

    const result = await service.runBackfill();
    const timeline = await store.query();
    const cursor = await store.getCursor();

    expect(result.processed).toBe(1);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.traceId).toBe('trace-932');
    expect(timeline[0]?.payload.onchain).toMatchObject({ trace: { traceId: 'trace-932' } });
    expect(cursor).not.toBeNull();
    expect(cursor?.traceId).toBe('trace-932');
    expect(stableReplayCursorString(cursor)).toContain('10:SIG_A:taskCreated:trace-932');
  });

  it('derives deterministic trace context for backfill events without explicit context', async () => {
    const store = new InMemoryReplayTimelineStore();
    const expected = buildReplayTraceContext({
      traceId: 'replay-backfill',
      eventName: 'taskCreated',
      slot: 10,
      signature: 'SIG_B',
      eventSequence: 0,
      sampleRate: 1,
    });

    const fetcher: BackfillFetcher = {
      async fetchPage() {
        return {
          events: [
            {
              eventName: 'taskCreated',
              slot: 10,
              signature: 'SIG_B',
              event: {
                taskId: new Uint8Array(32).fill(3),
                creator: new Uint8Array(32).fill(3),
                requiredCapabilities: 1n,
                rewardAmount: 1n,
                taskType: 0,
                deadline: 1,
                minReputation: 0,
                rewardMint: null,
                timestamp: 1,
              },
            },
          ],
          nextCursor: { slot: 10, signature: 'SIG_B', eventName: 'taskCreated' },
          done: true,
        };
      },
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 10,
      fetcher,
    });

    await service.runBackfill();
    const timeline = await store.query();
    const cursor = await store.getCursor();

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.traceId).toBe(expected.traceId);
    expect(timeline[0]?.traceSpanId).toBe(expected.spanId);
    expect(cursor?.traceId).toBe('replay-backfill');
    expect(cursor?.traceSpanId).toBe(expected.spanId);
    expect(stableReplayCursorString(cursor)).toContain('10:SIG_B:taskCreated:replay-backfill:');
  });

  it('resumes backfill using persisted cursor after a fetch failure', async () => {
    const store = new InMemoryReplayTimelineStore();
    const pageOne = [
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'A',
        event: { taskId: new Uint8Array(32).fill(1), creator: new Uint8Array(32).fill(1), requiredCapabilities: 1n, rewardAmount: 1n, taskType: 0, deadline: 1, minReputation: 0, rewardMint: null, timestamp: 1 },
      },
    ];
    const pageTwo = [
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'B',
        event: { taskId: new Uint8Array(32).fill(1), worker: new Uint8Array(32).fill(2), currentWorkers: 1, maxWorkers: 1, timestamp: 2 },
      },
    ];

    const fetcher: BackfillFetcher = {
      async fetchPage(cursor, toSlot) {
        expect(toSlot).toBe(9);

        if (!cursor) {
          return {
            events: pageOne,
            nextCursor: { slot: 1, signature: 'A', eventName: 'taskCreated' },
            done: false,
          };
        }

        if (cursor.signature === 'A' && !this.failOnce) {
          this.failOnce = true;
          throw new Error('simulated rpc failure');
        }

        return {
          events: pageTwo,
          nextCursor: null,
          done: true,
        };
      },
      failOnce: false,
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 9,
      fetcher,
    });

    await expect(service.runBackfill()).rejects.toThrow('simulated rpc failure');

    const partiallyIngested = await store.query();
    const savedCursor = await store.getCursor();
    expect(partiallyIngested).toHaveLength(1);
    expect(stableReplayCursorString(savedCursor)).toMatch(/^1:A:taskCreated:replay-backfill:/);

    const completed = await service.runBackfill();
    const fullTimeline = await store.query();
    expect(completed.processed).toBe(1);
    expect(completed.duplicates).toBe(0);
    expect(stableReplayCursorString(completed.cursor)).toBe('');
    expect(fullTimeline).toHaveLength(2);
  });

  it('resumes checkpointed backfill using persisted cursor for canonical fixture window', async () => {
    const fixtureEvents = REPLAY_QUALITY_FIXTURE_V1.onChainEvents.slice(0, 9);
    const file = join(tmpdir(), `replay-store-quality-${randomUUID()}.json`);
    const store = new FileReplayTimelineStore(file);

    let callCount = 0;
    let failAfterFirstPage = true;
    const fetcher: BackfillFetcher = {
      async fetchPage(cursor, toSlot, pageSize): Promise<{
        events: readonly {
          eventName: string;
          event: unknown;
          slot: number;
          signature: string;
          timestampMs?: number;
        }[];
        nextCursor: { slot: number; signature: string; eventName?: string } | null;
        done: boolean;
      }> {
        callCount += 1;
        if (toSlot !== 111) {
          throw new Error(`unexpected toSlot: ${String(toSlot)}`);
        }

        const start = cursor
          ? fixtureEvents.findIndex((entry) => entry.slot === cursor.slot && entry.signature === cursor.signature) + 1
          : 0;

        if (cursor && failAfterFirstPage) {
          failAfterFirstPage = false;
          throw new Error('simulated retryable source error');
        }

        if (start >= fixtureEvents.length) {
          return { events: [], nextCursor: null, done: true };
        }

        const events = fixtureEvents.slice(start, start + pageSize);
        const next = fixtureEvents[start + pageSize - 1];
        return {
          events: events.map((entry) => ({
            eventName: entry.eventName,
            event: entry.event,
            slot: entry.slot,
            signature: entry.signature,
            timestampMs: entry.timestampMs,
          })),
          nextCursor: next
            ? { slot: next.slot, signature: next.signature, eventName: next.eventName }
            : null,
          done: start + pageSize >= fixtureEvents.length,
        };
      },
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 111,
      fetcher,
      pageSize: 4,
      tracePolicy: { traceId: REPLAY_QUALITY_FIXTURE_V1.traceId, sampleRate: 1 },
    });

    await expect(service.runBackfill()).rejects.toThrow('simulated retryable source error');

    const persistedCursor = await store.getCursor();
    expect(stableReplayCursorString(persistedCursor)).toContain('4:SIG_TASK_CLAIMED_A');

    const recovered = await service.runBackfill();
    const timeline = await store.query();

    expect(recovered.processed).toBe(fixtureEvents.length - 4);
    expect(recovered.duplicates).toBe(0);
    expect(stableReplayCursorString(recovered.cursor)).toBe('');
    expect(timeline).toHaveLength(fixtureEvents.length);
  });

  it('emits a replay backfill stall alert when cursor does not advance', async () => {
    const store = new InMemoryReplayTimelineStore();
    const alerts: ReplayAnomalyAlert[] = [];

    const fetcher: BackfillFetcher = {
      async fetchPage() {
        return {
          events: [],
          nextCursor: { slot: 9, signature: 'STALL', eventName: 'taskCreated' },
          done: false,
        };
      },
    };

    const alertDispatcher: ReplayAlertDispatcher = {
      async emit(context: ReplayAlertContext) {
        alerts.push({
          ...context,
          id: `replay-backfill-stall-${alerts.length + 1}`,
          emittedAtMs: alerts.length + 1,
          repeatCount: 1,
        });
      },
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 9,
      fetcher,
      alertDispatcher,
    });

    await expect(service.runBackfill()).rejects.toThrow('replay backfill stalled: cursor did not advance');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.code).toBe('replay.backfill.stalled');
    expect(alerts[0]?.kind).toBe('replay_ingestion_lag');
    expect(alerts[0]?.metadata).toMatchObject({
      toSlot: 9,
    });
  });
});
