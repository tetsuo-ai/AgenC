/**
 * OpenTelemetry-compatible metrics and tracing implementations for the TaskExecutor pipeline.
 *
 * Provides:
 * - {@link DefaultMetricsCollector}: In-memory metrics collector with counter, histogram, and gauge support
 * - {@link NoopMetrics}: No-op metrics provider (default when no provider is configured)
 * - {@link NoopTracing}: No-op tracing provider (default when no provider is configured)
 * - {@link NoopSpan}: No-op span implementation
 *
 * All metric names follow the OpenTelemetry `agenc.task.*` naming convention.
 *
 * @module
 */

import type { MetricsProvider, TracingProvider, Span } from './types.js';

// ============================================================================
// Metric name constants (OpenTelemetry-compatible, agenc.task.* prefix)
// ============================================================================

export const METRIC_NAMES = {
  CLAIM_DURATION: 'agenc.task.claim.duration_ms',
  EXECUTE_DURATION: 'agenc.task.execute.duration_ms',
  SUBMIT_DURATION: 'agenc.task.submit.duration_ms',
  PIPELINE_DURATION: 'agenc.task.pipeline.duration_ms',
  QUEUE_SIZE: 'agenc.task.queue.size',
  ACTIVE_COUNT: 'agenc.task.active.count',
  TASKS_DISCOVERED: 'agenc.task.discovered.count',
  TASKS_CLAIMED: 'agenc.task.claimed.count',
  TASKS_COMPLETED: 'agenc.task.completed.count',
  TASKS_FAILED: 'agenc.task.failed.count',
  CLAIMS_FAILED: 'agenc.task.claims_failed.count',
  SUBMITS_FAILED: 'agenc.task.submits_failed.count',
  CLAIMS_EXPIRED: 'agenc.task.claims_expired.count',
  CLAIM_RETRIES: 'agenc.task.claim_retries.count',
  SUBMIT_RETRIES: 'agenc.task.submit_retries.count',
} as const;

// ============================================================================
// Histogram data structure
// ============================================================================

/**
 * A single histogram entry with value, timestamp, and labels.
 */
export interface HistogramEntry {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

// ============================================================================
// Metrics snapshot
// ============================================================================

/**
 * A snapshot of all collected metrics at a point in time.
 */
export interface MetricsSnapshot {
  /** Counter values keyed by metric name. */
  counters: Record<string, number>;
  /** Gauge values keyed by metric name. */
  gauges: Record<string, number>;
  /** Histogram entries keyed by metric name. */
  histograms: Record<string, HistogramEntry[]>;
  /** Timestamp when the snapshot was taken. */
  timestamp: number;
}

// ============================================================================
// MetricsCollector interface
// ============================================================================

/**
 * Extended metrics collector with snapshot and query capabilities.
 * Builds on {@link MetricsProvider} to add introspection for testing and export.
 */
export interface MetricsCollector extends MetricsProvider {
  /** Record a task duration for a specific pipeline stage. */
  recordTaskDuration(stage: string, durationMs: number, labels?: Record<string, string>): void;
  /** Increment a named counter by an optional amount (default 1). */
  incrementCounter(name: string, value?: number, labels?: Record<string, string>): void;
  /** Record a histogram value for distribution tracking. */
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  /** Get a point-in-time snapshot of all collected metrics. */
  getSnapshot(): MetricsSnapshot;
}

// ============================================================================
// DefaultMetricsCollector
// ============================================================================

/**
 * In-memory metrics collector implementing the {@link MetricsCollector} interface.
 *
 * Stores counters, gauges, and histograms in memory for export or inspection.
 * Suitable for testing and as the default collector when no external provider
 * (e.g., Prometheus, DataDog) is configured.
 *
 * @example
 * ```typescript
 * const collector = new DefaultMetricsCollector();
 * collector.counter('agenc.task.discovered.count');
 * collector.histogram('agenc.task.claim.duration_ms', 42);
 * collector.gauge('agenc.task.queue.size', 5);
 *
 * const snapshot = collector.getSnapshot();
 * console.log(snapshot.counters['agenc.task.discovered.count']); // 1
 * console.log(snapshot.histograms['agenc.task.claim.duration_ms']); // [{ value: 42, ... }]
 * ```
 */
export class DefaultMetricsCollector implements MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, HistogramEntry[]> = new Map();

  counter(name: string, value = 1, _labels?: Record<string, string>): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + value);
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    let entries = this.histograms.get(name);
    if (!entries) {
      entries = [];
      this.histograms.set(name, entries);
    }
    entries.push({ value, timestamp: Date.now(), labels });
  }

  gauge(name: string, value: number, _labels?: Record<string, string>): void {
    this.gauges.set(name, value);
  }

  recordTaskDuration(stage: string, durationMs: number, labels?: Record<string, string>): void {
    this.histogram(`agenc.task.${stage}.duration_ms`, durationMs, labels);
  }

  incrementCounter(name: string, value = 1, labels?: Record<string, string>): void {
    this.counter(name, value, labels);
  }

  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    this.histogram(name, value, labels);
  }

  getSnapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, val] of this.counters) {
      counters[key] = val;
    }

    const gauges: Record<string, number> = {};
    for (const [key, val] of this.gauges) {
      gauges[key] = val;
    }

    const histograms: Record<string, HistogramEntry[]> = {};
    for (const [key, val] of this.histograms) {
      histograms[key] = [...val];
    }

    return {
      counters,
      gauges,
      histograms,
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// NoopMetrics
// ============================================================================

/**
 * No-op metrics provider. All operations are silently ignored.
 * Used as the default when no metrics provider is configured.
 */
export class NoopMetrics implements MetricsProvider {
  counter(_name: string, _value?: number, _labels?: Record<string, string>): void {
    // noop
  }
  histogram(_name: string, _value: number, _labels?: Record<string, string>): void {
    // noop
  }
  gauge(_name: string, _value: number, _labels?: Record<string, string>): void {
    // noop
  }
}

// ============================================================================
// NoopSpan
// ============================================================================

/**
 * No-op span implementation. All operations are silently ignored.
 */
export class NoopSpan implements Span {
  setAttribute(_key: string, _value: string | number): void {
    // noop
  }
  setStatus(_status: 'ok' | 'error', _message?: string): void {
    // noop
  }
  end(): void {
    // noop
  }
}

// ============================================================================
// NoopTracing
// ============================================================================

/**
 * No-op tracing provider. Returns NoopSpan instances.
 * Used as the default when no tracing provider is configured.
 */
export class NoopTracing implements TracingProvider {
  startSpan(_name: string, _attributes?: Record<string, string>): Span {
    return new NoopSpan();
  }
}
