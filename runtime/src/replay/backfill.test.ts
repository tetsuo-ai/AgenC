import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ReplayBackfillService } from './backfill.js';
import { InMemoryReplayTimelineStore } from './in-memory-store.js';
import type {
  BackfillFetcher,
  BackfillFetcherPage,
  ProjectedTimelineInput,
  ReplayEventCursor,
} from './types.js';

function pubkey(seed: number): PublicKey {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return new PublicKey(buf);
}

function bytes(seed = 0, length = 32): Uint8Array {
  const buf = new Uint8Array(length);
  buf.fill(seed);
  return buf;
}

function event(slot: number, signature: string, eventName: string): ProjectedTimelineInput {
  return {
    slot,
    signature,
    eventName,
    event: {
      taskId: bytes(slot),
      creator: pubkey(slot),
      requiredCapabilities: 1n,
      rewardAmount: 1n,
      taskType: 0,
      deadline: 0,
      minReputation: 0,
      rewardMint: null,
      timestamp: slot * 100,
    },
    timestampMs: slot * 100,
  };
}

function createMockFetcher(
  pages: BackfillFetcherPage[],
): BackfillFetcher {
  let pageIndex = 0;
  return {
    async fetchPage(
      _cursor: ReplayEventCursor | null,
      _toSlot: number,
      _pageSize: number,
    ): Promise<BackfillFetcherPage> {
      const page = pages[pageIndex];
      if (!page) {
        return { events: [], nextCursor: null, done: true };
      }
      pageIndex++;
      return page;
    },
  };
}

