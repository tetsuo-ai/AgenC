/**
 * Canonical event contract descriptors used by the IDL drift check.
 *
 * Kept explicitly in code so changes are reviewable and deterministic.
 */

export type FieldFamily =
  | 'bytes<32>'
  | 'bytes<64>'
  | 'bytes<variable>'
  | 'i64'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'bool'
  | 'pubkey'
  | 'option<pubkey>'
  | 'i128'
  | 'u128'
  | 'unknown';

export interface EventFieldContract {
  name: string;
  family: FieldFamily;
}

export interface EventContract {
  eventName: string;
  fields: readonly EventFieldContract[];
}

export const RUNTIME_EVENT_CONTRACT: readonly EventContract[] = [
  {
    eventName: 'taskCreated',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'creator', family: 'pubkey' },
      { name: 'requiredCapabilities', family: 'u64' },
      { name: 'rewardAmount', family: 'u64' },
      { name: 'taskType', family: 'u8' },
      { name: 'deadline', family: 'i64' },
      { name: 'minReputation', family: 'u16' },
      { name: 'rewardMint', family: 'option<pubkey>' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'taskClaimed',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'worker', family: 'pubkey' },
      { name: 'currentWorkers', family: 'u8' },
      { name: 'maxWorkers', family: 'u8' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'taskCompleted',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'worker', family: 'pubkey' },
      { name: 'proofHash', family: 'bytes<32>' },
      { name: 'resultData', family: 'bytes<64>' },
      { name: 'rewardPaid', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'taskCancelled',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'creator', family: 'pubkey' },
      { name: 'refundAmount', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'dependentTaskCreated',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'creator', family: 'pubkey' },
      { name: 'dependsOn', family: 'pubkey' },
      { name: 'dependencyType', family: 'u8' },
      { name: 'rewardMint', family: 'option<pubkey>' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'disputeInitiated',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'initiator', family: 'pubkey' },
      { name: 'defendant', family: 'pubkey' },
      { name: 'resolutionType', family: 'u8' },
      { name: 'votingDeadline', family: 'i64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'disputeVoteCast',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'voter', family: 'pubkey' },
      { name: 'approved', family: 'bool' },
      { name: 'votesFor', family: 'u64' },
      { name: 'votesAgainst', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'disputeResolved',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'resolutionType', family: 'u8' },
      { name: 'outcome', family: 'u8' },
      { name: 'votesFor', family: 'u64' },
      { name: 'votesAgainst', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'disputeExpired',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'refundAmount', family: 'u64' },
      { name: 'creatorAmount', family: 'u64' },
      { name: 'workerAmount', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'disputeCancelled',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'task', family: 'pubkey' },
      { name: 'initiator', family: 'pubkey' },
      { name: 'cancelledAt', family: 'i64' },
    ],
  },
  {
    eventName: 'arbiterVotesCleanedUp',
    fields: [
      { name: 'disputeId', family: 'bytes<32>' },
      { name: 'arbiterCount', family: 'u8' },
    ],
  },
  {
    eventName: 'stateUpdated',
    fields: [
      { name: 'stateKey', family: 'bytes<32>' },
      { name: 'stateValue', family: 'bytes<64>' },
      { name: 'updater', family: 'pubkey' },
      { name: 'version', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'protocolInitialized',
    fields: [
      { name: 'authority', family: 'pubkey' },
      { name: 'treasury', family: 'pubkey' },
      { name: 'disputeThreshold', family: 'u8' },
      { name: 'protocolFeeBps', family: 'u16' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'rewardDistributed',
    fields: [
      { name: 'taskId', family: 'bytes<32>' },
      { name: 'recipient', family: 'pubkey' },
      { name: 'amount', family: 'u64' },
      { name: 'protocolFee', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'rateLimitHit',
    fields: [
      { name: 'agentId', family: 'bytes<32>' },
      { name: 'actionType', family: 'u8' },
      { name: 'limitType', family: 'u8' },
      { name: 'currentCount', family: 'u8' },
      { name: 'maxCount', family: 'u8' },
      { name: 'cooldownRemaining', family: 'i64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'migrationCompleted',
    fields: [
      { name: 'fromVersion', family: 'u8' },
      { name: 'toVersion', family: 'u8' },
      { name: 'authority', family: 'pubkey' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'protocolVersionUpdated',
    fields: [
      { name: 'oldVersion', family: 'u8' },
      { name: 'newVersion', family: 'u8' },
      { name: 'minSupportedVersion', family: 'u8' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'rateLimitsUpdated',
    fields: [
      { name: 'taskCreationCooldown', family: 'i64' },
      { name: 'maxTasksPer24h', family: 'u8' },
      { name: 'disputeInitiationCooldown', family: 'i64' },
      { name: 'maxDisputesPer24h', family: 'u8' },
      { name: 'minStakeForDispute', family: 'u64' },
      { name: 'updatedBy', family: 'pubkey' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'protocolFeeUpdated',
    fields: [
      { name: 'oldFeeBps', family: 'u16' },
      { name: 'newFeeBps', family: 'u16' },
      { name: 'updatedBy', family: 'pubkey' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'reputationChanged',
    fields: [
      { name: 'agentId', family: 'bytes<32>' },
      { name: 'oldReputation', family: 'u16' },
      { name: 'newReputation', family: 'u16' },
      { name: 'reason', family: 'u8' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'bondDeposited',
    fields: [
      { name: 'agent', family: 'pubkey' },
      { name: 'amount', family: 'u64' },
      { name: 'newTotal', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'bondLocked',
    fields: [
      { name: 'agent', family: 'pubkey' },
      { name: 'commitment', family: 'pubkey' },
      { name: 'amount', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'bondReleased',
    fields: [
      { name: 'agent', family: 'pubkey' },
      { name: 'commitment', family: 'pubkey' },
      { name: 'amount', family: 'u64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'bondSlashed',
    fields: [
      { name: 'agent', family: 'pubkey' },
      { name: 'commitment', family: 'pubkey' },
      { name: 'amount', family: 'u64' },
      { name: 'reason', family: 'u8' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
  {
    eventName: 'speculativeCommitmentCreated',
    fields: [
      { name: 'task', family: 'pubkey' },
      { name: 'producer', family: 'pubkey' },
      { name: 'resultHash', family: 'bytes<32>' },
      { name: 'bondedStake', family: 'u64' },
      { name: 'expiresAt', family: 'i64' },
      { name: 'timestamp', family: 'i64' },
    ],
  },
] as const;

export const RUNTIME_EVENT_BY_NAME = new Map(
  RUNTIME_EVENT_CONTRACT.map((event) => [event.eventName, event]),
);
