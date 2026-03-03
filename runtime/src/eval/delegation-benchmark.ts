/**
 * Deterministic delegation/decomposition benchmark suite.
 *
 * @module
 */

import {
  BENCHMARK_MANIFEST_SCHEMA_VERSION,
  type BenchmarkManifest,
} from "./benchmark-manifest.js";
import {
  BenchmarkRunner,
  type BenchmarkArtifact,
  type BenchmarkScenarioRunner,
} from "./benchmark-runner.js";
import { computePassAtK, computePassCaretK } from "./metrics.js";
import { stableStringifyJson, type JsonValue } from "./types.js";
import type {
  PipelineDelegationScenarioInput,
  PipelineDelegationScenarioMode,
} from "./pipeline-quality.js";

export const DEFAULT_DELEGATION_BENCHMARK_K = 2 as const;
export const DELEGATION_BENCHMARK_CORPUS_VERSION = "delegation-v1" as const;
export const DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID =
  "baseline_no_delegation" as const;

interface DelegationScenarioProfile {
  id: string;
  title: string;
  mode: PipelineDelegationScenarioMode;
  taskClass: string;
  riskTier: "low" | "medium" | "high";
  expectedConstraints: string[];
  seeds: number[];
  verifierGated: boolean;
}

interface DelegationRunSignal {
  scenarioId: string;
  mode: PipelineDelegationScenarioMode;
  seed: number;
  delegated: boolean;
  usefulDelegation: boolean;
  harmfulDelegation: boolean;
  plannerExecutionMismatch: boolean;
  childTimedOut: boolean;
  childFailed: boolean;
  synthesisConflict: boolean;
  depthCapHit: boolean;
  fanoutCapHit: boolean;
  passed: boolean;
  latencyMs: number;
  costUnits: number;
  verifierRetry: boolean;
}

export interface DelegationBenchmarkSummary {
  totalCases: number;
  delegatedCases: number;
  usefulDelegations: number;
  harmfulDelegations: number;
  plannerExecutionMismatches: number;
  childTimeouts: number;
  childFailures: number;
  synthesisConflicts: number;
  depthCapHits: number;
  fanoutCapHits: number;
  delegationAttemptRate: number;
  usefulDelegationRate: number;
  harmfulDelegationRate: number;
  plannerToExecutionMismatchRate: number;
  childTimeoutRate: number;
  childFailureRate: number;
  synthesisConflictRate: number;
  depthCapHitRate: number;
  fanoutCapHitRate: number;
  costDeltaVsBaseline: number;
  latencyDeltaVsBaseline: number;
  qualityDeltaVsBaseline: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
  baselineScenarioId: string;
  k: number;
  scenarioSummaries: PipelineDelegationScenarioInput[];
}

export interface DelegationBenchmarkSuiteResult {
  runId: string;
  generatedAtMs: number;
  manifest: BenchmarkManifest;
  benchmarkArtifact: BenchmarkArtifact;
  summary: DelegationBenchmarkSummary;
}

export interface DelegationBenchmarkSuiteConfig {
  now?: () => number;
  runId?: string;
  k?: number;
  manifest?: BenchmarkManifest;
}

