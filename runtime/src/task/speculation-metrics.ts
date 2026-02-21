/**
 * Speculation-specific metrics for observability of speculative execution.
 *
 * Provides:
 * - {@link SpeculationObservabilityMetrics}: Interface defining all speculation-related metrics
 * - {@link SpeculationMetricsCollector}: Collector for tracking speculation performance
 *
 * All metric names follow the OpenTelemetry `agenc.speculation.*` naming convention.
 *
 * @module
 */

// ============================================================================
// Metric name constants (OpenTelemetry-compatible, agenc.speculation.* prefix)
// ============================================================================

export const SPECULATION_METRIC_NAMES = {
  EXECUTIONS_TOTAL: "agenc.speculation.executions.total",
  HITS_TOTAL: "agenc.speculation.hits.total",
  MISSES_TOTAL: "agenc.speculation.misses.total",
  ROLLBACKS_TOTAL: "agenc.speculation.rollbacks.total",
  ACTIVE_COUNT: "agenc.speculation.active.count",
  MAX_DEPTH: "agenc.speculation.max_depth",
  STAKE_AT_RISK: "agenc.speculation.stake_at_risk_lamports",
  HIT_RATE: "agenc.speculation.hit_rate",
} as const;

// ============================================================================
// SpeculationObservabilityMetrics interface
// ============================================================================

/**
 * Metrics interface for speculative execution observability.
 *
 * Captures key performance indicators for speculation:
 * - Execution counts (total, hits, misses, rollbacks)
 * - Active speculation gauge
 * - Depth tracking for nested speculation
 * - Stake exposure monitoring
 *
 * This interface is designed for OpenTelemetry integration and external
 * observability systems, complementing the internal SpeculationMetrics
 * used by SpeculativeTaskScheduler.
 */
export interface SpeculationObservabilityMetrics {
  /** Total number of speculative executions started. */
  speculationExecutionsTotal: number;
  /** Number of speculations that were confirmed (predicted correctly). */
  speculationHitsTotal: number;
  /** Number of speculations that were invalidated (predicted incorrectly). */
  speculationMissesTotal: number;
  /** Number of rollback operations performed due to speculation failures. */
  speculationRollbacksTotal: number;
  /** Current number of active (in-flight) speculations. */
  activeSpeculations: number;
  /** Maximum speculation depth observed (for nested speculative execution). */
  currentMaxDepth: number;
  /** Total stake at risk across all active speculations (in lamports). */
  stakeAtRiskLamports: bigint;
}

// ============================================================================
// SpeculationMetricsCollector
// ============================================================================

/**
 * Collector for speculation-related metrics.
 *
 * Tracks speculative execution performance including hit/miss rates,
 * rollback frequency, speculation depth, and stake exposure.
 *
 * @example
 * ```typescript
 * const collector = new SpeculationMetricsCollector();
 *
 * // Track a speculation lifecycle
 * collector.recordSpeculationStarted();
 * collector.updateDepth(2);
 * collector.updateStake(1_000_000n);
 *
 * // Speculation confirmed
 * collector.recordSpeculationHit();
 *
 * // Check performance
 * console.log(collector.getHitRate()); // 1.0
 * console.log(collector.getMetrics());
 * ```
 */
export class SpeculationMetricsCollector {
  private metrics: SpeculationObservabilityMetrics = {
    speculationExecutionsTotal: 0,
    speculationHitsTotal: 0,
    speculationMissesTotal: 0,
    speculationRollbacksTotal: 0,
    activeSpeculations: 0,
    currentMaxDepth: 0,
    stakeAtRiskLamports: 0n,
  };

  /**
   * Record that a new speculation has started.
   * Increments both the total executions counter and active speculation gauge.
   */
  recordSpeculationStarted(): void {
    this.metrics.speculationExecutionsTotal++;
    this.metrics.activeSpeculations++;
  }

  /**
   * Record that a speculation was confirmed (hit).
   * Increments the hit counter and decrements the active speculation gauge.
   */
  recordSpeculationHit(): void {
    this.metrics.speculationHitsTotal++;
    this.metrics.activeSpeculations--;
  }

  /**
   * Record that a speculation was invalidated (miss).
   * Increments the miss counter and decrements the active speculation gauge.
   */
  recordSpeculationMiss(): void {
    this.metrics.speculationMissesTotal++;
    this.metrics.activeSpeculations--;
  }

  /**
   * Record that a rollback operation was performed.
   * This is typically called when a speculation miss requires state reversal.
   */
  recordRollback(): void {
    this.metrics.speculationRollbacksTotal++;
  }

  /**
   * Update the maximum observed speculation depth.
   * Only updates if the new depth exceeds the current maximum.
   *
   * @param depth - The current speculation depth
   */
  updateDepth(depth: number): void {
    this.metrics.currentMaxDepth = Math.max(
      this.metrics.currentMaxDepth,
      depth,
    );
  }

  /**
   * Update the current stake at risk across all active speculations.
   *
   * @param stake - Total stake at risk in lamports
   */
  updateStake(stake: bigint): void {
    this.metrics.stakeAtRiskLamports = stake;
  }

  /**
   * Get a snapshot of all current metrics.
   *
   * @returns A copy of the current metrics state
   */
  getMetrics(): SpeculationObservabilityMetrics {
    return { ...this.metrics };
  }

  /**
   * Calculate the speculation hit rate.
   *
   * @returns The ratio of hits to total resolved speculations (0-1), or 0 if no speculations have resolved
   */
  getHitRate(): number {
    const total =
      this.metrics.speculationHitsTotal + this.metrics.speculationMissesTotal;
    return total > 0 ? this.metrics.speculationHitsTotal / total : 0;
  }

  /**
   * Reset all metrics to their initial values.
   * Useful for testing or periodic metric resets.
   */
  reset(): void {
    this.metrics = {
      speculationExecutionsTotal: 0,
      speculationHitsTotal: 0,
      speculationMissesTotal: 0,
      speculationRollbacksTotal: 0,
      activeSpeculations: 0,
      currentMaxDepth: 0,
      stakeAtRiskLamports: 0n,
    };
  }
}
