/**
 * No-op telemetry collector. All methods are silent.
 *
 * Used as default when telemetry is not configured.
 *
 * @module
 */

import type { MetricsSnapshot } from "../task/metrics.js";
import type {
  TelemetryCollector,
  TelemetrySnapshot,
  TelemetrySink,
} from "./types.js";

const EMPTY_METRICS_SNAPSHOT: MetricsSnapshot = {
  counters: {},
  gauges: {},
  histograms: {},
  timestamp: 0,
};

const EMPTY_TELEMETRY_SNAPSHOT: TelemetrySnapshot = {
  counters: {},
  gauges: {},
  bigintGauges: {},
  histograms: {},
  timestamp: 0,
};

export class NoopTelemetryCollector implements TelemetryCollector {
  counter(
    _name: string,
    _value?: number,
    _labels?: Record<string, string>,
  ): void {}
  histogram(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}
  gauge(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}
  bigintGauge(
    _name: string,
    _value: bigint,
    _labels?: Record<string, string>,
  ): void {}
  recordTaskDuration(
    _stage: string,
    _durationMs: number,
    _labels?: Record<string, string>,
  ): void {}
  incrementCounter(
    _name: string,
    _value?: number,
    _labels?: Record<string, string>,
  ): void {}
  recordHistogram(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}
  getSnapshot(): MetricsSnapshot {
    return { ...EMPTY_METRICS_SNAPSHOT, timestamp: Date.now() };
  }
  getFullSnapshot(): TelemetrySnapshot {
    return { ...EMPTY_TELEMETRY_SNAPSHOT, timestamp: Date.now() };
  }
  reset(): void {}
  flush(): void {}
  addSink(_sink: TelemetrySink): void {}
  destroy(): void {}
}
