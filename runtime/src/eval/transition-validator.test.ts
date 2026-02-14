import { describe, expect, it } from 'vitest';
import { projectOnChainEvents } from './projector.js';
import {
  ANOMALY_CODES,
  validateTransition,
  OnChainTaskStatus,
  OnChainDisputeStatus,
  ON_CHAIN_TASK_TRANSITIONS,
  ON_CHAIN_DISPUTE_TRANSITIONS,
  EVENT_TO_TASK_STATUS,
  EVENT_TO_DISPUTE_STATUS,
  TransitionValidator,
  type TransitionValidationViolation,
} from './transition-validator.js';

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

describe('on-chain transition matrices (#966)', () => {
  it('task transition matrix matches on-chain TaskStatus::can_transition_to', () => {
    const open = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.Open];
    expect(open.has(OnChainTaskStatus.InProgress)).toBe(true);
    expect(open.has(OnChainTaskStatus.Cancelled)).toBe(true);
    expect(open.size).toBe(2);

    const inProgress = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.InProgress];
    expect(inProgress.has(OnChainTaskStatus.InProgress)).toBe(true);
    expect(inProgress.has(OnChainTaskStatus.Completed)).toBe(true);
    expect(inProgress.has(OnChainTaskStatus.Cancelled)).toBe(true);
    expect(inProgress.has(OnChainTaskStatus.Disputed)).toBe(true);
    expect(inProgress.has(OnChainTaskStatus.PendingValidation)).toBe(true);
    expect(inProgress.size).toBe(5);

    const pendingValidation = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.PendingValidation];
    expect(pendingValidation.has(OnChainTaskStatus.Completed)).toBe(true);
    expect(pendingValidation.has(OnChainTaskStatus.Disputed)).toBe(true);
    expect(pendingValidation.size).toBe(2);

    const completed = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.Completed];
    expect(completed.size).toBe(0);

    const cancelled = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.Cancelled];
    expect(cancelled.size).toBe(0);

    const disputed = ON_CHAIN_TASK_TRANSITIONS[OnChainTaskStatus.Disputed];
    expect(disputed.has(OnChainTaskStatus.Completed)).toBe(true);
    expect(disputed.has(OnChainTaskStatus.Cancelled)).toBe(true);
    expect(disputed.size).toBe(2);
  });

  it('dispute transition matrix covers all terminal states', () => {
    const active = ON_CHAIN_DISPUTE_TRANSITIONS[OnChainDisputeStatus.Active];
    expect(active.has(OnChainDisputeStatus.Resolved)).toBe(true);
    expect(active.has(OnChainDisputeStatus.Expired)).toBe(true);
    expect(active.has(OnChainDisputeStatus.Cancelled)).toBe(true);
    expect(active.size).toBe(3);

    expect(ON_CHAIN_DISPUTE_TRANSITIONS[OnChainDisputeStatus.Resolved].size).toBe(0);
    expect(ON_CHAIN_DISPUTE_TRANSITIONS[OnChainDisputeStatus.Expired].size).toBe(0);
    expect(ON_CHAIN_DISPUTE_TRANSITIONS[OnChainDisputeStatus.Cancelled].size).toBe(0);
  });

  it('event-to-status mappings cover expected events', () => {
    expect(EVENT_TO_TASK_STATUS.taskCreated).toBe(OnChainTaskStatus.Open);
    expect(EVENT_TO_TASK_STATUS.taskClaimed).toBe(OnChainTaskStatus.InProgress);
    expect(EVENT_TO_TASK_STATUS.taskCompleted).toBe(OnChainTaskStatus.Completed);
    expect(EVENT_TO_TASK_STATUS.taskCancelled).toBe(OnChainTaskStatus.Cancelled);

    expect(EVENT_TO_DISPUTE_STATUS.disputeInitiated).toBe(OnChainDisputeStatus.Active);
    expect(EVENT_TO_DISPUTE_STATUS.disputeResolved).toBe(OnChainDisputeStatus.Resolved);
    expect(EVENT_TO_DISPUTE_STATUS.disputeExpired).toBe(OnChainDisputeStatus.Expired);
    expect(EVENT_TO_DISPUTE_STATUS.disputeCancelled).toBe(OnChainDisputeStatus.Cancelled);
  });
});

