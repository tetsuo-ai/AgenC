/**
 * Phase 9 pipeline-quality gate evaluation.
 *
 * @module
 */

import type { PipelineQualityArtifact } from "./pipeline-quality.js";

export interface PipelineQualityGateThresholds {
  maxContextGrowthSlope: number;
  maxContextGrowthDelta: number;
  maxTokensPerCompletedTask: number;
  maxMalformedToolTurnForwarded: number;
  minMalformedToolTurnRejectedRate: number;
  maxDesktopFailedRuns: number;
  maxDesktopTimeoutRuns: number;
  maxOfflineReplayFailures: number;
}

export interface PipelineGateViolation {
  scope:
    | "context_growth"
    | "tool_turn"
    | "desktop"
    | "token_efficiency"
    | "offline_replay";
  metric: string;
  observed: number;
  threshold: number;
}

export interface PipelineGateEvaluation {
  passed: boolean;
  thresholds: PipelineQualityGateThresholds;
  violations: PipelineGateViolation[];
}

export const DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS: PipelineQualityGateThresholds =
  {
    maxContextGrowthSlope: 120,
    maxContextGrowthDelta: 220,
    maxTokensPerCompletedTask: 2_000,
    maxMalformedToolTurnForwarded: 0,
    minMalformedToolTurnRejectedRate: 1,
    maxDesktopFailedRuns: 0,
    maxDesktopTimeoutRuns: 0,
    maxOfflineReplayFailures: 0,
  };

function mergeThresholds(
  overrides: Partial<PipelineQualityGateThresholds> | undefined,
): PipelineQualityGateThresholds {
  return {
    ...DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS,
    ...(overrides ?? {}),
  };
}

function pushViolation(
  violations: PipelineGateViolation[],
  input: PipelineGateViolation,
): void {
  violations.push(input);
}

/**
 * Evaluate a pipeline-quality artifact against configured CI gate thresholds.
 */
export function evaluatePipelineQualityGates(
  artifact: PipelineQualityArtifact,
  thresholds?: Partial<PipelineQualityGateThresholds>,
): PipelineGateEvaluation {
  const merged = mergeThresholds(thresholds);
  const violations: PipelineGateViolation[] = [];

  if (artifact.contextGrowth.slope > merged.maxContextGrowthSlope) {
    pushViolation(violations, {
      scope: "context_growth",
      metric: "slope",
      observed: artifact.contextGrowth.slope,
      threshold: merged.maxContextGrowthSlope,
    });
  }

  if (artifact.contextGrowth.maxDelta > merged.maxContextGrowthDelta) {
    pushViolation(violations, {
      scope: "context_growth",
      metric: "max_delta",
      observed: artifact.contextGrowth.maxDelta,
      threshold: merged.maxContextGrowthDelta,
    });
  }

  if (
    artifact.tokenEfficiency.tokensPerCompletedTask >
    merged.maxTokensPerCompletedTask
  ) {
    pushViolation(violations, {
      scope: "token_efficiency",
      metric: "tokens_per_completed_task",
      observed: artifact.tokenEfficiency.tokensPerCompletedTask,
      threshold: merged.maxTokensPerCompletedTask,
    });
  }

  if (
    artifact.toolTurn.malformedForwarded >
    merged.maxMalformedToolTurnForwarded
  ) {
    pushViolation(violations, {
      scope: "tool_turn",
      metric: "malformed_forwarded",
      observed: artifact.toolTurn.malformedForwarded,
      threshold: merged.maxMalformedToolTurnForwarded,
    });
  }

  const malformedCases = artifact.toolTurn.malformedCases;
  if (malformedCases > 0) {
    const rejectionRate = artifact.toolTurn.malformedRejected / malformedCases;
    if (rejectionRate < merged.minMalformedToolTurnRejectedRate) {
      pushViolation(violations, {
        scope: "tool_turn",
        metric: "malformed_rejected_rate",
        observed: rejectionRate,
        threshold: merged.minMalformedToolTurnRejectedRate,
      });
    }
  }

  if (artifact.desktopStability.failedRuns > merged.maxDesktopFailedRuns) {
    pushViolation(violations, {
      scope: "desktop",
      metric: "failed_runs",
      observed: artifact.desktopStability.failedRuns,
      threshold: merged.maxDesktopFailedRuns,
    });
  }

  if (artifact.desktopStability.timedOutRuns > merged.maxDesktopTimeoutRuns) {
    pushViolation(violations, {
      scope: "desktop",
      metric: "timeout_runs",
      observed: artifact.desktopStability.timedOutRuns,
      threshold: merged.maxDesktopTimeoutRuns,
    });
  }

  const offlineFailures =
    artifact.offlineReplay.parseFailures +
    artifact.offlineReplay.replayFailures +
    artifact.offlineReplay.deterministicMismatches;
  if (offlineFailures > merged.maxOfflineReplayFailures) {
    pushViolation(violations, {
      scope: "offline_replay",
      metric: "total_failures",
      observed: offlineFailures,
      threshold: merged.maxOfflineReplayFailures,
    });
  }

  return {
    passed: violations.length === 0,
    thresholds: merged,
    violations,
  };
}

/**
 * Human-readable gate report for CI logs.
 */
export function formatPipelineQualityGateEvaluation(
  evaluation: PipelineGateEvaluation,
): string {
  const lines = [
    `Pipeline quality gates: ${evaluation.passed ? "PASS" : "FAIL"}`,
    "Thresholds:",
    `  context growth slope <= ${evaluation.thresholds.maxContextGrowthSlope.toFixed(4)}`,
    `  context growth max delta <= ${evaluation.thresholds.maxContextGrowthDelta.toFixed(4)}`,
    `  tokens/completed task <= ${evaluation.thresholds.maxTokensPerCompletedTask.toFixed(4)}`,
    `  malformed tool-turn forwarded <= ${evaluation.thresholds.maxMalformedToolTurnForwarded.toFixed(4)}`,
    `  malformed tool-turn rejected rate >= ${evaluation.thresholds.minMalformedToolTurnRejectedRate.toFixed(4)}`,
    `  desktop failed runs <= ${evaluation.thresholds.maxDesktopFailedRuns.toFixed(4)}`,
    `  desktop timeout runs <= ${evaluation.thresholds.maxDesktopTimeoutRuns.toFixed(4)}`,
    `  offline replay failures <= ${evaluation.thresholds.maxOfflineReplayFailures.toFixed(4)}`,
  ];

  if (evaluation.violations.length === 0) {
    lines.push("No threshold violations detected.");
    return lines.join("\n");
  }

  lines.push("Violations:");
  for (const violation of evaluation.violations) {
    lines.push(
      `  - [${violation.scope}] ${violation.metric}: observed=${violation.observed.toFixed(6)} threshold=${violation.threshold.toFixed(6)}`,
    );
  }

  return lines.join("\n");
}
