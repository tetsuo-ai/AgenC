import path from "node:path";
import { readFile } from "node:fs/promises";
import type { EvalRunRecord, EvaluationScorecard } from "./metrics.js";
import { parseTrajectoryTrace } from "./types.js";
import type { BenchmarkScenarioManifest } from "./benchmark-manifest.js";

type AggregateMetrics = Pick<
  EvaluationScorecard["aggregate"],
  | "passRate"
  | "passAtK"
  | "passCaretK"
  | "riskWeightedSuccess"
  | "conformanceScore"
  | "costNormalizedUtility"
>;

export interface ScorecardMetricDelta {
  passRate: number;
  passAtK: number;
  passCaretK: number;
  riskWeightedSuccess: number;
  conformanceScore: number;
  costNormalizedUtility: number;
}

export function riskTierToScore(
  tier: BenchmarkScenarioManifest["riskTier"],
): number {
  if (tier === "low") return 0.2;
  if (tier === "medium") return 0.5;
  return 0.85;
}

export function toRewardString(
  value: EvalRunRecord["rewardLamports"],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

export function computeScorecardMetricDelta(
  aggregate: AggregateMetrics,
  baseline: AggregateMetrics,
): ScorecardMetricDelta {
  return {
    passRate: aggregate.passRate - baseline.passRate,
    passAtK: aggregate.passAtK - baseline.passAtK,
    passCaretK: aggregate.passCaretK - baseline.passCaretK,
    riskWeightedSuccess:
      aggregate.riskWeightedSuccess - baseline.riskWeightedSuccess,
    conformanceScore: aggregate.conformanceScore - baseline.conformanceScore,
    costNormalizedUtility:
      aggregate.costNormalizedUtility - baseline.costNormalizedUtility,
  };
}

export async function readBenchmarkFixtureTrace(
  scenario: BenchmarkScenarioManifest,
  seed: number,
  manifestDir: string | undefined,
): Promise<unknown> {
  if (!scenario.fixtureTrace) {
    throw new Error(
      `scenario "${scenario.id}" has no runner and no fixtureTrace`,
    );
  }
  const fixturePath = path.isAbsolute(scenario.fixtureTrace)
    ? scenario.fixtureTrace
    : path.resolve(manifestDir ?? process.cwd(), scenario.fixtureTrace);
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const trace = parseTrajectoryTrace(parsed);
  return {
    ...trace,
    traceId: `${scenario.id}:seed-${seed}`,
    seed,
  };
}
