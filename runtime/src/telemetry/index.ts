/**
 * Telemetry module — unified metrics collection and export for @agenc/runtime.
 *
 * @module
 */

// Types (re-exports from task/types.ts + telemetry extensions)
export type {
  MetricsProvider,
  TracingProvider,
  Span,
  MetricsSnapshot,
  HistogramEntry,
  MetricsCollector,
  TelemetryCollector,
  TelemetrySnapshot,
  TelemetrySink,
  TelemetryConfig,
} from "./types.js";

// Collector
export { UnifiedTelemetryCollector, buildKey } from "./collector.js";

// Noop
export { NoopTelemetryCollector } from "./noop.js";

// Sinks
export { ConsoleSink, CallbackSink } from "./sinks.js";

// Metric names
export { TELEMETRY_METRIC_NAMES } from "./metric-names.js";

// Errors
export { TelemetryError } from "./errors.js";
