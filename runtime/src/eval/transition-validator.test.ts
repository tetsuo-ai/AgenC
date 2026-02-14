import { describe, expect, it } from 'vitest';
import { projectOnChainEvents } from './projector.js';
import { ANOMALY_CODES, validateTransition } from './transition-validator.js';

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
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'SIG_CLAIM',
        event: {
          taskId,
          worker: bytes(6),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 10,
        },
      },
      {
        eventName: 'disputeInitiated',
        slot: 3,
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
        slot: 4,
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
        slot: 5,
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
      anomalyCode: ANOMALY_CODES.TASK_TERMINAL_TRANSITION,
    });
  });
});

describe('anomaly codes (#959)', () => {
  it('assigns TASK_DOUBLE_COMPLETE when completed task receives completion event', () => {
    const taskId = bytes(20);
    const result = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'SIG_DC1',
        event: { taskId, creator: bytes(2), requiredCapabilities: 1n, rewardAmount: 1n, taskType: 0, deadline: 0, minReputation: 0, rewardMint: null, timestamp: 10 },
      },
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'SIG_DC2',
        event: { taskId, worker: bytes(3), currentWorkers: 1, maxWorkers: 1, timestamp: 11 },
      },
      {
        eventName: 'taskCompleted',
        slot: 3,
        signature: 'SIG_DC3',
        event: { taskId, worker: bytes(3), proofHash: bytes(4, 32), resultData: bytes(5, 64), rewardPaid: 1n, timestamp: 12 },
      },
      {
        eventName: 'taskCompleted',
        slot: 4,
        signature: 'SIG_DC4',
        event: { taskId, worker: bytes(3), proofHash: bytes(4, 32), resultData: bytes(5, 64), rewardPaid: 1n, timestamp: 13 },
      },
    ], { traceId: 'double-complete' });

    expect(result.telemetry.transitionViolations).toHaveLength(1);
    expect(result.telemetry.transitionViolations[0]?.anomalyCode).toBe(ANOMALY_CODES.TASK_DOUBLE_COMPLETE);
  });

  it('assigns TASK_TERMINAL_TRANSITION for any edge leaving completed state', () => {
    const taskId = bytes(21);
    const result = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'SIG_TT1',
        event: { taskId, creator: bytes(2), requiredCapabilities: 1n, rewardAmount: 1n, taskType: 0, deadline: 0, minReputation: 0, rewardMint: null, timestamp: 10 },
      },
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'SIG_TT2',
        event: { taskId, worker: bytes(3), currentWorkers: 1, maxWorkers: 1, timestamp: 11 },
      },
      {
        eventName: 'taskCompleted',
        slot: 3,
        signature: 'SIG_TT3',
        event: { taskId, worker: bytes(3), proofHash: bytes(4, 32), resultData: bytes(5, 64), rewardPaid: 1n, timestamp: 12 },
      },
      {
        eventName: 'taskClaimed',
        slot: 4,
        signature: 'SIG_TT4',
        event: { taskId, worker: bytes(6), currentWorkers: 2, maxWorkers: 2, timestamp: 13 },
      },
    ], { traceId: 'terminal-transition' });

    expect(result.telemetry.transitionViolations).toHaveLength(1);
    expect(result.telemetry.transitionViolations[0]?.anomalyCode).toBe(ANOMALY_CODES.TASK_TERMINAL_TRANSITION);
  });

  it('assigns DISPUTE_INVALID_START for vote without initiation', () => {
    const disputeId = bytes(22);
    const result = projectOnChainEvents([
      {
        eventName: 'disputeVoteCast',
        slot: 1,
        signature: 'SIG_DIS1',
        event: { disputeId, voter: bytes(8), approved: true, votesFor: 1n, votesAgainst: 0n, timestamp: 10 },
      },
    ], { traceId: 'dispute-invalid-start' });

    expect(result.telemetry.transitionViolations).toHaveLength(1);
    expect(result.telemetry.transitionViolations[0]?.anomalyCode).toBe(ANOMALY_CODES.DISPUTE_INVALID_START);
  });

  it('tracks task disputed state from disputeInitiated event', () => {
    const taskId = bytes(23);
    const disputeId = bytes(24);
    const result = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 1,
        signature: 'SIG_TD1',
        event: { taskId, creator: bytes(2), requiredCapabilities: 1n, rewardAmount: 1n, taskType: 0, deadline: 0, minReputation: 0, rewardMint: null, timestamp: 10 },
      },
      {
        eventName: 'taskClaimed',
        slot: 2,
        signature: 'SIG_TD2',
        event: { taskId, worker: bytes(3), currentWorkers: 1, maxWorkers: 1, timestamp: 11 },
      },
      {
        eventName: 'disputeInitiated',
        slot: 3,
        signature: 'SIG_TD3',
        event: { disputeId, taskId, initiator: bytes(6), defendant: bytes(7), resolutionType: 0, votingDeadline: 100, timestamp: 12 },
      },
    ], { traceId: 'task-disputed' });

    // No violations: claimed -> disputed is valid
    expect(result.telemetry.transitionViolations).toHaveLength(0);
  });
});
