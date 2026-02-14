import { PublicKey } from '@solana/web3.js';
import type { BackfillFetcherPage, ProjectedTimelineInput, ReplayEventCursor } from '../../src/replay/types.js';

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

export const REPLAY_CHAOS_PARTIAL_WRITE_FIXTURE = {
  resumeAfterCrash: {
    firstPage: {
      events: [event(1, 'SIG_1', 'taskCreated'), event(2, 'SIG_2', 'taskClaimed')],
      nextCursor: { slot: 2, signature: 'SIG_2', eventName: 'taskClaimed' } satisfies ReplayEventCursor,
      done: false,
    },
    finalPage: {
      events: [event(3, 'SIG_3', 'taskCompleted')],
      nextCursor: null,
      done: true,
    },
  } satisfies Record<string, BackfillFetcherPage>,
  cursorStall: {
    stalledPage: {
      events: [],
      nextCursor: { slot: 9, signature: 'STALL', eventName: 'taskCreated' },
      done: false,
    },
  } satisfies Record<string, BackfillFetcherPage>,
} as const;

