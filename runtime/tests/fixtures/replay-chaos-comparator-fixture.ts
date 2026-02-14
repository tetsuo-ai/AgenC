import { computeProjectionHash, type ReplayTimelineRecord } from '../../src/replay/types.js';
import { makeReplayTraceFromRecords } from '../../src/eval/replay-comparison.js';

function makeRecord(
  seq: number,
  type: string,
  slot: number,
  signature: string,
): ReplayTimelineRecord {
  const event = {
    seq,
    type,
    taskPda: 'task-1',
    timestampMs: slot * 10,
    payload: {
      value: seq,
      onchain: {
        signature,
        slot,
        eventType: type,
      },
    },
    slot,
    signature,
    sourceEventName: type === 'discovered' ? 'taskCreated' : 'taskClaimed',
    sourceEventSequence: seq - 1,
    sourceEventType: type,
    disputePda: undefined,
  } as Omit<ReplayTimelineRecord, 'projectionHash'>;

  return {
    ...event,
    projectionHash: computeProjectionHash({
      seq: event.seq,
      type: event.type,
      taskPda: event.taskPda,
      timestampMs: event.timestampMs,
      payload: event.payload,
      slot: event.slot,
      signature: event.signature,
      sourceEventName: event.sourceEventName,
      sourceEventSequence: event.sourceEventSequence,
    }),
  };
}

const BASE_PROJECTED: ReplayTimelineRecord[] = [
  makeRecord(1, 'discovered', 1, 'SIG_1'),
  makeRecord(2, 'claimed', 2, 'SIG_2'),
];

const BASE_LOCAL = makeReplayTraceFromRecords(BASE_PROJECTED, 1337, 'chaos-comparator-local');

const HASH_MISMATCH_PROJECTED = BASE_PROJECTED.map((record, index) => {
  if (index !== 0) {
    return record;
  }
  const tampered = {
    ...record,
    payload: {
      ...record.payload,
      tampered: true,
    },
  } as ReplayTimelineRecord;
  return {
    ...tampered,
    projectionHash: computeProjectionHash({
      seq: tampered.seq,
      type: tampered.type,
      taskPda: tampered.taskPda,
      timestampMs: tampered.timestampMs,
      payload: tampered.payload,
      slot: tampered.slot,
      signature: tampered.signature,
      sourceEventName: tampered.sourceEventName,
      sourceEventSequence: tampered.sourceEventSequence,
    }),
  };
});

export const REPLAY_CHAOS_COMPARATOR_FIXTURE = {
  traceId: 'replay-chaos-comparator-v1',
  seed: 1337,
  base: {
    projected: BASE_PROJECTED,
    localTrace: BASE_LOCAL,
  },
  scenarios: {
    hashMismatch: {
      projected: HASH_MISMATCH_PROJECTED,
      localTrace: BASE_LOCAL,
    },
    missingEvent: {
      projected: BASE_PROJECTED,
      localTrace: {
        ...BASE_LOCAL,
        events: BASE_LOCAL.events.filter((event) => event.seq !== 2),
      },
    },
    unexpectedEvent: {
      projected: BASE_PROJECTED,
      localTrace: {
        ...BASE_LOCAL,
        events: [
          ...BASE_LOCAL.events,
          {
            seq: 3,
            type: 'completed',
            taskPda: 'task-1',
            timestampMs: 30,
            payload: {
              value: 3,
              onchain: {
                signature: 'SIG_3',
                slot: 3,
                eventType: 'completed',
              },
            },
          },
        ],
      },
    },
    typeMismatch: {
      projected: BASE_PROJECTED,
      localTrace: {
        ...BASE_LOCAL,
        events: BASE_LOCAL.events.map((event) => event.seq === 2
          ? { ...event, type: 'failed' }
          : event),
      },
    },
  },
} as const;

