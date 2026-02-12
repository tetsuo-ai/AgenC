import { describe, it, expect } from 'vitest';
import { TrajectoryRecorder } from '../src/eval/recorder.js';
import { TrajectoryReplayEngine } from '../src/eval/replay.js';
import {
  computeEvaluationScorecard,
  evalRunFromReplayResult,
  serializeEvaluationScorecard,
  type EvalRunRecord,
} from '../src/eval/metrics.js';
import { buildCalibrationReport } from '../src/eval/calibration.js';

interface FixtureOptions {
  traceId: string;
  seed: number;
  pass: boolean;
  durationMs: number;
  policyViolation?: boolean;
  verifierVerdict?: 'pass' | 'fail' | 'needs_revision';
}

function buildFixtureRun(options: FixtureOptions, overrides: Partial<EvalRunRecord>): EvalRunRecord {
  let now = 1000;
  const recorder = new TrajectoryRecorder({
    traceId: options.traceId,
    seed: options.seed,
    now: () => now++,
  });

  const taskPda = `task-${options.traceId}`;
  recorder.record({ type: 'discovered', taskPda });
  recorder.record({ type: 'claimed', taskPda, payload: { claimTx: `claim-${options.traceId}` } });

  if (options.verifierVerdict) {
    recorder.record({
      type: 'verifier_verdict',
      taskPda,
      payload: { attempt: 1, verdict: options.verifierVerdict, confidence: 0.8 },
    });
  }

  if (options.policyViolation) {
    recorder.record({
      type: 'policy_violation',
      taskPda,
      payload: { code: 'risk_threshold_exceeded' },
    });
  }

  recorder.record({ type: 'executed', taskPda, payload: { outputLength: 1 } });

  if (options.pass) {
    recorder.record({
      type: 'completed',
      taskPda,
      payload: { completionTx: `complete-${options.traceId}`, durationMs: options.durationMs },
    });
  } else {
    recorder.record({
      type: 'failed',
      taskPda,
      payload: { error: 'execution_failed' },
    });
  }

  const replay = new TrajectoryReplayEngine({ strictMode: true, seed: options.seed }).replay(
    recorder.createTrace(),
  );

  return evalRunFromReplayResult(replay, {
    id: options.traceId,
    latencyMs: options.durationMs,
    ...overrides,
  });
}

