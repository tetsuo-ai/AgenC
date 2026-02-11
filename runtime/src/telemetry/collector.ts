/**
 * UnifiedTelemetryCollector — in-memory metrics collection with sinks.
 *
 * Implements both MetricsCollector (task/metrics.ts) and TelemetryCollector
 * so it can be passed to components expecting either interface.
 *
 * Labels are stored via composite keys: "name|k1=v1|k2=v2" (sorted keys).
 *
 * @module
 */

import type { MetricsSnapshot, HistogramEntry } from '../task/metrics.js';
import type {
  TelemetryCollector,
  TelemetrySnapshot,
  TelemetrySink,
  TelemetryConfig,
} from './types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

const DEFAULT_MAX_HISTOGRAM_ENTRIES = 10_000;

/**
 * Build a composite key from metric name and optional labels.
 * Labels are sorted by key for deterministic ordering.
 *
 * Examples:
 *   buildKey("a.b") → "a.b"
 *   buildKey("a.b", { method: "get", status: "ok" }) → "a.b|method=get|status=ok"
 */
export function buildKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels).sort();
  const parts = sorted.map((k) => `${k}=${labels[k]}`);
  return `${name}|${parts.join('|')}`;
}

/**
 * Unified telemetry collector with support for counters, gauges,
 * bigint gauges, histograms, sinks, and optional auto-flush.
 */
export class UnifiedTelemetryCollector implements TelemetryCollector {
  private readonly counters = new Map<string, number>();
  private readonly gauges_ = new Map<string, number>();
  private readonly bigintGauges_ = new Map<string, bigint>();
  private readonly histograms_ = new Map<string, HistogramEntry[]>();
  private readonly sinks: TelemetrySink[] = [];
  private readonly maxHistogramEntries: number;
  private readonly logger: Logger;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: TelemetryConfig, logger?: Logger) {
    this.logger = logger ?? silentLogger;
    this.maxHistogramEntries = config?.maxHistogramEntries ?? DEFAULT_MAX_HISTOGRAM_ENTRIES;

    if (config?.sinks) {
      for (const sink of config.sinks) {
        this.sinks.push(sink);
      }
    }

    if (config?.flushIntervalMs && config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), config.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  // ====== MetricsProvider interface ======

  counter(name: string, value = 1, labels?: Record<string, string>): void {
    const key = buildKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = buildKey(name, labels);
    let entries = this.histograms_.get(key);
    if (!entries) {
      entries = [];
      this.histograms_.set(key, entries);
    }
    entries.push({ value, timestamp: Date.now(), labels });
    // FIFO eviction
    while (entries.length > this.maxHistogramEntries) {
      entries.shift();
    }
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = buildKey(name, labels);
    this.gauges_.set(key, value);
  }

  // ====== MetricsCollector interface (additional methods) ======

  recordTaskDuration(stage: string, durationMs: number, labels?: Record<string, string>): void {
    this.histogram(`agenc.task.${stage}.duration_ms`, durationMs, labels);
  }

  incrementCounter(name: string, value = 1, labels?: Record<string, string>): void {
    this.counter(name, value, labels);
  }

  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    this.histogram(name, value, labels);
  }

  // ====== TelemetryCollector extensions ======

  bigintGauge(name: string, value: bigint, labels?: Record<string, string>): void {
    const key = buildKey(name, labels);
    this.bigintGauges_.set(key, value);
  }

  getSnapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges_),
      histograms: this.cloneHistograms(),
      timestamp: Date.now(),
    };
  }

  getFullSnapshot(): TelemetrySnapshot {
    const bigintGauges: Record<string, string> = {};
    for (const [key, val] of this.bigintGauges_) {
      bigintGauges[key] = val.toString();
    }

    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges_),
      bigintGauges,
      histograms: this.cloneHistograms(),
      timestamp: Date.now(),
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges_.clear();
    this.bigintGauges_.clear();
    this.histograms_.clear();
  }

  flush(): void {
    if (this.sinks.length === 0) return;
    const snapshot = this.getFullSnapshot();
    for (const sink of this.sinks) {
      try {
        sink.flush(snapshot);
      } catch (err) {
        this.logger.error(`Telemetry sink "${sink.name}" flush failed: ${err}`);
      }
    }
  }

  addSink(sink: TelemetrySink): void {
    this.sinks.push(sink);
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ====== Internals ======

  private cloneHistograms(): Record<string, HistogramEntry[]> {
    const result: Record<string, HistogramEntry[]> = {};
    for (const [key, entries] of this.histograms_) {
      result[key] = [...entries];
    }
    return result;
  }
}
