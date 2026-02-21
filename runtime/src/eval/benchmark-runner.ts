/**
 * Deterministic benchmark runner for versioned scenario manifests.
 *
 * @module
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  EvalRunRecord,
  EvaluationScorecard,
  ScorecardSerializeResult,
} from "./metrics.js";
import {
  computeEvaluationScorecard,
  evalRunFromReplayResult,
  serializeEvaluationScorecard,
} from "./metrics.js";
import { TrajectoryReplayEngine } from "./replay.js";
import {
  parseTrajectoryTrace,
  stableStringifyJson,
  type JsonValue,
} from "./types.js";
import {
  hashBenchmarkManifest,
  loadBenchmarkManifest,
  parseBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkScenarioManifest,
} from "./benchmark-manifest.js";

export const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface BenchmarkScenarioRunArtifact {
  runId: string;
  seed: number;
  traceId: string;
  deterministicHash: string;
  passed: boolean;
  latencyMs?: number;
  costUnits?: number;
  policyViolations?: number;
  verifierDisagreements?: number;
  rewardLamports?: string;
}

export interface BenchmarkMetricDelta {
  passRate: number;
  passAtK: number;
  passCaretK: number;
  riskWeightedSuccess: number;
  conformanceScore: number;
  costNormalizedUtility: number;
}

export interface BenchmarkScenarioReportArtifact {
  scenarioId: string;
  title: string;
  taskClass: string;
  riskTier: BenchmarkScenarioManifest["riskTier"];
  expectedConstraints: string[];
  runs: BenchmarkScenarioRunArtifact[];
  scorecard: EvaluationScorecard;
  serializedScorecard: ScorecardSerializeResult;
  deltasFromBaseline?: BenchmarkMetricDelta;
}

export interface BenchmarkArtifact {
  schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  generatedAtMs: number;
  corpusVersion: string;
  manifestHash: string;
  baselineScenarioId?: string;
  aggregate: {
    scorecard: EvaluationScorecard;
    serializedScorecard: ScorecardSerializeResult;
    deltasFromBaseline?: BenchmarkMetricDelta;
  };
  scenarios: BenchmarkScenarioReportArtifact[];
}

export interface BenchmarkScenarioExecutionContext {
  manifest: BenchmarkManifest;
  scenario: BenchmarkScenarioManifest;
  seed: number;
}

export interface BenchmarkScenarioExecutionOutput {
  trace: unknown;
  recordOverrides?: Partial<EvalRunRecord>;
}

export type BenchmarkScenarioRunner = (
  context: BenchmarkScenarioExecutionContext,
) =>
  | Promise<BenchmarkScenarioExecutionOutput>
  | BenchmarkScenarioExecutionOutput;

export interface BenchmarkRunnerConfig {
  now?: () => number;
  runId?: string;
  strictReplay?: boolean;
}

export interface BenchmarkRunOptions {
  scenarioRunners?: Record<string, BenchmarkScenarioRunner>;
  manifestDir?: string;
  k?: number;
}

function riskTierToScore(tier: BenchmarkScenarioManifest["riskTier"]): number {
  if (tier === "low") return 0.2;
  if (tier === "medium") return 0.5;
  return 0.85;
}

function toRewardString(
  value: EvalRunRecord["rewardLamports"],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function computeDeltas(
  aggregate: EvaluationScorecard["aggregate"],
  baseline: EvaluationScorecard["aggregate"],
): BenchmarkMetricDelta {
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

async function readFixtureTrace(
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

/**
 * Deterministic benchmark runner.
 */
export class BenchmarkRunner {
  private readonly now: () => number;
  private readonly runId?: string;
  private readonly strictReplay: boolean;

  constructor(config: BenchmarkRunnerConfig = {}) {
    this.now = config.now ?? Date.now;
    this.runId = config.runId;
    this.strictReplay = config.strictReplay ?? true;
  }

  async runFromFile(
    manifestPath: string,
    options: Omit<BenchmarkRunOptions, "manifestDir"> = {},
  ): Promise<BenchmarkArtifact> {
    const manifest = await loadBenchmarkManifest(manifestPath);
    return await this.run(manifest, {
      ...options,
      manifestDir: path.dirname(manifestPath),
    });
  }

