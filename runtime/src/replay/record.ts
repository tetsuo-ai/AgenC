import type { ProjectedTimelineEvent } from "../eval/projector.js";
import type { ReplayTimelineRecord } from "./types.js";
import { computeProjectionHash } from "./types.js";
import { extractDisputePdaFromPayload } from "./pda-utils.js";
import { deriveTraceId } from "./trace.js";

/**
 * Normalize a projected timeline event into a replay store record.
 *
 * Shared by realtime bridge ingestion and historical backfill so both paths
 * persist exactly the same record shape and hash semantics.
 */
export function toReplayStoreRecord(
  event: ProjectedTimelineEvent,
): ReplayTimelineRecord {
  const trace = (event.payload.onchain as Record<string, unknown> | undefined)
    ?.trace as
    | undefined
    | {
        traceId?: string;
        spanId?: string;
        parentSpanId?: string;
        sampled?: boolean;
      };

  const resolvedTraceId =
    trace?.traceId ??
    deriveTraceId(
      undefined,
      event.slot,
      event.signature,
      event.sourceEventName,
      event.sourceEventSequence,
    );

  const recordEvent: Omit<ReplayTimelineRecord, "projectionHash"> = {
    seq: event.seq,
    type: event.type,
    taskPda: event.taskPda,
    disputePda: extractDisputePdaFromPayload(event.payload),
    timestampMs: event.timestampMs,
    payload: event.payload,
    slot: event.slot,
    signature: event.signature,
    sourceEventName: event.sourceEventName,
    sourceEventType: event.type,
    sourceEventSequence: event.sourceEventSequence,
    traceId: resolvedTraceId,
    traceSpanId: trace?.spanId,
    traceParentSpanId: trace?.parentSpanId,
    traceSampled: trace?.sampled === true,
  };

  return {
    ...recordEvent,
    projectionHash: computeProjectionHash({
      ...recordEvent,
      sourceEventName: event.sourceEventName,
      sourceEventSequence: event.sourceEventSequence,
    } as Parameters<typeof computeProjectionHash>[0]),
  };
}
