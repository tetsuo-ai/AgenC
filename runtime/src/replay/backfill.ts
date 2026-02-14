/**
 * Replay timeline backfill service with cursor resume behavior.
 *
 * @module
 */

import { projectOnChainEvents } from '../eval/projector.js';
import type { OnChainProjectionInput, ProjectedTimelineEvent } from '../eval/projector.js';
import {
  buildReplayKey,
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
  deriveTraceId,
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

  /**
   * Cursor persistence contract:
   *
   * 1. Events are saved to the store FIRST via store.save()
   * 2. Cursor is persisted AFTER store.save() completes
   * 3. If crash occurs between save() and saveCursor():
   *    - Resume will re-fetch the same page
   *    - store.save() uses INSERT OR IGNORE / Set dedup
   *    - Result: exactly-once semantics for stored events
   * 4. saveCursor(null) is called when backfill completes (done=true)
   *    to signal completion
   */
  async runBackfill(): Promise<BackfillResult> {
    const pageSize = this.options.pageSize ?? DEFAULT_BACKFILL_PAGE_SIZE;
    let cursor = await this.store.getCursor();
    let processed = 0;
    let duplicates = 0;
    const duplicateKeys: string[] = [];
    let previousCursor = stableReplayCursorString(cursor);
    const traceId = this.options.tracePolicy?.traceId ?? cursor?.traceId ?? 'replay-backfill';
    const sampleRate = this.options.tracePolicy?.sampleRate ?? 1;
    const emitOtel = this.options.tracePolicy?.emitOtel ?? false;

    // Validate cursor integrity on resume
    if (cursor !== null) {
      if (typeof cursor.slot !== 'number' || !Number.isInteger(cursor.slot) || cursor.slot < 0) {
        void this.options.alertDispatcher?.emit({
          code: 'replay.backfill.invalid_cursor',
          severity: 'warning',
          kind: 'replay_ingestion_lag',
          message: 'backfill cursor has invalid slot, resetting to null',
          traceId,
          metadata: { cursorSlot: cursor.slot },
        });
        cursor = null;
        try {
          await this.store.saveCursor(null);
        } catch (error) {
          void this.options.alertDispatcher?.emit({
            code: 'replay.backfill.cursor_write_failed',
            severity: 'warning',
            kind: 'replay_ingestion_lag',
            message: 'backfill cursor reset failed, continuing with in-memory reset',
            traceId,
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (typeof cursor.signature !== 'string' || cursor.signature.length === 0) {
        void this.options.alertDispatcher?.emit({
          code: 'replay.backfill.invalid_cursor',
          severity: 'warning',
          kind: 'replay_ingestion_lag',
          message: 'backfill cursor has invalid signature, resetting to null',
          traceId,
          metadata: { cursorSignature: String(cursor.signature) },
        });
        cursor = null;
        try {
          await this.store.saveCursor(null);
        } catch (error) {
          void this.options.alertDispatcher?.emit({
            code: 'replay.backfill.cursor_write_failed',
            severity: 'warning',
            kind: 'replay_ingestion_lag',
            message: 'backfill cursor reset failed, continuing with in-memory reset',
            traceId,
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    if (cursor !== null) {
      void this.options.alertDispatcher?.emit({
        code: 'replay.backfill.resume_after_crash',
        severity: 'info',
        kind: 'replay_ingestion_lag',
        message: 'backfill resumed from persisted cursor',
        slot: cursor.slot,
        signature: cursor.signature,
        traceId,
        metadata: {
          toSlot: this.options.toSlot,
          pageSize,
        },
      });
    }

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
          let writeResult: Awaited<ReturnType<ReplayTimelineStore['save']>>;
          try {
            writeResult = await this.store.save(records);
          } catch (error) {
            pageSpan.end(error);

            void this.options.alertDispatcher?.emit({
              code: 'replay.backfill.store_write_failed',
              severity: 'error',
              kind: 'replay_ingestion_lag',
              message: 'backfill store write failed, stopping early',
              slot: cursor?.slot,
              signature: cursor?.signature,
              traceId,
              metadata: {
                toSlot: this.options.toSlot,
                pageSize,
                attemptedRecords: records.length,
                cursor: stableReplayCursorString(cursor),
                error: error instanceof Error ? error.message : String(error),
              },
            });

            return {
              processed,
              duplicates,
              cursor,
              duplicateReport: duplicateKeys.length > 0
                ? { count: duplicates, keys: [...duplicateKeys].sort() }
                : undefined,
            };
          }

          processed += writeResult.inserted;
          duplicates += writeResult.duplicates;

          // Track duplicate keys deterministically
          if (writeResult.duplicates > 0) {
            for (const record of records) {
              const key = buildReplayKey(record.slot, record.signature, record.sourceEventType);
              duplicateKeys.push(key);
            }

            void this.options.alertDispatcher?.emit({
              code: 'replay.backfill.duplicates',
              severity: 'info',
              kind: 'replay_ingestion_lag',
              message: `backfill page contained ${writeResult.duplicates} duplicate events`,
              slot: cursor?.slot,
              traceId,
              metadata: {
                duplicateCount: writeResult.duplicates,
                pageInserted: writeResult.inserted,
              },
            });
          }

          pageSpan.end();
        } catch (error) {
          pageSpan.end(error);
          throw error;
        }
      }

      const lastTraceSpanId = pageEvents.length > 0
        ? pageEvents[pageEvents.length - 1]?.traceContext?.spanId
        : cursor?.traceSpanId;
      const nextCursor = page.nextCursor
        ? {
          ...page.nextCursor,
          traceId,
          traceSpanId: page.nextCursor.traceSpanId ?? lastTraceSpanId,
        }
        : null;
      try {
        await this.store.saveCursor(nextCursor);
      } catch (error) {
        void this.options.alertDispatcher?.emit({
          code: 'replay.backfill.cursor_write_failed',
          severity: 'warning',
          kind: 'replay_ingestion_lag',
          message: 'backfill cursor persistence failed, stopping early',
          slot: cursor?.slot,
          signature: cursor?.signature,
          traceId,
          metadata: {
            toSlot: this.options.toSlot,
            pageSize,
            cursor: stableReplayCursorString(cursor),
            nextCursor: stableReplayCursorString(nextCursor),
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return {
          processed,
          duplicates,
          cursor,
          duplicateReport: duplicateKeys.length > 0
            ? { count: duplicates, keys: [...duplicateKeys].sort() }
            : undefined,
        };
      }
      cursor = page.nextCursor;

      if (page.done) {
        return {
          processed,
          duplicates,
          cursor,
          duplicateReport: duplicateKeys.length > 0
            ? { count: duplicates, keys: [...duplicateKeys].sort() }
            : undefined,
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

  // Synthesize traceId from canonical tuple when trace context is absent
  const resolvedTraceId = trace?.traceId ?? deriveTraceId(
    undefined,
    event.slot,
    event.signature,
    event.sourceEventName,
    event.sourceEventSequence,
  );

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
    traceId: resolvedTraceId,
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
