import { describe, it, expect, beforeEach } from "vitest";
import {
  SpeculationMetricsCollector,
  SPECULATION_METRIC_NAMES,
  type SpeculationObservabilityMetrics,
} from "./speculation-metrics.js";

describe("SpeculationMetricsCollector", () => {
  let collector: SpeculationMetricsCollector;

  beforeEach(() => {
    collector = new SpeculationMetricsCollector();
  });

  describe("initial state", () => {
    it("should initialize with zero values", () => {
      const metrics = collector.getMetrics();

      expect(metrics.speculationExecutionsTotal).toBe(0);
      expect(metrics.speculationHitsTotal).toBe(0);
      expect(metrics.speculationMissesTotal).toBe(0);
      expect(metrics.speculationRollbacksTotal).toBe(0);
      expect(metrics.activeSpeculations).toBe(0);
      expect(metrics.currentMaxDepth).toBe(0);
      expect(metrics.stakeAtRiskLamports).toBe(0n);
    });

    it("should return 0 hit rate when no speculations have resolved", () => {
      expect(collector.getHitRate()).toBe(0);
    });
  });

  describe("recordSpeculationStarted", () => {
    it("should increment executions total and active count", () => {
      collector.recordSpeculationStarted();

      const metrics = collector.getMetrics();
      expect(metrics.speculationExecutionsTotal).toBe(1);
      expect(metrics.activeSpeculations).toBe(1);
    });

    it("should track multiple started speculations", () => {
      collector.recordSpeculationStarted();
      collector.recordSpeculationStarted();
      collector.recordSpeculationStarted();

      const metrics = collector.getMetrics();
      expect(metrics.speculationExecutionsTotal).toBe(3);
      expect(metrics.activeSpeculations).toBe(3);
    });
  });

  describe("recordSpeculationHit", () => {
    it("should increment hits and decrement active count", () => {
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();

      const metrics = collector.getMetrics();
      expect(metrics.speculationHitsTotal).toBe(1);
      expect(metrics.activeSpeculations).toBe(0);
    });
  });

  describe("recordSpeculationMiss", () => {
    it("should increment misses and decrement active count", () => {
      collector.recordSpeculationStarted();
      collector.recordSpeculationMiss();

      const metrics = collector.getMetrics();
      expect(metrics.speculationMissesTotal).toBe(1);
      expect(metrics.activeSpeculations).toBe(0);
    });
  });

  describe("recordRollback", () => {
    it("should increment rollback counter", () => {
      collector.recordRollback();
      collector.recordRollback();

      const metrics = collector.getMetrics();
      expect(metrics.speculationRollbacksTotal).toBe(2);
    });
  });

  describe("updateDepth", () => {
    it("should track maximum depth", () => {
      collector.updateDepth(1);
      expect(collector.getMetrics().currentMaxDepth).toBe(1);

      collector.updateDepth(3);
      expect(collector.getMetrics().currentMaxDepth).toBe(3);

      collector.updateDepth(2);
      expect(collector.getMetrics().currentMaxDepth).toBe(3); // Still 3
    });
  });

  describe("updateStake", () => {
    it("should update stake at risk", () => {
      collector.updateStake(1_000_000n);
      expect(collector.getMetrics().stakeAtRiskLamports).toBe(1_000_000n);

      collector.updateStake(500_000n);
      expect(collector.getMetrics().stakeAtRiskLamports).toBe(500_000n);
    });

    it("should handle large stake values", () => {
      const largeStake = 1_000_000_000_000_000n; // 1 quadrillion lamports
      collector.updateStake(largeStake);
      expect(collector.getMetrics().stakeAtRiskLamports).toBe(largeStake);
    });
  });

  describe("getHitRate", () => {
    it("should calculate hit rate correctly", () => {
      // 3 hits, 1 miss = 75% hit rate
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();
      collector.recordSpeculationStarted();
      collector.recordSpeculationMiss();

      expect(collector.getHitRate()).toBe(0.75);
    });

    it("should return 1.0 when all speculations hit", () => {
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();

      expect(collector.getHitRate()).toBe(1);
    });

    it("should return 0 when all speculations miss", () => {
      collector.recordSpeculationStarted();
      collector.recordSpeculationMiss();
      collector.recordSpeculationStarted();
      collector.recordSpeculationMiss();

      expect(collector.getHitRate()).toBe(0);
    });
  });

  describe("getMetrics", () => {
    it("should return a copy of metrics", () => {
      collector.recordSpeculationStarted();
      const metrics1 = collector.getMetrics();
      const metrics2 = collector.getMetrics();

      expect(metrics1).not.toBe(metrics2); // Different objects
      expect(metrics1).toEqual(metrics2); // Same values
    });
  });

  describe("reset", () => {
    it("should reset all metrics to initial values", () => {
      // Populate some metrics
      collector.recordSpeculationStarted();
      collector.recordSpeculationHit();
      collector.recordRollback();
      collector.updateDepth(5);
      collector.updateStake(1_000_000n);

      // Reset
      collector.reset();

      // Verify all zeroed
      const metrics = collector.getMetrics();
      expect(metrics.speculationExecutionsTotal).toBe(0);
      expect(metrics.speculationHitsTotal).toBe(0);
      expect(metrics.speculationMissesTotal).toBe(0);
      expect(metrics.speculationRollbacksTotal).toBe(0);
      expect(metrics.activeSpeculations).toBe(0);
      expect(metrics.currentMaxDepth).toBe(0);
      expect(metrics.stakeAtRiskLamports).toBe(0n);
    });
  });

  describe("full lifecycle", () => {
    it("should track a realistic speculation workflow", () => {
      // Start 5 speculations
      for (let i = 0; i < 5; i++) {
        collector.recordSpeculationStarted();
      }
      collector.updateDepth(3);
      collector.updateStake(5_000_000n);

      let metrics = collector.getMetrics();
      expect(metrics.speculationExecutionsTotal).toBe(5);
      expect(metrics.activeSpeculations).toBe(5);

      // 3 hit, 2 miss
      collector.recordSpeculationHit();
      collector.recordSpeculationHit();
      collector.recordSpeculationHit();
      collector.recordSpeculationMiss();
      collector.recordRollback();
      collector.recordSpeculationMiss();
      collector.recordRollback();

      collector.updateStake(0n);

      metrics = collector.getMetrics();
      expect(metrics.speculationHitsTotal).toBe(3);
      expect(metrics.speculationMissesTotal).toBe(2);
      expect(metrics.speculationRollbacksTotal).toBe(2);
      expect(metrics.activeSpeculations).toBe(0);
      expect(metrics.currentMaxDepth).toBe(3);
      expect(metrics.stakeAtRiskLamports).toBe(0n);
      expect(collector.getHitRate()).toBe(0.6);
    });
  });
});

