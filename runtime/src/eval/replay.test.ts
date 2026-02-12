import { describe, it, expect } from 'vitest';
import { EVAL_TRACE_SCHEMA_VERSION, type TrajectoryTrace } from './types.js';
import { TrajectoryReplayEngine } from './replay.js';

function baseTrace(events: TrajectoryTrace['events']): TrajectoryTrace {
  return {
    schemaVersion: EVAL_TRACE_SCHEMA_VERSION,
    traceId: 'trace-replay',
    seed: 77,
    createdAtMs: 100,
    events,
  };
}

describe('TrajectoryReplayEngine', () => {
  it('produces stable deterministic hash for identical trace + config', () => {
    const trace = baseTrace([
      { seq: 1, type: 'discovered', taskPda: 'task-a', timestampMs: 101, payload: {} },
      { seq: 2, type: 'claimed', taskPda: 'task-a', timestampMs: 102, payload: {} },
      { seq: 3, type: 'executed', taskPda: 'task-a', timestampMs: 103, payload: { outputLength: 1 } },
      { seq: 4, type: 'completed', taskPda: 'task-a', timestampMs: 104, payload: { completionTx: 'tx-1' } },
    ]);

    const engine = new TrajectoryReplayEngine({ strictMode: true, seed: 999 });
    const first = engine.replay(trace);
    const second = engine.replay(trace);

    expect(first.deterministicHash).toBe(second.deterministicHash);
    expect(first.summary.completedTasks).toBe(1);
    expect(first.tasks['task-a'].status).toBe('completed');
  });

  it('reports invalid transitions in strict mode', () => {
    const trace = baseTrace([
      { seq: 1, type: 'completed', taskPda: 'task-b', timestampMs: 101, payload: {} },
    ]);

    const result = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toContain('invalid completion transition');
  });

  it('captures escalation, policy violations, and speculation aborts', () => {
    const trace = baseTrace([
      { seq: 1, type: 'discovered', taskPda: 'task-c', timestampMs: 101, payload: {} },
      { seq: 2, type: 'claimed', taskPda: 'task-c', timestampMs: 102, payload: {} },
      {
        seq: 3,
        type: 'policy_violation',
        taskPda: 'task-c',
        timestampMs: 103,
        payload: { code: 'risk_threshold_exceeded' },
      },
      {
        seq: 4,
        type: 'speculation_aborted',
        taskPda: 'task-c',
        timestampMs: 104,
        payload: { reason: 'parent_failed' },
      },
      {
        seq: 5,
        type: 'escalated',
        taskPda: 'task-c',
        timestampMs: 105,
        payload: { reason: 'verifier_failed' },
      },
    ]);

    const result = new TrajectoryReplayEngine({ strictMode: false }).replay(trace);
    expect(result.summary.policyViolations).toBe(1);
    expect(result.summary.speculationAborts).toBe(1);
    expect(result.summary.escalatedTasks).toBe(1);
    expect(result.tasks['task-c'].status).toBe('escalated');
  });

  it('migrates legacy traces during replay', () => {
    const legacy = {
      traceId: 'legacy-trace',
      createdAtMs: 10,
      events: [
        {
          type: 'claimed',
          taskPda: 'task-legacy',
          timestampMs: 11,
          payload: {},
        },
      ],
    };

    const result = new TrajectoryReplayEngine().replay(legacy);
    expect(result.trace.schemaVersion).toBe(EVAL_TRACE_SCHEMA_VERSION);
    expect(result.trace.events[0].seq).toBe(1);
  });
});
