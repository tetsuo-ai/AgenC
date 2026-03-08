import { stableStringifyJson, type JsonValue } from "./types.js";

export const BACKGROUND_RUN_QUALITY_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type BackgroundRunScenarioCategory =
  | "canary"
  | "soak"
  | "chaos"
  | "replay";

export interface BackgroundRunScenarioArtifact {
  readonly scenarioId: string;
  readonly category: BackgroundRunScenarioCategory;
  readonly ok: boolean;
  readonly finalState: string;
  readonly latencyMs: number;
  readonly timeToFirstAckMs?: number;
  readonly timeToFirstVerifiedUpdateMs?: number;
  readonly stopLatencyMs?: number;
  readonly falseCompletion: boolean;
  readonly blockedWithoutNotice: boolean;
  readonly recoverySucceeded: boolean;
  readonly verifierAccurate: boolean;
  readonly replayConsistent: boolean;
  readonly transcriptScore: number;
  readonly toolTrajectoryScore: number;
  readonly endStateCorrectnessScore: number;
  readonly verifierCorrectnessScore: number;
  readonly restartRecoveryCorrectnessScore: number;
  readonly operatorUxCorrectnessScore: number;
  readonly tokenCount: number;
  readonly eventCount: number;
  readonly notes?: string;
}

export interface BackgroundRunQualityArtifact {
  readonly schemaVersion: typeof BACKGROUND_RUN_QUALITY_ARTIFACT_SCHEMA_VERSION;
  readonly runId: string;
  readonly generatedAtMs: number;
  readonly runCount: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly blockedRuns: number;
  readonly cancelledRuns: number;
  readonly canaryRuns: number;
  readonly soakRuns: number;
  readonly chaosRuns: number;
  readonly replayRuns: number;
  readonly meanLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly meanTimeToFirstAckMs: number;
  readonly meanTimeToFirstVerifiedUpdateMs: number;
  readonly falseCompletionRate: number;
  readonly blockedWithoutNoticeRate: number;
  readonly meanStopLatencyMs: number;
  readonly recoverySuccessRate: number;
  readonly verifierAccuracyRate: number;
  readonly transcriptScore: number;
  readonly toolTrajectoryScore: number;
  readonly endStateCorrectnessScore: number;
  readonly verifierCorrectnessScore: number;
  readonly restartRecoveryCorrectnessScore: number;
  readonly operatorUxCorrectnessScore: number;
  readonly totalTokens: number;
  readonly meanTokensPerRun: number;
  readonly replayInconsistencies: number;
  readonly chaosFailures: number;
  readonly scenarios: readonly BackgroundRunScenarioArtifact[];
}