const DEFAULT_SCENARIO_PROFILES: readonly DelegationScenarioProfile[] = [
  {
    id: DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
    title: "Baseline no delegation",
    mode: "no_delegation",
    taskClass: "orchestration",
    riskTier: "medium",
    expectedConstraints: ["no_delegation", "baseline"],
    seeds: [11, 12, 13, 14],
    verifierGated: true,
  },
  {
    id: "delegation_single_child",
    title: "Single child delegation",
    mode: "single_child",
    taskClass: "orchestration",
    riskTier: "medium",
    expectedConstraints: ["single_child", "delegation"],
    seeds: [11, 12, 13, 14],
    verifierGated: true,
  },
  {
    id: "delegation_parallel_children",
    title: "Parallel children delegation",
    mode: "parallel_children",
    taskClass: "orchestration",
    riskTier: "high",
    expectedConstraints: ["parallel_children", "delegation"],
    seeds: [11, 12, 13, 14],
    verifierGated: true,
  },
  {
    id: "delegation_handoff_mode",
    title: "Handoff delegation mode",
    mode: "handoff",
    taskClass: "orchestration",
    riskTier: "high",
    expectedConstraints: ["handoff_mode", "delegation"],
    seeds: [11, 12, 13, 14],
    verifierGated: true,
  },
  {
    id: "delegation_verifier_retry",
    title: "Verifier-triggered retry",
    mode: "verifier_retry",
    taskClass: "orchestration",
    riskTier: "medium",
    expectedConstraints: ["verifier_retry", "delegation"],
    seeds: [11, 12, 13, 14],
    verifierGated: true,
  },
];

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeSeed(seed: number): number {
  return Math.abs(Math.trunc(seed));
}

function seedIndex(seed: number): number {
  return normalizeSeed(seed) % 4;
}

function buildSyntheticTrace(signal: DelegationRunSignal): unknown {
  let timestampMs = 1;
  let seq = 1;
  const taskPda = `${signal.scenarioId}:task:${signal.seed}`;
  const events: Array<Record<string, unknown>> = [
    {
      seq: seq++,
      type: "discovered",
      taskPda,
      timestampMs: timestampMs++,
      payload: {},
    },
    {
      seq: seq++,
      type: "claimed",
      taskPda,
      timestampMs: timestampMs++,
      payload: { claimTx: `${signal.scenarioId}-claim-${signal.seed}` },
    },
  ];

  if (signal.plannerExecutionMismatch) {
    events.push({
      seq: seq++,
      type: "policy_violation",
      taskPda,
      timestampMs: timestampMs++,
      payload: { code: "planner_execution_mismatch" },
    });
  }

  if (signal.verifierRetry) {
    events.push({
      seq: seq++,
      type: "verifier_verdict",
      taskPda,
      timestampMs: timestampMs++,
      payload: {
        attempt: 1,
        verdict: "needs_revision",
        confidence: 0.46,
      },
    });
    events.push({
      seq: seq++,
      type: "verifier_verdict",
      taskPda,
      timestampMs: timestampMs++,
      payload: {
        attempt: 2,
        verdict: "pass",
        confidence: 0.91,
      },
    });
  } else {
    events.push({
      seq: seq++,
      type: "verifier_verdict",
      taskPda,
      timestampMs: timestampMs++,
      payload: {
        attempt: 1,
        verdict: signal.passed ? "pass" : "fail",
        confidence: signal.passed ? 0.88 : 0.31,
      },
    });
  }

  events.push({
    seq: seq++,
    type: "executed",
    taskPda,
    timestampMs: timestampMs++,
    payload: {
      outputLength: signal.passed ? 1 : 0,
      delegated: signal.delegated,
      delegationMode: signal.mode,
    },
  });

  events.push(
    signal.passed
      ? {
          seq: seq++,
          type: "completed",
          taskPda,
          timestampMs: timestampMs + signal.latencyMs,
          payload: {
            completionTx: `${signal.scenarioId}-complete-${signal.seed}`,
            durationMs: signal.latencyMs,
          },
        }
      : {
          seq: seq++,
          type: "failed",
          taskPda,
          timestampMs: timestampMs + signal.latencyMs,
          payload: {
            error: signal.childTimedOut
              ? "child_timeout"
              : signal.childFailed
                ? "child_failure"
                : "delegation_failure",
          },
        },
  );

  return {
    schemaVersion: 1,
    traceId: `${signal.scenarioId}:seed-${signal.seed}`,
    seed: signal.seed,
    createdAtMs: 1_700_000_000_000,
    metadata: {
      source: "delegation-benchmark",
      mode: signal.mode,
    },
    events,
  };
}

