/**
 * Phase 9 pipeline-quality artifact schema and helpers.
 *
 * @module
 */

import { stableStringifyJson, type JsonValue } from "./types.js";

const LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION = 2 as const;

export interface PipelineContextGrowthArtifact {
  turns: number;
  promptTokenSeries: number[];
  tokenDeltas: number[];
  maxDelta: number;
  slope: number;
}

export interface PipelineToolTurnArtifact {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

export interface PipelineDesktopRunArtifact {
  runId: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  failedStep?: number;
  preview?: string;
}

export interface PipelineDesktopStabilityArtifact {
  runs: number;
  failedRuns: number;
  timedOutRuns: number;
  maxDurationMs: number;
  runSummaries: PipelineDesktopRunArtifact[];
}

export interface PipelineTokenEfficiencyArtifact {
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  tokensPerCompletedTask: number;
}

export interface PipelineOfflineReplayFixtureArtifact {
  fixtureId: string;
  ok: boolean;
  parseError?: string;
  replayError?: string;
  deterministicMismatch?: boolean;
}

export interface PipelineOfflineReplayArtifact {
  fixtureCount: number;
  parseFailures: number;
  replayFailures: number;
  deterministicMismatches: number;
  fixtures: PipelineOfflineReplayFixtureArtifact[];
}

export type PipelineDelegationScenarioMode =
  | "no_delegation"
  | "single_child"
  | "parallel_children"
  | "handoff"
  | "verifier_retry";

export interface PipelineDelegationScenarioArtifact {
  scenarioId: string;
  mode: PipelineDelegationScenarioMode;
  runCount: number;
  passRate: number;
  passAtK: number;
  passCaretK: number;
  meanLatencyMs: number;
  meanCostUnits: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
}

export interface PipelineDelegationArtifact {
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
  scenarioSummaries: PipelineDelegationScenarioArtifact[];
}

export interface PipelineQualityArtifact {
  schemaVersion: typeof PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthArtifact;
  toolTurn: PipelineToolTurnArtifact;
  desktopStability: PipelineDesktopStabilityArtifact;
  tokenEfficiency: PipelineTokenEfficiencyArtifact;
  offlineReplay: PipelineOfflineReplayArtifact;
  delegation: PipelineDelegationArtifact;
}

export interface PipelineContextGrowthInput {
  promptTokenSeries: readonly number[];
}

export interface PipelineToolTurnInput {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

export interface PipelineDesktopStabilityInput {
  runSummaries: readonly PipelineDesktopRunArtifact[];
}

export interface PipelineTokenEfficiencyInput {
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

export interface PipelineOfflineReplayInput {
  fixtures: readonly PipelineOfflineReplayFixtureArtifact[];
}

export interface PipelineDelegationScenarioInput {
  scenarioId: string;
  mode: PipelineDelegationScenarioMode;
  runCount: number;
  passRate: number;
  passAtK: number;
  passCaretK: number;
  meanLatencyMs: number;
  meanCostUnits: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
}

export interface PipelineDelegationInput {
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
  costDeltaVsBaseline: number;
  latencyDeltaVsBaseline: number;
  qualityDeltaVsBaseline: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
  baselineScenarioId: string;
  k: number;
  scenarioSummaries: readonly PipelineDelegationScenarioInput[];
}

export interface PipelineQualityArtifactInput {
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthInput;
  toolTurn: PipelineToolTurnInput;
  desktopStability: PipelineDesktopStabilityInput;
  tokenEfficiency: PipelineTokenEfficiencyInput;
  offlineReplay: PipelineOfflineReplayInput;
  delegation?: PipelineDelegationInput;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isFinite(value),
    `${path} must be a finite number`,
  );
  return value;
}

function asFiniteNonNegativeNumber(value: unknown, path: string): number {
  const numeric = asFiniteNumber(value, path);
  assert(numeric >= 0, `${path} must be a non-negative finite number`);
  return numeric;
}

function asInteger(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isInteger(value),
    `${path} must be an integer`,
  );
  return value;
}

function asNonNegativeInteger(value: unknown, path: string): number {
  const numeric = asInteger(value, path);
  assert(numeric >= 0, `${path} must be a non-negative integer`);
  return numeric;
}

function asRate(value: unknown, path: string): number {
  const numeric = asFiniteNumber(value, path);
  assert(
    numeric >= 0 && numeric <= 1,
    `${path} must be a rate in [0, 1]`,
  );
  return numeric;
}

function parseNumberArray(value: unknown, path: string): number[] {
  assert(Array.isArray(value), `${path} must be an array`);
  return value.map((entry, index) =>
    asFiniteNonNegativeNumber(entry, `${path}[${index}]`),
  );
}

function computeTokenDeltas(series: readonly number[]): number[] {
  if (series.length <= 1) return [];
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i++) {
    deltas.push(series[i]! - series[i - 1]!);
  }
  return deltas;
}

