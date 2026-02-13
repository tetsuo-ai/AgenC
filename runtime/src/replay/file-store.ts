/**
 * File-backed replay timeline store for deterministic checkpointed replay.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InMemoryReplayTimelineStore } from './in-memory-store.js';
import { type ReplayEventCursor, type ReplayStorageWriteResult, type ReplayTimelineQuery, type ReplayTimelineRecord, type ReplayTimelineStore } from './types.js';

interface StoredTimelineState {
  cursor: ReplayEventCursor | null;
  records: Array<ReplayTimelineRecord>;
}

export class FileReplayTimelineStore implements ReplayTimelineStore {
  private readonly fallback = new InMemoryReplayTimelineStore();
  private loaded = false;

  constructor(private readonly filePath: string) {
  }

  async save(records: readonly ReplayTimelineRecord[]): Promise<ReplayStorageWriteResult> {
    const state = await this.getState();
    const result = await this.fallback.save(records);
    state.records = [...(await this.fallback.query())];
    await this.persist(state);
    return result;
  }

  async query(filter: ReplayTimelineQuery = {}): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    await this.getState();
    return this.fallback.query(filter);
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    const state = await this.getState();
    return state.cursor;
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    const state = await this.getState();
    state.cursor = cursor;
    await this.persist(state);
  }

  async clear(): Promise<void> {
    await this.persist({ cursor: null, records: [] });
    await this.fallback.clear();
  }

  private async getState(): Promise<StoredTimelineState> {
    if (this.loaded) {
      return {
        cursor: await this.fallback.getCursor(),
        records: [...(await this.fallback.query())],
      };
    }

    await this.fallback.clear();
    if (!existsSync(this.filePath)) {
      const empty: StoredTimelineState = { cursor: null, records: [] };
      await this.persist(empty);
      this.loaded = true;
      return empty;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredTimelineState | null;
      const cursor = parsed?.cursor ?? null;
      const records = Array.isArray(parsed?.records) ? [...parsed.records] : [];
      await this.fallback.clear();
      if (records.length > 0) {
        await this.fallback.save(records);
      }
      await this.fallback.saveCursor(cursor);
      this.loaded = true;
      return {
        cursor,
        records,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        const empty: StoredTimelineState = { cursor: null, records: [] };
        this.loaded = true;
        return empty;
      }
      throw error;
    }
  }

  private async persist(state: StoredTimelineState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({
      cursor: state.cursor,
      records: state.records,
    });
    await writeFile(this.filePath, payload);
  }
}
