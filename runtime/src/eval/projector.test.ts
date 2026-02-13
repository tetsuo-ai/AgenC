import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { projectOnChainEvents } from './projector.js';
import { TrajectoryReplayEngine } from './replay.js';

function pubkey(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
}

function bytes(seed = 0, length = 32): Uint8Array {
  const output = new Uint8Array(length);
  output.fill(seed);
  return output;
}

describe('on-chain event projection', () => {
  it('orders events by slot, signature, and sequence deterministically', () => {
    const events = [
      {
        eventName: 'taskCompleted',
        slot: 100,
        signature: 'ZZZ',
        timestampMs: 2_000,
        event: {
          taskId: bytes(9),
          worker: pubkey(2),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 123n,
          timestamp: 2_000,
        },
      },
      {
        eventName: 'taskCreated',
        slot: 10,
        signature: 'AAA',
        timestampMs: 1_000,
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
          requiredCapabilities: 100n,
          rewardAmount: 50_000n,
          taskType: 0,
          deadline: 5_000,
          minReputation: 1,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: 'taskClaimed',
        slot: 10,
        signature: 'AAA',
        timestampMs: 1_100,
        event: {
          taskId: bytes(1),
          worker: pubkey(4),
          currentWorkers: 1,
          maxWorkers: 5,
          timestamp: 1_100,
        },
      },
    ];

    const forward = projectOnChainEvents(events, { traceId: 'trace-1' });
    const backward = projectOnChainEvents([...events].reverse(), { traceId: 'trace-1' });

    expect(stableForward(forward)).toEqual(stableForward(backward));
    expect(forward.trace.events.map((entry) => entry.type)).toEqual(['discovered', 'claimed', 'completed']);
  });

  it('deduplicates repeated signature/name/payload tuples', () => {
    const event = {
      eventName: 'taskCreated',
      slot: 11,
      signature: 'SIG_DUP',
      timestampMs: 3_000,
      event: {
        taskId: bytes(3),
        creator: pubkey(9),
        requiredCapabilities: 1n,
        rewardAmount: 50n,
        taskType: 0,
        deadline: 20,
        minReputation: 0,
        rewardMint: null,
        timestamp: 3_000,
      },
    };

    const result = projectOnChainEvents([event, { ...event }, event], { traceId: 'dup-test' });

    expect(result.trace.events).toHaveLength(1);
    expect(result.telemetry.projectedEvents).toBe(1);
    expect(result.telemetry.duplicatesDropped).toBe(2);
  });

  it('captures unknown event names in telemetry and keeps processing', () => {
    const result = projectOnChainEvents([
      {
        eventName: 'unknownEventFromProgram',
        slot: 12,
        signature: 'SIG_UNKNOWN',
        timestampMs: 100,
        event: { value: 1 },
      },
    ]);

    expect(result.telemetry.unknownEvents).toEqual(['unknownEventFromProgram']);
    expect(result.telemetry.projectedEvents).toBe(0);
    expect(result.trace.events).toHaveLength(0);
  });

  it('records transition conflicts while still emitting trajectory events', () => {
    const result = projectOnChainEvents([
      {
        eventName: 'taskCompleted',
        slot: 15,
        signature: 'SIG_TASK',
        timestampMs: 300,
        event: {
          taskId: bytes(7),
          worker: pubkey(1),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 42n,
          timestamp: 300,
        },
      },
    ]);

    expect(result.trace.events).toHaveLength(1);
    expect(result.telemetry.transitionConflicts).toHaveLength(1);
    expect(result.telemetry.transitionConflicts[0]).toContain('none -> completed');
  });

  it('tracks dispute lifecycle transition conflicts', () => {
    const result = projectOnChainEvents([
      {
        eventName: 'disputeVoteCast',
        slot: 20,
        signature: 'SIG_DISPUTE_VOTE',
        timestampMs: 11,
        event: {
          disputeId: bytes(4),
          voter: pubkey(3),
          approved: true,
          votesFor: 5n,
          votesAgainst: 2n,
          timestamp: 11,
        },
      },
    ]);

    expect(result.telemetry.transitionConflicts).toHaveLength(1);
    expect(result.telemetry.transitionConflicts[0]).toContain('dispute:vote_cast');
  });

  it('produces replay-compatible lifecycle traces for valid task paths', () => {
    const result = projectOnChainEvents([
      {
        eventName: 'taskCreated',
        slot: 10,
        signature: 'SIG_REPLAY_1',
        event: {
          taskId: bytes(5),
          creator: pubkey(9),
          requiredCapabilities: 1n,
          rewardAmount: 1n,
          taskType: 0,
          deadline: 12,
          minReputation: 0,
          rewardMint: null,
          timestamp: 100,
        },
      },
      {
        eventName: 'taskClaimed',
        slot: 11,
        signature: 'SIG_REPLAY_2',
        event: {
          taskId: bytes(5),
          worker: pubkey(2),
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 101,
        },
      },
      {
        eventName: 'taskCompleted',
        slot: 12,
        signature: 'SIG_REPLAY_3',
        event: {
          taskId: bytes(5),
          worker: pubkey(2),
          proofHash: bytes(1, 32),
          resultData: bytes(2, 64),
          rewardPaid: 5n,
          timestamp: 102,
        },
      },
    ]);

    const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(result.trace);

    expect(result.telemetry.transitionConflicts).toHaveLength(0);
    expect(replay.errors).toHaveLength(0);
    expect(result.trace.events).toHaveLength(3);
    expect(replay.tasks[result.trace.events[0]?.taskPda ?? 'missing']).toBeDefined();
  });

  it('retains non-task context in source metadata', () => {
    const key = pubkey(8);
    const result = projectOnChainEvents([
      {
        eventName: 'rewardDistributed',
        slot: 20,
        signature: 'SIG_CTX',
        event: {
          taskId: bytes(6),
          recipient: key,
          amount: 100n,
          protocolFee: 1n,
          timestamp: 11,
        },
      },
    ]);

    expect(result.trace.events[0]?.payload).toMatchObject({
      onchain: {
        eventName: 'rewardDistributed',
        signature: 'SIG_CTX',
      },
    });
  });
});

function stableForward(result: ReturnType<typeof projectOnChainEvents>): string {
  return JSON.stringify(result.trace.events);
}
