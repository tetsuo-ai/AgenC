/**
 * Phase 2 Event Parse Functions
 *
 * Converts raw Anchor event data to typed, developer-friendly event objects.
 * Agent events (AgentRegistered, AgentUpdated, AgentDeregistered) are parsed
 * in agent/events.ts (Phase 1) and are NOT duplicated here.
 *
 * @module
 */

import type {
  RawTaskCreatedEvent,
  TaskCreatedEvent,
  RawTaskClaimedEvent,
  TaskClaimedEvent,
  RawTaskCompletedEvent,
  TaskCompletedEvent,
  RawTaskCancelledEvent,
  TaskCancelledEvent,
  RawDependentTaskCreatedEvent,
  DependentTaskCreatedEvent,
  RawDisputeInitiatedEvent,
  DisputeInitiatedEvent,
  RawDisputeVoteCastEvent,
  DisputeVoteCastEvent,
  RawDisputeResolvedEvent,
  DisputeResolvedEvent,
  RawDisputeExpiredEvent,
  DisputeExpiredEvent,
  RawDisputeCancelledEvent,
  DisputeCancelledEvent,
  RawArbiterVotesCleanedUpEvent,
  ArbiterVotesCleanedUpEvent,
  RawStateUpdatedEvent,
  StateUpdatedEvent,
  RawProtocolInitializedEvent,
  ProtocolInitializedEvent,
  RawRewardDistributedEvent,
  RewardDistributedEvent,
  RawRateLimitHitEvent,
  RateLimitHitEvent,
  RawMigrationCompletedEvent,
  MigrationCompletedEvent,
  RawProtocolVersionUpdatedEvent,
  ProtocolVersionUpdatedEvent,
  RawRateLimitsUpdatedEvent,
  RateLimitsUpdatedEvent,
  RawProtocolFeeUpdatedEvent,
  ProtocolFeeUpdatedEvent,
  RawReputationChangedEvent,
  ReputationChangedEvent,
  RawBondDepositedEvent,
  BondDepositedEvent,
  RawBondLockedEvent,
  BondLockedEvent,
  RawBondReleasedEvent,
  BondReleasedEvent,
  RawBondSlashedEvent,
  BondSlashedEvent,
  RawSpeculativeCommitmentCreatedEvent,
  SpeculativeCommitmentCreatedEvent,
} from "./types.js";
import { toUint8Array } from "../utils/encoding.js";

// --- Task Parse Functions ---

/**
 * Parses a raw TaskCreated event into typed form.
 */
export function parseTaskCreatedEvent(
  raw: RawTaskCreatedEvent,
): TaskCreatedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    requiredCapabilities: BigInt(raw.requiredCapabilities.toString()),
    rewardAmount: BigInt(raw.rewardAmount.toString()),
    taskType: raw.taskType,
    deadline: raw.deadline.toNumber(),
    minReputation: raw.minReputation,
    rewardMint: raw.rewardMint,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw TaskClaimed event into typed form.
 */
export function parseTaskClaimedEvent(
  raw: RawTaskClaimedEvent,
): TaskClaimedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    worker: raw.worker,
    currentWorkers: raw.currentWorkers,
    maxWorkers: raw.maxWorkers,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw TaskCompleted event into typed form.
 */
export function parseTaskCompletedEvent(
  raw: RawTaskCompletedEvent,
): TaskCompletedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    worker: raw.worker,
    proofHash: toUint8Array(raw.proofHash),
    resultData: toUint8Array(raw.resultData),
    rewardPaid: BigInt(raw.rewardPaid.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw TaskCancelled event into typed form.
 */
export function parseTaskCancelledEvent(
  raw: RawTaskCancelledEvent,
): TaskCancelledEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    refundAmount: BigInt(raw.refundAmount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DependentTaskCreated event into typed form.
 */
export function parseDependentTaskCreatedEvent(
  raw: RawDependentTaskCreatedEvent,
): DependentTaskCreatedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    dependsOn: raw.dependsOn,
    dependencyType: raw.dependencyType,
    rewardMint: raw.rewardMint,
    timestamp: raw.timestamp.toNumber(),
  };
}

// --- Dispute Parse Functions ---

/**
 * Parses a raw DisputeInitiated event into typed form.
 */
export function parseDisputeInitiatedEvent(
  raw: RawDisputeInitiatedEvent,
): DisputeInitiatedEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    taskId: toUint8Array(raw.taskId),
    initiator: raw.initiator,
    defendant: raw.defendant,
    resolutionType: raw.resolutionType,
    votingDeadline: raw.votingDeadline.toNumber(),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeVoteCast event into typed form.
 */
export function parseDisputeVoteCastEvent(
  raw: RawDisputeVoteCastEvent,
): DisputeVoteCastEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    voter: raw.voter,
    approved: raw.approved,
    votesFor: BigInt(raw.votesFor.toString()),
    votesAgainst: BigInt(raw.votesAgainst.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeResolved event into typed form.
 */
export function parseDisputeResolvedEvent(
  raw: RawDisputeResolvedEvent,
): DisputeResolvedEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    resolutionType: raw.resolutionType,
    outcome: raw.outcome,
    votesFor: BigInt(raw.votesFor.toString()),
    votesAgainst: BigInt(raw.votesAgainst.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeExpired event into typed form.
 */
export function parseDisputeExpiredEvent(
  raw: RawDisputeExpiredEvent,
): DisputeExpiredEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    taskId: toUint8Array(raw.taskId),
    refundAmount: BigInt(raw.refundAmount.toString()),
    creatorAmount: BigInt(raw.creatorAmount.toString()),
    workerAmount: BigInt(raw.workerAmount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeCancelled event into typed form.
 */
export function parseDisputeCancelledEvent(
  raw: RawDisputeCancelledEvent,
): DisputeCancelledEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    task: raw.task,
    initiator: raw.initiator,
    cancelledAt: raw.cancelledAt.toNumber(),
  };
}

/**
 * Parses a raw ArbiterVotesCleanedUp event into typed form.
 */
export function parseArbiterVotesCleanedUpEvent(
  raw: RawArbiterVotesCleanedUpEvent,
): ArbiterVotesCleanedUpEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    arbiterCount: raw.arbiterCount,
  };
}

