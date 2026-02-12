/**
 * Evaluation and deterministic replay module.
 *
 * @module
 */

export {
  EVAL_TRACE_SCHEMA_VERSION,
  parseTrajectoryTrace,
  migrateTrajectoryTrace,
  canonicalizeTrajectoryTrace,
  stableStringifyJson,
  type JsonPrimitive,
  type JsonValue,
  type JsonObject,
  type KnownTrajectoryEventType,
  type TrajectoryEventType,
  type TrajectoryRecordInput,
  type TrajectoryRecorderSink,
  type TrajectoryEvent,
  type TrajectoryTrace,
  type LegacyTrajectoryEventV0,
  type LegacyTrajectoryTraceV0,
} from './types.js';

export {
  TrajectoryRecorder,
  type TrajectoryRecorderConfig,
} from './recorder.js';

export {
  TrajectoryReplayEngine,
  type ReplayTaskStatus,
  type ReplayTaskState,
  type ReplaySummary,
  type TrajectoryReplayResult,
  type TrajectoryReplayConfig,
} from './replay.js';
