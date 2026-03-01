/**
 * Phase 9 pipeline-quality artifact schema and helpers.
 *
 * @module
 */

import { stableStringifyJson, type JsonValue } from "./types.js";

export const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION = 1 as const;

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

export interface PipelineQualityArtifact {
  schemaVersion: typeof PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthArtifact;
  toolTurn: PipelineToolTurnArtifact;
  desktopStability: PipelineDesktopStabilityArtifact;
  tokenEfficiency: PipelineTokenEfficiencyArtifact;
  offlineReplay: PipelineOfflineReplayArtifact;
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

export interface PipelineQualityArtifactInput {
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthInput;
  toolTurn: PipelineToolTurnInput;
  desktopStability: PipelineDesktopStabilityInput;
  tokenEfficiency: PipelineTokenEfficiencyInput;
  offlineReplay: PipelineOfflineReplayInput;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNonNegativeNumber(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${path} must be a non-negative finite number`,
  );
  return value;
}

function asInteger(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isInteger(value),
    `${path} must be an integer`,
  );
  return value;
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

function normalizeContextGrowth(
  input: PipelineContextGrowthInput,
): PipelineContextGrowthArtifact {
  const promptTokenSeries = input.promptTokenSeries.map((value, index) =>
    asFiniteNonNegativeNumber(value, `contextGrowth.promptTokenSeries[${index}]`),
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
    validCases: asInteger(input.validCases, "toolTurn.validCases"),
    validAccepted: asInteger(input.validAccepted, "toolTurn.validAccepted"),
    malformedCases: asInteger(input.malformedCases, "toolTurn.malformedCases"),
    malformedRejected: asInteger(
      input.malformedRejected,
      "toolTurn.malformedRejected",
    ),
    malformedForwarded: asInteger(
      input.malformedForwarded,
      "toolTurn.malformedForwarded",
    ),
  };
}

function normalizeDesktopStability(
  input: PipelineDesktopStabilityInput,
): PipelineDesktopStabilityArtifact {
  const runSummaries = input.runSummaries.map((entry, index) => {
    assert(typeof entry.runId === "string", `desktop.runSummaries[${index}].runId must be a string`);
    assert(typeof entry.ok === "boolean", `desktop.runSummaries[${index}].ok must be boolean`);
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
        : asInteger(entry.failedStep, `desktop.runSummaries[${index}].failedStep`);
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
  const completedTasks = asInteger(
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
  };
}

/**
 * Parse and validate a pipeline-quality artifact object.
 */
export function parsePipelineQualityArtifact(
  value: unknown,
): PipelineQualityArtifact {
  assert(isRecord(value), "pipeline quality artifact must be an object");
  assert(
    value.schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    `unsupported pipeline quality schema version: ${String(value.schemaVersion)}`,
  );

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
