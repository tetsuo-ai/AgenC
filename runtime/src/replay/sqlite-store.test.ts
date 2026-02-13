import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BackfillFetcher,
  computeProjectionHash,
  type ReplayTimelineRecord,
  ReplayBackfillService,
  SqliteReplayTimelineStore,
  stableReplayCursorString,
} from './index.js';

const hasSqliteDependency = (() => {
  try {
    createRequire(import.meta.url).resolve('better-sqlite3');
    return true;
  } catch (_error) {
    return false;
  }
})();

const sqliteStoreDescribe = hasSqliteDependency ? describe : describe.skip;

function makeRecord(
  seq: number,
  type: string,
  slot: number,
  signature: string,
): ReplayTimelineRecord {
  const record = {
    seq,
    type,
    taskPda: 'task-1',
    timestampMs: slot * 10 + seq,
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
    ...record,
    projectionHash: computeProjectionHash({
      seq,
      type: record.type,
      taskPda: record.taskPda,
      timestampMs: record.timestampMs,
      payload: record.payload,
      slot,
      signature,
      sourceEventName: record.sourceEventName,
      sourceEventSequence: record.sourceEventSequence,
    }),
  };
}

sqliteStoreDescribe('SqliteReplayTimelineStore', () => {
  it('persists replay records and cursor deterministically', async () => {
    const path = join(tmpdir(), `replay-store-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path);

    await store.save([
      makeRecord(2, 'claimed', 2, 'SIG_B'),
      makeRecord(1, 'discovered', 1, 'SIG_A'),
      makeRecord(3, 'claimed', 3, 'SIG_C'),
    ]);

    await store.saveCursor({
      slot: 3,
      signature: 'SIG_C',
      eventName: 'taskClaimed',
      traceId: 'trace-930',
      traceSpanId: 'span-2',
    });

    const reopened = new SqliteReplayTimelineStore(path);
    const timeline = await reopened.query({ taskPda: 'task-1' });
    const cursor = await reopened.getCursor();

    expect(timeline.map((entry) => entry.signature)).toEqual(['SIG_A', 'SIG_B', 'SIG_C']);
    expect(timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(stableReplayCursorString(cursor)).toBe('3:SIG_C:taskClaimed:trace-930:span-2');

    await reopened.clear();
    const cleared = await reopened.query();
    const clearedCursor = await reopened.getCursor();
    expect(cleared).toHaveLength(0);
    expect(clearedCursor).toBeNull();
  });

  it('applies ttl retention and drops old events', async () => {
    const path = join(tmpdir(), `replay-store-ttl-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path, {
      retention: {
        ttlMs: 1_000,
      },
    });

    const baseTime = Date.now();
    await store.save([
      { ...makeRecord(1, 'discovered', 1, 'SIG_OLD'), timestampMs: baseTime - 5_000 },
      { ...makeRecord(2, 'claimed', 2, 'SIG_NEW'), timestampMs: baseTime + 1 },
    ]);

    const timeline = await store.query({ taskPda: 'task-1' });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.signature).toBe('SIG_NEW');
  });

  it('applies max events per task and preserves deterministic ordering', async () => {
    const path = join(tmpdir(), `replay-store-task-limit-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path, {
      retention: {
        maxEventsPerTask: 2,
      },
    });

    await store.save([
      makeRecord(1, 'taskA', 10, 'SIG_A'),
      makeRecord(2, 'taskA', 11, 'SIG_B'),
      makeRecord(3, 'taskA', 12, 'SIG_C'),
      makeRecord(4, 'taskA', 13, 'SIG_D'),
    ]);

    const timeline = await store.query({ taskPda: 'task-1' });
    expect(timeline.map((entry) => entry.signature)).toEqual(['SIG_C', 'SIG_D']);
    expect(timeline.map((entry) => entry.seq)).toEqual([3, 4]);
  });

  it('applies max events per dispute', async () => {
    const path = join(tmpdir(), `replay-store-dispute-limit-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path, {
      retention: {
        maxEventsPerDispute: 1,
      },
    });

    await store.save([
      { ...makeRecord(1, 'taskA', 10, 'SIG_A'), disputePda: 'dispute-1' },
      { ...makeRecord(2, 'taskA', 11, 'SIG_B'), disputePda: 'dispute-1' },
      { ...makeRecord(3, 'taskA', 12, 'SIG_C'), disputePda: 'dispute-2' },
    ]);

    const disputeTimeline = await store.query({ disputePda: 'dispute-1' });
    expect(disputeTimeline).toHaveLength(1);
    expect(disputeTimeline[0]?.signature).toBe('SIG_B');
  });

  it('applies max total event cap', async () => {
    const path = join(tmpdir(), `replay-store-total-limit-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path, {
      retention: {
        maxEventsTotal: 3,
      },
    });

    await store.save([
      { ...makeRecord(1, 'taskA', 10, 'SIG_A'), taskPda: 'task-1' },
      { ...makeRecord(2, 'taskA', 11, 'SIG_B'), taskPda: 'task-1' },
      { ...makeRecord(3, 'taskA', 12, 'SIG_C'), taskPda: 'task-1' },
      { ...makeRecord(4, 'taskA', 13, 'SIG_D'), taskPda: 'task-1' },
      { ...makeRecord(5, 'taskA', 14, 'SIG_E'), taskPda: 'task-1' },
    ]);

    const timeline = await store.query();
    expect(timeline).toHaveLength(3);
    expect(timeline.map((entry) => entry.signature)).toEqual(['SIG_C', 'SIG_D', 'SIG_E']);
  });

  it('compacts deterministically when compaction is enabled', async () => {
    const path = join(tmpdir(), `replay-store-compaction-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(path, {
      compaction: {
        enabled: true,
        compactAfterWrites: 2,
      },
    });

    await store.save([makeRecord(1, 'taskA', 1, 'SIG_A'), makeRecord(2, 'taskA', 2, 'SIG_B')]);
    await store.save([makeRecord(3, 'taskA', 3, 'SIG_C')]);

    const timeline = await store.query({ taskPda: 'task-1' });
    expect(timeline.map((entry) => entry.signature)).toEqual(['SIG_A', 'SIG_B', 'SIG_C']);
  });
  it('resumes backfill from persisted cursor for sqlite store', async () => {
    const file = join(tmpdir(), `replay-store-backfill-${randomUUID()}.sqlite`);
    const store = new SqliteReplayTimelineStore(file);

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

    const fetcher: BackfillFetcher & { failOnce: boolean } = {
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

    const cursor = await store.getCursor();
    expect(stableReplayCursorString(cursor)).toMatch(/^1:A:taskCreated:replay-backfill:/);

    const completed = await service.runBackfill();
    const fullTimeline = await store.query();

    expect(completed.processed).toBe(1);
    expect(completed.duplicates).toBe(0);
    expect(stableReplayCursorString(completed.cursor)).toBe('');
    expect(fullTimeline).toHaveLength(2);
  });
});
