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
  minDelegationAttemptRate: number;
  maxDelegationAttemptRate: number;
  minUsefulDelegationRate: number;
  maxHarmfulDelegationRate: number;
  maxPlannerToExecutionMismatchRate: number;
  maxChildTimeoutRate: number;
  maxChildFailureRate: number;
  maxSynthesisConflictRate: number;
  maxDepthCapHitRate: number;
  maxFanoutCapHitRate: number;
  maxCostDeltaVsBaseline: number;
  maxLatencyDeltaVsBaseline: number;
  minQualityDeltaVsBaseline: number;
  minPassAtKDeltaVsBaseline: number;
  minPassCaretKDeltaVsBaseline: number;
  failFastHarmfulDelegationRate: number;
  failFastRunawayCapHitRate: number;
}

export interface PipelineGateViolation {
  scope:
    | "context_growth"
    | "tool_turn"
    | "desktop"
    | "token_efficiency"
    | "offline_replay"
    | "delegation";
  metric: string;
  observed: number;
  threshold: number;
}

export interface PipelineGateEvaluation {
  passed: boolean;
  thresholds: PipelineQualityGateThresholds;
  violations: PipelineGateViolation[];
  failFastTriggered: boolean;
  failFastReason?: "harmful_delegation" | "runaway_caps";
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
    minDelegationAttemptRate: 0.3,
    maxDelegationAttemptRate: 0.95,
    minUsefulDelegationRate: 0.6,
    maxHarmfulDelegationRate: 0.3,
    maxPlannerToExecutionMismatchRate: 0.25,
    maxChildTimeoutRate: 0.2,
    maxChildFailureRate: 0.25,
    maxSynthesisConflictRate: 0.2,
    maxDepthCapHitRate: 0.2,
    maxFanoutCapHitRate: 0.2,
    maxCostDeltaVsBaseline: 0.8,
    maxLatencyDeltaVsBaseline: 60,
    minQualityDeltaVsBaseline: 0,
    minPassAtKDeltaVsBaseline: 0,
    minPassCaretKDeltaVsBaseline: 0,
    failFastHarmfulDelegationRate: 0.45,
    failFastRunawayCapHitRate: 0.4,
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

