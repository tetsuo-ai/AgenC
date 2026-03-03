import { describe, expect, it } from "vitest";
import {
  PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
  buildPipelineQualityArtifact,
  parsePipelineQualityArtifact,
  serializePipelineQualityArtifact,
} from "./pipeline-quality.js";

describe("pipeline-quality artifact", () => {
  it("builds derived context, replay, and delegation rollups", () => {
    const artifact = buildPipelineQualityArtifact({
      runId: "phase9-run",
      generatedAtMs: 1700000000000,
      contextGrowth: {
        promptTokenSeries: [100, 140, 150, 190],
      },
      toolTurn: {
        validCases: 3,
        validAccepted: 3,
        malformedCases: 4,
        malformedRejected: 4,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-1",
            ok: true,
            timedOut: false,
            durationMs: 3200,
          },
          {
            runId: "desktop-2",
            ok: false,
            timedOut: true,
            durationMs: 5000,
            failedStep: 2,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 4,
        totalPromptTokens: 400,
        totalCompletionTokens: 120,
        totalTokens: 520,
      },
      offlineReplay: {
        fixtures: [
          { fixtureId: "a", ok: true },
          { fixtureId: "b", ok: false, replayError: "bad transition" },
          {
            fixtureId: "c",
            ok: false,
            parseError: "invalid json",
            deterministicMismatch: true,
          },
        ],
      },
      delegation: {
        totalCases: 20,
        delegatedCases: 16,
        usefulDelegations: 12,
        harmfulDelegations: 4,
        plannerExecutionMismatches: 2,
        childTimeouts: 1,
        childFailures: 2,
        synthesisConflicts: 2,
        depthCapHits: 1,
        fanoutCapHits: 1,
        costDeltaVsBaseline: 0.34,
        latencyDeltaVsBaseline: -28,
        qualityDeltaVsBaseline: 0.2,
        passAtKDeltaVsBaseline: 0.1,
        passCaretKDeltaVsBaseline: 0.15,
        baselineScenarioId: "baseline_no_delegation",
        k: 2,
        scenarioSummaries: [
          {
            scenarioId: "baseline_no_delegation",
            mode: "no_delegation",
            runCount: 4,
            passRate: 0.5,
            passAtK: 0.833333,
            passCaretK: 0.75,
            meanLatencyMs: 157.5,
            meanCostUnits: 1.03,
            passAtKDeltaVsBaseline: 0,
            passCaretKDeltaVsBaseline: 0,
          },
        ],
      },
    });

    expect(artifact.schemaVersion).toBe(
      PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    );
    expect(artifact.contextGrowth.turns).toBe(4);
    expect(artifact.contextGrowth.tokenDeltas).toEqual([40, 10, 40]);
    expect(artifact.contextGrowth.maxDelta).toBe(40);
    expect(artifact.contextGrowth.slope).toBeCloseTo(30, 8);
    expect(artifact.desktopStability.runs).toBe(2);
    expect(artifact.desktopStability.failedRuns).toBe(1);
    expect(artifact.desktopStability.timedOutRuns).toBe(1);
    expect(artifact.desktopStability.maxDurationMs).toBe(5000);
    expect(artifact.tokenEfficiency.tokensPerCompletedTask).toBe(130);
    expect(artifact.offlineReplay.fixtureCount).toBe(3);
    expect(artifact.offlineReplay.parseFailures).toBe(1);
    expect(artifact.offlineReplay.replayFailures).toBe(1);
    expect(artifact.offlineReplay.deterministicMismatches).toBe(1);
    expect(artifact.delegation.delegationAttemptRate).toBeCloseTo(0.8, 8);
    expect(artifact.delegation.usefulDelegationRate).toBeCloseTo(0.75, 8);
    expect(artifact.delegation.harmfulDelegationRate).toBeCloseTo(0.25, 8);
    expect(artifact.delegation.childTimeoutRate).toBeCloseTo(0.0625, 8);
    expect(artifact.delegation.passAtKDeltaVsBaseline).toBeCloseTo(0.1, 8);
    expect(artifact.delegation.scenarioSummaries).toHaveLength(1);
  });

  it("round-trips parse + serialization deterministically", () => {
    const built = buildPipelineQualityArtifact({
      runId: "phase9-roundtrip",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [32, 44, 49],
      },
      toolTurn: {
        validCases: 2,
        validAccepted: 2,
        malformedCases: 2,
        malformedRejected: 2,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-ok",
            ok: true,
            timedOut: false,
            durationMs: 1000,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 2,
        totalPromptTokens: 90,
        totalCompletionTokens: 30,
        totalTokens: 120,
      },
      offlineReplay: {
        fixtures: [{ fixtureId: "fixture-1", ok: true }],
      },
      delegation: {
        totalCases: 5,
        delegatedCases: 2,
        usefulDelegations: 2,
        harmfulDelegations: 0,
        plannerExecutionMismatches: 0,
        childTimeouts: 0,
        childFailures: 0,
        synthesisConflicts: 0,
        depthCapHits: 0,
        fanoutCapHits: 0,
        costDeltaVsBaseline: 0.2,
        latencyDeltaVsBaseline: -4,
        qualityDeltaVsBaseline: 0.1,
        passAtKDeltaVsBaseline: 0.1,
        passCaretKDeltaVsBaseline: 0.1,
        baselineScenarioId: "baseline_no_delegation",
        k: 2,
        scenarioSummaries: [
          {
            scenarioId: "baseline_no_delegation",
            mode: "no_delegation",
            runCount: 3,
            passRate: 0.66,
            passAtK: 1,
            passCaretK: 0.88,
            meanLatencyMs: 10,
            meanCostUnits: 1,
            passAtKDeltaVsBaseline: 0,
            passCaretKDeltaVsBaseline: 0,
          },
        ],
      },
    });

    const parsed = parsePipelineQualityArtifact(
      JSON.parse(serializePipelineQualityArtifact(built)) as unknown,
    );

    expect(parsed).toEqual(built);
    expect(serializePipelineQualityArtifact(parsed)).toBe(
      serializePipelineQualityArtifact(built),
    );
  });

  it("migrates schema v1 artifacts by defaulting delegation metrics", () => {
    const parsed = parsePipelineQualityArtifact({
      schemaVersion: 1,
      runId: "legacy-v1",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [12, 18],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 1,
        malformedRejected: 1,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalTokens: 15,
      },
      offlineReplay: {
        fixtures: [],
      },
    });

    expect(parsed.schemaVersion).toBe(PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.delegation.totalCases).toBe(0);
    expect(parsed.delegation.delegationAttemptRate).toBe(0);
    expect(parsed.delegation.passAtKDeltaVsBaseline).toBe(0);
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parsePipelineQualityArtifact({
        schemaVersion: 99,
        runId: "bad",
        generatedAtMs: 1,
      }),
    ).toThrow(/schema version/i);
  });
});