function simulateScenarioSignal(
  mode: PipelineDelegationScenarioMode,
  scenarioId: string,
  seed: number,
): DelegationRunSignal {
  const idx = seedIndex(seed);

  if (mode === "no_delegation") {
    const passed = idx % 2 === 0;
    return {
      scenarioId,
      mode,
      seed,
      delegated: false,
      usefulDelegation: false,
      harmfulDelegation: false,
      plannerExecutionMismatch: false,
      childTimedOut: false,
      childFailed: false,
      synthesisConflict: false,
      depthCapHit: false,
      fanoutCapHit: false,
      passed,
      latencyMs: 150 + idx * 5,
      costUnits: 1 + idx * 0.02,
      verifierRetry: false,
    };
  }

  if (mode === "single_child") {
    const passed = idx !== 3;
    const childFailed = !passed;
    const harmfulDelegation = !passed || childFailed;
    return {
      scenarioId,
      mode,
      seed,
      delegated: true,
      usefulDelegation: passed && !harmfulDelegation,
      harmfulDelegation,
      plannerExecutionMismatch: false,
      childTimedOut: false,
      childFailed,
      synthesisConflict: false,
      depthCapHit: false,
      fanoutCapHit: false,
      passed,
      latencyMs: passed ? 112 + idx * 4 : 170,
      costUnits: 1.22 + idx * 0.03,
      verifierRetry: false,
    };
  }

  if (mode === "parallel_children") {
    const passed = idx !== 0;
    const childTimedOut = !passed;
    const synthesisConflict = idx === 1;
    const harmfulDelegation = !passed || childTimedOut;
    return {
      scenarioId,
      mode,
      seed,
      delegated: true,
      usefulDelegation: passed && !harmfulDelegation,
      harmfulDelegation,
      plannerExecutionMismatch: idx === 2,
      childTimedOut,
      childFailed: false,
      synthesisConflict,
      depthCapHit: false,
      fanoutCapHit: idx === 3,
      passed,
      latencyMs: passed ? 95 + idx * 3 : 185,
      costUnits: 1.4 + idx * 0.04,
      verifierRetry: false,
    };
  }

  if (mode === "handoff") {
    const passed = idx !== 1;
    const childFailed = !passed;
    const synthesisConflict = idx === 2;
    const harmfulDelegation = !passed || childFailed;
    return {
      scenarioId,
      mode,
      seed,
      delegated: true,
      usefulDelegation: passed && !harmfulDelegation,
      harmfulDelegation,
      plannerExecutionMismatch: idx === 0,
      childTimedOut: false,
      childFailed,
      synthesisConflict,
      depthCapHit: idx === 3,
      fanoutCapHit: false,
      passed,
      latencyMs: passed ? 108 + idx * 5 : 175,
      costUnits: 1.52 + idx * 0.03,
      verifierRetry: false,
    };
  }

  const passed = true;
  return {
    scenarioId,
    mode,
    seed,
    delegated: true,
    usefulDelegation: true,
    harmfulDelegation: false,
    plannerExecutionMismatch: false,
    childTimedOut: false,
    childFailed: false,
    synthesisConflict: false,
    depthCapHit: false,
    fanoutCapHit: false,
    passed,
    latencyMs: 122 + idx * 4,
    costUnits: 1.33 + idx * 0.02,
    verifierRetry: idx % 2 === 0,
  };
}

function createScenarioRunners(
  profiles: readonly DelegationScenarioProfile[],
  runSignals: DelegationRunSignal[],
): Record<string, BenchmarkScenarioRunner> {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const runners: Record<string, BenchmarkScenarioRunner> = {};

  for (const profile of profiles) {
    runners[profile.id] = ({ scenario, seed }) => {
      const resolvedProfile = profileById.get(scenario.id);
      if (!resolvedProfile) {
        throw new Error(`Unknown delegation scenario: ${scenario.id}`);
      }

      const signal = simulateScenarioSignal(
        resolvedProfile.mode,
        scenario.id,
        seed,
      );
      runSignals.push(signal);

      return {
        trace: buildSyntheticTrace(signal),
        recordOverrides: {
          passed: signal.passed,
          latencyMs: signal.latencyMs,
          costUnits: signal.costUnits,
          policyViolations:
            signal.plannerExecutionMismatch || signal.harmfulDelegation ? 1 : 0,
          verifierDisagreements: signal.verifierRetry ? 1 : 0,
        },
      };
    };
  }

  return runners;
}