  const harmfulDelegationRate = artifact.delegation.harmfulDelegationRate;
  if (harmfulDelegationRate > merged.failFastHarmfulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "harmful_delegation_rate_fail_fast",
      observed: harmfulDelegationRate,
      threshold: merged.failFastHarmfulDelegationRate,
    });

    return {
      passed: false,
      thresholds: merged,
      violations,
      failFastTriggered: true,
      failFastReason: "harmful_delegation",
    };
  }

  const runawayCapRate = Math.max(
    artifact.delegation.depthCapHitRate,
    artifact.delegation.fanoutCapHitRate,
  );
  if (runawayCapRate > merged.failFastRunawayCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "runaway_cap_hit_rate_fail_fast",
      observed: runawayCapRate,
      threshold: merged.failFastRunawayCapHitRate,
    });

    return {
      passed: false,
      thresholds: merged,
      violations,
      failFastTriggered: true,
      failFastReason: "runaway_caps",
    };
  }

  if (
    artifact.delegation.delegationAttemptRate < merged.minDelegationAttemptRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "delegation_attempt_rate",
      observed: artifact.delegation.delegationAttemptRate,
      threshold: merged.minDelegationAttemptRate,
    });
  }

  if (
    artifact.delegation.delegationAttemptRate > merged.maxDelegationAttemptRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "delegation_attempt_rate",
      observed: artifact.delegation.delegationAttemptRate,
      threshold: merged.maxDelegationAttemptRate,
    });
  }

  if (artifact.delegation.usefulDelegationRate < merged.minUsefulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "useful_delegation_rate",
      observed: artifact.delegation.usefulDelegationRate,
      threshold: merged.minUsefulDelegationRate,
    });
  }

  if (artifact.delegation.harmfulDelegationRate > merged.maxHarmfulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "harmful_delegation_rate",
      observed: artifact.delegation.harmfulDelegationRate,
      threshold: merged.maxHarmfulDelegationRate,
    });
  }

  if (
    artifact.delegation.plannerToExecutionMismatchRate >
    merged.maxPlannerToExecutionMismatchRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "planner_to_execution_mismatch_rate",
      observed: artifact.delegation.plannerToExecutionMismatchRate,
      threshold: merged.maxPlannerToExecutionMismatchRate,
    });
  }

  if (artifact.delegation.childTimeoutRate > merged.maxChildTimeoutRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "child_timeout_rate",
      observed: artifact.delegation.childTimeoutRate,
      threshold: merged.maxChildTimeoutRate,
    });
  }

  if (artifact.delegation.childFailureRate > merged.maxChildFailureRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "child_failure_rate",
      observed: artifact.delegation.childFailureRate,
      threshold: merged.maxChildFailureRate,
    });
  }

  if (artifact.delegation.synthesisConflictRate > merged.maxSynthesisConflictRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "synthesis_conflict_rate",
      observed: artifact.delegation.synthesisConflictRate,
      threshold: merged.maxSynthesisConflictRate,
    });
  }

  if (artifact.delegation.depthCapHitRate > merged.maxDepthCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "depth_cap_hit_rate",
      observed: artifact.delegation.depthCapHitRate,
      threshold: merged.maxDepthCapHitRate,
    });
  }

  if (artifact.delegation.fanoutCapHitRate > merged.maxFanoutCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "fanout_cap_hit_rate",
      observed: artifact.delegation.fanoutCapHitRate,
      threshold: merged.maxFanoutCapHitRate,
    });
  }

  if (artifact.delegation.costDeltaVsBaseline > merged.maxCostDeltaVsBaseline) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "cost_delta_vs_baseline",
      observed: artifact.delegation.costDeltaVsBaseline,
      threshold: merged.maxCostDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.latencyDeltaVsBaseline >
    merged.maxLatencyDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "latency_delta_vs_baseline",
      observed: artifact.delegation.latencyDeltaVsBaseline,
      threshold: merged.maxLatencyDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.qualityDeltaVsBaseline < merged.minQualityDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "quality_delta_vs_baseline",
      observed: artifact.delegation.qualityDeltaVsBaseline,
      threshold: merged.minQualityDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.passAtKDeltaVsBaseline <
    merged.minPassAtKDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "pass_at_k_delta_vs_baseline",
      observed: artifact.delegation.passAtKDeltaVsBaseline,
      threshold: merged.minPassAtKDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.passCaretKDeltaVsBaseline <
    merged.minPassCaretKDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "pass_caret_k_delta_vs_baseline",
      observed: artifact.delegation.passCaretKDeltaVsBaseline,
      threshold: merged.minPassCaretKDeltaVsBaseline,
    });
  }

  return {
    passed: violations.length === 0,
    thresholds: merged,
    violations,
    failFastTriggered: false,
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
    `  delegation attempt rate >= ${evaluation.thresholds.minDelegationAttemptRate.toFixed(4)}`,
    `  delegation attempt rate <= ${evaluation.thresholds.maxDelegationAttemptRate.toFixed(4)}`,
    `  useful delegation rate >= ${evaluation.thresholds.minUsefulDelegationRate.toFixed(4)}`,
    `  harmful delegation rate <= ${evaluation.thresholds.maxHarmfulDelegationRate.toFixed(4)}`,
    `  planner/execution mismatch rate <= ${evaluation.thresholds.maxPlannerToExecutionMismatchRate.toFixed(4)}`,
    `  child timeout rate <= ${evaluation.thresholds.maxChildTimeoutRate.toFixed(4)}`,
    `  child failure rate <= ${evaluation.thresholds.maxChildFailureRate.toFixed(4)}`,
    `  synthesis conflict rate <= ${evaluation.thresholds.maxSynthesisConflictRate.toFixed(4)}`,
    `  depth cap hit rate <= ${evaluation.thresholds.maxDepthCapHitRate.toFixed(4)}`,
    `  fanout cap hit rate <= ${evaluation.thresholds.maxFanoutCapHitRate.toFixed(4)}`,
    `  cost delta vs baseline <= ${evaluation.thresholds.maxCostDeltaVsBaseline.toFixed(4)}`,
    `  latency delta vs baseline <= ${evaluation.thresholds.maxLatencyDeltaVsBaseline.toFixed(4)}`,
    `  quality delta vs baseline >= ${evaluation.thresholds.minQualityDeltaVsBaseline.toFixed(4)}`,
    `  pass@k delta vs baseline >= ${evaluation.thresholds.minPassAtKDeltaVsBaseline.toFixed(4)}`,
    `  pass^k delta vs baseline >= ${evaluation.thresholds.minPassCaretKDeltaVsBaseline.toFixed(4)}`,
    `  fail-fast harmful delegation rate <= ${evaluation.thresholds.failFastHarmfulDelegationRate.toFixed(4)}`,
    `  fail-fast runaway cap hit rate <= ${evaluation.thresholds.failFastRunawayCapHitRate.toFixed(4)}`,
  ];

  if (evaluation.failFastTriggered) {
    lines.push(`Fail-fast triggered: ${evaluation.failFastReason ?? "unknown"}`);
  }

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
