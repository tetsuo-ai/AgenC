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

export {
  BENCHMARK_MANIFEST_SCHEMA_VERSION,
  parseBenchmarkManifest,
  loadBenchmarkManifest,
  hashBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkScenarioManifest,
} from './benchmark-manifest.js';

export {
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  BenchmarkRunner,
  serializeBenchmarkArtifact,
  writeBenchmarkArtifact,
  type BenchmarkScenarioRunArtifact,
  type BenchmarkMetricDelta,
  type BenchmarkScenarioReportArtifact,
  type BenchmarkArtifact,
  type BenchmarkScenarioExecutionContext,
  type BenchmarkScenarioExecutionOutput,
  type BenchmarkScenarioRunner,
  type BenchmarkRunnerConfig,
  type BenchmarkRunOptions,
} from './benchmark-runner.js';

export {
  computePassAtK,
  computePassCaretK,
  getRewardTier,
  evalRunFromReplayResult,
  computeEvaluationScorecard,
  recordEvaluationMetrics,
  serializeEvaluationScorecard,
  type RewardTier,
  type EvalRunRecord,
  type EvalAggregateMetrics,
  type EvaluationScorecard,
  type ScorecardSerializeResult,
} from './metrics.js';

export {
  buildCalibrationBins,
  computeExpectedCalibrationError,
  computeMaxCalibrationError,
  computeAgreementRate,
  buildCalibrationReport,
  recordCalibrationMetrics,
  type CalibrationSample,
  type VerdictComparison,
  type CalibrationBin,
  type CalibrationAggregate,
  type CalibrationReport,
} from './calibration.js';