function buildScenarioSummaries(
  benchmarkArtifact: BenchmarkArtifact,
  profileById: Map<string, DelegationScenarioProfile>,
): PipelineDelegationScenarioInput[] {
  return benchmarkArtifact.scenarios.map((scenario) => {
    const profile = profileById.get(scenario.scenarioId);
    if (!profile) {
      throw new Error(
        `Missing delegation profile for scenario: ${scenario.scenarioId}`,
      );
    }

    return {
      scenarioId: scenario.scenarioId,
      mode: profile.mode,
      runCount: scenario.scorecard.aggregate.runCount,
      passRate: scenario.scorecard.aggregate.passRate,
      passAtK: scenario.scorecard.aggregate.passAtK,
      passCaretK: scenario.scorecard.aggregate.passCaretK,
      meanLatencyMs: scenario.scorecard.aggregate.meanLatencyMs,
      meanCostUnits: scenario.scorecard.aggregate.meanCostUnits,
      passAtKDeltaVsBaseline: scenario.deltasFromBaseline?.passAtK ?? 0,
      passCaretKDeltaVsBaseline: scenario.deltasFromBaseline?.passCaretK ?? 0,
    } satisfies PipelineDelegationScenarioInput;
  });
}

function buildSummary(
  runSignals: readonly DelegationRunSignal[],
  benchmarkArtifact: BenchmarkArtifact,
  k: number,
  profileById: Map<string, DelegationScenarioProfile>,
): DelegationBenchmarkSummary {
  const baselineRuns = runSignals.filter(
    (entry) => entry.scenarioId === DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
  );
  const delegatedRuns = runSignals.filter((entry) => entry.delegated);

  const baselinePasses = baselineRuns.filter((entry) => entry.passed).length;
  const delegatedPasses = delegatedRuns.filter((entry) => entry.passed).length;

  const baselinePassRate = ratio(baselinePasses, baselineRuns.length);
  const delegatedPassRate = ratio(delegatedPasses, delegatedRuns.length);

  const baselinePassAtK = computePassAtK(baselineRuns.length, baselinePasses, k);
  const delegatedPassAtK = computePassAtK(
    delegatedRuns.length,
    delegatedPasses,
    k,
  );

  const usefulDelegations = delegatedRuns.filter(
    (entry) => entry.usefulDelegation,
  ).length;
  const harmfulDelegations = delegatedRuns.filter(
    (entry) => entry.harmfulDelegation,
  ).length;
  const plannerExecutionMismatches = delegatedRuns.filter(
    (entry) => entry.plannerExecutionMismatch,
  ).length;
  const childTimeouts = delegatedRuns.filter((entry) => entry.childTimedOut).length;
  const childFailures = delegatedRuns.filter((entry) => entry.childFailed).length;
  const synthesisConflicts = delegatedRuns.filter(
    (entry) => entry.synthesisConflict,
  ).length;
  const depthCapHits = delegatedRuns.filter((entry) => entry.depthCapHit).length;
  const fanoutCapHits = delegatedRuns.filter((entry) => entry.fanoutCapHit).length;

  const baselineMeanCost = mean(baselineRuns.map((entry) => entry.costUnits));
  const delegatedMeanCost = mean(delegatedRuns.map((entry) => entry.costUnits));
  const baselineMeanLatency = mean(
    baselineRuns.map((entry) => entry.latencyMs),
  );
  const delegatedMeanLatency = mean(
    delegatedRuns.map((entry) => entry.latencyMs),
  );

  return {
    totalCases: runSignals.length,
    delegatedCases: delegatedRuns.length,
    usefulDelegations,
    harmfulDelegations,
    plannerExecutionMismatches,
    childTimeouts,
    childFailures,
    synthesisConflicts,
    depthCapHits,
    fanoutCapHits,
    delegationAttemptRate: ratio(delegatedRuns.length, runSignals.length),
    usefulDelegationRate: ratio(usefulDelegations, delegatedRuns.length),
    harmfulDelegationRate: ratio(harmfulDelegations, delegatedRuns.length),
    plannerToExecutionMismatchRate: ratio(
      plannerExecutionMismatches,
      delegatedRuns.length,
    ),
    childTimeoutRate: ratio(childTimeouts, delegatedRuns.length),
    childFailureRate: ratio(childFailures, delegatedRuns.length),
    synthesisConflictRate: ratio(synthesisConflicts, delegatedRuns.length),
    depthCapHitRate: ratio(depthCapHits, delegatedRuns.length),
    fanoutCapHitRate: ratio(fanoutCapHits, delegatedRuns.length),
    costDeltaVsBaseline: delegatedMeanCost - baselineMeanCost,
    latencyDeltaVsBaseline: delegatedMeanLatency - baselineMeanLatency,
    qualityDeltaVsBaseline: delegatedPassRate - baselinePassRate,
    passAtKDeltaVsBaseline: delegatedPassAtK - baselinePassAtK,
    passCaretKDeltaVsBaseline:
      computePassCaretK(delegatedPassRate, k) -
      computePassCaretK(baselinePassRate, k),
    baselineScenarioId: DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
    k,
    scenarioSummaries: buildScenarioSummaries(benchmarkArtifact, profileById),
  };
}

