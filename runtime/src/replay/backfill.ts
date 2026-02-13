/**
 * Replay timeline backfill service with cursor resume behavior.
 *
 * @module
 */

import { projectOnChainEvents } from '../eval/projector.js';
import type { OnChainProjectionInput, ProjectedTimelineEvent } from '../eval/projector.js';
import {
  computeProjectionHash,
  stableReplayCursorString,
  type BackfillFetcher,
  type BackfillResult,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
  type ProjectedTimelineInput,
} from './types.js';
import {
  buildReplaySpanEvent,
  buildReplaySpanName,
  buildReplayTraceContext,
  startReplaySpan,
} from './trace.js';
import type { ReplayAlertDispatcher } from './alerting.js';

const DEFAULT_BACKFILL_PAGE_SIZE = 100;

export class ReplayBackfillService {
  constructor(
    private readonly store: ReplayTimelineStore,
    private readonly options: {
      toSlot: number;
      pageSize?: number;
      fetcher: BackfillFetcher;
      alertDispatcher?: ReplayAlertDispatcher;
      tracePolicy?: {
        traceId?: string;
        sampleRate?: number;
        emitOtel?: boolean;
      };
    },
  ) {}

  async runBackfill(): Promise<BackfillResult> {
    const pageSize = this.options.pageSize ?? DEFAULT_BACKFILL_PAGE_SIZE;
    let cursor = await this.store.getCursor();
    let processed = 0;
    let duplicates = 0;
    let previousCursor = stableReplayCursorString(cursor);
    const traceId = this.options.tracePolicy?.traceId ?? cursor?.traceId ?? 'replay-backfill';
    const sampleRate = this.options.tracePolicy?.sampleRate ?? 1;
    const emitOtel = this.options.tracePolicy?.emitOtel ?? false;

    while (true) {
      const page = await this.options.fetcher.fetchPage(cursor, this.options.toSlot, pageSize);
      const pageEvents: OnChainProjectionInput[] = page.events.map((event, index) => {
        const sourceEventSequence = event.sourceEventSequence ?? index;
        const eventTraceContext = (event as ProjectedTimelineInput).traceContext
          ?? buildReplayTraceContext({
            traceId,
            eventName: event.eventName,
            slot: event.slot,
            signature: event.signature,
            eventSequence: sourceEventSequence,
            sampleRate,
          });

        return {
          ...(event as ProjectedTimelineInput),
          sourceEventSequence,
          traceContext: eventTraceContext,
        };
      });

      if (pageEvents.length > 0) {
        const lastEvent = pageEvents.at(-1);
        const spanAnchorSlot = page.nextCursor?.slot ?? lastEvent!.slot;
        const spanAnchorSignature = page.nextCursor?.signature ?? lastEvent!.signature;
        const pageSpan = startReplaySpan({
          name: buildReplaySpanName('replay.backfill.page', {
            slot: spanAnchorSlot,
            signature: spanAnchorSignature,
          }),
          trace: pageEvents[0]?.traceContext ?? buildReplayTraceContext({
            traceId,
            eventName: 'replay-backfill',
            slot: spanAnchorSlot,
            signature: spanAnchorSignature,
            eventSequence: 0,
            sampleRate,
          }),
          emitOtel,
          attributes: buildReplaySpanEvent('replay.backfill.page', {
            slot: spanAnchorSlot,
            signature: spanAnchorSignature,
          }),
        });

        try {
          const projection = projectOnChainEvents(pageEvents, {
            traceId,
            seed: 0,
          });
          const records = projection.events.map(toReplayStoreRecord);
          const writeResult = await this.store.save(records);

          processed += writeResult.inserted;
          duplicates += writeResult.duplicates;
          pageSpan.end();
        } catch (error) {
          pageSpan.end(error);
          throw error;
        }
      }

      const lastTraceSpanId = pageEvents.length > 0
        ? pageEvents[pageEvents.length - 1]?.traceContext?.spanId
        : cursor?.traceSpanId;
      await this.store.saveCursor(page.nextCursor
        ? {
          ...page.nextCursor,
          traceId,
          traceSpanId: page.nextCursor.traceSpanId ?? lastTraceSpanId,
        }
        : null);
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
          void this.options.alertDispatcher?.emit({
            code: 'replay.backfill.stalled',
            severity: 'warning',
            kind: 'replay_ingestion_lag',
            message: 'backfill cursor stalled while fetching next page',
            slot: cursor?.slot,
            sourceEventName: cursor?.eventName,
            signature: cursor?.signature,
            traceId: this.options.tracePolicy?.traceId,
            metadata: {
              toSlot: this.options.toSlot,
            },
          });
          throw new Error('replay backfill stalled: cursor did not advance');
        }
      }

      previousCursor = stableReplayCursorString(cursor);
    }
  }
}

function toReplayStoreRecord(event: ProjectedTimelineEvent): ReplayTimelineRecord {
  const trace = (event.payload.onchain as Record<string, unknown> | undefined)?.trace as
    | undefined
    | { traceId?: string; spanId?: string; parentSpanId?: string; sampled?: boolean };

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
    traceId: trace?.traceId,
    traceSpanId: trace?.spanId,
    traceParentSpanId: trace?.parentSpanId,
    traceSampled: trace?.sampled === true,
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
