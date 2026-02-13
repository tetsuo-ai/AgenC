import { PublicKey } from '@solana/web3.js';

export interface ChaosInputEvent {
  eventName: string;
  slot: number;
  signature: string;
  timestampMs?: number;
  event: Record<string, unknown>;
}

export interface ReplayChaosFixture {
  traceId: string;
  seed: number;
  onChainEvents: readonly ChaosInputEvent[];
  expected: {
    lenientProjectedCount: number;
    lenientEventFingerprint: string;
    lenientEventTypes: ReadonlyArray<string>;
    lenientTelemetry: {
      projectedEvents: number;
      duplicatesDropped: number;
      malformedInputs: number;
      unknownEvents: number;
      transitionConflicts: number;
      transitionViolations: number;
    };
    strictThrowMessage: string;
    droppedClaimedEventFingerprint: string;
    droppedClaimedEventTypes: ReadonlyArray<string>;
    droppedClaimedTelemetry: {
      projectedEvents: number;
      duplicatesDropped: number;
      malformedInputs: number;
      unknownEvents: number;
      transitionConflicts: number;
      transitionViolations: number;
    };
    speculationLifecycleEventTypes: ReadonlyArray<string>;
  };
}

function bytes(seed: number, length = 32): Uint8Array {
  return Uint8Array.from({ length }, () => seed);
}

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed));
}

export const REPLAY_CHAOS_FIXTURE: ReplayChaosFixture = {
  traceId: 'replay-chaos-v1',
  seed: 777,
  onChainEvents: [
    {
      eventName: 'taskCompleted',
      slot: 14,
      signature: 'SIG_TASK_COMPLETED_DUP',
      timestampMs: 4,
      event: {
        taskId: bytes(1),
        worker: pubkey(4),
        proofHash: bytes(5, 32),
        resultData: bytes(6, 64),
        rewardPaid: 1000n,
        timestamp: 4,
      },
    },
    {
      eventName: 'taskCreated',
      slot: 10,
      signature: 'SIG_TASK_CREATED',
      timestampMs: 1,
      event: {
        taskId: bytes(1),
        creator: pubkey(2),
        requiredCapabilities: 1n,
        rewardAmount: 10_000n,
        taskType: 0,
        deadline: 50_000,
        minReputation: 1,
        rewardMint: null,
        timestamp: 1,
      },
    },
    {
      eventName: 'taskClaimed',
      slot: 11,
      signature: 'SIG_TASK_CLAIMED',
      timestampMs: 2,
      event: {
        taskId: bytes(1),
        worker: pubkey(3),
        currentWorkers: 1,
        maxWorkers: 3,
        timestamp: 2,
      },
    },
    {
      eventName: 'taskClaimed',
      slot: 11,
      signature: 'SIG_TASK_CLAIMED',
      timestampMs: 2,
      event: {
        taskId: bytes(1),
        worker: pubkey(3),
        currentWorkers: 1,
        maxWorkers: 3,
        timestamp: 2,
      },
    },
    {
      eventName: 'unknownEventFromProgram',
      slot: 12,
      signature: 'SIG_UNKNOWN',
      timestampMs: 3,
      event: {
        taskId: bytes(1),
        payload: 'payload',
      },
    },
    {
      eventName: 'disputeInitiated',
      slot: 15,
      signature: 'SIG_DISPUTE_INIT',
      timestampMs: 5,
      event: {
        disputeId: bytes(21),
        taskId: bytes(1),
        initiator: pubkey(7),
        defendant: pubkey(8),
        resolutionType: 0,
        votingDeadline: 60_000,
        timestamp: 5,
      },
    },
    {
      eventName: 'speculativeCommitmentCreated',
      slot: 16,
      signature: 'SIG_SPECULATION_START',
      timestampMs: 6,
      event: {
        commitment: bytes(9),
        task: bytes(1),
        disputeId: bytes(21),
        amount: 150n,
        timestamp: 6,
      },
    },
    {
      eventName: 'bondReleased',
      slot: 17,
      signature: 'SIG_SPECULATION_CONFIRM',
      timestampMs: 7,
      event: {
        taskId: bytes(1),
        commitment: bytes(9),
        slasher: pubkey(8),
        amount: 150n,
        timestamp: 7,
      },
    },
    {
      eventName: 'bondSlashed',
      slot: 18,
      signature: 'SIG_SPECULATION_ABORT',
      timestampMs: 8,
      event: {
        taskId: bytes(1),
        commitment: bytes(9),
        slasher: pubkey(8),
        amount: 150n,
        timestamp: 8,
      },
    },
    {
      eventName: 'taskCreated',
      slot: 9,
      signature: 'SIG_MALFORMED',
      timestampMs: 9,
      event: {
        notAValidTask: true,
      },
    },
  ],
  expected: {
    lenientProjectedCount: 8,
    lenientEventFingerprint: '8af18aad286a6299929f9c368849084281f794e959b4e3b30212a5827e394ab9',
    lenientEventTypes: [
      'discovered',
      'discovered',
      'claimed',
      'completed',
      'dispute:initiated',
      'speculation_started',
      'speculation_confirmed',
      'speculation_aborted',
    ],
    lenientTelemetry: {
      projectedEvents: 8,
      duplicatesDropped: 1,
      malformedInputs: 0,
      unknownEvents: 1,
      transitionConflicts: 3,
      transitionViolations: 2,
    },
    strictThrowMessage: 'Replay projection strict mode failed: task:taskCreated@SIG_MALFORMED: missing_task_id',
    droppedClaimedEventFingerprint: '0602282e4fe843558bd45c5e02b1de6c9cb08febf93994a7290a47db8f252153',
    droppedClaimedEventTypes: [
      'discovered',
      'discovered',
      'completed',
      'dispute:initiated',
      'speculation_started',
      'speculation_confirmed',
      'speculation_aborted',
    ],
    droppedClaimedTelemetry: {
      projectedEvents: 7,
      duplicatesDropped: 0,
      malformedInputs: 0,
      unknownEvents: 1,
      transitionConflicts: 4,
      transitionViolations: 3,
    },
    speculationLifecycleEventTypes: [
      'speculation_started',
      'speculation_confirmed',
      'speculation_aborted',
    ],
  },
};
