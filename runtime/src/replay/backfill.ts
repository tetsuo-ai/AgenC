/**
 * Replay timeline backfill service with cursor resume behavior.
 *
 * @module
 */

import { projectOnChainEvents } from '../eval/projector.js';
import type { ProjectedTimelineEvent } from '../eval/projector.js';
import {
  computeProjectionHash,
  stableReplayCursorString,
  type BackfillFetcher,
  type BackfillResult,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from './types.js';

const DEFAULT_BACKFILL_PAGE_SIZE = 100;

export class ReplayBackfillService {
  constructor(
    private readonly store: ReplayTimelineStore,
    private readonly options: {
      toSlot: number;
      pageSize?: number;
      fetcher: BackfillFetcher;
    },
  ) {}

  async runBackfill(): Promise<BackfillResult> {
    const pageSize = this.options.pageSize ?? DEFAULT_BACKFILL_PAGE_SIZE;
    let cursor = await this.store.getCursor();
    let processed = 0;
    let duplicates = 0;
    let previousCursor = stableReplayCursorString(cursor);

    while (true) {
      const page = await this.options.fetcher.fetchPage(cursor, this.options.toSlot, pageSize);
      if (page.events.length > 0) {
        const projection = projectOnChainEvents(page.events, { traceId: 'replay-backfill' });
        const records = projection.events.map(toReplayStoreRecord);
        const writeResult = await this.store.save(records);
        processed += writeResult.inserted;
        duplicates += writeResult.duplicates;
      }

      await this.store.saveCursor(page.nextCursor);
      cursor = page.nextCursor;

      if (page.done) {
        return {
          processed,
          duplicates,
          cursor,
        };
      }

      if (page.events.length === 0) {
        const nextCursor = stableReplayCursorString(cursor);
        if (nextCursor === previousCursor) {
          throw new Error('replay backfill stalled: cursor did not advance');
        }
      }

      previousCursor = stableReplayCursorString(cursor);
    }
  }
}

function toReplayStoreRecord(event: ProjectedTimelineEvent): ReplayTimelineRecord {
  const recordEvent = {
    seq: event.seq,
    type: event.type,
    taskPda: event.taskPda,
    timestampMs: event.timestampMs,
    payload: event.payload,
    slot: event.slot,
    signature: event.signature,
    sourceEventName: event.sourceEventName,
    sourceEventSequence: event.sourceEventSequence,
    sourceEventType: event.type,
  } as Omit<ReplayTimelineRecord, 'projectionHash'>;

  return {
    ...recordEvent,
    projectionHash: computeProjectionHash({
      ...recordEvent,
      sourceEventName: event.sourceEventName,
      sourceEventSequence: event.sourceEventSequence,
    } as ReturnType<typeof projectOnChainEvents>['events'][number]),
  };
}
