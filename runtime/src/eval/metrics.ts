/**
 * Reliability scorecard metrics for trajectory evaluation.
 *
 * @module
 */

import type { MetricsProvider } from "../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import type { TrajectoryReplayResult } from "./replay.js";

export type RewardTier = "low" | "medium" | "high" | "unknown";

export interface EvalRunRecord {
  id: string;
  passed: boolean;
  taskType?: string;
  rewardLamports?: bigint | number | string;
  verifierGated?: boolean;
  riskScore?: number;
  costUnits?: number;
  latencyMs?: number;
  policyViolations?: number;
  verifierDisagreements?: number;
}

export interface EvalAggregateMetrics {
  runCount: number;
  successCount: number;
  passRate: number;
  passAtK: number;
  passCaretK: number;
  riskWeightedSuccess: number;
  conformanceScore: number;
  costNormalizedUtility: number;
  meanLatencyMs: number;
  meanCostUnits: number;
}

export interface EvaluationScorecard {
  k: number;
  aggregate: EvalAggregateMetrics;
  byTaskType: Record<string, EvalAggregateMetrics>;
  byRewardTier: Record<RewardTier, EvalAggregateMetrics>;
  byVerifierGate: Record<"gated" | "ungated", EvalAggregateMetrics>;
}

export interface ScorecardSerializeResult {
  json: string;
  summary: string;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeNumber(value: number | undefined, fallback = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return value;
}

function toLamportsNumber(
  value: bigint | number | string | undefined,
): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > maxSafe) return Number.MAX_SAFE_INTEGER;
    if (value < 0n) return 0;
    return Number(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function getRewardTier(
  rewardLamports: bigint | number | string | undefined,
): RewardTier {
  const lamports = toLamportsNumber(rewardLamports);
  if (lamports === undefined) return "unknown";
  if (lamports < 1_000_000) return "low";
  if (lamports < 100_000_000) return "medium";
  return "high";
}

/**
 * Standard pass@k estimate (sampling without replacement).
 */
export function computePassAtK(
  totalRuns: number,
  successRuns: number,
  k: number,
): number {
  if (totalRuns <= 0 || k <= 0) return 0;
  const n = totalRuns;
  const c = Math.max(0, Math.min(successRuns, totalRuns));
  const kk = Math.min(k, n);

  if (n - c < kk) {
    return 1;
  }

  let missProbability = 1;
  for (let i = 0; i < kk; i++) {
    missProbability *= (n - c - i) / (n - i);
  }

  return 1 - missProbability;
}

/**
 * pass^k estimate (independent retries with replacement).
 */
export function computePassCaretK(passRate: number, k: number): number {
  if (k <= 0) return 0;
  const p = clamp01(passRate);
  return 1 - Math.pow(1 - p, k);
}

function computeRiskWeightedSuccess(records: EvalRunRecord[]): number {
  if (records.length === 0) return 0;

  let weightedSuccess = 0;
  let weightedTotal = 0;

  for (const record of records) {
    const weight = 0.5 + clamp01(safeNumber(record.riskScore, 0));
    weightedSuccess += (record.passed ? 1 : 0) * weight;
    weightedTotal += weight;
  }

  return weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
}

function computeConformanceScore(records: EvalRunRecord[]): number {
  if (records.length === 0) return 0;

  let total = 0;
  for (const record of records) {
    const policyViolations = Math.max(
      0,
      safeNumber(record.policyViolations, 0),
    );
    const verifierDisagreements = Math.max(
      0,
      safeNumber(record.verifierDisagreements, 0),
    );
    total += 1 / (1 + policyViolations + verifierDisagreements);
  }

  return total / records.length;
}

function computeCostNormalizedUtility(records: EvalRunRecord[]): number {
  if (records.length === 0) return 0;

  let weightedSuccess = 0;
  let totalCost = 0;

  for (const record of records) {
    const successWeight = 0.5 + clamp01(safeNumber(record.riskScore, 0));
    weightedSuccess += (record.passed ? 1 : 0) * successWeight;

    const cost = safeNumber(record.costUnits, 1);
    totalCost += Math.max(cost, 1e-9);
  }

  return weightedSuccess / totalCost;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function computeAggregate(
  records: EvalRunRecord[],
  k: number,
): EvalAggregateMetrics {
  if (records.length === 0) {
    return {
      runCount: 0,
      successCount: 0,
      passRate: 0,
      passAtK: 0,
      passCaretK: 0,
      riskWeightedSuccess: 0,
      conformanceScore: 0,
      costNormalizedUtility: 0,
      meanLatencyMs: 0,
      meanCostUnits: 0,
    };
  }

  const successCount = records.filter((record) => record.passed).length;
  const passRate = successCount / records.length;

  return {
    runCount: records.length,
    successCount,
    passRate,
    passAtK: computePassAtK(records.length, successCount, k),
    passCaretK: computePassCaretK(passRate, k),
    riskWeightedSuccess: computeRiskWeightedSuccess(records),
    conformanceScore: computeConformanceScore(records),
    costNormalizedUtility: computeCostNormalizedUtility(records),
    meanLatencyMs: mean(
      records.map((record) => safeNumber(record.latencyMs, 0)),
    ),
    meanCostUnits: mean(
      records.map((record) => safeNumber(record.costUnits, 1)),
    ),
  };
}

function groupBy<T>(
  records: EvalRunRecord[],
  selector: (record: EvalRunRecord) => T,
): Map<T, EvalRunRecord[]> {
  const groups = new Map<T, EvalRunRecord[]>();

  for (const record of records) {
    const key = selector(record);
    const current = groups.get(key);
    if (current) {
      current.push(record);
      continue;
    }
    groups.set(key, [record]);
  }

  return groups;
}

function extractDurationFromReplay(
  replay: TrajectoryReplayResult,
): number | undefined {
  const durationValues = replay.trace.events
    .filter(
      (event) =>
        event.type === "completed" || event.type === "completed_speculative",
    )
    .map((event) => event.payload.durationMs)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );

  return durationValues.length > 0 ? mean(durationValues) : undefined;
}

function extractVerifierDisagreementsFromReplay(
  replay: TrajectoryReplayResult,
): number {
  let disagreements = 0;

  for (const event of replay.trace.events) {
    if (event.type !== "verifier_verdict") continue;
    const verdict = event.payload.verdict;
    const attempt = event.payload.attempt;

    if (verdict !== "pass" && (attempt === 1 || attempt === undefined)) {
      disagreements++;
    }
  }

  return disagreements;
}

/**
 * Build a run record from replay output to feed scorecard calculation.
 */
export function evalRunFromReplayResult(
  replay: TrajectoryReplayResult,
  overrides: Partial<EvalRunRecord> = {},
): EvalRunRecord {
  const passed =
    replay.summary.completedTasks > 0 &&
    replay.summary.failedTasks === 0 &&
    replay.summary.escalatedTasks === 0;

  return {
    id: overrides.id ?? replay.trace.traceId,
    passed: overrides.passed ?? passed,
    taskType: overrides.taskType,
    rewardLamports: overrides.rewardLamports,
    verifierGated: overrides.verifierGated,
    riskScore: overrides.riskScore,
    costUnits: overrides.costUnits,
    latencyMs: overrides.latencyMs ?? extractDurationFromReplay(replay),
    policyViolations:
      overrides.policyViolations ?? replay.summary.policyViolations,
    verifierDisagreements:
      overrides.verifierDisagreements ??
      extractVerifierDisagreementsFromReplay(replay),
  };
}

/**
 * Compute reliability scorecard with stratified breakouts.
 */
export function computeEvaluationScorecard(
  records: EvalRunRecord[],
  options: { k?: number } = {},
): EvaluationScorecard {
  const k = Math.max(1, Math.floor(options.k ?? 3));

  const byTaskType: Record<string, EvalAggregateMetrics> = {};
  const byRewardTier: Record<RewardTier, EvalAggregateMetrics> = {
    low: computeAggregate([], k),
    medium: computeAggregate([], k),
    high: computeAggregate([], k),
    unknown: computeAggregate([], k),
  };
  const byVerifierGate: Record<"gated" | "ungated", EvalAggregateMetrics> = {
    gated: computeAggregate([], k),
    ungated: computeAggregate([], k),
  };

  const taskTypeGroups = groupBy(
    records,
    (record) => record.taskType ?? "unknown",
  );
  for (const [taskType, taskTypeRecords] of taskTypeGroups) {
    byTaskType[String(taskType)] = computeAggregate(taskTypeRecords, k);
  }

  const rewardTierGroups = groupBy(records, (record) =>
    getRewardTier(record.rewardLamports),
  );
  for (const [rewardTier, tierRecords] of rewardTierGroups) {
    byRewardTier[rewardTier] = computeAggregate(tierRecords, k);
  }

  const verifierGateGroups = groupBy(records, (record) =>
    record.verifierGated ? "gated" : "ungated",
  );
  for (const [gate, gateRecords] of verifierGateGroups) {
    byVerifierGate[gate] = computeAggregate(gateRecords, k);
  }

  return {
    k,
    aggregate: computeAggregate(records, k),
    byTaskType,
    byRewardTier,
    byVerifierGate,
  };
}

/**
 * Emit scorecard metrics via existing MetricsProvider collector API.
 */
export function recordEvaluationMetrics(
  scorecard: EvaluationScorecard,
  metrics?: MetricsProvider,
): void {
  if (!metrics) return;

  const emit = (
    labels: Record<string, string>,
    aggregate: EvalAggregateMetrics,
  ): void => {
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_PASS_AT_K,
      aggregate.passAtK,
      labels,
    );
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_PASS_CARET_K,
      aggregate.passCaretK,
      labels,
    );
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_RISK_WEIGHTED_SUCCESS,
      aggregate.riskWeightedSuccess,
      labels,
    );
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_CONFORMANCE_SCORE,
      aggregate.conformanceScore,
      labels,
    );
    metrics.gauge(
      TELEMETRY_METRIC_NAMES.EVAL_COST_NORMALIZED_UTILITY,
      aggregate.costNormalizedUtility,
      labels,
    );
  };

  emit({ scope: "aggregate", k: String(scorecard.k) }, scorecard.aggregate);

  for (const [taskType, aggregate] of Object.entries(scorecard.byTaskType)) {
    emit(
      { scope: "task_type", task_type: taskType, k: String(scorecard.k) },
      aggregate,
    );
  }

  for (const [rewardTier, aggregate] of Object.entries(
    scorecard.byRewardTier,
  )) {
    emit(
      { scope: "reward_tier", reward_tier: rewardTier, k: String(scorecard.k) },
      aggregate,
    );
  }

  for (const [gate, aggregate] of Object.entries(scorecard.byVerifierGate)) {
    emit(
      { scope: "verifier_gate", verifier_gate: gate, k: String(scorecard.k) },
      aggregate,
    );
  }
}

