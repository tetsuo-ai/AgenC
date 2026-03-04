/**
 * Deterministic benchmark runner for versioned scenario manifests.
 *
 * @module
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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
import { stableStringifyJson, type JsonValue } from "./types.js";
import {
  hashBenchmarkManifest,
  loadBenchmarkManifest,
  parseBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkScenarioManifest,
} from "./benchmark-manifest.js";
import {
  computeScorecardMetricDelta,
  readBenchmarkFixtureTrace,
  riskTierToScore,
  toRewardString,
  type ScorecardMetricDelta,
} from "./runner-shared.js";

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

export type BenchmarkMetricDelta = ScorecardMetricDelta;

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
              trace: await readBenchmarkFixtureTrace(
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
        scenario.deltasFromBaseline = computeScorecardMetricDelta(
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
          ? computeScorecardMetricDelta(
              aggregateScorecard.aggregate,
              baselineAggregate,
            )
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