describe('ReplayBackfillService', () => {
  it('cursor reflects last processed page boundary', async () => {
    const store = new InMemoryReplayTimelineStore();
    const fetcher = createMockFetcher([
      {
        events: [event(1, 'SIG_1', 'taskCreated')],
        nextCursor: { slot: 1, signature: 'SIG_1' },
        done: false,
      },
      {
        events: [event(2, 'SIG_2', 'taskClaimed')],
        nextCursor: null,
        done: true,
      },
    ]);

    const service = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    const result = await service.runBackfill();

    // done=true with nextCursor=null → saveCursor(null) is called
    const cursor = await store.getCursor();
    expect(cursor).toBeNull();
    expect(result.processed).toBe(2);
    expect(result.duplicates).toBe(0);
  });

  it('reports duplicate events deterministically', async () => {
    const store = new InMemoryReplayTimelineStore();
    const duplicateEvent = event(1, 'SIG_1', 'taskCreated');
    const fetcher = createMockFetcher([
      {
        events: [duplicateEvent],
        nextCursor: { slot: 1, signature: 'SIG_1' },
        done: false,
      },
      {
        events: [duplicateEvent],
        nextCursor: null,
        done: true,
      },
    ]);

    const service = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    const result = await service.runBackfill();

    expect(result.duplicates).toBeGreaterThan(0);
    expect(result.duplicateReport).toBeDefined();
    expect(result.duplicateReport!.count).toBe(result.duplicates);
    expect(result.duplicateReport!.keys).toEqual(
      [...result.duplicateReport!.keys].sort(),
    );
  });

  it('resume from partial cursor produces no event gaps', async () => {
    const store = new InMemoryReplayTimelineStore();
    // First run: process first event
    const fetcher1 = createMockFetcher([
      {
        events: [event(1, 'SIG_1', 'taskCreated')],
        nextCursor: { slot: 1, signature: 'SIG_1' },
        done: true,
      },
    ]);

    const service1 = new ReplayBackfillService(store, { toSlot: 100, fetcher: fetcher1 });
    await service1.runBackfill();

    // Set cursor at the midpoint for resume
    await store.saveCursor({ slot: 1, signature: 'SIG_1' });

    // Second run: resume from cursor
    const fetcher2 = createMockFetcher([
      {
        events: [event(2, 'SIG_2', 'taskClaimed')],
        nextCursor: null,
        done: true,
      },
    ]);

    const service2 = new ReplayBackfillService(store, { toSlot: 100, fetcher: fetcher2 });
    await service2.runBackfill();

    const allRecords = await store.query();
    expect(allRecords.length).toBe(2);
    // Verify monotonic slot ordering
    for (let i = 1; i < allRecords.length; i++) {
      expect(allRecords[i]!.slot).toBeGreaterThanOrEqual(allRecords[i - 1]!.slot);
    }
  });

  it('survives interruption mid-page and resumes correctly', async () => {
    const store = new InMemoryReplayTimelineStore();
    let callCount = 0;

    const fetcher: BackfillFetcher = {
      async fetchPage(): Promise<BackfillFetcherPage> {
        callCount++;
        if (callCount === 1) {
          return {
            events: [event(1, 'SIG_1', 'taskCreated'), event(2, 'SIG_2', 'taskClaimed')],
            nextCursor: { slot: 2, signature: 'SIG_2' },
            done: false,
          };
        }
        if (callCount === 2) {
          // Simulate crash after first page saved
          throw new Error('simulated crash');
        }
        // Resume call (callCount >= 3)
        return {
          events: [event(3, 'SIG_3', 'taskCompleted')],
          nextCursor: null,
          done: true,
        };
      },
    };

    // First run -- crashes on page 2 fetch
    const service1 = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    await expect(service1.runBackfill()).rejects.toThrow('simulated crash');

    // Events from page 1 should be persisted
    const recordsAfterCrash = await store.query();
    expect(recordsAfterCrash.length).toBe(2);

    // Resume -- should pick up and add page 3 events
    const service2 = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    const result = await service2.runBackfill();

    const allRecords = await store.query();
    expect(allRecords.length).toBe(3);
    expect(result.processed).toBe(1);
  });

  it('repeat backfill with same inputs produces identical store state', async () => {
    const events = [
      event(1, 'SIG_1', 'taskCreated'),
      event(2, 'SIG_2', 'taskClaimed'),
      event(3, 'SIG_3', 'taskCompleted'),
    ];

    // First run
    const store1 = new InMemoryReplayTimelineStore();
    const service1 = new ReplayBackfillService(store1, {
      toSlot: 100,
      fetcher: createMockFetcher([{ events, nextCursor: null, done: true }]),
    });
    await service1.runBackfill();
    const records1 = await store1.query();

    // Second run (same inputs, fresh store)
    const store2 = new InMemoryReplayTimelineStore();
    const service2 = new ReplayBackfillService(store2, {
      toSlot: 100,
      fetcher: createMockFetcher([{ events, nextCursor: null, done: true }]),
    });
    await service2.runBackfill();
    const records2 = await store2.query();

    // Store state must be identical
    expect(records1.length).toBe(records2.length);
    for (let i = 0; i < records1.length; i++) {
      expect(records1[i]!.projectionHash).toBe(records2[i]!.projectionHash);
      expect(records1[i]!.slot).toBe(records2[i]!.slot);
      expect(records1[i]!.signature).toBe(records2[i]!.signature);
      expect(records1[i]!.sourceEventName).toBe(records2[i]!.sourceEventName);
    }

    // Third run into SAME store -- duplicates only, no new inserts
    const service3 = new ReplayBackfillService(store1, {
      toSlot: 100,
      fetcher: createMockFetcher([{ events, nextCursor: null, done: true }]),
    });
    const result3 = await service3.runBackfill();
    expect(result3.processed).toBe(0);
    expect(result3.duplicates).toBe(events.length);
    expect(result3.duplicateReport).toBeDefined();
    expect(result3.duplicateReport!.count).toBe(events.length);
  });

  it('resets invalid cursor and emits alert', async () => {
    const store = new InMemoryReplayTimelineStore();
    // Set invalid cursor (negative slot)
    await store.saveCursor({ slot: -1, signature: '' });

    const alerts: { code: string; message: string }[] = [];
    const alertDispatcher = {
      emit: async (ctx: { code: string; message: string }) => {
        alerts.push(ctx);
      },
    };

    const fetcher = createMockFetcher([
      {
        events: [event(1, 'SIG_1', 'taskCreated')],
        nextCursor: null,
        done: true,
      },
    ]);

    const service = new ReplayBackfillService(store, {
      toSlot: 100,
      fetcher,
      alertDispatcher: alertDispatcher as any,
    });
    await service.runBackfill();

    // Cursor should have been reset (backfill starts from scratch)
    const records = await store.query();
    expect(records.length).toBe(1);
    // Alert should have been emitted for invalid cursor
    expect(alerts.some(a => a.code === 'replay.backfill.invalid_cursor')).toBe(true);
  });

  it('resets cursor with empty signature and emits alert', async () => {
    const store = new InMemoryReplayTimelineStore();
    await store.saveCursor({ slot: 5, signature: '' });

    const alerts: { code: string }[] = [];
    const alertDispatcher = {
      emit: async (ctx: { code: string }) => {
        alerts.push(ctx);
      },
    };

    const fetcher = createMockFetcher([
      {
        events: [event(1, 'SIG_1', 'taskCreated')],
        nextCursor: null,
        done: true,
      },
    ]);

    const service = new ReplayBackfillService(store, {
      toSlot: 100,
      fetcher,
      alertDispatcher: alertDispatcher as any,
    });
    await service.runBackfill();

    expect(alerts.some(a => a.code === 'replay.backfill.invalid_cursor')).toBe(true);
  });

  it('no duplicate report when no duplicates detected', async () => {
    const store = new InMemoryReplayTimelineStore();
    const fetcher = createMockFetcher([
      {
        events: [event(1, 'SIG_1', 'taskCreated'), event(2, 'SIG_2', 'taskClaimed')],
        nextCursor: null,
        done: true,
      },
    ]);

    const service = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    const result = await service.runBackfill();

    expect(result.duplicates).toBe(0);
    expect(result.duplicateReport).toBeUndefined();
  });
});
