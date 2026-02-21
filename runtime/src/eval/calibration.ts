/**
 * Verifier/judge agreement and confidence calibration helpers.
 *
 * @module
 */

import type { MetricsProvider } from "../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import { clamp01 } from "../utils/numeric.js";
import { groupBy } from "../utils/collections.js";
import { getRewardTier, type RewardTier } from "./metrics.js";

export interface CalibrationSample {
  confidence: number;
  correct: boolean;
  taskType?: string;
  rewardLamports?: bigint | number | string;
  verifierGated?: boolean;
}

export interface VerdictComparison {
  verifierVerdict: string;
  judgeVerdict: string;
  confidence: number;
  taskType?: string;
  rewardLamports?: bigint | number | string;
  verifierGated?: boolean;
}

export interface CalibrationBin {
  index: number;
  minConfidence: number;
  maxConfidence: number;
  count: number;
  meanConfidence: number;
  empiricalAccuracy: number;
  gap: number;
}

export interface CalibrationAggregate {
  sampleCount: number;
  comparisonCount: number;
  agreementRate: number;
  disagreements: number;
  expectedCalibrationError: number;
  maxCalibrationError: number;
  bins: CalibrationBin[];
}

export interface CalibrationReport {
  overall: CalibrationAggregate;
  byTaskType: Record<string, CalibrationAggregate>;
  byRewardTier: Record<RewardTier, CalibrationAggregate>;
  byVerifierGate: Record<"gated" | "ungated", CalibrationAggregate>;
  overconfidentBinIndices: number[];
  underconfidentBinIndices: number[];
}

function buildEmptyBins(binCount: number): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < binCount; index++) {
    const minConfidence = index / binCount;
    const maxConfidence = (index + 1) / binCount;
    bins.push({
      index,
      minConfidence,
      maxConfidence,
      count: 0,
      meanConfidence: 0,
      empiricalAccuracy: 0,
      gap: 0,
    });
  }
  return bins;
}

/**
 * Build confidence calibration bins.
 */
export function buildCalibrationBins(
  samples: CalibrationSample[],
  binCount = 10,
): CalibrationBin[] {
  const safeBinCount = Math.max(1, Math.floor(binCount));
  const bins = buildEmptyBins(safeBinCount);

  const confidenceSums = new Array<number>(safeBinCount).fill(0);
  const correctnessSums = new Array<number>(safeBinCount).fill(0);

  for (const sample of samples) {
    const confidence = clamp01(sample.confidence);
    const index = Math.min(
      safeBinCount - 1,
      Math.floor(confidence * safeBinCount),
    );
    bins[index].count += 1;
    confidenceSums[index] += confidence;
    correctnessSums[index] += sample.correct ? 1 : 0;
  }

  for (const bin of bins) {
    if (bin.count === 0) continue;
    bin.meanConfidence = confidenceSums[bin.index] / bin.count;
    bin.empiricalAccuracy = correctnessSums[bin.index] / bin.count;
    bin.gap = bin.empiricalAccuracy - bin.meanConfidence;
  }

  return bins;
}

export function computeExpectedCalibrationError(
  bins: CalibrationBin[],
): number {
  const total = bins.reduce((acc, bin) => acc + bin.count, 0);
  if (total === 0) return 0;

  let weightedGap = 0;
  for (const bin of bins) {
    weightedGap += (bin.count / total) * Math.abs(bin.gap);
  }
  return weightedGap;
}

export function computeMaxCalibrationError(bins: CalibrationBin[]): number {
  if (bins.length === 0) return 0;
  return bins.reduce((maxGap, bin) => Math.max(maxGap, Math.abs(bin.gap)), 0);
}

export function computeAgreementRate(comparisons: VerdictComparison[]): number {
  if (comparisons.length === 0) return 0;
  const matches = comparisons.filter(
    (comparison) => comparison.verifierVerdict === comparison.judgeVerdict,
  ).length;
  return matches / comparisons.length;
}

function aggregateCalibration(
  samples: CalibrationSample[],
  comparisons: VerdictComparison[],
  binCount: number,
): CalibrationAggregate {
  const bins = buildCalibrationBins(samples, binCount);
  const agreementRate = computeAgreementRate(comparisons);
  const disagreements = comparisons.filter(
    (comparison) => comparison.verifierVerdict !== comparison.judgeVerdict,
  ).length;

  return {
    sampleCount: samples.length,
    comparisonCount: comparisons.length,
    agreementRate,
    disagreements,
    expectedCalibrationError: computeExpectedCalibrationError(bins),
    maxCalibrationError: computeMaxCalibrationError(bins),
    bins,
  };
}


