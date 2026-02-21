/**
 * Deterministic mutation runner for benchmark robustness regression testing.
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
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  BenchmarkRunner,
  type BenchmarkMetricDelta,
  type BenchmarkRunOptions,
} from "./benchmark-runner.js";
import {
  hashBenchmarkManifest,
  loadBenchmarkManifest,
  parseBenchmarkManifest,
  type BenchmarkManifest,
  type BenchmarkScenarioManifest,
} from "./benchmark-manifest.js";
import {
  MutationEngine,
  type MutationOperatorCategory,
} from "./mutation-engine.js";

export const MUTATION_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface MutationScenarioRunArtifact {
  mutationId: string;
  scenarioId: string;
  operatorId: string;
  operatorCategory: MutationOperatorCategory;
  seed: number;
  traceId: string;
  deterministicHash: string;
  passed: boolean;
  latencyMs?: number;
  costUnits?: number;
  policyViolations?: number;
  verifierDisagreements?: number;
  rewardLamports?: string;
  note?: string;
}

export interface MutationOperatorReportArtifact {
  operatorId: string;
  operatorCategory: MutationOperatorCategory;
  description: string;
  runCount: number;
  scorecard: EvaluationScorecard;
  serializedScorecard: ScorecardSerializeResult;
  deltasFromBaseline: BenchmarkMetricDelta;
}

export interface MutationScenarioReportArtifact {
  scenarioId: string;
  title: string;
  taskClass: string;
  riskTier: BenchmarkScenarioManifest["riskTier"];
  runCount: number;
  scorecard: EvaluationScorecard;
  serializedScorecard: ScorecardSerializeResult;
  deltasFromBaseline: BenchmarkMetricDelta;
}

export interface MutationRegressionScenario {
  scope: "aggregate" | "scenario" | "operator";
  id: string;
  passRateDelta: number;
  conformanceScoreDelta: number;
  costNormalizedUtilityDelta: number;
  runCount: number;
}

export interface MutationArtifact {
  schemaVersion: typeof MUTATION_ARTIFACT_SCHEMA_VERSION;
  benchmarkSchemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  generatedAtMs: number;
  mutationSeed: number;
  corpusVersion: string;
  manifestHash: string;
  baselineBenchmarkRunId: string;
  baselineAggregate: {
    scorecard: EvaluationScorecard;
    serializedScorecard: ScorecardSerializeResult;
  };
  aggregate: {
    scorecard: EvaluationScorecard;
    serializedScorecard: ScorecardSerializeResult;
    deltasFromBaseline: BenchmarkMetricDelta;
  };
  runs: MutationScenarioRunArtifact[];
  operators: MutationOperatorReportArtifact[];
  scenarios: MutationScenarioReportArtifact[];
  topRegressions: MutationRegressionScenario[];
}

export interface MutationRunnerConfig {
  now?: () => number;
  runId?: string;
  strictReplay?: boolean;
  engine?: MutationEngine;
}

export interface MutationRunOptions extends BenchmarkRunOptions {
  operatorIds?: string[];
  maxMutationsPerScenario?: number;
  mutationSeed?: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function riskTierToScore(tier: BenchmarkScenarioManifest["riskTier"]): number {
  if (tier === "low") return 0.2;
  if (tier === "medium") return 0.5;
  return 0.85;
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

function toRewardString(
  value: EvalRunRecord["rewardLamports"],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  return String(value);
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

function buildTopRegressions(
  aggregateDelta: BenchmarkMetricDelta,
  scenarioReports: MutationScenarioReportArtifact[],
  operatorReports: MutationOperatorReportArtifact[],
): MutationRegressionScenario[] {
  const entries: MutationRegressionScenario[] = [
    {
      scope: "aggregate",
      id: "aggregate",
      passRateDelta: aggregateDelta.passRate,
      conformanceScoreDelta: aggregateDelta.conformanceScore,
      costNormalizedUtilityDelta: aggregateDelta.costNormalizedUtility,
      runCount: scenarioReports.reduce(
        (acc, report) => acc + report.runCount,
        0,
      ),
    },
  ];

  for (const scenario of scenarioReports) {
    entries.push({
      scope: "scenario",
      id: scenario.scenarioId,
      passRateDelta: scenario.deltasFromBaseline.passRate,
      conformanceScoreDelta: scenario.deltasFromBaseline.conformanceScore,
      costNormalizedUtilityDelta:
        scenario.deltasFromBaseline.costNormalizedUtility,
      runCount: scenario.runCount,
    });
  }

  for (const operator of operatorReports) {
    entries.push({
      scope: "operator",
      id: operator.operatorId,
      passRateDelta: operator.deltasFromBaseline.passRate,
      conformanceScoreDelta: operator.deltasFromBaseline.conformanceScore,
      costNormalizedUtilityDelta:
        operator.deltasFromBaseline.costNormalizedUtility,
      runCount: operator.runCount,
    });
  }

  return entries
    .sort((left, right) => {
      if (left.passRateDelta !== right.passRateDelta) {
        return left.passRateDelta - right.passRateDelta;
      }
      if (left.conformanceScoreDelta !== right.conformanceScoreDelta) {
        return left.conformanceScoreDelta - right.conformanceScoreDelta;
      }
      return left.id.localeCompare(right.id);
    })
    .slice(0, 10);
}

/**
 * Parse and validate mutation artifact input.
 */