  async run(
    input: BenchmarkManifest,
    options: BenchmarkRunOptions = {},
  ): Promise<BenchmarkArtifact> {
    const manifest = parseBenchmarkManifest(input);
    const runId = this.runId ?? `benchmark-${this.now()}`;
    const manifestHash = hashBenchmarkManifest(manifest);
    const k = Math.max(1, Math.floor(options.k ?? manifest.k ?? 3));

    const scenarioRunners = options.scenarioRunners ?? {};
    const scenarioReports: BenchmarkScenarioReportArtifact[] = [];
    const allRunRecords: EvalRunRecord[] = [];
    let baselineAggregate: EvaluationScorecard["aggregate"] | null = null;

    for (const scenario of manifest.scenarios) {
      const scenarioRuns: BenchmarkScenarioRunArtifact[] = [];
      const scenarioRunRecords: EvalRunRecord[] = [];

      for (const seed of scenario.seeds) {
        const scenarioRunner = scenarioRunners[scenario.id];
        const execution = scenarioRunner
          ? await scenarioRunner({ manifest, scenario, seed })
          : {
              trace: await readFixtureTrace(
                scenario,
                seed,
                options.manifestDir,
              ),
            };

        const replay = new TrajectoryReplayEngine({
          strictMode: this.strictReplay,
          seed,
        }).replay(execution.trace);

        const runIdForSeed = `${scenario.id}:seed-${seed}`;
        const record = evalRunFromReplayResult(replay, {
          id: runIdForSeed,
          taskType: scenario.taskClass,
          riskScore: riskTierToScore(scenario.riskTier),
          rewardLamports: scenario.rewardLamports,
          verifierGated: scenario.verifierGated,
          costUnits: scenario.costUnits,
          ...execution.recordOverrides,
        });
        scenarioRunRecords.push(record);
        allRunRecords.push(record);

        scenarioRuns.push({
          runId: runIdForSeed,
          seed,
          traceId: replay.trace.traceId,
          deterministicHash: replay.deterministicHash,
          passed: record.passed,
          latencyMs: record.latencyMs,
          costUnits: record.costUnits,
          policyViolations: record.policyViolations,
          verifierDisagreements: record.verifierDisagreements,
          rewardLamports: toRewardString(record.rewardLamports),
        });
      }

      const scorecard = computeEvaluationScorecard(scenarioRunRecords, { k });
      if (
        manifest.baselineScenarioId &&
        scenario.id === manifest.baselineScenarioId
      ) {
        baselineAggregate = scorecard.aggregate;
      }

      scenarioReports.push({
        scenarioId: scenario.id,
        title: scenario.title,
        taskClass: scenario.taskClass,
        riskTier: scenario.riskTier,
        expectedConstraints: [...scenario.expectedConstraints],
        runs: scenarioRuns,
        scorecard,
        serializedScorecard: serializeEvaluationScorecard(scorecard),
      });
    }

    if (!baselineAggregate && scenarioReports.length > 0) {
      baselineAggregate = scenarioReports[0]!.scorecard.aggregate;
    }

    if (baselineAggregate) {
      for (const scenario of scenarioReports) {
        scenario.deltasFromBaseline = computeDeltas(
          scenario.scorecard.aggregate,
          baselineAggregate,
        );
      }
    }

    const aggregateScorecard = computeEvaluationScorecard(allRunRecords, { k });
    const artifact: BenchmarkArtifact = {
      schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
      runId,
      generatedAtMs: this.now(),
      corpusVersion: manifest.corpusVersion,
      manifestHash,
      baselineScenarioId: manifest.baselineScenarioId,
      aggregate: {
        scorecard: aggregateScorecard,
        serializedScorecard: serializeEvaluationScorecard(aggregateScorecard),
        deltasFromBaseline: baselineAggregate
          ? computeDeltas(aggregateScorecard.aggregate, baselineAggregate)
          : undefined,
      },
      scenarios: scenarioReports,
    };

    return artifact;
  }
}

/**
 * Stable JSON serialization for benchmark artifacts.
 */
export function serializeBenchmarkArtifact(
  artifact: BenchmarkArtifact,
): string {
  return stableStringifyJson(artifact as unknown as JsonValue);
}

/**
 * Persist benchmark artifact to disk.
 */
export async function writeBenchmarkArtifact(
  outputPath: string,
  artifact: BenchmarkArtifact,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${serializeBenchmarkArtifact(artifact)}\n`,
    "utf8",
  );
}