export function buildCalibrationReport(
  samples: CalibrationSample[],
  comparisons: VerdictComparison[],
  options: { binCount?: number } = {},
): CalibrationReport {
  const binCount = Math.max(1, Math.floor(options.binCount ?? 10));

  const overall = aggregateCalibration(samples, comparisons, binCount);

  const byTaskType: Record<string, CalibrationAggregate> = {};
  const taskTypes = new Set<string>([
    ...samples.map((sample) => sample.taskType ?? "unknown"),
    ...comparisons.map((comparison) => comparison.taskType ?? "unknown"),
  ]);

  for (const taskType of taskTypes) {
    byTaskType[taskType] = aggregateCalibration(
      samples.filter((sample) => (sample.taskType ?? "unknown") === taskType),
      comparisons.filter(
        (comparison) => (comparison.taskType ?? "unknown") === taskType,
      ),
      binCount,
    );
  }

  const byRewardTier: Record<RewardTier, CalibrationAggregate> = {
    low: aggregateCalibration([], [], binCount),
    medium: aggregateCalibration([], [], binCount),
    high: aggregateCalibration([], [], binCount),
    unknown: aggregateCalibration([], [], binCount),
  };

  const rewardTiers = new Set<RewardTier>([
    ...samples.map((sample) => getRewardTier(sample.rewardLamports)),
    ...comparisons.map((comparison) =>
      getRewardTier(comparison.rewardLamports),
    ),
  ]);

  for (const rewardTier of rewardTiers) {
    byRewardTier[rewardTier] = aggregateCalibration(
      samples.filter(
        (sample) => getRewardTier(sample.rewardLamports) === rewardTier,
      ),
      comparisons.filter(
        (comparison) => getRewardTier(comparison.rewardLamports) === rewardTier,
      ),
      binCount,
    );
  }

  const byVerifierGate: Record<"gated" | "ungated", CalibrationAggregate> = {
    gated: aggregateCalibration([], [], binCount),
    ungated: aggregateCalibration([], [], binCount),
  };

  const gateGroups = groupBy(samples, (sample) =>
    sample.verifierGated === true ? "gated" : "ungated",
  );
  const comparisonGateGroups = groupBy(comparisons, (comparison) =>
    comparison.verifierGated === true ? "gated" : "ungated",
  );

  for (const gate of ["gated", "ungated"] as const) {
    byVerifierGate[gate] = aggregateCalibration(
      gateGroups.get(gate) ?? [],
      comparisonGateGroups.get(gate) ?? [],
      binCount,
    );
  }

  const overconfidentBinIndices = overall.bins
    .filter((bin) => bin.count > 0 && bin.gap < 0)
    .map((bin) => bin.index);

  const underconfidentBinIndices = overall.bins
    .filter((bin) => bin.count > 0 && bin.gap > 0)
    .map((bin) => bin.index);

  return {
    overall,
    byTaskType,
    byRewardTier,
    byVerifierGate,
    overconfidentBinIndices,
    underconfidentBinIndices,
  };
}

export function recordCalibrationMetrics(
  report: CalibrationReport,
  metrics?: MetricsProvider,
): void {
  if (!metrics) return;

  metrics.gauge(
    TELEMETRY_METRIC_NAMES.EVAL_CALIBRATION_ERROR,
    report.overall.expectedCalibrationError,
    { scope: "overall" },
  );

  for (const [taskType, aggregate] of Object.entries(report.byTaskType)) {
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_CALIBRATION_ERROR,
      aggregate.expectedCalibrationError,
      { scope: "task_type", task_type: taskType },
    );
  }

  for (const [rewardTier, aggregate] of Object.entries(report.byRewardTier)) {
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_CALIBRATION_ERROR,
      aggregate.expectedCalibrationError,
      { scope: "reward_tier", reward_tier: rewardTier },
    );
  }

  for (const [gate, aggregate] of Object.entries(report.byVerifierGate)) {
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_CALIBRATION_ERROR,
      aggregate.expectedCalibrationError,
      { scope: "verifier_gate", verifier_gate: gate },
    );
  }
}
