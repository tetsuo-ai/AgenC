import type {
  ReplayEventCursor,
  ReplayStorageWriteResult,
  ReplayTimelineQuery,
  ReplayTimelineRecord,
  ReplayTimelineStore,
} from '../../src/replay/types.js';

export interface FailingReplayTimelineStoreConfig {
  failAfterSaves?: number;
  emptyQuery?: boolean;
  corruptQueryResults?: (
    records: ReadonlyArray<ReplayTimelineRecord>
  ) => ReadonlyArray<ReplayTimelineRecord>;
}

export class FailingReplayTimelineStore implements ReplayTimelineStore {
  private saveCount = 0;

  constructor(
    private readonly inner: ReplayTimelineStore,
    private readonly config: FailingReplayTimelineStoreConfig = {},
  ) {}

  async save(records: readonly ReplayTimelineRecord[]): Promise<ReplayStorageWriteResult> {
    this.saveCount += 1;
    if (this.config.failAfterSaves !== undefined && this.saveCount > this.config.failAfterSaves) {
      throw new Error('Simulated store write failure');
    }
    return await this.inner.save(records);
  }

  async query(filter: ReplayTimelineQuery = {}): Promise<ReadonlyArray<ReplayTimelineRecord>> {
    if (this.config.emptyQuery) {
      return [];
    }
    const records = await this.inner.query(filter);
    return this.config.corruptQueryResults ? this.config.corruptQueryResults(records) : records;
  }

  async getCursor(): Promise<ReplayEventCursor | null> {
    return await this.inner.getCursor();
  }

  async saveCursor(cursor: ReplayEventCursor | null): Promise<void> {
    await this.inner.saveCursor(cursor);
  }

  async clear(): Promise<void> {
    await this.inner.clear();
  }
}

