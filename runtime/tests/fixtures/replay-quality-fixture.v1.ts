import { PublicKey } from '@solana/web3.js';

export interface ReplayQualityInputEvent {
  eventName: string;
  slot: number;
  signature: string;
  timestampMs?: number;
  event: Record<string, unknown>;
}

interface ReplayQualityFixture {
  traceId: string;
  seed: number;
  capturedAtMs: number;
  onChainEvents: readonly ReplayQualityInputEvent[];
}

function bytes(seed: number, length = 32): Uint8Array {
  const output = new Uint8Array(length);
  output.fill(seed);
  return output;
}

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed));
}

export const REPLAY_QUALITY_FIXTURE_V1: ReplayQualityFixture = {
  traceId: 'replay-quality-v1',
  seed: 120,
  capturedAtMs: 1_700_000_000_000,
  onChainEvents: [
    {
      eventName: 'protocolInitialized',
      slot: 1,
      signature: 'SIG_PROTO_INIT',
      timestampMs: 10_000,
      event: {
        authority: pubkey(1),
        treasury: pubkey(2),
        disputeThreshold: 2,
        protocolFeeBps: 250,
        timestamp: 10_000,
      },
    },
    {
      eventName: 'taskCreated',
      slot: 2,
      signature: 'SIG_TASK_CREATED_A',
      timestampMs: 10_010,
      event: {
        taskId: bytes(1),
        creator: pubkey(10),
        requiredCapabilities: 1n,
        rewardAmount: 1_000n,
        taskType: 0,
        deadline: 12_000,
        minReputation: 0,
        rewardMint: null,
        timestamp: 10_010,
      },
    },
    {
      eventName: 'agentRegistered',
      slot: 3,
      signature: 'SIG_AGENT_REGISTERED',
      timestampMs: 10_020,
      event: {
        agentId: bytes(9),
        authority: pubkey(10),
        capabilities: 7n,
        endpoint: 'wss://agent.example',
        timestamp: 10_020,
      },
    },
    {
      eventName: 'taskClaimed',
      slot: 4,
      signature: 'SIG_TASK_CLAIMED_A',
      timestampMs: 10_030,
      event: {
        taskId: bytes(1),
        worker: pubkey(11),
        currentWorkers: 1,
        maxWorkers: 2,
        timestamp: 10_030,
      },
    },
    {
      eventName: 'taskCompleted',
      slot: 5,
      signature: 'SIG_TASK_COMPLETED_A',
      timestampMs: 10_040,
      event: {
        taskId: bytes(1),
        worker: pubkey(11),
        proofHash: bytes(3, 32),
        resultData: bytes(4, 64),
        rewardPaid: 1_000n,
        timestamp: 10_040,
      },
    },
    {
      eventName: 'taskCreated',
      slot: 6,
      signature: 'SIG_TASK_CREATED_B',
      timestampMs: 10_050,
      event: {
        taskId: bytes(2),
        creator: pubkey(12),
        requiredCapabilities: 2n,
        rewardAmount: 500n,
        taskType: 1,
        deadline: 12_000,
        minReputation: 1,
        rewardMint: null,
        timestamp: 10_050,
      },
    },
    {
      eventName: 'taskCancelled',
      slot: 7,
      signature: 'SIG_TASK_CANCELLED_B',
      timestampMs: 10_060,
      event: {
        taskId: bytes(2),
        creator: pubkey(12),
        refundAmount: 500n,
        timestamp: 10_060,
      },
    },
    {
      eventName: 'dependentTaskCreated',
      slot: 8,
      signature: 'SIG_DEP_TASK',
      timestampMs: 10_070,
      event: {
        taskId: bytes(3),
        creator: pubkey(12),
        dependsOn: pubkey(2),
        dependencyType: 1,
        rewardMint: null,
        timestamp: 10_070,
      },
    },
    {
      eventName: 'disputeInitiated',
      slot: 9,
      signature: 'SIG_DISPUTE_INIT_A',
      timestampMs: 10_080,
      event: {
        disputeId: bytes(21),
        taskId: bytes(1),
        initiator: pubkey(20),
        defendant: pubkey(21),
        resolutionType: 2,
        votingDeadline: 20_000,
        timestamp: 10_080,
      },
    },
    {
      eventName: 'disputeVoteCast',
      slot: 10,
      signature: 'SIG_DISPUTE_VOTE_A',
      timestampMs: 10_090,
      event: {
        disputeId: bytes(21),
        voter: pubkey(22),
        approved: true,
        votesFor: 8n,
        votesAgainst: 2n,
        timestamp: 10_090,
      },
    },
    {
      eventName: 'disputeResolved',
      slot: 11,
      signature: 'SIG_DISPUTE_RESOLVE_A',
      timestampMs: 10_100,
      event: {
        disputeId: bytes(21),
        taskId: bytes(1),
        resolutionType: 2,
        outcome: 1,
        votesFor: 8n,
        votesAgainst: 2n,
        timestamp: 10_100,
      },
    },
    {
      eventName: 'disputeInitiated',
      slot: 12,
      signature: 'SIG_DISPUTE_INIT_B',
      timestampMs: 10_110,
      event: {
        disputeId: bytes(22),
        taskId: bytes(3),
        initiator: pubkey(23),
        defendant: pubkey(24),
        resolutionType: 0,
        votingDeadline: 20_500,
        timestamp: 10_110,
      },
    },
    {
      eventName: 'disputeCancelled',
      slot: 13,
      signature: 'SIG_DISPUTE_CANCEL_B',
      timestampMs: 10_120,
      event: {
        disputeId: bytes(22),
        task: pubkey(3),
        initiator: pubkey(23),
        cancelledAt: 12_500,
      },
    },
    {
      eventName: 'disputeInitiated',
      slot: 14,
      signature: 'SIG_DISPUTE_INIT_C',
      timestampMs: 10_130,
      event: {
        disputeId: bytes(23),
        taskId: bytes(2),
        initiator: pubkey(25),
        defendant: pubkey(26),
        resolutionType: 1,
        votingDeadline: 21_000,
        timestamp: 10_130,
      },
    },
    {
      eventName: 'disputeExpired',
      slot: 15,
      signature: 'SIG_DISPUTE_EXPIRE_C',
      timestampMs: 10_140,
      event: {
        disputeId: bytes(23),
        taskId: bytes(2),
        refundAmount: 300n,
        creatorAmount: 100n,
        workerAmount: 200n,
        timestamp: 10_140,
      },
    },
    {
      eventName: 'arbiterVotesCleanedUp',
      slot: 16,
      signature: 'SIG_ARB_CLEAN_A',
      timestampMs: 10_150,
      event: {
        disputeId: bytes(21),
        arbiterCount: 2,
      },
    },
    {
      eventName: 'speculativeCommitmentCreated',
      slot: 17,
      signature: 'SIG_SPEC_START_A',
      timestampMs: 10_160,
      event: {
        task: pubkey(1),
        producer: pubkey(30),
        resultHash: bytes(40, 32),
        bondedStake: 222n,
        expiresAt: 12_500,
        timestamp: 10_160,
      },
    },
    {
      eventName: 'bondReleased',
      slot: 18,
      signature: 'SIG_SPEC_CONFIRM_A',
      timestampMs: 10_170,
      event: {
        agent: pubkey(30),
        commitment: pubkey(1),
        amount: 222n,
        timestamp: 10_170,
      },
    },
    {
      eventName: 'speculativeCommitmentCreated',
      slot: 19,
      signature: 'SIG_SPEC_START_B',
      timestampMs: 10_180,
      event: {
        task: pubkey(3),
        producer: pubkey(31),
        resultHash: bytes(50, 32),
        bondedStake: 333n,
        expiresAt: 13_000,
        timestamp: 10_180,
      },
    },
    {
      eventName: 'bondSlashed',
      slot: 20,
      signature: 'SIG_SPEC_ABORT_B',
      timestampMs: 10_190,
      event: {
        agent: pubkey(31),
        commitment: pubkey(3),
        amount: 333n,
        reason: 1,
        timestamp: 10_190,
      },
    },
    {
      eventName: 'stateUpdated',
      slot: 21,
      signature: 'SIG_STATE_UPDATE',
      timestampMs: 10_200,
      event: {
        stateKey: bytes(1, 32),
        stateValue: bytes(2, 64),
        updater: pubkey(40),
        version: 2n,
        timestamp: 10_200,
      },
    },
    {
      eventName: 'rewardDistributed',
      slot: 22,
      signature: 'SIG_REWARD',
      timestampMs: 10_210,
      event: {
        taskId: bytes(1),
        recipient: pubkey(11),
        amount: 900n,
        protocolFee: 100n,
        timestamp: 10_210,
      },
    },
    {
      eventName: 'rateLimitHit',
      slot: 23,
      signature: 'SIG_RATE_LIMIT_HIT',
      timestampMs: 10_220,
      event: {
        agentId: bytes(9),
        actionType: 0,
        limitType: 1,
        currentCount: 5,
        maxCount: 8,
        cooldownRemaining: 300,
        timestamp: 10_220,
      },
    },
    {
      eventName: 'migrationCompleted',
      slot: 24,
      signature: 'SIG_MIGRATION',
      timestampMs: 10_230,
      event: {
        fromVersion: 1,
        toVersion: 2,
        authority: pubkey(50),
        timestamp: 10_230,
      },
    },
    {
      eventName: 'protocolVersionUpdated',
      slot: 25,
      signature: 'SIG_VERSION',
      timestampMs: 10_240,
      event: {
        oldVersion: 2,
        newVersion: 3,
        minSupportedVersion: 2,
        timestamp: 10_240,
      },
    },
    {
      eventName: 'rateLimitsUpdated',
      slot: 26,
      signature: 'SIG_RATE_LIMITS',
      timestampMs: 10_250,
      event: {
        taskCreationCooldown: 90,
        maxTasksPer24h: 8,
        disputeInitiationCooldown: 45,
        maxDisputesPer24h: 4,
        minStakeForDispute: 3_000n,
        updatedBy: pubkey(60),
        timestamp: 10_250,
      },
    },
    {
      eventName: 'protocolFeeUpdated',
      slot: 27,
      signature: 'SIG_FEE',
      timestampMs: 10_260,
      event: {
        oldFeeBps: 250,
        newFeeBps: 300,
        updatedBy: pubkey(61),
        timestamp: 10_260,
      },
    },
    {
      eventName: 'reputationChanged',
      slot: 28,
      signature: 'SIG_REPUTATION',
      timestampMs: 10_270,
      event: {
        agentId: bytes(9),
        oldReputation: 1200,
        newReputation: 1320,
        reason: 3,
        timestamp: 10_270,
      },
    },
    {
      eventName: 'bondDeposited',
      slot: 29,
      signature: 'SIG_BOND_DEPOSIT',
      timestampMs: 10_280,
      event: {
        agent: pubkey(30),
        amount: 777n,
        newTotal: 777n,
        timestamp: 10_280,
      },
    },
    {
      eventName: 'bondLocked',
      slot: 30,
      signature: 'SIG_BOND_LOCK',
      timestampMs: 10_290,
      event: {
        agent: pubkey(30),
        commitment: pubkey(70),
        amount: 333n,
        timestamp: 10_290,
      },
    },
    {
      eventName: 'agentUpdated',
      slot: 31,
      signature: 'SIG_AGENT_UPDATED',
      timestampMs: 10_300,
      event: {
        agentId: bytes(9),
        capabilities: 15n,
        status: 1,
        timestamp: 10_300,
      },
    },
    {
      eventName: 'agentDeregistered',
      slot: 32,
      signature: 'SIG_AGENT_DEREG',
      timestampMs: 10_310,
      event: {
        agentId: bytes(9),
        authority: pubkey(10),
        timestamp: 10_310,
      },
    },
    {
      eventName: 'agentSuspended',
      slot: 33,
      signature: 'SIG_AGENT_SUSPENDED',
      timestampMs: 10_320,
      event: {
        agentId: bytes(9),
        authority: pubkey(10),
        timestamp: 10_320,
      },
    },
    {
      eventName: 'agentUnsuspended',
      slot: 34,
      signature: 'SIG_AGENT_UNSUSPENDED',
      timestampMs: 10_330,
      event: {
        agentId: bytes(9),
        authority: pubkey(10),
        timestamp: 10_330,
      },
    },
    {
      eventName: 'taskClaimed',
      slot: 35,
      signature: 'SIG_TASK_CLAIMED_C',
      timestampMs: 10_340,
      event: {
        taskId: bytes(3),
        worker: pubkey(35),
        currentWorkers: 1,
        maxWorkers: 1,
        timestamp: 10_340,
      },
    },
    {
      eventName: 'taskCompleted',
      slot: 36,
      signature: 'SIG_TASK_COMPLETED_C',
      timestampMs: 10_350,
      event: {
        taskId: bytes(3),
        worker: pubkey(35),
        proofHash: bytes(6, 32),
        resultData: bytes(7, 64),
        rewardPaid: 700n,
        timestamp: 10_350,
      },
    },
    {
      eventName: 'protocolFeeUpdated',
      slot: 37,
      signature: 'SIG_FEE_ALT',
      timestampMs: 10_360,
      event: {
        oldFeeBps: 300,
        newFeeBps: 320,
        updatedBy: pubkey(62),
        timestamp: 10_360,
      },
    },
  ],
} as const;