describe('eval scorecard integration', () => {
  it('computes deterministic scorecards from fixture traces', () => {
    const runs: EvalRunRecord[] = [
      buildFixtureRun(
        {
          traceId: 'good-1',
          seed: 1,
          pass: true,
          durationMs: 30,
          verifierVerdict: 'pass',
        },
        {
          taskType: 'qa',
          rewardLamports: 500_000,
          verifierGated: true,
          riskScore: 0.8,
          costUnits: 2,
        },
      ),
      buildFixtureRun(
        {
          traceId: 'good-2',
          seed: 2,
          pass: true,
          durationMs: 40,
          verifierVerdict: 'pass',
        },
        {
          taskType: 'planning',
          rewardLamports: 2_000_000,
          verifierGated: false,
          riskScore: 0.3,
          costUnits: 1,
        },
      ),
      buildFixtureRun(
        {
          traceId: 'bad-1',
          seed: 3,
          pass: false,
          durationMs: 35,
          verifierVerdict: 'needs_revision',
          policyViolation: true,
        },
        {
          taskType: 'qa',
          rewardLamports: 200_000_000,
          verifierGated: true,
          riskScore: 0.9,
          costUnits: 2,
        },
      ),
    ];

    const scorecard = computeEvaluationScorecard(runs, { k: 2 });
    const serialized = serializeEvaluationScorecard(scorecard);

    expect(scorecard.aggregate.runCount).toBe(3);
    expect(scorecard.aggregate.passRate).toBeCloseTo(2 / 3, 6);
    expect(scorecard.aggregate.passAtK).toBeGreaterThan(0);
    expect(scorecard.byTaskType.qa.runCount).toBe(2);
    expect(scorecard.byRewardTier.high.runCount).toBe(1);
    expect(scorecard.byVerifierGate.gated.runCount).toBe(2);
    expect(serialized.json).toContain('"aggregate"');
    expect(serialized.summary).toContain('pass_at_k=');
  });

  it('flags degraded traces with lower reliability metrics', () => {
    const baselineRuns: EvalRunRecord[] = [
      buildFixtureRun(
        { traceId: 'baseline-a', seed: 10, pass: true, durationMs: 25, verifierVerdict: 'pass' },
        {
          taskType: 'qa',
          rewardLamports: 1_000_000,
          verifierGated: true,
          riskScore: 0.7,
          costUnits: 1,
        },
      ),
      buildFixtureRun(
        { traceId: 'baseline-b', seed: 11, pass: true, durationMs: 35, verifierVerdict: 'pass' },
        {
          taskType: 'planning',
          rewardLamports: 2_000_000,
          verifierGated: false,
          riskScore: 0.3,
          costUnits: 1,
        },
      ),
      buildFixtureRun(
        { traceId: 'baseline-c', seed: 12, pass: false, durationMs: 45, verifierVerdict: 'needs_revision' },
        {
          taskType: 'qa',
          rewardLamports: 500_000,
          verifierGated: true,
          riskScore: 0.8,
          costUnits: 2,
        },
      ),
    ];

    const degradedRuns: EvalRunRecord[] = [
      baselineRuns[0],
      buildFixtureRun(
        {
          traceId: 'degraded-b',
          seed: 21,
          pass: false,
          durationMs: 60,
          verifierVerdict: 'fail',
          policyViolation: true,
        },
        {
          taskType: 'planning',
          rewardLamports: 2_000_000,
          verifierGated: false,
          riskScore: 0.3,
          costUnits: 2,
        },
      ),
      buildFixtureRun(
        {
          traceId: 'degraded-c',
          seed: 22,
          pass: false,
          durationMs: 55,
          verifierVerdict: 'fail',
          policyViolation: true,
        },
        {
          taskType: 'qa',
          rewardLamports: 500_000,
          verifierGated: true,
          riskScore: 0.8,
          costUnits: 2,
        },
      ),
    ];

    const baseline = computeEvaluationScorecard(baselineRuns, { k: 2 });
    const degraded = computeEvaluationScorecard(degradedRuns, { k: 2 });

    expect(degraded.aggregate.passRate).toBeLessThan(baseline.aggregate.passRate);
    expect(degraded.aggregate.passAtK).toBeLessThan(baseline.aggregate.passAtK);
    expect(degraded.aggregate.conformanceScore).toBeLessThan(baseline.aggregate.conformanceScore);
    expect(degraded.aggregate.costNormalizedUtility).toBeLessThan(
      baseline.aggregate.costNormalizedUtility,
    );

    const baselineCalibration = buildCalibrationReport(
      baselineRuns.map((run) => ({
        confidence: run.passed ? 0.8 : 0.4,
        correct: run.passed,
        taskType: run.taskType,
        rewardLamports: run.rewardLamports,
        verifierGated: run.verifierGated,
      })),
      baselineRuns.map((run) => ({
        verifierVerdict: run.passed ? 'pass' : 'fail',
        judgeVerdict: run.passed ? 'pass' : 'fail',
        confidence: run.passed ? 0.8 : 0.4,
        taskType: run.taskType,
        rewardLamports: run.rewardLamports,
        verifierGated: run.verifierGated,
      })),
    );

    const degradedCalibration = buildCalibrationReport(
      degradedRuns.map((run) => ({
        confidence: 0.9,
        correct: run.passed,
        taskType: run.taskType,
        rewardLamports: run.rewardLamports,
        verifierGated: run.verifierGated,
      })),
      degradedRuns.map((run) => ({
        verifierVerdict: run.passed ? 'pass' : 'pass',
        judgeVerdict: run.passed ? 'pass' : 'fail',
        confidence: 0.9,
        taskType: run.taskType,
        rewardLamports: run.rewardLamports,
        verifierGated: run.verifierGated,
      })),
    );

    expect(degradedCalibration.overall.expectedCalibrationError).toBeGreaterThan(
      baselineCalibration.overall.expectedCalibrationError,
    );
  });
});