export function parseMutationArtifact(value: unknown): MutationArtifact {
  assert(isPlainObject(value), "mutation artifact must be an object");
  assert(
    value.schemaVersion === MUTATION_ARTIFACT_SCHEMA_VERSION,
    `unsupported mutation artifact schemaVersion: ${String(value.schemaVersion)}`,
  );
  assert(
    value.benchmarkSchemaVersion === BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    `unsupported benchmark schema version: ${String(value.benchmarkSchemaVersion)}`,
  );
  assert(
    typeof value.runId === "string" && value.runId.length > 0,
    "runId must be a non-empty string",
  );
  assert(
    Number.isInteger(value.generatedAtMs),
    "generatedAtMs must be an integer",
  );
  assert(
    typeof value.corpusVersion === "string" && value.corpusVersion.length > 0,
    "corpusVersion must be a non-empty string",
  );
  assert(
    typeof value.manifestHash === "string" && value.manifestHash.length > 0,
    "manifestHash must be a non-empty string",
  );
  assert(Array.isArray(value.runs), "runs must be an array");
  assert(Array.isArray(value.operators), "operators must be an array");
  assert(Array.isArray(value.scenarios), "scenarios must be an array");
  assert(
    Array.isArray(value.topRegressions),
    "topRegressions must be an array",
  );
  return value as unknown as MutationArtifact;
}

/**
 * Deterministic mutation runner.
 */
export class MutationRunner {
  private readonly now: () => number;
  private readonly runId?: string;
  private readonly strictReplay: boolean;
  private readonly engine: MutationEngine;

  constructor(config: MutationRunnerConfig = {}) {
    this.now = config.now ?? Date.now;
    this.runId = config.runId;
    this.strictReplay = config.strictReplay ?? true;
    this.engine = config.engine ?? new MutationEngine();
  }

  async runFromFile(
    manifestPath: string,
    options: Omit<MutationRunOptions, "manifestDir"> = {},
  ): Promise<MutationArtifact> {
    const manifest = await loadBenchmarkManifest(manifestPath);
    return await this.run(manifest, {
      ...options,
      manifestDir: path.dirname(manifestPath),
    });
  }