describe('negative transition corpus (#966)', () => {
  const INVALID_TASK_TRANSITIONS: Array<[OnChainTaskStatus, OnChainTaskStatus]> = [
    [OnChainTaskStatus.Completed, OnChainTaskStatus.Open],
    [OnChainTaskStatus.Completed, OnChainTaskStatus.InProgress],
    [OnChainTaskStatus.Completed, OnChainTaskStatus.Cancelled],
    [OnChainTaskStatus.Completed, OnChainTaskStatus.Disputed],
    [OnChainTaskStatus.Completed, OnChainTaskStatus.PendingValidation],
    [OnChainTaskStatus.Cancelled, OnChainTaskStatus.Open],
    [OnChainTaskStatus.Cancelled, OnChainTaskStatus.InProgress],
    [OnChainTaskStatus.Cancelled, OnChainTaskStatus.Completed],
    [OnChainTaskStatus.Cancelled, OnChainTaskStatus.Disputed],
    [OnChainTaskStatus.Cancelled, OnChainTaskStatus.PendingValidation],
    [OnChainTaskStatus.Open, OnChainTaskStatus.Completed],
    [OnChainTaskStatus.Open, OnChainTaskStatus.Disputed],
    [OnChainTaskStatus.Open, OnChainTaskStatus.PendingValidation],
    [OnChainTaskStatus.PendingValidation, OnChainTaskStatus.Open],
    [OnChainTaskStatus.PendingValidation, OnChainTaskStatus.InProgress],
    [OnChainTaskStatus.PendingValidation, OnChainTaskStatus.Cancelled],
    [OnChainTaskStatus.Disputed, OnChainTaskStatus.Open],
    [OnChainTaskStatus.Disputed, OnChainTaskStatus.InProgress],
    [OnChainTaskStatus.Disputed, OnChainTaskStatus.PendingValidation],
  ];

  for (const [from, to] of INVALID_TASK_TRANSITIONS) {
    it(`rejects task ${OnChainTaskStatus[from]} -> ${OnChainTaskStatus[to]}`, () => {
      const allowed = ON_CHAIN_TASK_TRANSITIONS[from];
      expect(allowed.has(to)).toBe(false);
    });
  }

  const INVALID_DISPUTE_TRANSITIONS: Array<[OnChainDisputeStatus, OnChainDisputeStatus]> = [
    [OnChainDisputeStatus.Resolved, OnChainDisputeStatus.Active],
    [OnChainDisputeStatus.Resolved, OnChainDisputeStatus.Expired],
    [OnChainDisputeStatus.Resolved, OnChainDisputeStatus.Cancelled],
    [OnChainDisputeStatus.Expired, OnChainDisputeStatus.Active],
    [OnChainDisputeStatus.Expired, OnChainDisputeStatus.Resolved],
    [OnChainDisputeStatus.Expired, OnChainDisputeStatus.Cancelled],
    [OnChainDisputeStatus.Cancelled, OnChainDisputeStatus.Active],
    [OnChainDisputeStatus.Cancelled, OnChainDisputeStatus.Resolved],
    [OnChainDisputeStatus.Cancelled, OnChainDisputeStatus.Expired],
  ];

  for (const [from, to] of INVALID_DISPUTE_TRANSITIONS) {
    it(`rejects dispute ${OnChainDisputeStatus[from]} -> ${OnChainDisputeStatus[to]}`, () => {
      const allowed = ON_CHAIN_DISPUTE_TRANSITIONS[from];
      expect(allowed.has(to)).toBe(false);
    });
  }
});

