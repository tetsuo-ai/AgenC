import { describe, expect, it } from 'vitest';
import { TrajectoryReplayEngine } from '../src/eval/replay.js';
import { projectOnChainEvents } from '../src/eval/projector.js';
import { CHAOS_SCENARIOS } from '../src/eval/chaos-matrix.js';
import { REPLAY_CHAOS_FIXTURE } from './fixtures/replay-chaos-fixture.ts';

function eventSignature(result: ReturnType<typeof projectOnChainEvents>): string {
  return result.trace.events
    .map((entry) => `${entry.type}:${entry.taskPda ?? 'na'}:${entry.signature}`)
    .join('|');
}

describe('chaotic replay projection pipeline', () => {
  it('exposes a stable chaos scenario matrix', () => {
    expect(CHAOS_SCENARIOS.length).toBeGreaterThanOrEqual(12);
    const ids = CHAOS_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CHAOS_SCENARIOS.some((scenario) => scenario.category === 'partial_write')).toBe(true);
  });

  it('remains deterministic for out-of-order and duplicated chaos streams in lenient mode', () => {
    const shuffled = [...REPLAY_CHAOS_FIXTURE.onChainEvents].sort((left, right) => {
      if (left.slot !== right.slot) {
        return left.slot - right.slot;
      }
      return left.signature.localeCompare(right.signature);
    });

    const result = projectOnChainEvents(
      shuffled,
      {
        traceId: REPLAY_CHAOS_FIXTURE.traceId,
        seed: REPLAY_CHAOS_FIXTURE.seed,
      },
    );
    const replayHash = new TrajectoryReplayEngine().replay(result.trace).deterministicHash;

    expect(result.events.map((entry) => entry.type)).toEqual([
      ...REPLAY_CHAOS_FIXTURE.expected.lenientEventTypes,
    ]);
    expect(result.events).toHaveLength(REPLAY_CHAOS_FIXTURE.expected.lenientProjectedCount);
    expect(result.telemetry.projectedEvents).toBe(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.projectedEvents);
    expect(result.telemetry.duplicatesDropped).toBe(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.duplicatesDropped);
    expect(result.telemetry.unknownEvents).toEqual([REPLAY_CHAOS_FIXTURE.onChainEvents.find((entry) => entry.eventName === 'unknownEventFromProgram')?.eventName]);
    expect(result.telemetry.malformedInputs.length).toBe(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.malformedInputs);
    expect(result.telemetry.transitionConflicts).toHaveLength(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.transitionConflicts);
    expect(result.telemetry.transitionViolations).toHaveLength(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.transitionViolations);
    expect(result.telemetry.unknownEvents).toHaveLength(REPLAY_CHAOS_FIXTURE.expected.lenientTelemetry.unknownEvents);
    expect(replayHash).toBe(REPLAY_CHAOS_FIXTURE.expected.lenientEventFingerprint);
    expect(eventSignature(result)).toMatchSnapshot();
  });

  it('detects same chaos signatures deterministically in strict mode', () => {
    expect(() =>
      projectOnChainEvents(REPLAY_CHAOS_FIXTURE.onChainEvents, {
        traceId: REPLAY_CHAOS_FIXTURE.traceId,
        seed: REPLAY_CHAOS_FIXTURE.seed,
        strictProjection: true,
      })
    ).toThrowError(new RegExp(REPLAY_CHAOS_FIXTURE.expected.strictThrowMessage));
  });

  it('handles dropped middle events without breaking deterministic output shape', () => {
    const droppedClaimInput = REPLAY_CHAOS_FIXTURE.onChainEvents.filter((entry) => entry.eventName !== 'taskClaimed');
    const first = projectOnChainEvents(droppedClaimInput, {
      traceId: 'replay-dropped-claim',
      seed: REPLAY_CHAOS_FIXTURE.seed,
    });
    const second = projectOnChainEvents(droppedClaimInput, {
      traceId: 'replay-dropped-claim',
      seed: REPLAY_CHAOS_FIXTURE.seed,
    });

    expect(first.events.map((entry) => entry.type)).toEqual([
      ...REPLAY_CHAOS_FIXTURE.expected.droppedClaimedEventTypes,
    ]);
    expect(first.telemetry.projectedEvents)
      .toBe(REPLAY_CHAOS_FIXTURE.expected.droppedClaimedTelemetry.projectedEvents);
    expect(first.telemetry.duplicatesDropped)
      .toBe(REPLAY_CHAOS_FIXTURE.expected.droppedClaimedTelemetry.duplicatesDropped);
    expect(first.telemetry.transitionConflicts).toHaveLength(
      REPLAY_CHAOS_FIXTURE.expected.droppedClaimedTelemetry.transitionConflicts
    );
    expect(first.telemetry.transitionViolations).toHaveLength(
      REPLAY_CHAOS_FIXTURE.expected.droppedClaimedTelemetry.transitionViolations
    );
    expect(first.telemetry.unknownEvents).toHaveLength(
      REPLAY_CHAOS_FIXTURE.expected.droppedClaimedTelemetry.unknownEvents
    );
    expect(new TrajectoryReplayEngine().replay(first.trace).deterministicHash).toBe(
      REPLAY_CHAOS_FIXTURE.expected.droppedClaimedEventFingerprint,
    );
    expect(second.telemetry).toEqual(first.telemetry);
    expect(eventSignature(first)).toMatchSnapshot();

    expect(() => projectOnChainEvents(droppedClaimInput, {
      traceId: 'replay-dropped-claim',
      seed: REPLAY_CHAOS_FIXTURE.seed,
      strictProjection: true,
    })).toThrowError(/Replay projection strict mode failed/);
  });

  it('flags speculative lifecycle bursts consistently across repeated runs', () => {
    const burstInput = [
      {
        eventName: 'speculativeCommitmentCreated',
        slot: 200,
        signature: 'SIG_BURST_START',
        event: {
          commitment: new Uint8Array(32).fill(3),
          task: new Uint8Array(32).fill(10),
          amount: 1_000n,
          disputeId: new Uint8Array(32).fill(20),
          timestamp: 200,
        },
      },
      {
        eventName: 'bondReleased',
        slot: 201,
        signature: 'SIG_BURST_CONFIRM',
        event: {
          taskId: new Uint8Array(32).fill(10),
          commitment: new Uint8Array(32).fill(3),
          slasher: new Uint8Array(32).fill(20),
          amount: 1_000n,
          timestamp: 201,
        },
      },
      {
        eventName: 'bondReleased',
        slot: 202,
        signature: 'SIG_BURST_CONFIRM_DUP',
        event: {
          taskId: new Uint8Array(32).fill(10),
          commitment: new Uint8Array(32).fill(3),
          slasher: new Uint8Array(32).fill(20),
          amount: 1_000n,
          timestamp: 202,
        },
      },
      {
        eventName: 'bondSlashed',
        slot: 203,
        signature: 'SIG_BURST_ABORT',
        event: {
          taskId: new Uint8Array(32).fill(10),
          commitment: new Uint8Array(32).fill(3),
          slasher: new Uint8Array(32).fill(20),
          amount: 1_000n,
          timestamp: 203,
        },
      },
    ];

    const first = projectOnChainEvents(burstInput, { traceId: 'chaos-burst', seed: 3_311 });
    const second = projectOnChainEvents(burstInput, { traceId: 'chaos-burst', seed: 3_311 });

    expect(first.telemetry.transitionViolations).toHaveLength(3);
    expect(second.telemetry.transitionViolations).toHaveLength(3);
    expect(first.telemetry.transitionConflicts).toEqual(second.telemetry.transitionConflicts);
    expect(new TrajectoryReplayEngine().replay(first.trace).deterministicHash)
      .toBe(new TrajectoryReplayEngine().replay(second.trace).deterministicHash);
  });
});