describe("SPECULATION_METRIC_NAMES", () => {
  it("should have OpenTelemetry-compatible metric names", () => {
    expect(SPECULATION_METRIC_NAMES.EXECUTIONS_TOTAL).toBe(
      "agenc.speculation.executions.total",
    );
    expect(SPECULATION_METRIC_NAMES.HITS_TOTAL).toBe(
      "agenc.speculation.hits.total",
    );
    expect(SPECULATION_METRIC_NAMES.MISSES_TOTAL).toBe(
      "agenc.speculation.misses.total",
    );
    expect(SPECULATION_METRIC_NAMES.ROLLBACKS_TOTAL).toBe(
      "agenc.speculation.rollbacks.total",
    );
    expect(SPECULATION_METRIC_NAMES.ACTIVE_COUNT).toBe(
      "agenc.speculation.active.count",
    );
    expect(SPECULATION_METRIC_NAMES.MAX_DEPTH).toBe(
      "agenc.speculation.max_depth",
    );
    expect(SPECULATION_METRIC_NAMES.STAKE_AT_RISK).toBe(
      "agenc.speculation.stake_at_risk_lamports",
    );
    expect(SPECULATION_METRIC_NAMES.HIT_RATE).toBe(
      "agenc.speculation.hit_rate",
    );
  });
});