/**
 * Serialize scorecard for CI artifacts (machine + human readable).
 */
export function serializeEvaluationScorecard(
  scorecard: EvaluationScorecard,
): ScorecardSerializeResult {
  const json = JSON.stringify(scorecard, null, 2);

  const summaryLines: string[] = [
    `k=${scorecard.k}`,
    `runs=${scorecard.aggregate.runCount}`,
    `success=${scorecard.aggregate.successCount}`,
    `pass_rate=${scorecard.aggregate.passRate.toFixed(4)}`,
    `pass_at_k=${scorecard.aggregate.passAtK.toFixed(4)}`,
    `pass_caret_k=${scorecard.aggregate.passCaretK.toFixed(4)}`,
    `risk_weighted_success=${scorecard.aggregate.riskWeightedSuccess.toFixed(4)}`,
    `conformance_score=${scorecard.aggregate.conformanceScore.toFixed(4)}`,
    `cost_normalized_utility=${scorecard.aggregate.costNormalizedUtility.toFixed(6)}`,
    `mean_latency_ms=${scorecard.aggregate.meanLatencyMs.toFixed(2)}`,
    `mean_cost_units=${scorecard.aggregate.meanCostUnits.toFixed(4)}`,
  ];

  return {
    json,
    summary: summaryLines.join("\n"),
  };
}
