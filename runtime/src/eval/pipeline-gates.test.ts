import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS,
  evaluatePipelineQualityGates,
  formatPipelineQualityGateEvaluation,
} from "./pipeline-gates.js";
import type { PipelineQualityArtifact } from "./pipeline-quality.js";

function artifactFixture(): PipelineQualityArtifact {
  return {
    schemaVersion: 1,
    runId: "pipeline-fixture",
    generatedAtMs: 1700000000000,
    contextGrowth: {
      turns: 5,
      promptTokenSeries: [120, 160, 180, 205, 230],
      tokenDeltas: [40, 20, 25, 25],
      maxDelta: 40,
      slope: 27.5,
    },
    toolTurn: {
      validCases: 3,
      validAccepted: 3,
      malformedCases: 4,
      malformedRejected: 4,
      malformedForwarded: 0,
    },
    desktopStability: {
      runs: 2,
      failedRuns: 0,
      timedOutRuns: 0,
      maxDurationMs: 3200,
      runSummaries: [
        {
          runId: "desktop-1",
          ok: true,
          timedOut: false,
          durationMs: 2800,
        },
        {
          runId: "desktop-2",
          ok: true,
          timedOut: false,
          durationMs: 3200,
        },
      ],
    },
    tokenEfficiency: {
      completedTasks: 4,
      totalPromptTokens: 600,
      totalCompletionTokens: 200,
      totalTokens: 800,
      tokensPerCompletedTask: 200,
    },
    offlineReplay: {
      fixtureCount: 2,
      parseFailures: 0,
      replayFailures: 0,
      deterministicMismatches: 0,
      fixtures: [
        { fixtureId: "incident-a", ok: true },
        { fixtureId: "incident-b", ok: true },
      ],
    },
  };
}

describe("pipeline quality gates", () => {
  it("passes with default thresholds for healthy artifact", () => {
    const evaluation = evaluatePipelineQualityGates(artifactFixture());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.thresholds).toEqual(
      DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS,
    );
  });

  it("fails when malformed tool-turns are forwarded", () => {
    const artifact = artifactFixture();
    artifact.toolTurn.malformedForwarded = 1;
    artifact.toolTurn.malformedRejected = 3;
    const evaluation = evaluatePipelineQualityGates(artifact);

    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.violations.some(
        (entry) =>
          entry.scope === "tool_turn" && entry.metric === "malformed_forwarded",
      ),
    ).toBe(true);
  });

  it("fails when desktop timeout regression appears", () => {
    const artifact = artifactFixture();
    artifact.desktopStability.timedOutRuns = 1;
    artifact.desktopStability.failedRuns = 1;
    const evaluation = evaluatePipelineQualityGates(artifact);

    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.violations.some(
        (entry) => entry.scope === "desktop" && entry.metric === "timeout_runs",
      ),
    ).toBe(true);
  });

  it("fails when context growth/token efficiency exceed strict thresholds", () => {
    const evaluation = evaluatePipelineQualityGates(artifactFixture(), {
      maxContextGrowthSlope: 10,
      maxTokensPerCompletedTask: 50,
    });

    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.violations.some(
        (entry) =>
          entry.scope === "context_growth" && entry.metric === "slope",
      ),
    ).toBe(true);
    expect(
      evaluation.violations.some(
        (entry) =>
          entry.scope === "token_efficiency" &&
          entry.metric === "tokens_per_completed_task",
      ),
    ).toBe(true);
  });

  it("formats violations for CI output", () => {
    const artifact = artifactFixture();
    artifact.offlineReplay.parseFailures = 1;
    const evaluation = evaluatePipelineQualityGates(artifact);
    const report = formatPipelineQualityGateEvaluation(evaluation);

    expect(report).toContain("Pipeline quality gates: FAIL");
    expect(report).toContain("[offline_replay] total_failures");
  });
});
