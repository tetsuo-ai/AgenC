import { describe, expect, it } from 'vitest';
import { ReplayBackfillService } from '../src/replay/backfill.js';
import { InMemoryReplayTimelineStore } from '../src/replay/in-memory-store.js';
import type { BackfillFetcher, BackfillFetcherPage, ReplayEventCursor } from '../src/replay/types.js';
import type { ReplayAlertContext, ReplayAlertDispatcher } from '../src/replay/alerting.js';
import { REPLAY_CHAOS_PARTIAL_WRITE_FIXTURE } from './fixtures/replay-chaos-partial-write-fixture.ts';

describe('partial write and resume chaos scenarios', () => {
  it('resumes from persisted cursor after simulated crash', async () => {
    const store = new InMemoryReplayTimelineStore();
    let callCount = 0;

    const fetcher: BackfillFetcher = {
      async fetchPage(
        _cursor: ReplayEventCursor | null,
        _toSlot: number,
        _pageSize: number,
      ): Promise<BackfillFetcherPage> {
        callCount += 1;
        if (callCount === 1) {
          return REPLAY_CHAOS_PARTIAL_WRITE_FIXTURE.resumeAfterCrash.firstPage;
        }
        if (callCount === 2) {
          throw new Error('simulated crash');
        }
        return REPLAY_CHAOS_PARTIAL_WRITE_FIXTURE.resumeAfterCrash.finalPage;
      },
    };

    const first = new ReplayBackfillService(store, { toSlot: 100, fetcher });
    await expect(first.runBackfill()).rejects.toThrow('simulated crash');

    const afterCrash = await store.query();
    expect(afterCrash.length).toBeGreaterThan(0);

    const alerts: ReplayAlertContext[] = [];
    const alertDispatcher: ReplayAlertDispatcher = {
      async emit(context: ReplayAlertContext) {
        alerts.push(context);
        return null;
      },
    };

    const resumed = new ReplayBackfillService(store, { toSlot: 100, fetcher, alertDispatcher });
    const result = await resumed.runBackfill();
    expect(result.processed).toBe(1);

    const finalRecords = await store.query();
    expect(finalRecords).toHaveLength(3);
    expect(alerts.some((alert) => alert.code === 'replay.backfill.resume_after_crash')).toBe(true);
  });

  it('emits a stall alert when cursor does not advance', async () => {
    const store = new InMemoryReplayTimelineStore();
    const alerts: ReplayAlertContext[] = [];
    const alertDispatcher: ReplayAlertDispatcher = {
      async emit(context: ReplayAlertContext) {
        alerts.push(context);
        return null;
      },
    };

    const fetcher: BackfillFetcher = {
      async fetchPage() {
        return REPLAY_CHAOS_PARTIAL_WRITE_FIXTURE.cursorStall.stalledPage;
      },
    };

    const service = new ReplayBackfillService(store, {
      toSlot: 9,
      fetcher,
      alertDispatcher,
    });

    await expect(service.runBackfill()).rejects.toThrow('replay backfill stalled: cursor did not advance');
    expect(alerts.some((alert) => alert.code === 'replay.backfill.stalled')).toBe(true);
  });
});

