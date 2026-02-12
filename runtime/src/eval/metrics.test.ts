import { describe, it, expect } from 'vitest';
import { UnifiedTelemetryCollector } from '../telemetry/collector.js';
import { TrajectoryRecorder } from './recorder.js';
import { TrajectoryReplayEngine } from './replay.js';
import {
  computePassAtK,
  computePassCaretK,
  computeEvaluationScorecard,
  evalRunFromReplayResult,
  recordEvaluationMetrics,
  serializeEvaluationScorecard,
  type EvalRunRecord,
} from './metrics.js';

describe('eval/metrics', () => {
  it('computes pass@k and pass^k correctly', () => {
    const passAt2 = computePassAtK(5, 3, 2);
    const passCaret2 = computePassCaretK(3 / 5, 2);

    expect(passAt2).toBeCloseTo(0.9, 6);
    expect(passCaret2).toBeCloseTo(0.84, 6);
  });

  it('builds stratified scorecard by task type, reward tier, and verifier gate', () => {
    const records: EvalRunRecord[] = [
      {
        id: 'run-a',
        passed: true,
        taskType: 'qa',
        rewardLamports: 500_000,
        verifierGated: true,
        riskScore: 0.7,
        costUnits: 2,
        latencyMs: 40,
        policyViolations: 0,
        verifierDisagreements: 0,
      },
      {
        id: 'run-b',
        passed: false,
        taskType: 'qa',
        rewardLamports: 2_000_000,
        verifierGated: true,
        riskScore: 0.9,
        costUnits: 2,
        latencyMs: 50,
        policyViolations: 1,
        verifierDisagreements: 1,
      },
      {
        id: 'run-c',
        passed: true,
        taskType: 'planning',
        rewardLamports: 200_000_000,
        verifierGated: false,
        riskScore: 0.2,
        costUnits: 1,
        latencyMs: 30,
        policyViolations: 0,
        verifierDisagreements: 0,
      },
    ];

    const scorecard = computeEvaluationScorecard(records, { k: 2 });

    expect(scorecard.aggregate.runCount).toBe(3);
    expect(scorecard.byTaskType.qa.runCount).toBe(2);
    expect(scorecard.byTaskType.planning.runCount).toBe(1);
    expect(scorecard.byRewardTier.low.runCount).toBe(1);
    expect(scorecard.byRewardTier.medium.runCount).toBe(1);
    expect(scorecard.byRewardTier.high.runCount).toBe(1);
    expect(scorecard.byVerifierGate.gated.runCount).toBe(2);
    expect(scorecard.byVerifierGate.ungated.runCount).toBe(1);
  });

  it('records scorecard gauges via existing telemetry collector', () => {
    const scorecard = computeEvaluationScorecard([
      {
        id: 'run-only',
        passed: true,
        taskType: 'qa',
        rewardLamports: 100_000,
        verifierGated: false,
        riskScore: 0.5,
        costUnits: 1,
        latencyMs: 10,
        policyViolations: 0,
        verifierDisagreements: 0,
      },
    ], { k: 1 });

    const collector = new UnifiedTelemetryCollector();
    recordEvaluationMetrics(scorecard, collector);

    const snapshot = collector.getSnapshot();
    expect(Object.keys(snapshot.gauges).some((name) => name.startsWith('agenc.eval.pass_at_k'))).toBe(true);
    expect(Object.keys(snapshot.gauges).some((name) => name.startsWith('agenc.eval.conformance_score'))).toBe(true);
    expect(Object.keys(snapshot.gauges).some((name) => name.startsWith('agenc.eval.cost_normalized_utility'))).toBe(true);
  });

  it('serializes scorecards to json and human-readable summary', () => {
    const scorecard = computeEvaluationScorecard([
      {
        id: 'run-summary',
        passed: true,
      },
    ], { k: 1 });

    const serialized = serializeEvaluationScorecard(scorecard);
    expect(serialized.json).toContain('"aggregate"');
    expect(serialized.summary).toContain('pass_rate=');
    expect(serialized.summary).toContain('cost_normalized_utility=');
  });

  it('derives run records from replay results', () => {
    const recorder = new TrajectoryRecorder({ traceId: 'metrics-from-replay', seed: 22 });
    recorder.record({ type: 'discovered', taskPda: 'task-replay' });
    recorder.record({ type: 'claimed', taskPda: 'task-replay' });
    recorder.record({
      type: 'verifier_verdict',
      taskPda: 'task-replay',
      payload: { attempt: 1, verdict: 'needs_revision' },
    });
    recorder.record({
      type: 'completed',
      taskPda: 'task-replay',
      payload: { durationMs: 42 },
    });

    const replay = new TrajectoryReplayEngine().replay(recorder.createTrace());
    const run = evalRunFromReplayResult(replay, {
      taskType: 'qa',
      rewardLamports: 100_000,
      verifierGated: true,
      costUnits: 1.5,
      riskScore: 0.6,
    });

    expect(run.passed).toBe(true);
    expect(run.policyViolations).toBe(0);
    expect(run.verifierDisagreements).toBe(1);
    expect(run.latencyMs).toBe(42);
  });
});
