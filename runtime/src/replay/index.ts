/**
 * Replay storage and backfill subsystem.
 *
 * @module
 */

export { InMemoryReplayTimelineStore } from "./in-memory-store.js";

export { FileReplayTimelineStore } from "./file-store.js";

export { SqliteReplayTimelineStore } from "./sqlite-store.js";

export { ReplayBackfillService } from "./backfill.js";

export {
  ReplayEventBridge,
  type ReplayBridgeConfig,
  type ReplayBridgeBackfillOptions,
  type ReplayBridgeHandle,
  type ReplayBridgeStoreConfig,
} from "./bridge.js";

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
  type BackfillDuplicateReport,
  ProjectedTimelineInput,
  BackfillFetcherPage,
  buildReplayKey,
  computeProjectionHash,
  stableReplayCursorString,
  REPLAY_OPERATIONAL_LIMITS,
} from "./types.js";

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
} from "./trace.js";

export {
  createReplayAlertDispatcher,
  type ReplayAlertAdapter,
  type ReplayAlertContext,
  type ReplayAnomalyAlert,
  type ReplayAlertingPolicyOptions,
  type ReplayAlertSeverity,
  type ReplayAlertKind,
  ReplayAlertDispatcher,
  REPLAY_ALERT_SCHEMA_VERSION,
  type ReplayAlertSchemaV1,
  REPLAY_ALERT_V1_REQUIRED_FIELDS,
  REPLAY_ALERT_V1_VALID_SEVERITIES,
  REPLAY_ALERT_V1_VALID_KINDS,
  type SchemaCompatibilityResult,
  validateAlertSchema,
  computeAnomalySetHash,
  computeAnomalySetHashFromContexts,
} from "./alerting.js";

export {
  normalizePdaValue,
  normalizePdaString,
  extractDisputePdaFromPayload,
} from "./pda-utils.js";
