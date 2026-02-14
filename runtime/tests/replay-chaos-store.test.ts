import { describe, expect, it } from 'vitest';
import { ReplayBackfillService } from '../src/replay/backfill.js';
import { InMemoryReplayTimelineStore } from '../src/replay/in-memory-store.js';
import type { BackfillFetcher, BackfillFetcherPage, ReplayEventCursor } from '../src/replay/types.js';
import type { ReplayAlertContext, ReplayAlertDispatcher } from '../src/replay/alerting.js';
import { ReplayComparisonService, makeReplayTraceFromRecords } from '../src/eval/replay-comparison.js';
import { FailingReplayTimelineStore } from './helpers/failing-store.ts';
import { REPLAY_CHAOS_STORE_FIXTURE } from './fixtures/replay-chaos-store-fixture.ts';

function createMockFetcher(pages: ReadonlyArray<BackfillFetcherPage>): BackfillFetcher {
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

describe('replay store chaos scenarios', () => {
  it('backfill handles store write failure gracefully', async () => {
    const inner = new InMemoryReplayTimelineStore();
    const failing = new FailingReplayTimelineStore(inner, { failAfterSaves: 2 });
    const alerts: ReplayAlertContext[] = [];
    const alertDispatcher: ReplayAlertDispatcher = {
      async emit(context: ReplayAlertContext) {
        alerts.push(context);
        return null;
      },
    };

    const service = new ReplayBackfillService(failing, {
      toSlot: 100,
      pageSize: 1,
      fetcher: createMockFetcher(REPLAY_CHAOS_STORE_FIXTURE.writeFailurePages),
      alertDispatcher,
    });

    const result = await service.runBackfill();
    expect(result.processed).toBe(2);
    expect(result.cursor).not.toBeNull();
    expect(alerts.some((alert) => alert.code === 'replay.backfill.store_write_failed')).toBe(true);

    const timeline = await inner.query();
    expect(timeline).toHaveLength(2);
  });

  it('reports type mismatch when store corrupts projected event type', async () => {
    const inner = new InMemoryReplayTimelineStore();
    const records = REPLAY_CHAOS_STORE_FIXTURE.records;
    await inner.save(records);

    const corrupting = new FailingReplayTimelineStore(inner, {
      corruptQueryResults: (rows) =>
        rows.map((row, index) => index === 0 ? { ...row, type: 'failed' } : row),
    });

    const localTrace = makeReplayTraceFromRecords(records, 7, 'chaos-store-corruption');
    const result = await new ReplayComparisonService().compare({
      projected: corrupting,
      localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'type_mismatch')).toBe(true);
  });

  it('reports unexpected events when store returns empty projected timeline', async () => {
    const inner = new InMemoryReplayTimelineStore();
    const records = REPLAY_CHAOS_STORE_FIXTURE.records;
    await inner.save(records);

    const empty = new FailingReplayTimelineStore(inner, { emptyQuery: true });
    const localTrace = makeReplayTraceFromRecords(records, 7, 'chaos-store-empty');

    const result = await new ReplayComparisonService().compare({
      projected: empty,
      localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'unexpected_event')).toBe(true);
  });
});

