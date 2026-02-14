/**
 * Replay storage and backfill subsystem.
 *
 * @module
 */

export {
  InMemoryReplayTimelineStore,
} from './in-memory-store.js';

export {
  FileReplayTimelineStore,
} from './file-store.js';

export {
  SqliteReplayTimelineStore,
} from './sqlite-store.js';

export {
  ReplayBackfillService,
} from './backfill.js';

export {
  ReplayEventBridge,
  type ReplayBridgeConfig,
  type ReplayBridgeBackfillOptions,
  type ReplayBridgeHandle,
  type ReplayBridgeStoreConfig,
} from './bridge.js';

export {
  ReplayHealth,
  ReplayTimelineQuery,
  ReplayTimelineStore,
  ReplayTimelineRecord,
  ReplayEventCursor,
  ReplayStorageWriteResult,
  ReplayTimelineRetentionPolicy,
  ReplayTimelineCompactionPolicy,
  ReplayTimelineStoreConfig,
  BackfillFetcher,
  BackfillResult,
  ProjectedTimelineInput,
  BackfillFetcherPage,
  buildReplayKey,
  computeProjectionHash,
  stableReplayCursorString,
} from './types.js';

export {
  buildReplayTraceContext,
  buildReplaySpanEvent,
  buildReplaySpanName,
  deriveTraceId,
  startReplaySpan,
  toReplayTraceEnvelope,
  type ReplayTraceContext,
  type ReplayTraceEnvelope,
  type ReplayTracingPolicy,
  DEFAULT_TRACE_SAMPLE_RATE,
} from './trace.js';

export {
  createReplayAlertDispatcher,
  type ReplayAlertAdapter,
  type ReplayAlertContext,
  type ReplayAnomalyAlert,
  type ReplayAlertingPolicyOptions,
  type ReplayAlertSeverity,
  type ReplayAlertKind,
  ReplayAlertDispatcher,
} from './alerting.js';
