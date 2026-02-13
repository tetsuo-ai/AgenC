/**
 * Replay persistence primitives and backfill contracts.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { stableStringifyJson, type JsonValue } from '../eval/types.js';
import type { ProjectedTimelineEvent } from '../eval/projector.js';

export interface ReplayEventCursor {
  slot: number;
  signature: string;
  eventName?: string;
}

export interface ReplayTimelineRecord extends Omit<ProjectedTimelineEvent, 'payload'> {
  sourceEventName: string;
  sourceEventType: string;
  disputePda?: string;
  projectionHash: string;
  payload: ProjectedTimelineEvent['payload'];
}

export interface ReplayTimelineRecordInput {
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventType: string;
  event: ProjectedTimelineEvent;
}

export interface ReplayTimelineQuery {
  taskPda?: string;
  disputePda?: string;
  fromSlot?: number;
  toSlot?: number;
  fromTimestampMs?: number;
  toTimestampMs?: number;
  limit?: number;
  offset?: number;
}

export interface ReplayStorageWriteResult {
  inserted: number;
  duplicates: number;
}

export interface ReplayTimelineStore {
  save(records: readonly ReplayTimelineRecord[]): Promise<ReplayStorageWriteResult>;
  query(filter?: ReplayTimelineQuery): Promise<ReadonlyArray<ReplayTimelineRecord>>;
  getCursor(): Promise<ReplayEventCursor | null>;
  saveCursor(cursor: ReplayEventCursor | null): Promise<void>;
  clear(): Promise<void>;
}

export interface BackfillFetcher {
  fetchPage(
    cursor: ReplayEventCursor | null,
    toSlot: number,
    pageSize: number
  ): Promise<BackfillFetcherPage>;
}

export interface BackfillFetcherPage {
  events: ReadonlyArray<ProjectedTimelineInput>;
  nextCursor: ReplayEventCursor | null;
  done: boolean;
}

export interface ProjectedTimelineInput {
  eventName: string;
  event: unknown;
  slot: number;
  signature: string;
  timestampMs?: number;
}

export interface BackfillResult {
  processed: number;
  duplicates: number;
  cursor: ReplayEventCursor | null;
}

export interface ReplayHealth {
  totalEvents: number;
  uniqueEvents: number;
  lastCursor: ReplayEventCursor | null;
  taskCount: number;
}

export interface ReplayComparatorInput {
  events: ReadonlyArray<ReplayTimelineRecord>;
  traceTaskIds?: ReadonlyArray<string>;
}

export function stableReplayCursorString(cursor: ReplayEventCursor | null): string {
  if (!cursor) {
    return '';
  }
  return `${cursor.slot}:${cursor.signature}:${cursor.eventName ?? ''}`;
}

export function computeProjectionHash(event: ProjectedTimelineEvent): string {
  const payload = {
    seq: event.seq,
    type: event.type,
    taskPda: event.taskPda,
    timestampMs: event.timestampMs,
    payload: event.payload,
    slot: event.slot,
    signature: event.signature,
    sourceEventName: event.sourceEventName,
    sourceEventSequence: event.sourceEventSequence,
  };
  return createHash('sha256').update(stableStringifyJson(payload as JsonValue)).digest('hex');
}

export function buildReplayKey(
  slot: number,
  signature: string,
  sourceEventType: string,
): string {
  return `${slot}|${signature}|${sourceEventType}`;
}
