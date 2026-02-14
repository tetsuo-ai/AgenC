/**
 * Replay persistence primitives and backfill contracts.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { stableStringifyJson, type JsonValue } from '../eval/types.js';
import type { ProjectedTimelineEvent } from '../eval/projector.js';
import type { ReplayTraceContext } from './trace.js';

export interface ReplayEventCursor {
  slot: number;
  signature: string;
  eventName?: string;
  traceId?: string;
  traceSpanId?: string;
}

export interface ReplayTimelineRecord extends Omit<ProjectedTimelineEvent, 'payload'> {
  sourceEventName: string;
  sourceEventType: string;
  disputePda?: string;
  projectionHash: string;
  traceId?: string;
  traceSpanId?: string;
  traceParentSpanId?: string;
  traceSampled?: boolean;
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
  getDurability?(): import('../memory/types.js').DurabilityInfo;
  flush?(): Promise<void>;
}

/**
 * Operational limits and constraints for replay stores.
 */
export const REPLAY_OPERATIONAL_LIMITS = {
  /** SQLite: max recommended database size (bytes) */
  SQLITE_MAX_DB_SIZE_BYTES: 10 * 1024 * 1024 * 1024, // 10 GiB
  /** File store: max recommended file size (bytes) before performance degrades */
  FILE_MAX_SIZE_BYTES: 512 * 1024 * 1024, // 512 MiB
  /** InMemory: max recommended events before memory pressure */
  IN_MEMORY_MAX_EVENTS: 1_000_000,
} as const;

export interface ReplayTimelineRetentionPolicy {
  /** Retain events newer than this TTL in milliseconds. */
  ttlMs?: number;
  /** Keep only the most recent N events for a task. */
  maxEventsPerTask?: number;
  /** Keep only the most recent N events for a dispute timeline. */
  maxEventsPerDispute?: number;
  /** Keep only the most recent N events overall in the store. */
  maxEventsTotal?: number;
}

export interface ReplayTimelineCompactionPolicy {
  /** Run compacting operations when enabled. Defaults to `false`. */
  enabled?: boolean;
  /** Number of save operations between SQLite VACUUM calls. */
  compactAfterWrites?: number;
}

export interface ReplayTimelineStoreConfig {
  retention?: ReplayTimelineRetentionPolicy;
  compaction?: ReplayTimelineCompactionPolicy;
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
  sourceEventSequence?: number;
  traceContext?: ReplayTraceContext;
}

export interface BackfillDuplicateReport {
  /** Total duplicate events detected across all pages */
  count: number;
  /** Deterministic list of duplicate event keys (slot|signature|sourceEventType) */
  keys: string[];
}

export interface BackfillResult {
  processed: number;
  duplicates: number;
  cursor: ReplayEventCursor | null;
  /** Deterministic duplicate report for auditing */
  duplicateReport?: BackfillDuplicateReport;
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
  const base = `${cursor.slot}:${cursor.signature}:${cursor.eventName ?? ''}`;
  if (!cursor.traceId && !cursor.traceSpanId) {
    return base;
  }
  return `${base}:${cursor.traceId ?? ''}:${cursor.traceSpanId ?? ''}`;
}

/**
 * Compute a deterministic hash of a projected timeline event.
 *
 * The hash covers the canonical identity tuple (slot, signature,
 * sourceEventName, sourceEventSequence) plus the remaining projection
 * fields. `stableStringifyJson()` sorts keys lexicographically so the
 * literal field order in the object literal below does not affect the
 * output — it is listed explicitly to document which fields participate
 * in the hash.
 */
export function computeProjectionHash(event: ProjectedTimelineEvent): string {
  const canonical = {
    // Canonical identity tuple (order is contractual)
    slot: event.slot,
    signature: event.signature,
    sourceEventName: event.sourceEventName,
    sourceEventSequence: event.sourceEventSequence,
    // Remaining projection fields
    payload: event.payload,
    seq: event.seq,
    taskPda: event.taskPda,
    timestampMs: event.timestampMs,
    type: event.type,
  };
  return createHash('sha256').update(stableStringifyJson(canonical as JsonValue)).digest('hex');
}

export function buildReplayKey(
  slot: number,
  signature: string,
  sourceEventType: string,
): string {
  return `${slot}|${signature}|${sourceEventType}`;
}