// --- Protocol Parse Functions ---

/**
 * Parses a raw StateUpdated event into typed form.
 */
export function parseStateUpdatedEvent(
  raw: RawStateUpdatedEvent,
): StateUpdatedEvent {
  return {
    stateKey: toUint8Array(raw.stateKey),
    stateValue: toUint8Array(raw.stateValue),
    updater: raw.updater,
    version: BigInt(raw.version.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw ProtocolInitialized event into typed form.
 */
export function parseProtocolInitializedEvent(
  raw: RawProtocolInitializedEvent,
): ProtocolInitializedEvent {
  return {
    authority: raw.authority,
    treasury: raw.treasury,
    disputeThreshold: raw.disputeThreshold,
    protocolFeeBps: raw.protocolFeeBps,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw RewardDistributed event into typed form.
 */
export function parseRewardDistributedEvent(
  raw: RawRewardDistributedEvent,
): RewardDistributedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    recipient: raw.recipient,
    amount: BigInt(raw.amount.toString()),
    protocolFee: BigInt(raw.protocolFee.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw RateLimitHit event into typed form.
 */
export function parseRateLimitHitEvent(
  raw: RawRateLimitHitEvent,
): RateLimitHitEvent {
  return {
    agentId: toUint8Array(raw.agentId),
    actionType: raw.actionType,
    limitType: raw.limitType,
    currentCount: raw.currentCount,
    maxCount: raw.maxCount,
    cooldownRemaining: raw.cooldownRemaining.toNumber(),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw MigrationCompleted event into typed form.
 */
export function parseMigrationCompletedEvent(
  raw: RawMigrationCompletedEvent,
): MigrationCompletedEvent {
  return {
    fromVersion: raw.fromVersion,
    toVersion: raw.toVersion,
    authority: raw.authority,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw ProtocolVersionUpdated event into typed form.
 */
export function parseProtocolVersionUpdatedEvent(
  raw: RawProtocolVersionUpdatedEvent,
): ProtocolVersionUpdatedEvent {
  return {
    oldVersion: raw.oldVersion,
    newVersion: raw.newVersion,
    minSupportedVersion: raw.minSupportedVersion,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw RateLimitsUpdated event into typed form.
 */
export function parseRateLimitsUpdatedEvent(
  raw: RawRateLimitsUpdatedEvent,
): RateLimitsUpdatedEvent {
  return {
    taskCreationCooldown: raw.taskCreationCooldown.toNumber(),
    maxTasksPer24h: raw.maxTasksPer24h,
    disputeInitiationCooldown: raw.disputeInitiationCooldown.toNumber(),
    maxDisputesPer24h: raw.maxDisputesPer24h,
    minStakeForDispute: BigInt(raw.minStakeForDispute.toString()),
    updatedBy: raw.updatedBy,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw ProtocolFeeUpdated event into typed form.
 */
export function parseProtocolFeeUpdatedEvent(
  raw: RawProtocolFeeUpdatedEvent,
): ProtocolFeeUpdatedEvent {
  return {
    oldFeeBps: raw.oldFeeBps,
    newFeeBps: raw.newFeeBps,
    updatedBy: raw.updatedBy,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw ReputationChanged event into typed form.
 */
export function parseReputationChangedEvent(
  raw: RawReputationChangedEvent,
): ReputationChangedEvent {
  return {
    agentId: toUint8Array(raw.agentId),
    oldReputation: raw.oldReputation,
    newReputation: raw.newReputation,
    reason: raw.reason,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw BondDeposited event into typed form.
 */
export function parseBondDepositedEvent(
  raw: RawBondDepositedEvent,
): BondDepositedEvent {
  return {
    agent: raw.agent,
    amount: BigInt(raw.amount.toString()),
    newTotal: BigInt(raw.newTotal.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw BondLocked event into typed form.
 */
export function parseBondLockedEvent(raw: RawBondLockedEvent): BondLockedEvent {
  return {
    agent: raw.agent,
    commitment: raw.commitment,
    amount: BigInt(raw.amount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw BondReleased event into typed form.
 */
export function parseBondReleasedEvent(
  raw: RawBondReleasedEvent,
): BondReleasedEvent {
  return {
    agent: raw.agent,
    commitment: raw.commitment,
    amount: BigInt(raw.amount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw BondSlashed event into typed form.
 */
export function parseBondSlashedEvent(
  raw: RawBondSlashedEvent,
): BondSlashedEvent {
  return {
    agent: raw.agent,
    commitment: raw.commitment,
    amount: BigInt(raw.amount.toString()),
    reason: raw.reason,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw SpeculativeCommitmentCreated event into typed form.
 */
export function parseSpeculativeCommitmentCreatedEvent(
  raw: RawSpeculativeCommitmentCreatedEvent,
): SpeculativeCommitmentCreatedEvent {
  return {
    task: raw.task,
    producer: raw.producer,
    resultHash: toUint8Array(raw.resultHash),
    bondedStake: BigInt(raw.bondedStake.toString()),
    expiresAt: raw.expiresAt.toNumber(),
    timestamp: raw.timestamp.toNumber(),
  };
}