export interface BackgroundRunQualityArtifactInput {
  readonly runId: string;
  readonly generatedAtMs: number;
  readonly scenarios: readonly BackgroundRunScenarioArtifact[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asFiniteNumber(value: unknown, path: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `${path} must be a finite number`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  assert(typeof value === "boolean", `${path} must be a boolean`);
  return value;
}

function asString(value: unknown, path: string): string {
  assert(typeof value === "string" && value.length > 0, `${path} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function ratio(
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function buildBackgroundRunQualityArtifact(
  input: BackgroundRunQualityArtifactInput,
): BackgroundRunQualityArtifact {
  const scenarios = [...input.scenarios];
  const latencies = scenarios.map((scenario) => scenario.latencyMs);
  const ackLatencies = scenarios
    .map((scenario) => scenario.timeToFirstAckMs)
    .filter((value): value is number => value !== undefined);
  const verifiedLatencies = scenarios
    .map((scenario) => scenario.timeToFirstVerifiedUpdateMs)
    .filter((value): value is number => value !== undefined);
  const stopLatencies = scenarios
    .map((scenario) => scenario.stopLatencyMs)
    .filter((value): value is number => value !== undefined);

  const completedRuns = scenarios.filter((scenario) => scenario.finalState === "completed").length;
  const failedRuns = scenarios.filter((scenario) => scenario.finalState === "failed").length;
  const blockedRuns = scenarios.filter((scenario) => scenario.finalState === "blocked").length;
  const cancelledRuns = scenarios.filter((scenario) => scenario.finalState === "cancelled").length;

  return {
    schemaVersion: BACKGROUND_RUN_QUALITY_ARTIFACT_SCHEMA_VERSION,
    runId: input.runId,
    generatedAtMs: input.generatedAtMs,
    runCount: scenarios.length,
    completedRuns,
    failedRuns,
    blockedRuns,
    cancelledRuns,
    canaryRuns: scenarios.filter((scenario) => scenario.category === "canary").length,
    soakRuns: scenarios.filter((scenario) => scenario.category === "soak").length,
    chaosRuns: scenarios.filter((scenario) => scenario.category === "chaos").length,
    replayRuns: scenarios.filter((scenario) => scenario.category === "replay").length,
    meanLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    meanTimeToFirstAckMs: mean(ackLatencies),
    meanTimeToFirstVerifiedUpdateMs: mean(verifiedLatencies),
    falseCompletionRate: ratio(
      scenarios.filter((scenario) => scenario.falseCompletion).length,
      scenarios.length,
    ),
    blockedWithoutNoticeRate: ratio(
      scenarios.filter((scenario) => scenario.blockedWithoutNotice).length,
      scenarios.length,
    ),
    meanStopLatencyMs: mean(stopLatencies),
    recoverySuccessRate: ratio(
      scenarios.filter((scenario) => scenario.recoverySucceeded).length,
      scenarios.length,
    ),
    verifierAccuracyRate: ratio(
      scenarios.filter((scenario) => scenario.verifierAccurate).length,
      scenarios.length,
    ),
    transcriptScore: mean(scenarios.map((scenario) => scenario.transcriptScore)),
    toolTrajectoryScore: mean(
      scenarios.map((scenario) => scenario.toolTrajectoryScore),
    ),
    endStateCorrectnessScore: mean(
      scenarios.map((scenario) => scenario.endStateCorrectnessScore),
    ),
    verifierCorrectnessScore: mean(
      scenarios.map((scenario) => scenario.verifierCorrectnessScore),
    ),
    restartRecoveryCorrectnessScore: mean(
      scenarios.map((scenario) => scenario.restartRecoveryCorrectnessScore),
    ),
    operatorUxCorrectnessScore: mean(
      scenarios.map((scenario) => scenario.operatorUxCorrectnessScore),
    ),
    totalTokens: scenarios.reduce((sum, scenario) => sum + scenario.tokenCount, 0),
    meanTokensPerRun: mean(scenarios.map((scenario) => scenario.tokenCount)),
    replayInconsistencies: scenarios.filter((scenario) => !scenario.replayConsistent).length,
    chaosFailures: scenarios.filter(
      (scenario) => scenario.category === "chaos" && !scenario.ok,
    ).length,
    scenarios,
  };
}

export function parseBackgroundRunQualityArtifact(
  value: unknown,
): BackgroundRunQualityArtifact {
  assert(isRecord(value), "background-run quality artifact must be an object");
  const scenariosRaw = value.scenarios;
  assert(Array.isArray(scenariosRaw), "background-run quality artifact scenarios must be an array");
  const scenarios = scenariosRaw.map((scenario, index) => {
    assert(isRecord(scenario), `scenarios[${index}] must be an object`);
    return {
      scenarioId: asString(scenario.scenarioId, `scenarios[${index}].scenarioId`),
      category: asString(scenario.category, `scenarios[${index}].category`) as BackgroundRunScenarioCategory,
      ok: asBoolean(scenario.ok, `scenarios[${index}].ok`),
      finalState: asString(scenario.finalState, `scenarios[${index}].finalState`),
      latencyMs: asFiniteNumber(scenario.latencyMs, `scenarios[${index}].latencyMs`),
      timeToFirstAckMs:
        scenario.timeToFirstAckMs === undefined
          ? undefined
          : asFiniteNumber(scenario.timeToFirstAckMs, `scenarios[${index}].timeToFirstAckMs`),
      timeToFirstVerifiedUpdateMs:
        scenario.timeToFirstVerifiedUpdateMs === undefined
          ? undefined
          : asFiniteNumber(
              scenario.timeToFirstVerifiedUpdateMs,
              `scenarios[${index}].timeToFirstVerifiedUpdateMs`,
            ),
      stopLatencyMs:
        scenario.stopLatencyMs === undefined
          ? undefined
          : asFiniteNumber(scenario.stopLatencyMs, `scenarios[${index}].stopLatencyMs`),
      falseCompletion: asBoolean(
        scenario.falseCompletion,
        `scenarios[${index}].falseCompletion`,
      ),
      blockedWithoutNotice: asBoolean(
        scenario.blockedWithoutNotice,
        `scenarios[${index}].blockedWithoutNotice`,
      ),
      recoverySucceeded: asBoolean(
        scenario.recoverySucceeded,
        `scenarios[${index}].recoverySucceeded`,
      ),
      verifierAccurate: asBoolean(
        scenario.verifierAccurate,
        `scenarios[${index}].verifierAccurate`,
      ),
      replayConsistent: asBoolean(
        scenario.replayConsistent,
        `scenarios[${index}].replayConsistent`,
      ),
      transcriptScore: asFiniteNumber(
        scenario.transcriptScore,
        `scenarios[${index}].transcriptScore`,
      ),
      toolTrajectoryScore: asFiniteNumber(
        scenario.toolTrajectoryScore,
        `scenarios[${index}].toolTrajectoryScore`,
      ),
      endStateCorrectnessScore: asFiniteNumber(
        scenario.endStateCorrectnessScore,
        `scenarios[${index}].endStateCorrectnessScore`,
      ),
      verifierCorrectnessScore: asFiniteNumber(
        scenario.verifierCorrectnessScore,
        `scenarios[${index}].verifierCorrectnessScore`,
      ),
      restartRecoveryCorrectnessScore: asFiniteNumber(
        scenario.restartRecoveryCorrectnessScore,
        `scenarios[${index}].restartRecoveryCorrectnessScore`,
      ),
      operatorUxCorrectnessScore: asFiniteNumber(
        scenario.operatorUxCorrectnessScore,
        `scenarios[${index}].operatorUxCorrectnessScore`,
      ),
      tokenCount: asFiniteNumber(scenario.tokenCount, `scenarios[${index}].tokenCount`),
      eventCount: asFiniteNumber(scenario.eventCount, `scenarios[${index}].eventCount`),
      notes:
        scenario.notes === undefined
          ? undefined
          : asString(scenario.notes, `scenarios[${index}].notes`),
    } satisfies BackgroundRunScenarioArtifact;
  });

  return buildBackgroundRunQualityArtifact({
    runId: asString(value.runId, "runId"),
    generatedAtMs: asFiniteNumber(value.generatedAtMs, "generatedAtMs"),
    scenarios,
  });
}

export function serializeBackgroundRunQualityArtifact(
  artifact: BackgroundRunQualityArtifact,
): string {
  return stableStringifyJson(artifact as unknown as JsonValue);
}
