/**
 * Offline decomposition workflow search harness (AFlow-inspired).
 *
 * Evaluates DAG variants over replay traces and promotes only variants that
 * improve the quality-cost-latency Pareto frontier over baseline.
 *
 * @module
 */

import { TrajectoryReplayEngine } from "./replay.js";
import type { TrajectoryTrace } from "./types.js";

export interface DecompositionDagVariant {
  readonly variantId: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly maxDepth: number;
  readonly maxParallelism: number;
  readonly strategyArmId?: string;
}

export interface DecompositionReplayFixture {
  readonly fixtureId: string;
  readonly trace: TrajectoryTrace | unknown;
}

export interface DecompositionSearchConfig {
  readonly minQualityGain?: number;
  readonly maxCostIncreaseRatio?: number;
  readonly maxLatencyIncreaseRatio?: number;
  readonly replayStrictMode?: boolean;
}

export interface DecompositionVariantScore {
  readonly variantId: string;
  readonly quality: number;
  readonly costUnits: number;
  readonly latencyMs: number;
  readonly reward: number;
  readonly onParetoFrontier: boolean;
  readonly dominatesBaseline: boolean;
  readonly rationale: readonly string[];
}

export interface DecompositionSearchResult {
  readonly baseline: {
    readonly quality: number;
    readonly costUnits: number;
    readonly latencyMs: number;
  };
  readonly variantScores: readonly DecompositionVariantScore[];
  readonly paretoFrontierIds: readonly string[];
  readonly promotedVariantIds: readonly string[];
}

interface AggregateReplayMetrics {
  readonly quality: number;
  readonly costUnits: number;
  readonly latencyMs: number;
}

const DEFAULT_MIN_QUALITY_GAIN = 0.01;
const DEFAULT_MAX_COST_INCREASE_RATIO = 0.1;
const DEFAULT_MAX_LATENCY_INCREASE_RATIO = 0.1;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getTraceLatencyMs(trace: TrajectoryTrace): number {
  if (trace.events.length === 0) return 0;
  const first = trace.events[0]?.timestampMs ?? 0;
  const last = trace.events[trace.events.length - 1]?.timestampMs ?? first;
  return Math.max(0, last - first);
}

function aggregateReplayMetrics(
  fixtures: readonly DecompositionReplayFixture[],
  strictMode: boolean,
): AggregateReplayMetrics {
  const replay = new TrajectoryReplayEngine({ strictMode });
  const qualitySeries: number[] = [];
  const costSeries: number[] = [];
  const latencySeries: number[] = [];

  for (const fixture of fixtures) {
    const replayResult = replay.replay(fixture.trace);
    const taskCount = replayResult.summary.taskCount;
    const quality = taskCount > 0
      ? replayResult.summary.completedTasks / taskCount
      : 0;
    const costUnits = replayResult.summary.totalEvents;
    const latencyMs = getTraceLatencyMs(replayResult.trace);

    qualitySeries.push(clamp01(quality));
    costSeries.push(Math.max(1, costUnits));
    latencySeries.push(Math.max(0, latencyMs));
  }

  return {
    quality: clamp01(mean(qualitySeries)),
    costUnits: Math.max(1, mean(costSeries)),
    latencyMs: Math.max(0, mean(latencySeries)),
  };
}

