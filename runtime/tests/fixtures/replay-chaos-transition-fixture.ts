import { computeProjectionHash, type ReplayTimelineRecord } from '../../src/replay/types.js';
import { makeReplayTraceFromRecords } from '../../src/eval/replay-comparison.js';

function makeRecord(
  seq: number,
  type: string,
  slot: number,
  signature: string,
): ReplayTimelineRecord {
  const record = {
    seq,
    type,
    taskPda: 'task-1',
    timestampMs: slot * 10,
    payload: { value: seq, onchain: { signature, slot, eventType: type } },
    slot,
    signature,
    sourceEventName: type === 'discovered'
      ? 'taskCreated'
      : type === 'claimed'
        ? 'taskClaimed'
        : type === 'completed'
          ? 'taskCompleted'
          : type === 'failed'
            ? 'taskCancelled'
            : 'disputeInitiated',
    sourceEventSequence: seq - 1,
    sourceEventType: type,
    disputePda: undefined,
  } as Omit<ReplayTimelineRecord, 'projectionHash'>;

  return {
    ...record,
    projectionHash: computeProjectionHash({
      seq: record.seq,
      type: record.type,
      taskPda: record.taskPda,
      timestampMs: record.timestampMs,
      payload: record.payload,
      slot: record.slot,
      signature: record.signature,
      sourceEventName: record.sourceEventName,
      sourceEventSequence: record.sourceEventSequence,
    }),
  };
}

const INVALID_OPEN_TO_COMPLETED = [
  makeRecord(1, 'discovered', 1, 'SIG_1'),
  makeRecord(2, 'completed', 2, 'SIG_2'),
];

const DISPUTE_ON_CANCELLED = [
  makeRecord(1, 'discovered', 1, 'SIG_1'),
  makeRecord(2, 'failed', 2, 'SIG_2'),
  makeRecord(3, 'dispute:initiated', 3, 'SIG_3'),
];

const DOUBLE_COMPLETION_BASE = [
  makeRecord(1, 'discovered', 1, 'SIG_1'),
  makeRecord(2, 'completed', 2, 'SIG_2'),
];

export const REPLAY_CHAOS_TRANSITION_FIXTURE = {
  seed: 4242,
  scenarios: {
    invalidOpenToCompleted: {
      projected: INVALID_OPEN_TO_COMPLETED,
      localTrace: makeReplayTraceFromRecords(INVALID_OPEN_TO_COMPLETED, 4242, 'chaos-transition-open'),
    },
    disputeOnCancelled: {
      projected: DISPUTE_ON_CANCELLED,
      localTrace: makeReplayTraceFromRecords(DISPUTE_ON_CANCELLED, 4242, 'chaos-transition-dispute'),
    },
    doubleCompletion: {
      projected: [
        DOUBLE_COMPLETION_BASE[0]!,
        DOUBLE_COMPLETION_BASE[1]!,
        { ...DOUBLE_COMPLETION_BASE[1]!, signature: 'SIG_2_DUP' },
      ],
      localTrace: makeReplayTraceFromRecords(DOUBLE_COMPLETION_BASE, 4242, 'chaos-transition-dup'),
    },
  },
} as const;

