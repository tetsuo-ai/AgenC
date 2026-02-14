import { PublicKey } from '@solana/web3.js';
import { computeProjectionHash, type ReplayTimelineRecord } from '../../src/replay/types.js';
import type { BackfillFetcherPage, ProjectedTimelineInput } from '../../src/replay/types.js';

function pubkey(seed: number): PublicKey {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return new PublicKey(buf);
}

function bytes(seed = 0, length = 32): Uint8Array {
  const buf = new Uint8Array(length);
  buf.fill(seed);
  return buf;
}

function event(slot: number, signature: string, eventName: string): ProjectedTimelineInput {
  return {
    slot,
    signature,
    eventName,
    event: {
      taskId: bytes(slot),
      creator: pubkey(slot),
      requiredCapabilities: 1n,
      rewardAmount: 1n,
      taskType: 0,
      deadline: 0,
      minReputation: 0,
      rewardMint: null,
      timestamp: slot * 100,
    },
    timestampMs: slot * 100,
  };
}

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
    sourceEventName: type === 'discovered' ? 'taskCreated' : 'taskClaimed',
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

export const REPLAY_CHAOS_STORE_FIXTURE = {
  records: [
    makeRecord(1, 'discovered', 1, 'SIG_1'),
    makeRecord(2, 'claimed', 2, 'SIG_2'),
  ],
  writeFailurePages: [
    {
      events: [event(1, 'SIG_1', 'taskCreated')],
      nextCursor: { slot: 1, signature: 'SIG_1', eventName: 'taskCreated' },
      done: false,
    },
    {
      events: [event(2, 'SIG_2', 'taskCreated')],
      nextCursor: { slot: 2, signature: 'SIG_2', eventName: 'taskCreated' },
      done: false,
    },
    {
      events: [event(3, 'SIG_3', 'taskCreated')],
      nextCursor: null,
      done: true,
    },
  ] satisfies BackfillFetcherPage[],
} as const;