function evaluateVariant(
  baseline: AggregateReplayMetrics,
  variant: DecompositionDagVariant,
): Omit<DecompositionVariantScore, "onParetoFrontier" | "dominatesBaseline"> {
  const parallelism = Math.max(1, variant.maxParallelism);
  const depth = Math.max(1, variant.maxDepth);
  const nodeCount = Math.max(1, variant.nodeCount);
  const edgeDensity = variant.edgeCount / nodeCount;

  const strategyBias = variant.strategyArmId === "aggressive"
    ? 0.03
    : variant.strategyArmId === "conservative"
      ? -0.01
      : 0;

  const qualityGain = clamp01(
    0.015 * Math.log2(parallelism + 1) -
      0.01 * Math.max(0, depth - 2) +
      strategyBias,
  );
  const quality = clamp01(baseline.quality + qualityGain);

  const costMultiplier =
    1 +
    0.08 * Math.max(0, parallelism - 1) +
    0.03 * Math.max(0, depth - 1) +
    0.02 * Math.max(0, edgeDensity - 1);
  const costUnits = Math.max(1, baseline.costUnits * costMultiplier);

  const latencyMultiplier =
    1 +
    0.06 * Math.max(0, depth - 1) -
    0.03 * Math.max(0, parallelism - 1);
  const latencyMs = Math.max(0, baseline.latencyMs * latencyMultiplier);

  const normalizedCostPenalty = Math.min(1, costUnits / Math.max(1, baseline.costUnits * 2));
  const normalizedLatencyPenalty =
    Math.min(1, latencyMs / Math.max(1, baseline.latencyMs * 2));
  const reward =
    quality -
    0.25 * normalizedCostPenalty -
    0.25 * normalizedLatencyPenalty;

  const rationale = [
    `parallelism=${parallelism}`,
    `depth=${depth}`,
    `edgeDensity=${edgeDensity.toFixed(3)}`,
    `strategy=${variant.strategyArmId ?? "balanced"}`,
  ];

  return {
    variantId: variant.variantId,
    quality,
    costUnits,
    latencyMs,
    reward,
    rationale,
  };
}

function dominates(
  a: Pick<DecompositionVariantScore, "quality" | "costUnits" | "latencyMs">,
  b: Pick<DecompositionVariantScore, "quality" | "costUnits" | "latencyMs">,
): boolean {
  const noWorse =
    a.quality >= b.quality &&
    a.costUnits <= b.costUnits &&
    a.latencyMs <= b.latencyMs;
  const strictlyBetter =
    a.quality > b.quality ||
    a.costUnits < b.costUnits ||
    a.latencyMs < b.latencyMs;
  return noWorse && strictlyBetter;
}

export function searchDecompositionPolicies(input: {
  readonly fixtures: readonly DecompositionReplayFixture[];
  readonly variants: readonly DecompositionDagVariant[];
  readonly config?: DecompositionSearchConfig;
}): DecompositionSearchResult {
  const strictMode = input.config?.replayStrictMode ?? true;
  const baseline = aggregateReplayMetrics(input.fixtures, strictMode);
  const minQualityGain = input.config?.minQualityGain ?? DEFAULT_MIN_QUALITY_GAIN;
  const maxCostIncreaseRatio =
    input.config?.maxCostIncreaseRatio ?? DEFAULT_MAX_COST_INCREASE_RATIO;
  const maxLatencyIncreaseRatio =
    input.config?.maxLatencyIncreaseRatio ?? DEFAULT_MAX_LATENCY_INCREASE_RATIO;

  const scored = input.variants.map((variant) =>
    evaluateVariant(baseline, variant),
  );

  const paretoFrontier = scored.filter((candidate) =>
    !scored.some((other) =>
      other.variantId !== candidate.variantId && dominates(other, candidate)
    )
  );
  const frontierIds = paretoFrontier.map((entry) => entry.variantId);

  const variantScores: DecompositionVariantScore[] = scored.map((entry) => {
    const dominatesBaseline = dominates(entry, baseline);
    return {
      ...entry,
      onParetoFrontier: frontierIds.includes(entry.variantId),
      dominatesBaseline,
    };
  });

  const promotedVariantIds = variantScores
    .filter((entry) => entry.onParetoFrontier)
    .filter((entry) => entry.quality >= baseline.quality + minQualityGain)
    .filter((entry) =>
      entry.costUnits <= baseline.costUnits * (1 + maxCostIncreaseRatio)
    )
    .filter((entry) =>
      entry.latencyMs <= baseline.latencyMs * (1 + maxLatencyIncreaseRatio)
    )
    .map((entry) => entry.variantId);

  return {
    baseline,
    variantScores,
    paretoFrontierIds: frontierIds,
    promotedVariantIds,
  };
}