describe('TransitionValidator class (#966)', () => {
  const TASK_TRANSITIONS: Record<string, ReadonlySet<string>> = {
    discovered: new Set(['claimed', 'failed']),
    claimed: new Set(['completed', 'failed', 'disputed']),
    completed: new Set([]),
    failed: new Set([]),
    disputed: new Set(['completed', 'failed']),
  };
  const TASK_START_EVENTS = new Set<string>(['discovered']);

  const DISPUTE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
    'dispute:initiated': new Set(['dispute:vote_cast', 'dispute:resolved', 'dispute:expired', 'dispute:cancelled']),
    'dispute:vote_cast': new Set(['dispute:vote_cast', 'dispute:resolved', 'dispute:expired']),
    'dispute:resolved': new Set([]),
    'dispute:expired': new Set([]),
    'dispute:cancelled': new Set([]),
  };
  const DISPUTE_START_EVENTS = new Set<string>(['dispute:initiated']);

  it('accepts valid on-chain task lifecycle (Open -> InProgress -> Completed)', () => {
    const validator = new TransitionValidator();
    const r1 = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_1', slot: 1, sourceEventSequence: 0,
    });
    expect(r1.valid).toBe(true);

    const r2 = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'discovered', nextState: 'claimed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_2', slot: 2, sourceEventSequence: 1,
    });
    expect(r2.valid).toBe(true);

    const r3 = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCompleted', eventType: 'completed',
      previousState: 'claimed', nextState: 'completed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_3', slot: 3, sourceEventSequence: 2,
    });
    expect(r3.valid).toBe(true);
  });

  it('rejects impossible on-chain task transition (Completed -> InProgress)', () => {
    const validator = new TransitionValidator();
    // Walk task to Completed
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_1', slot: 1, sourceEventSequence: 0,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'discovered', nextState: 'claimed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_2', slot: 2, sourceEventSequence: 1,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCompleted', eventType: 'completed',
      previousState: 'claimed', nextState: 'completed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_3', slot: 3, sourceEventSequence: 2,
    });

    // Attempt Completed -> InProgress (taskClaimed after completed)
    const result = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'completed', nextState: 'claimed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_BAD', slot: 10, sourceEventSequence: 3,
    });
    // Replay-level validation catches this first (terminal state)
    expect(result.valid).toBe(false);
    expect(result.violation).toBeDefined();
  });

  it('catches on-chain violation even when replay lifecycle allows it', () => {
    // Use permissive replay transitions but strict on-chain
    const permissiveTransitions: Record<string, ReadonlySet<string>> = {
      discovered: new Set(['claimed', 'completed', 'failed']),
      claimed: new Set(['completed', 'claimed', 'discovered']),
      completed: new Set(['claimed']),  // replay allows completed -> claimed
    };
    const validator = new TransitionValidator();

    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: permissiveTransitions, allowedStarts: new Set(['discovered']),
      signature: 'SIG_1', slot: 1, sourceEventSequence: 0,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'discovered', nextState: 'claimed',
      transitions: permissiveTransitions, allowedStarts: new Set(['discovered']),
      signature: 'SIG_2', slot: 2, sourceEventSequence: 1,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCompleted', eventType: 'completed',
      previousState: 'claimed', nextState: 'completed',
      transitions: permissiveTransitions, allowedStarts: new Set(['discovered']),
      signature: 'SIG_3', slot: 3, sourceEventSequence: 2,
    });

    // Replay transitions allow completed -> claimed, but on-chain does not
    const result = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'completed', nextState: 'claimed',
      transitions: permissiveTransitions, allowedStarts: new Set(['discovered']),
      signature: 'SIG_4', slot: 4, sourceEventSequence: 3,
    });
    expect(result.valid).toBe(false);
    expect(result.violation!.reason).toContain('on-chain');
    expect(result.violation!.reason).toContain('Completed');
    expect(result.violation!.reason).toContain('InProgress');
  });

  it('rejects impossible on-chain dispute transition (Resolved -> Active)', () => {
    const validator = new TransitionValidator();

    validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeInitiated', eventType: 'dispute:initiated',
      previousState: undefined, nextState: 'dispute:initiated',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_D1', slot: 1, sourceEventSequence: 0,
    });
    validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeResolved', eventType: 'dispute:resolved',
      previousState: 'dispute:initiated', nextState: 'dispute:resolved',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_D2', slot: 2, sourceEventSequence: 1,
    });

    // Resolved -> Active is invalid
    const result = validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeInitiated', eventType: 'dispute:initiated',
      previousState: 'dispute:resolved', nextState: 'dispute:initiated',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_D3', slot: 3, sourceEventSequence: 2,
    });
    // Replay-level validation catches this (terminal state)
    expect(result.valid).toBe(false);
  });

  it('tracks independent entities separately', () => {
    const validator = new TransitionValidator();

    // Task T1 reaches Completed
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_1', slot: 1, sourceEventSequence: 0,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'discovered', nextState: 'claimed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_2', slot: 2, sourceEventSequence: 1,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCompleted', eventType: 'completed',
      previousState: 'claimed', nextState: 'completed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_3', slot: 3, sourceEventSequence: 2,
    });

    // Task T2 is independent and should still be valid
    const r = validator.validate({
      scope: 'task', entityId: 'T2', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_4', slot: 4, sourceEventSequence: 0,
    });
    expect(r.valid).toBe(true);
  });

  it('reset clears all tracked state', () => {
    const validator = new TransitionValidator();

    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_1', slot: 1, sourceEventSequence: 0,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskClaimed', eventType: 'claimed',
      previousState: 'discovered', nextState: 'claimed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_2', slot: 2, sourceEventSequence: 1,
    });
    validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCompleted', eventType: 'completed',
      previousState: 'claimed', nextState: 'completed',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_3', slot: 3, sourceEventSequence: 2,
    });

    validator.reset();

    // After reset, T1 should be treated as new — taskCreated valid again
    const result = validator.validate({
      scope: 'task', entityId: 'T1', eventName: 'taskCreated', eventType: 'discovered',
      previousState: undefined, nextState: 'discovered',
      transitions: TASK_TRANSITIONS, allowedStarts: TASK_START_EVENTS,
      signature: 'SIG_4', slot: 10, sourceEventSequence: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('toAnomaly produces structured anomaly payload', () => {
    const violation: TransitionValidationViolation = {
      scope: 'task',
      entityId: 'T1',
      eventName: 'taskClaimed',
      eventType: 'claimed',
      fromState: 'Completed',
      toState: 'InProgress',
      reason: 'on-chain: Completed -> InProgress',
      signature: 'SIG_X',
      slot: 42,
      sourceEventSequence: 3,
      anomalyCode: ANOMALY_CODES.UNKNOWN_TRANSITION,
    };

    const validator = new TransitionValidator();
    const anomaly = validator.toAnomaly(violation, { taskPda: 'TASK_PDA_1' });

    expect(anomaly.type).toBe('transition_invalid');
    expect(anomaly.scope).toBe('task');
    expect(anomaly.from).toBe('Completed');
    expect(anomaly.to).toBe('InProgress');
    expect(anomaly.reason).toBe('on-chain: Completed -> InProgress');
    expect(anomaly.taskPda).toBe('TASK_PDA_1');
    expect(anomaly.disputePda).toBeUndefined();
    expect(anomaly.entityId).toBe('T1');
    expect(anomaly.slot).toBe(42);
    expect(anomaly.signature).toBe('SIG_X');
    expect(anomaly.sourceEventSequence).toBe(3);
    expect(anomaly.eventName).toBe('taskClaimed');
  });

  it('toAnomaly includes dispute PDA context', () => {
    const violation: TransitionValidationViolation = {
      scope: 'dispute',
      entityId: 'D1',
      eventName: 'disputeInitiated',
      eventType: 'dispute:initiated',
      fromState: 'Resolved',
      toState: 'Active',
      reason: 'on-chain: Resolved -> Active',
      signature: 'SIG_Y',
      slot: 55,
      sourceEventSequence: 1,
      anomalyCode: ANOMALY_CODES.UNKNOWN_TRANSITION,
    };

    const validator = new TransitionValidator();
    const anomaly = validator.toAnomaly(violation, { disputePda: 'DISPUTE_PDA_1' });

    expect(anomaly.scope).toBe('dispute');
    expect(anomaly.disputePda).toBe('DISPUTE_PDA_1');
    expect(anomaly.taskPda).toBeUndefined();
  });

  it('events without on-chain mapping skip on-chain check entirely', () => {
    const validator = new TransitionValidator();

    // Set up a valid dispute lifecycle
    validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeInitiated', eventType: 'dispute:initiated',
      previousState: undefined, nextState: 'dispute:initiated',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_D1', slot: 1, sourceEventSequence: 0,
    });

    // disputeVoteCast has no EVENT_TO_DISPUTE_STATUS mapping
    // It should pass on-chain check (skipped) and pass replay check (valid transition)
    const r = validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeVoteCast', eventType: 'dispute:vote_cast',
      previousState: 'dispute:initiated', nextState: 'dispute:vote_cast',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_V', slot: 5, sourceEventSequence: 1,
    });
    expect(r.valid).toBe(true);
  });

  it('unmapped events pass on-chain validation when replay lifecycle is valid', () => {
    const validator = new TransitionValidator();

    // First set up a valid dispute start
    validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeInitiated', eventType: 'dispute:initiated',
      previousState: undefined, nextState: 'dispute:initiated',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_D1', slot: 1, sourceEventSequence: 0,
    });

    // disputeVoteCast has no on-chain mapping — should pass if replay allows it
    const r = validator.validate({
      scope: 'dispute', entityId: 'D1', eventName: 'disputeVoteCast', eventType: 'dispute:vote_cast',
      previousState: 'dispute:initiated', nextState: 'dispute:vote_cast',
      transitions: DISPUTE_TRANSITIONS, allowedStarts: DISPUTE_START_EVENTS,
      signature: 'SIG_V', slot: 5, sourceEventSequence: 1,
    });
    expect(r.valid).toBe(true);
  });
});