function computeSlope(series: readonly number[]): number {
  if (series.length <= 1) return 0;
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? first;
  return (last - first) / (series.length - 1);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function defaultDelegationInput(): PipelineDelegationInput {
  return {
    totalCases: 0,
    delegatedCases: 0,
    usefulDelegations: 0,
    harmfulDelegations: 0,
    plannerExecutionMismatches: 0,
    childTimeouts: 0,
    childFailures: 0,
    synthesisConflicts: 0,
    depthCapHits: 0,
    fanoutCapHits: 0,
    costDeltaVsBaseline: 0,
    latencyDeltaVsBaseline: 0,
    qualityDeltaVsBaseline: 0,
    passAtKDeltaVsBaseline: 0,
    passCaretKDeltaVsBaseline: 0,
    baselineScenarioId: "baseline_no_delegation",
    k: 1,
    scenarioSummaries: [],
  };
}

function normalizeContextGrowth(
  input: PipelineContextGrowthInput,
): PipelineContextGrowthArtifact {
  const promptTokenSeries = input.promptTokenSeries.map((value, index) =>
    asFiniteNonNegativeNumber(
      value,
      `contextGrowth.promptTokenSeries[${index}]`,
    ),
  );
  const tokenDeltas = computeTokenDeltas(promptTokenSeries);
  const maxDelta =
    tokenDeltas.length > 0
      ? tokenDeltas.reduce((max, value) => Math.max(max, value), 0)
      : 0;
  const slope = computeSlope(promptTokenSeries);

  return {
    turns: promptTokenSeries.length,
    promptTokenSeries,
    tokenDeltas,
    maxDelta,
    slope,
  };
}

function normalizeToolTurn(
  input: PipelineToolTurnInput,
): PipelineToolTurnArtifact {
  return {
    validCases: asNonNegativeInteger(input.validCases, "toolTurn.validCases"),
    validAccepted: asNonNegativeInteger(
      input.validAccepted,
      "toolTurn.validAccepted",
    ),
    malformedCases: asNonNegativeInteger(
      input.malformedCases,
      "toolTurn.malformedCases",
    ),
    malformedRejected: asNonNegativeInteger(
      input.malformedRejected,
      "toolTurn.malformedRejected",
    ),
    malformedForwarded: asNonNegativeInteger(
      input.malformedForwarded,
      "toolTurn.malformedForwarded",
    ),
  };
}

function normalizeDesktopStability(
  input: PipelineDesktopStabilityInput,
): PipelineDesktopStabilityArtifact {
  const runSummaries = input.runSummaries.map((entry, index) => {
    assert(
      typeof entry.runId === "string",
      `desktop.runSummaries[${index}].runId must be a string`,
    );
    assert(
      typeof entry.ok === "boolean",
      `desktop.runSummaries[${index}].ok must be boolean`,
    );
    assert(
      typeof entry.timedOut === "boolean",
      `desktop.runSummaries[${index}].timedOut must be boolean`,
    );
    const durationMs = asFiniteNonNegativeNumber(
      entry.durationMs,
      `desktop.runSummaries[${index}].durationMs`,
    );
    const failedStep =
      entry.failedStep === undefined
        ? undefined
        : asInteger(
            entry.failedStep,
            `desktop.runSummaries[${index}].failedStep`,
          );
    const preview =
      entry.preview === undefined ? undefined : String(entry.preview);
    return {
      runId: entry.runId,
      ok: entry.ok,
      timedOut: entry.timedOut,
      durationMs,
      failedStep,
      preview,
    } satisfies PipelineDesktopRunArtifact;
  });

  const failedRuns = runSummaries.filter((entry) => !entry.ok).length;
  const timedOutRuns = runSummaries.filter((entry) => entry.timedOut).length;
  const maxDurationMs = runSummaries.reduce(
    (max, entry) => Math.max(max, entry.durationMs),
    0,
  );

  return {
    runs: runSummaries.length,
    failedRuns,
    timedOutRuns,
    maxDurationMs,
    runSummaries,
  };
}

function normalizeTokenEfficiency(
  input: PipelineTokenEfficiencyInput,
): PipelineTokenEfficiencyArtifact {
  const completedTasks = asNonNegativeInteger(
    input.completedTasks,
    "tokenEfficiency.completedTasks",
  );
  const totalPromptTokens = asFiniteNonNegativeNumber(
    input.totalPromptTokens,
    "tokenEfficiency.totalPromptTokens",
  );
  const totalCompletionTokens = asFiniteNonNegativeNumber(
    input.totalCompletionTokens,
    "tokenEfficiency.totalCompletionTokens",
  );
  const totalTokens = asFiniteNonNegativeNumber(
    input.totalTokens,
    "tokenEfficiency.totalTokens",
  );
  const tokensPerCompletedTask =
    completedTasks > 0 ? totalTokens / completedTasks : totalTokens;

  return {
    completedTasks,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    tokensPerCompletedTask,
  };
}

function normalizeOfflineReplay(
  input: PipelineOfflineReplayInput,
): PipelineOfflineReplayArtifact {
  const fixtures = input.fixtures.map((entry, index) => {
    assert(
      typeof entry.fixtureId === "string" && entry.fixtureId.length > 0,
      `offlineReplay.fixtures[${index}].fixtureId must be a non-empty string`,
    );
    assert(
      typeof entry.ok === "boolean",
      `offlineReplay.fixtures[${index}].ok must be boolean`,
    );
    const parseError =
      entry.parseError === undefined ? undefined : String(entry.parseError);
    const replayError =
      entry.replayError === undefined ? undefined : String(entry.replayError);
    const deterministicMismatch =
      entry.deterministicMismatch === undefined
        ? undefined
        : Boolean(entry.deterministicMismatch);
    return {
      fixtureId: entry.fixtureId,
      ok: entry.ok,
      parseError,
      replayError,
      deterministicMismatch,
    } satisfies PipelineOfflineReplayFixtureArtifact;
  });

  return {
    fixtureCount: fixtures.length,
    parseFailures: fixtures.filter((entry) => Boolean(entry.parseError)).length,
    replayFailures: fixtures.filter((entry) => Boolean(entry.replayError)).length,
    deterministicMismatches: fixtures.filter(
      (entry) => entry.deterministicMismatch === true,
    ).length,
    fixtures,
  };
}

function normalizeDelegation(
  input: PipelineDelegationInput | undefined,
): PipelineDelegationArtifact {
  const normalizedInput = input ?? defaultDelegationInput();

  const totalCases = asNonNegativeInteger(
    normalizedInput.totalCases,
    "delegation.totalCases",
  );
  const delegatedCases = asNonNegativeInteger(
    normalizedInput.delegatedCases,
    "delegation.delegatedCases",
  );
  assert(
    delegatedCases <= totalCases,
    "delegation.delegatedCases must be <= delegation.totalCases",
  );

  const usefulDelegations = asNonNegativeInteger(
    normalizedInput.usefulDelegations,
    "delegation.usefulDelegations",
  );
  const harmfulDelegations = asNonNegativeInteger(
    normalizedInput.harmfulDelegations,
    "delegation.harmfulDelegations",
  );
  const plannerExecutionMismatches = asNonNegativeInteger(
    normalizedInput.plannerExecutionMismatches,
    "delegation.plannerExecutionMismatches",
  );
  const childTimeouts = asNonNegativeInteger(
    normalizedInput.childTimeouts,
    "delegation.childTimeouts",
  );
  const childFailures = asNonNegativeInteger(
    normalizedInput.childFailures,
    "delegation.childFailures",
  );
  const synthesisConflicts = asNonNegativeInteger(
    normalizedInput.synthesisConflicts,
    "delegation.synthesisConflicts",
  );
  const depthCapHits = asNonNegativeInteger(
    normalizedInput.depthCapHits,
    "delegation.depthCapHits",
  );
  const fanoutCapHits = asNonNegativeInteger(
    normalizedInput.fanoutCapHits,
    "delegation.fanoutCapHits",
  );

  for (const [metric, value] of [
    ["usefulDelegations", usefulDelegations],
    ["harmfulDelegations", harmfulDelegations],
    ["plannerExecutionMismatches", plannerExecutionMismatches],
    ["childTimeouts", childTimeouts],
    ["childFailures", childFailures],
    ["synthesisConflicts", synthesisConflicts],
    ["depthCapHits", depthCapHits],
    ["fanoutCapHits", fanoutCapHits],
  ] as const) {
    assert(
      value <= delegatedCases,
      `delegation.${metric} must be <= delegation.delegatedCases`,
    );
  }

  const baselineScenarioId = String(normalizedInput.baselineScenarioId ?? "");
  assert(
    baselineScenarioId.length > 0,
    "delegation.baselineScenarioId must be a non-empty string",
  );
  const k = asNonNegativeInteger(normalizedInput.k, "delegation.k");
  assert(k > 0, "delegation.k must be >= 1");

  const scenarioSummaries = normalizedInput.scenarioSummaries.map(
    (entry, index) => {
      assert(
        typeof entry.scenarioId === "string" && entry.scenarioId.length > 0,
        `delegation.scenarioSummaries[${index}].scenarioId must be a non-empty string`,
      );
      assert(
        entry.mode === "no_delegation" ||
          entry.mode === "single_child" ||
          entry.mode === "parallel_children" ||
          entry.mode === "handoff" ||
          entry.mode === "verifier_retry",
        `delegation.scenarioSummaries[${index}].mode must be a valid scenario mode`,
      );
      return {
        scenarioId: entry.scenarioId,
        mode: entry.mode,
        runCount: asNonNegativeInteger(
          entry.runCount,
          `delegation.scenarioSummaries[${index}].runCount`,
        ),
        passRate: asRate(
          entry.passRate,
          `delegation.scenarioSummaries[${index}].passRate`,
        ),
        passAtK: asRate(
          entry.passAtK,
          `delegation.scenarioSummaries[${index}].passAtK`,
        ),
        passCaretK: asRate(
          entry.passCaretK,
          `delegation.scenarioSummaries[${index}].passCaretK`,
        ),
        meanLatencyMs: asFiniteNonNegativeNumber(
          entry.meanLatencyMs,
          `delegation.scenarioSummaries[${index}].meanLatencyMs`,
        ),
        meanCostUnits: asFiniteNonNegativeNumber(
          entry.meanCostUnits,
          `delegation.scenarioSummaries[${index}].meanCostUnits`,
        ),
        passAtKDeltaVsBaseline: asFiniteNumber(
          entry.passAtKDeltaVsBaseline,
          `delegation.scenarioSummaries[${index}].passAtKDeltaVsBaseline`,
        ),
        passCaretKDeltaVsBaseline: asFiniteNumber(
          entry.passCaretKDeltaVsBaseline,
          `delegation.scenarioSummaries[${index}].passCaretKDeltaVsBaseline`,
        ),
      } satisfies PipelineDelegationScenarioArtifact;
    },
  );

  const delegationAttemptRate = safeRatio(delegatedCases, totalCases);

  return {
    totalCases,
    delegatedCases,
    usefulDelegations,
    harmfulDelegations,
    plannerExecutionMismatches,
    childTimeouts,
    childFailures,
    synthesisConflicts,
    depthCapHits,
    fanoutCapHits,
    delegationAttemptRate,
    usefulDelegationRate: safeRatio(usefulDelegations, delegatedCases),
    harmfulDelegationRate: safeRatio(harmfulDelegations, delegatedCases),
    plannerToExecutionMismatchRate: safeRatio(
      plannerExecutionMismatches,
      delegatedCases,
    ),
    childTimeoutRate: safeRatio(childTimeouts, delegatedCases),
    childFailureRate: safeRatio(childFailures, delegatedCases),
    synthesisConflictRate: safeRatio(synthesisConflicts, delegatedCases),
    depthCapHitRate: safeRatio(depthCapHits, delegatedCases),
    fanoutCapHitRate: safeRatio(fanoutCapHits, delegatedCases),
    costDeltaVsBaseline: asFiniteNumber(
      normalizedInput.costDeltaVsBaseline,
      "delegation.costDeltaVsBaseline",
    ),
    latencyDeltaVsBaseline: asFiniteNumber(
      normalizedInput.latencyDeltaVsBaseline,
      "delegation.latencyDeltaVsBaseline",
    ),
    qualityDeltaVsBaseline: asFiniteNumber(
      normalizedInput.qualityDeltaVsBaseline,
      "delegation.qualityDeltaVsBaseline",
    ),
    passAtKDeltaVsBaseline: asFiniteNumber(
      normalizedInput.passAtKDeltaVsBaseline,
      "delegation.passAtKDeltaVsBaseline",
    ),
    passCaretKDeltaVsBaseline: asFiniteNumber(
      normalizedInput.passCaretKDeltaVsBaseline,
      "delegation.passCaretKDeltaVsBaseline",
    ),
    baselineScenarioId,
    k,
    scenarioSummaries,
  };
}

/**
 * Build normalized pipeline-quality artifact with derived rollups.
 */
export function buildPipelineQualityArtifact(
  input: PipelineQualityArtifactInput,
): PipelineQualityArtifact {
  assert(
    typeof input.runId === "string" && input.runId.length > 0,
    "runId must be a non-empty string",
  );
  const generatedAtMs = asFiniteNonNegativeNumber(
    input.generatedAtMs,
    "generatedAtMs",
  );

  return {
    schemaVersion: PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    runId: input.runId,
    generatedAtMs,
    contextGrowth: normalizeContextGrowth(input.contextGrowth),
    toolTurn: normalizeToolTurn(input.toolTurn),
    desktopStability: normalizeDesktopStability(input.desktopStability),
    tokenEfficiency: normalizeTokenEfficiency(input.tokenEfficiency),
    offlineReplay: normalizeOfflineReplay(input.offlineReplay),
    delegation: normalizeDelegation(input.delegation),
  };
}

/**
 * Parse and validate a pipeline-quality artifact object.
 */
export function parsePipelineQualityArtifact(
  value: unknown,
): PipelineQualityArtifact {
  assert(isRecord(value), "pipeline quality artifact must be an object");

  const schemaVersion = asInteger(value.schemaVersion, "schemaVersion");
  assert(
    schemaVersion === LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    `unsupported pipeline quality schema version: ${String(value.schemaVersion)}`,
  );

  const delegationSource = isRecord(value.delegation)
    ? value.delegation
    : undefined;

  return buildPipelineQualityArtifact({
    runId: String(value.runId ?? ""),
    generatedAtMs: asFiniteNonNegativeNumber(value.generatedAtMs, "generatedAtMs"),
    contextGrowth: {
      promptTokenSeries: parseNumberArray(
        (value.contextGrowth as Record<string, unknown>)?.promptTokenSeries,
        "contextGrowth.promptTokenSeries",
      ),
    },
    toolTurn: {
      validCases: asInteger(
        (value.toolTurn as Record<string, unknown>)?.validCases,
        "toolTurn.validCases",
      ),
      validAccepted: asInteger(
        (value.toolTurn as Record<string, unknown>)?.validAccepted,
        "toolTurn.validAccepted",
      ),
      malformedCases: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedCases,
        "toolTurn.malformedCases",
      ),
      malformedRejected: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedRejected,
        "toolTurn.malformedRejected",
      ),
      malformedForwarded: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedForwarded,
        "toolTurn.malformedForwarded",
      ),
    },
    desktopStability: {
      runSummaries: ((value.desktopStability as Record<string, unknown>)
        ?.runSummaries ?? []) as PipelineDesktopRunArtifact[],
    },
    tokenEfficiency: {
      completedTasks: asInteger(
        (value.tokenEfficiency as Record<string, unknown>)?.completedTasks,
        "tokenEfficiency.completedTasks",
      ),
      totalPromptTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalPromptTokens,
        "tokenEfficiency.totalPromptTokens",
      ),
      totalCompletionTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalCompletionTokens,
        "tokenEfficiency.totalCompletionTokens",
      ),
      totalTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalTokens,
        "tokenEfficiency.totalTokens",
      ),
    },
    offlineReplay: {
      fixtures: ((value.offlineReplay as Record<string, unknown>)?.fixtures ??
        []) as PipelineOfflineReplayFixtureArtifact[],
    },
    delegation:
      schemaVersion === LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION
        ? undefined
        : {
            totalCases: asNonNegativeInteger(
              delegationSource?.totalCases ?? 0,
              "delegation.totalCases",
            ),
            delegatedCases: asNonNegativeInteger(
              delegationSource?.delegatedCases ?? 0,
              "delegation.delegatedCases",
            ),
            usefulDelegations: asNonNegativeInteger(
              delegationSource?.usefulDelegations ?? 0,
              "delegation.usefulDelegations",
            ),
            harmfulDelegations: asNonNegativeInteger(
              delegationSource?.harmfulDelegations ?? 0,
              "delegation.harmfulDelegations",
            ),
            plannerExecutionMismatches: asNonNegativeInteger(
              delegationSource?.plannerExecutionMismatches ?? 0,
              "delegation.plannerExecutionMismatches",
            ),
            childTimeouts: asNonNegativeInteger(
              delegationSource?.childTimeouts ?? 0,
              "delegation.childTimeouts",
            ),
            childFailures: asNonNegativeInteger(
              delegationSource?.childFailures ?? 0,
              "delegation.childFailures",
            ),
            synthesisConflicts: asNonNegativeInteger(
              delegationSource?.synthesisConflicts ?? 0,
              "delegation.synthesisConflicts",
            ),
            depthCapHits: asNonNegativeInteger(
              delegationSource?.depthCapHits ?? 0,
              "delegation.depthCapHits",
            ),
            fanoutCapHits: asNonNegativeInteger(
              delegationSource?.fanoutCapHits ?? 0,
              "delegation.fanoutCapHits",
            ),
            costDeltaVsBaseline: asFiniteNumber(
              delegationSource?.costDeltaVsBaseline ?? 0,
              "delegation.costDeltaVsBaseline",
            ),
            latencyDeltaVsBaseline: asFiniteNumber(
              delegationSource?.latencyDeltaVsBaseline ?? 0,
              "delegation.latencyDeltaVsBaseline",
            ),
            qualityDeltaVsBaseline: asFiniteNumber(
              delegationSource?.qualityDeltaVsBaseline ?? 0,
              "delegation.qualityDeltaVsBaseline",
            ),
            passAtKDeltaVsBaseline: asFiniteNumber(
              delegationSource?.passAtKDeltaVsBaseline ?? 0,
              "delegation.passAtKDeltaVsBaseline",
            ),
            passCaretKDeltaVsBaseline: asFiniteNumber(
              delegationSource?.passCaretKDeltaVsBaseline ?? 0,
              "delegation.passCaretKDeltaVsBaseline",
            ),
            baselineScenarioId: String(
              delegationSource?.baselineScenarioId ?? "baseline_no_delegation",
            ),
            k: asNonNegativeInteger(delegationSource?.k ?? 1, "delegation.k"),
            scenarioSummaries: (delegationSource?.scenarioSummaries ??
              []) as PipelineDelegationScenarioInput[],
          },
  });
}

/**
 * Stable JSON serialization for pipeline-quality artifacts.
 */
export function serializePipelineQualityArtifact(
  artifact: PipelineQualityArtifact,
): string {
  return stableStringifyJson(artifact as unknown as JsonValue);
}
