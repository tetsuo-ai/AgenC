/**
 * In-memory replay timeline store used for tests and single-process development.
 *
 * @module
 */

import { buildReplayKey } from './types.js';
import type {
  ReplayEventCursor,
  ReplayStorageWriteResult,
  ReplayTimelineRecord,
  ReplayTimelineQuery,
  ReplayTimelineStore,
} from './types.js';

function sortReplayEvents(events: readonly ReplayTimelineRecord[]): ReplayTimelineRecord[] {
  return [...events].sort((left, right) => {
    if (left.slot !== right.slot) {
      return left.slot - right.slot;
    }
    if (left.signature !== right.signature) {
      return left.signature.localeCompare(right.signature);
    }
    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    return left.sourceEventType.localeCompare(right.sourceEventType);
  });
}

function passesFilter(event: ReplayTimelineRecord, filter: ReplayTimelineQuery): boolean {
  if (filter.taskPda && event.taskPda !== filter.taskPda) {
    return false;
  }
  if (filter.disputePda && event.disputePda !== filter.disputePda) {
    return false;
  }
  if (filter.fromSlot !== undefined && event.slot < filter.fromSlot) {
    return false;
  }
  if (filter.toSlot !== undefined && event.slot > filter.toSlot) {
    return false;
  }
  if (filter.fromTimestampMs !== undefined && event.timestampMs < filter.fromTimestampMs) {
    return false;
  }
  if (filter.toTimestampMs !== undefined && event.timestampMs > filter.toTimestampMs) {
    return false;
  }
  return true;
}

export class InMemoryReplayTimelineStore implements ReplayTimelineStore {
  private readonly events: ReplayTimelineRecord[] = [];
  private readonly ids = new Set<string>();
  private cursor: ReplayEventCursor | null = null;

  async save(records: readonly ReplayTimelineRecord[]): Promise<ReplayStorageWriteResult> {
    let inserted = 0;
    let duplicates = 0;

    for (const event of records) {
      const key = buildReplayKey(event.slot, event.signature, event.sourceEventType);
      if (this.ids.has(key)) {
        duplicates += 1;
        continue;
      }

      this.ids.add(key);
      this.events.push(event);
      inserted += 1;
    }

    return { inserted, duplicates };
  }

  async query(filter: ReplayTimelineQuery = {}): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    const all = sortReplayEvents(this.events.filter((event) => passesFilter(event, filter)));
    const start = filter.offset ?? 0;
    const end = filter.limit === undefined ? all.length : start + filter.limit;
    return all.slice(start, end);
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    return this.cursor;
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    this.cursor = cursor;
  }

  async clear(): Promise<void> {
    this.events.length = 0;
    this.ids.clear();
    this.cursor = null;
  }
}