/**
 * Build the canonical decomposition-quality benchmark manifest.
 */
export function buildDelegationBenchmarkManifest(
  k: number = DEFAULT_DELEGATION_BENCHMARK_K,
): BenchmarkManifest {
  return {
    schemaVersion: BENCHMARK_MANIFEST_SCHEMA_VERSION,
    corpusVersion: DELEGATION_BENCHMARK_CORPUS_VERSION,
    baselineScenarioId: DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
    k: Math.max(1, Math.floor(k)),
    scenarios: DEFAULT_SCENARIO_PROFILES.map((profile) => ({
      id: profile.id,
      title: profile.title,
      taskClass: profile.taskClass,
      riskTier: profile.riskTier,
      expectedConstraints: [...profile.expectedConstraints],
      seeds: [...profile.seeds],
      verifierGated: profile.verifierGated,
      costUnits: 1,
      metadata: {
        delegationMode: profile.mode,
        source: "delegation-benchmark",
      },
    })),
  };
}

/**
 * Run deterministic decomposition/delegation benchmark suite.
 */
export async function runDelegationBenchmarkSuite(
  config: DelegationBenchmarkSuiteConfig = {},
): Promise<DelegationBenchmarkSuiteResult> {
  const now = config.now ?? Date.now;
  const k = Math.max(1, Math.floor(config.k ?? DEFAULT_DELEGATION_BENCHMARK_K));
  const runId = config.runId ?? `delegation-benchmark-${now()}`;
  const manifest = config.manifest ?? buildDelegationBenchmarkManifest(k);

  const runSignals: DelegationRunSignal[] = [];
  const profileById = new Map(
    DEFAULT_SCENARIO_PROFILES.map((profile) => [profile.id, profile]),
  );

  const benchmarkArtifact = await new BenchmarkRunner({
    now,
    runId: `${runId}:benchmark`,
  }).run(manifest, {
    k,
    scenarioRunners: createScenarioRunners(DEFAULT_SCENARIO_PROFILES, runSignals),
  });

  return {
    runId,
    generatedAtMs: now(),
    manifest,
    benchmarkArtifact,
    summary: buildSummary(runSignals, benchmarkArtifact, k, profileById),
  };
}

/**
 * Stable JSON serialization for delegation benchmark suite artifacts.
 */
export function serializeDelegationBenchmarkSuiteResult(
  result: DelegationBenchmarkSuiteResult,
): string {
  return stableStringifyJson(result as unknown as JsonValue);
}
