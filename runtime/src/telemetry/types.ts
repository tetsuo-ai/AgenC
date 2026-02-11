/**
 * Telemetry type definitions for @agenc/runtime.
 *
 * Re-exports MetricsProvider, TracingProvider, and Span from task/types.ts
 * (the canonical definitions) and defines the extended TelemetryCollector
 * interface with bigint gauges, snapshots, sinks, and lifecycle.
 *
 * @module
 */

export type { MetricsProvider, TracingProvider, Span } from '../task/types.js';

import type { MetricsSnapshot, HistogramEntry, MetricsCollector } from '../task/metrics.js';

// Re-export for convenience
export type { MetricsSnapshot, HistogramEntry, MetricsCollector };

/**
 * Extended telemetry snapshot including bigint gauges.
 */
export interface TelemetrySnapshot {
  /** Counter values keyed by composite key: "name|label=val" */
  counters: Record<string, number>;
  /** Gauge values keyed by composite key */
  gauges: Record<string, number>;
  /** Bigint gauge values as stringified bigints */
  bigintGauges: Record<string, string>;
  /** Histogram entries keyed by metric name */
  histograms: Record<string, HistogramEntry[]>;
  /** Timestamp when the snapshot was taken */
  timestamp: number;
}

/**
 * Unified telemetry collector that extends MetricsProvider with
 * bigint gauges, snapshots, sinks, and lifecycle management.
 */
export interface TelemetryCollector extends MetricsCollector {
  /** Set a bigint gauge (e.g. earnings in lamports) */
  bigintGauge(name: string, value: bigint, labels?: Record<string, string>): void;
  /** Get snapshot compatible with MetricsCollector / TaskExecutor */
  getSnapshot(): MetricsSnapshot;
  /** Get full snapshot including bigint gauges */
  getFullSnapshot(): TelemetrySnapshot;
  /** Clear all collected metrics */
  reset(): void;
  /** Flush current snapshot to all registered sinks */
  flush(): void;
  /** Register a telemetry sink */
  addSink(sink: TelemetrySink): void;
  /** Clean up resources (auto-flush timer, etc.) */
  destroy(): void;
}

/**
 * Sink that receives telemetry snapshots on flush.
 */
export interface TelemetrySink {
  readonly name: string;
  flush(snapshot: TelemetrySnapshot): void;
}

/**
 * Configuration for the unified telemetry system.
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled. Default: true */
  enabled?: boolean;
  /** Initial sinks to register */
  sinks?: TelemetrySink[];
  /** Auto-flush interval in ms. 0 = manual only (default) */
  flushIntervalMs?: number;
  /** Maximum histogram entries per metric. Default: 10_000 */
  maxHistogramEntries?: number;
}
