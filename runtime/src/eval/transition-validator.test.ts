import { describe, expect, it } from 'vitest';
import { projectOnChainEvents } from './projector.js';
import { validateTransition } from './transition-validator.js';

function bytes(seed: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, () => seed);
}

describe('transition validator', () => {
  it('accepts valid task lifecycle progressions', () => {
    const taskId = bytes(1);
    const events = [
      {
        eventName: 'taskCreated' as const,
        slot: 1,
        signature: 'SIG_A',
        event: {
          taskId,
          creator: bytes(2),
          requiredCapabilities: 1n,
          rewardAmount: 1n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 10,
        },
      },
      {
        eventName: 'taskClaimed' as const,
        slot: 2,
        signature: 'SIG_B',
        event: {
          taskId,
          worker: bytes(3),
          currentWorkers: 1,
          maxWorkers: 2,
          timestamp: 11,
        },
      },
      {
        eventName: 'taskCompleted' as const,
        slot: 3,
        signature: 'SIG_C',
        event: {
          taskId,
          worker: bytes(3),
          proofHash: bytes(4, 32),
          resultData: bytes(5, 64),
          rewardPaid: 7n,
          timestamp: 12,
        },
      },
    ];

    const result = projectOnChainEvents(events, { traceId: 'valid-task' });
    expect(result.telemetry.transitionViolations).toEqual([]);
  });

  it('flags deterministic invalid task transition graph edges', () => {
    const taskId = bytes(2);
    const result = projectOnChainEvents([
      {
        eventName: 'taskCompleted',
        slot: 1,
        signature: 'SIG_BAD',
        event: {
          taskId,
          worker: bytes(3),
          proofHash: bytes(4, 32),
          resultData: bytes(5, 64),
          rewardPaid: 1n,
          timestamp: 10,
        },
      },
    ], { traceId: 'bad-task' });

    expect(result.telemetry.transitionViolations).toHaveLength(1);
    const violation = result.telemetry.transitionViolations[0];
    expect(violation?.scope).toBe('task');
    expect(violation?.fromState).toBeUndefined();
    expect(violation?.toState).toBe('completed');
  });

  it('accepts valid dispute transitions and flags invalid branches', () => {
    const disputeId = bytes(4);
    const taskId = bytes(5);
    const task = {
      taskId,
      creator: bytes(3),
      requiredCapabilities: 1n,
      rewardAmount: 1n,
      taskType: 0,
      deadline: 0,
      minReputation: 0,
      rewardMint: null,
      timestamp: 10,
    };

    const valid = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'SIG_TASK',
        event: task,
      },
      {
        eventName: 'disputeInitiated',
        slot: 2,
        signature: 'SIG_DISPUTE',
        event: {
          disputeId,
          taskId,
          initiator: bytes(6),
          defendant: bytes(7),
          resolutionType: 0,
          votingDeadline: 100,
          timestamp: 11,
        },
      },
      {
        eventName: 'disputeVoteCast',
        slot: 3,
        signature: 'SIG_VOTE',
        event: {
          disputeId,
          voter: bytes(8),
          approved: true,
          votesFor: 1n,
          votesAgainst: 0n,
          timestamp: 12,
        },
      },
      {
        eventName: 'disputeResolved',
        slot: 4,
        signature: 'SIG_RESOLVE',
        event: {
          disputeId,
          taskId,
          approver: bytes(9),
          timestamp: 13,
        },
      },
    ], { traceId: 'valid-dispute' });

    expect(valid.telemetry.transitionViolations).toHaveLength(0);

    const invalid = projectOnChainEvents([
      {
        eventName: 'disputeVoteCast',
        slot: 10,
        signature: 'SIG_INVALID',
        event: {
          disputeId,
          voter: bytes(8),
          approved: true,
          votesFor: 1n,
          votesAgainst: 0n,
          timestamp: 14,
        },
      },
    ], { traceId: 'invalid-dispute' });

    expect(invalid.telemetry.transitionViolations).toHaveLength(1);
    expect(invalid.telemetry.transitionViolations[0]?.scope).toBe('dispute');
  });

  it('supports strict projection mode and throws on impossible transitions', () => {
    const taskId = bytes(10);
    expect(() => projectOnChainEvents([
      {
        eventName: 'taskCompleted',
        slot: 5,
        signature: 'SIG_STRICT',
        event: {
          taskId,
          worker: bytes(11),
          proofHash: bytes(4, 32),
          resultData: bytes(5, 64),
          rewardPaid: 7n,
          timestamp: 12,
        },
      },
    ], { traceId: 'strict', strictProjection: true }))
      .toThrowError(/Replay projection strict mode failed/);
  });
});

describe('validateTransition', () => {
  it('returns a deterministic violation for invalid transitions', () => {
    const violation = validateTransition({
      scope: 'task',
      entityId: 'task-1',
      eventName: 'taskCompleted',
      eventType: 'completed',
      previousState: 'completed',
      nextState: 'claimed',
      transitions: {
        discovered: new Set(['claimed', 'failed']),
        claimed: new Set(['completed', 'failed']),
        completed: new Set([]),
        failed: new Set([]),
      },
      allowedStarts: new Set(['discovered']),
      signature: 'SIG-1',
      slot: 9,
      sourceEventSequence: 7,
    });

    expect(violation).toMatchObject({
      scope: 'task',
      entityId: 'task-1',
      fromState: 'completed',
      toState: 'claimed',
      signature: 'SIG-1',
      slot: 9,
      sourceEventSequence: 7,
      reason: 'completed -> claimed',
    });
  });
});
