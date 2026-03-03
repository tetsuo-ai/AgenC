import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS,
  evaluatePipelineQualityGates,
  formatPipelineQualityGateEvaluation,
} from "./pipeline-gates.js";
import type { PipelineQualityArtifact } from "./pipeline-quality.js";

function artifactFixture(): PipelineQualityArtifact {
  return {
    schemaVersion: 2,
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
      delegationAttemptRate: 0.8,
      usefulDelegationRate: 0.75,
      harmfulDelegationRate: 0.25,
      plannerToExecutionMismatchRate: 0.125,
      childTimeoutRate: 0.0625,
      childFailureRate: 0.125,
      synthesisConflictRate: 0.125,
      depthCapHitRate: 0.0625,
      fanoutCapHitRate: 0.0625,
      costDeltaVsBaseline: 0.35,
      latencyDeltaVsBaseline: -28,
      qualityDeltaVsBaseline: 0.2,
      passAtKDeltaVsBaseline: 0.1,
      passCaretKDeltaVsBaseline: 0.2,
      baselineScenarioId: "baseline_no_delegation",
      k: 2,
      scenarioSummaries: [
        {
          scenarioId: "baseline_no_delegation",
          mode: "no_delegation",
          runCount: 4,
          passRate: 0.5,
          passAtK: 0.8333,
          passCaretK: 0.75,
          meanLatencyMs: 157.5,
          meanCostUnits: 1.03,
          passAtKDeltaVsBaseline: 0,
          passCaretKDeltaVsBaseline: 0,
        },
      ],
    },
  };
}

describe("pipeline quality gates", () => {
  it("passes with default thresholds for healthy artifact", () => {
    const evaluation = evaluatePipelineQualityGates(artifactFixture());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.failFastTriggered).toBe(false);
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

  it("fails delegation pass@k and pass^k regression thresholds", () => {
    const evaluation = evaluatePipelineQualityGates(artifactFixture(), {
      minPassAtKDeltaVsBaseline: 0.25,
      minPassCaretKDeltaVsBaseline: 0.25,
    });

    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.violations.some(
        (entry) =>
          entry.scope === "delegation" &&
          entry.metric === "pass_at_k_delta_vs_baseline",
      ),
    ).toBe(true);
    expect(
      evaluation.violations.some(
        (entry) =>
          entry.scope === "delegation" &&
          entry.metric === "pass_caret_k_delta_vs_baseline",
      ),
    ).toBe(true);
  });

  it("triggers fail-fast for harmful delegation runaway", () => {
    const artifact = artifactFixture();
    artifact.delegation.harmfulDelegationRate = 0.8;

    const evaluation = evaluatePipelineQualityGates(artifact);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failFastTriggered).toBe(true);
    expect(evaluation.failFastReason).toBe("harmful_delegation");
    expect(
      evaluation.violations.some(
        (entry) => entry.metric === "harmful_delegation_rate_fail_fast",
      ),
    ).toBe(true);
  });

  it("formats violations for CI output", () => {
    const artifact = artifactFixture();
    artifact.offlineReplay.parseFailures = 1;
    artifact.delegation.passAtKDeltaVsBaseline = -0.1;
    artifact.delegation.passCaretKDeltaVsBaseline = -0.1;
    const evaluation = evaluatePipelineQualityGates(artifact);
    const report = formatPipelineQualityGateEvaluation(evaluation);

    expect(report).toContain("Pipeline quality gates: FAIL");
    expect(report).toContain("[offline_replay] total_failures");
    expect(report).toContain("[delegation] pass_at_k_delta_vs_baseline");
  });
});
