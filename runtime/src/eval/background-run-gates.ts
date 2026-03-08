import type { BackgroundRunQualityArtifact } from "./background-run-quality.js";

export interface BackgroundRunQualityGateThresholds {
  maxMeanLatencyMs: number;
  maxMeanTimeToFirstAckMs: number;
  maxMeanTimeToFirstVerifiedUpdateMs: number;
  maxFalseCompletionRate: number;
  maxBlockedWithoutNoticeRate: number;
  maxMeanStopLatencyMs: number;
  minRecoverySuccessRate: number;
  minVerifierAccuracyRate: number;
  minTranscriptScore: number;
  minToolTrajectoryScore: number;
  minEndStateCorrectnessScore: number;
  minVerifierCorrectnessScore: number;
  minRestartRecoveryCorrectnessScore: number;
  minOperatorUxCorrectnessScore: number;
  maxMeanTokensPerRun: number;
  maxReplayInconsistencies: number;
  maxChaosFailures: number;
}

export interface BackgroundRunGateViolation {
  readonly metric: string;
  readonly observed: number;
  readonly threshold: number;
}

export interface BackgroundRunGateEvaluation {
  readonly passed: boolean;
  readonly thresholds: BackgroundRunQualityGateThresholds;
  readonly violations: readonly BackgroundRunGateViolation[];
}

export const DEFAULT_BACKGROUND_RUN_QUALITY_GATE_THRESHOLDS: BackgroundRunQualityGateThresholds =
  {
    maxMeanLatencyMs: 5_000,
    maxMeanTimeToFirstAckMs: 1_000,
    maxMeanTimeToFirstVerifiedUpdateMs: 10_000,
    maxFalseCompletionRate: 0,
    maxBlockedWithoutNoticeRate: 0,
    maxMeanStopLatencyMs: 2_000,
    minRecoverySuccessRate: 0.9,
    minVerifierAccuracyRate: 0.95,
    minTranscriptScore: 0.9,
    minToolTrajectoryScore: 0.9,
    minEndStateCorrectnessScore: 0.95,
    minVerifierCorrectnessScore: 0.95,
    minRestartRecoveryCorrectnessScore: 0.9,
    minOperatorUxCorrectnessScore: 0.9,
    maxMeanTokensPerRun: 1_000,
    maxReplayInconsistencies: 0,
    maxChaosFailures: 0,
  };

export function evaluateBackgroundRunQualityGates(
  artifact: BackgroundRunQualityArtifact,
  overrides?: Partial<BackgroundRunQualityGateThresholds>,
): BackgroundRunGateEvaluation {
  const thresholds = {
    ...DEFAULT_BACKGROUND_RUN_QUALITY_GATE_THRESHOLDS,
    ...(overrides ?? {}),
  };
  const violations: BackgroundRunGateViolation[] = [];
  const checkMax = (
    metric: string,
    observed: number,
    threshold: number,
  ) => {
    if (observed > threshold) {
      violations.push({ metric, observed, threshold });
    }
  };
  const checkMin = (
    metric: string,
    observed: number,
    threshold: number,
  ) => {
    if (observed < threshold) {
      violations.push({ metric, observed, threshold });
    }
  };

  checkMax("mean_latency_ms", artifact.meanLatencyMs, thresholds.maxMeanLatencyMs);
  checkMax(
    "mean_time_to_first_ack_ms",
    artifact.meanTimeToFirstAckMs,
    thresholds.maxMeanTimeToFirstAckMs,
  );
  checkMax(
    "mean_time_to_first_verified_update_ms",
    artifact.meanTimeToFirstVerifiedUpdateMs,
    thresholds.maxMeanTimeToFirstVerifiedUpdateMs,
  );
  checkMax(
    "false_completion_rate",
    artifact.falseCompletionRate,
    thresholds.maxFalseCompletionRate,
  );
  checkMax(
    "blocked_without_notice_rate",
    artifact.blockedWithoutNoticeRate,
    thresholds.maxBlockedWithoutNoticeRate,
  );
  checkMax(
    "mean_stop_latency_ms",
    artifact.meanStopLatencyMs,
    thresholds.maxMeanStopLatencyMs,
  );
  checkMin(
    "recovery_success_rate",
    artifact.recoverySuccessRate,
    thresholds.minRecoverySuccessRate,
  );
  checkMin(
    "verifier_accuracy_rate",
    artifact.verifierAccuracyRate,
    thresholds.minVerifierAccuracyRate,
  );
  checkMin("transcript_score", artifact.transcriptScore, thresholds.minTranscriptScore);
  checkMin(
    "tool_trajectory_score",
    artifact.toolTrajectoryScore,
    thresholds.minToolTrajectoryScore,
  );
  checkMin(
    "end_state_correctness_score",
    artifact.endStateCorrectnessScore,
    thresholds.minEndStateCorrectnessScore,
  );
  checkMin(
    "verifier_correctness_score",
    artifact.verifierCorrectnessScore,
    thresholds.minVerifierCorrectnessScore,
  );
  checkMin(
    "restart_recovery_correctness_score",
    artifact.restartRecoveryCorrectnessScore,
    thresholds.minRestartRecoveryCorrectnessScore,
  );
  checkMin(
    "operator_ux_correctness_score",
    artifact.operatorUxCorrectnessScore,
    thresholds.minOperatorUxCorrectnessScore,
  );
  checkMax(
    "mean_tokens_per_run",
    artifact.meanTokensPerRun,
    thresholds.maxMeanTokensPerRun,
  );
  checkMax(
    "replay_inconsistencies",
    artifact.replayInconsistencies,
    thresholds.maxReplayInconsistencies,
  );
  checkMax("chaos_failures", artifact.chaosFailures, thresholds.maxChaosFailures);

  return {
    passed: violations.length === 0,
    thresholds,
    violations,
  };
}

export function formatBackgroundRunGateEvaluation(
  evaluation: BackgroundRunGateEvaluation,
): string {
  if (evaluation.passed) {
    return "Background-run quality gates passed.";
  }
  return [
    "Background-run quality gates failed:",
    ...evaluation.violations.map(
      (violation) =>
        `- ${violation.metric}: observed=${violation.observed} threshold=${violation.threshold}`,
    ),
  ].join("\n");
}
