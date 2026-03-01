import { describe, expect, it } from "vitest";
import {
  PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
  buildPipelineQualityArtifact,
  parsePipelineQualityArtifact,
  serializePipelineQualityArtifact,
} from "./pipeline-quality.js";

describe("pipeline-quality artifact", () => {
  it("builds derived context growth, desktop, and replay rollups", () => {
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
    });

    const parsed = parsePipelineQualityArtifact(
      JSON.parse(serializePipelineQualityArtifact(built)) as unknown,
    );

    expect(parsed).toEqual(built);
    expect(serializePipelineQualityArtifact(parsed)).toBe(
      serializePipelineQualityArtifact(built),
    );
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