  async run(
    input: BenchmarkManifest,
    options: MutationRunOptions = {},
  ): Promise<MutationArtifact> {
    const manifest = parseBenchmarkManifest(input);
    const runId = this.runId ?? `mutation-${this.now()}`;
    const manifestHash = hashBenchmarkManifest(manifest);
    const mutationSeed = Number.isInteger(options.mutationSeed)
      ? (options.mutationSeed as number)
      : 0;
    const k = Math.max(1, Math.floor(options.k ?? manifest.k ?? 3));

    const baselineRunner = new BenchmarkRunner({
      now: this.now,
      runId: `${runId}:baseline`,
      strictReplay: this.strictReplay,
    });
    const baselineArtifact = await baselineRunner.run(manifest, {
      scenarioRunners: options.scenarioRunners,
      manifestDir: options.manifestDir,
      k,
    });
    const baselineAggregate = baselineArtifact.aggregate.scorecard.aggregate;

    const runs: MutationScenarioRunArtifact[] = [];
    const allRunRecords: EvalRunRecord[] = [];
    const scenarioRecordMap = new Map<string, EvalRunRecord[]>();
    const operatorRecordMap = new Map<string, EvalRunRecord[]>();
    const operatorRunMap = new Map<string, MutationScenarioRunArtifact[]>();
    const operatorMetaMap = new Map<
      string,
      { category: MutationOperatorCategory; description: string }
    >(
      this.engine.getOperators().map((operator) => [
        operator.id,
        {
          category: operator.category,
          description: operator.description,
        },
      ]),
    );

    for (const scenario of manifest.scenarios) {
      for (const seed of scenario.seeds) {
        const scenarioRunner = options.scenarioRunners?.[scenario.id];
        const execution = scenarioRunner
          ? await scenarioRunner({ manifest, scenario, seed })
          : {
              trace: await readFixtureTrace(
                scenario,
                seed,
                options.manifestDir,
              ),
            };

        const mutations = this.engine.createMutations(
          execution.trace,
          {
            scenarioId: scenario.id,
            seed,
            mutationSeed,
          },
          {
            operatorIds: options.operatorIds,
            maxMutationsPerScenario: options.maxMutationsPerScenario,
          },
        );

        for (const mutation of mutations) {
          const replay = new TrajectoryReplayEngine({
            strictMode: this.strictReplay,
            seed,
          }).replay(mutation.trace);

          const record = evalRunFromReplayResult(replay, {
            id: mutation.mutationId,
            taskType: scenario.taskClass,
            riskScore: riskTierToScore(scenario.riskTier),
            rewardLamports: scenario.rewardLamports,
            verifierGated: scenario.verifierGated,
            costUnits: scenario.costUnits,
            ...execution.recordOverrides,
          });

          const runArtifact: MutationScenarioRunArtifact = {
            mutationId: mutation.mutationId,
            scenarioId: scenario.id,
            operatorId: mutation.operatorId,
            operatorCategory: mutation.operatorCategory,
            seed,
            traceId: replay.trace.traceId,
            deterministicHash: mutation.deterministicHash,
            passed: record.passed,
            latencyMs: record.latencyMs,
            costUnits: record.costUnits,
            policyViolations: record.policyViolations,
            verifierDisagreements: record.verifierDisagreements,
            rewardLamports: toRewardString(record.rewardLamports),
            note: mutation.note,
          };

          runs.push(runArtifact);
          allRunRecords.push(record);

          const scenarioRecords = scenarioRecordMap.get(scenario.id);
          if (scenarioRecords) {
            scenarioRecords.push(record);
          } else {
            scenarioRecordMap.set(scenario.id, [record]);
          }

          const operatorRecords = operatorRecordMap.get(mutation.operatorId);
          if (operatorRecords) {
            operatorRecords.push(record);
          } else {
            operatorRecordMap.set(mutation.operatorId, [record]);
          }

          const operatorRuns = operatorRunMap.get(mutation.operatorId);
          if (operatorRuns) {
            operatorRuns.push(runArtifact);
          } else {
            operatorRunMap.set(mutation.operatorId, [runArtifact]);
          }
        }
      }
    }

    const aggregateScorecard = computeEvaluationScorecard(allRunRecords, { k });
    const aggregateDelta = computeDeltas(
      aggregateScorecard.aggregate,
      baselineAggregate,
    );

    const scenarioReports: MutationScenarioReportArtifact[] = manifest.scenarios
      .map((scenario) => {
        const records = scenarioRecordMap.get(scenario.id) ?? [];
        const scorecard = computeEvaluationScorecard(records, { k });
        const baselineScenario = baselineArtifact.scenarios.find(
          (entry) => entry.scenarioId === scenario.id,
        );
        const baselineReference =
          baselineScenario?.scorecard.aggregate ?? baselineAggregate;
        return {
          scenarioId: scenario.id,
          title: scenario.title,
          taskClass: scenario.taskClass,
          riskTier: scenario.riskTier,
          runCount: records.length,
          scorecard,
          serializedScorecard: serializeEvaluationScorecard(scorecard),
          deltasFromBaseline: computeDeltas(
            scorecard.aggregate,
            baselineReference,
          ),
        };
      })
      .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));

    const operatorReports: MutationOperatorReportArtifact[] = [
      ...operatorRecordMap.entries(),
    ]
      .map(([operatorId, records]) => {
        const scorecard = computeEvaluationScorecard(records, { k });
        const meta = operatorMetaMap.get(operatorId);
        return {
          operatorId,
          operatorCategory: meta?.category ?? "workflow",
          description: meta?.description ?? "Custom mutation operator",
          runCount: records.length,
          scorecard,
          serializedScorecard: serializeEvaluationScorecard(scorecard),
          deltasFromBaseline: computeDeltas(
            scorecard.aggregate,
            baselineAggregate,
          ),
        };
      })
      .sort((left, right) => left.operatorId.localeCompare(right.operatorId));

    const artifact: MutationArtifact = {
      schemaVersion: MUTATION_ARTIFACT_SCHEMA_VERSION,
      benchmarkSchemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
      runId,
      generatedAtMs: this.now(),
      mutationSeed,
      corpusVersion: manifest.corpusVersion,
      manifestHash,
      baselineBenchmarkRunId: baselineArtifact.runId,
      baselineAggregate: {
        scorecard: baselineArtifact.aggregate.scorecard,
        serializedScorecard: baselineArtifact.aggregate.serializedScorecard,
      },
      aggregate: {
        scorecard: aggregateScorecard,
        serializedScorecard: serializeEvaluationScorecard(aggregateScorecard),
        deltasFromBaseline: aggregateDelta,
      },
      runs: runs.sort((left, right) =>
        left.mutationId.localeCompare(right.mutationId),
      ),
      operators: operatorReports,
      scenarios: scenarioReports,
      topRegressions: buildTopRegressions(
        aggregateDelta,
        scenarioReports,
        operatorReports,
      ),
    };

    return artifact;
  }
}

/**
 * Stable JSON serialization for mutation artifacts.
 */
export function serializeMutationArtifact(artifact: MutationArtifact): string {
  return stableStringifyJson(artifact as unknown as JsonValue);
}

/**
 * Persist mutation artifact to disk.
 */
export async function writeMutationArtifact(
  outputPath: string,
  artifact: MutationArtifact,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${serializeMutationArtifact(artifact)}\n`,
    "utf8",
  );
}
