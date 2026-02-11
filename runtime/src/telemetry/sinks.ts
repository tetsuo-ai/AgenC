/**
 * Built-in telemetry sinks.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import type { TelemetrySink, TelemetrySnapshot } from './types.js';

/**
 * Logs a formatted telemetry snapshot via a Logger instance.
 */
export class ConsoleSink implements TelemetrySink {
  readonly name = 'console';
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  flush(snapshot: TelemetrySnapshot): void {
    const counterCount = Object.keys(snapshot.counters).length;
    const gaugeCount = Object.keys(snapshot.gauges).length;
    const bigintGaugeCount = Object.keys(snapshot.bigintGauges).length;
    const histogramCount = Object.keys(snapshot.histograms).length;

    const lines: string[] = [
      `[Telemetry] Flush at ${new Date(snapshot.timestamp).toISOString()}`,
      `  Counters (${counterCount}):`,
    ];

    for (const [key, val] of Object.entries(snapshot.counters)) {
      lines.push(`    ${key} = ${val}`);
    }

    lines.push(`  Gauges (${gaugeCount}):`);
    for (const [key, val] of Object.entries(snapshot.gauges)) {
      lines.push(`    ${key} = ${val}`);
    }

    if (bigintGaugeCount > 0) {
      lines.push(`  BigInt Gauges (${bigintGaugeCount}):`);
      for (const [key, val] of Object.entries(snapshot.bigintGauges)) {
        lines.push(`    ${key} = ${val}`);
      }
    }

    lines.push(`  Histograms (${histogramCount}):`);
    for (const [key, entries] of Object.entries(snapshot.histograms)) {
      if (entries.length === 0) continue;
      const values = entries.map((e) => e.value);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      lines.push(`    ${key}: count=${entries.length} avg=${avg.toFixed(1)} min=${min} max=${max}`);
    }

    this.logger.info(lines.join('\n'));
  }
}

/**
 * Invokes a callback with the telemetry snapshot on each flush.
 */
export class CallbackSink implements TelemetrySink {
  readonly name: string;
  private readonly callback: (snapshot: TelemetrySnapshot) => void;

  constructor(callback: (snapshot: TelemetrySnapshot) => void, name = 'callback') {
    this.callback = callback;
    this.name = name;
  }

  flush(snapshot: TelemetrySnapshot): void {
    this.callback(snapshot);
  }
}
