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
  RawTaskCreatedEvent, TaskCreatedEvent,
  RawTaskClaimedEvent, TaskClaimedEvent,
  RawTaskCompletedEvent, TaskCompletedEvent,
  RawTaskCancelledEvent, TaskCancelledEvent,
  RawDisputeInitiatedEvent, DisputeInitiatedEvent,
  RawDisputeVoteCastEvent, DisputeVoteCastEvent,
  RawDisputeResolvedEvent, DisputeResolvedEvent,
  RawDisputeExpiredEvent, DisputeExpiredEvent,
  RawStateUpdatedEvent, StateUpdatedEvent,
  RawProtocolInitializedEvent, ProtocolInitializedEvent,
  RawRewardDistributedEvent, RewardDistributedEvent,
  RawRateLimitHitEvent, RateLimitHitEvent,
  RawMigrationCompletedEvent, MigrationCompletedEvent,
  RawProtocolVersionUpdatedEvent, ProtocolVersionUpdatedEvent,
} from './types.js';

/**
 * Converts array-like value to Uint8Array.
 * Defined locally (same as agent/events.ts and agent/types.ts).
 */
function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

// --- Task Parse Functions ---

/**
 * Parses a raw TaskCreated event into typed form.
 */
export function parseTaskCreatedEvent(raw: RawTaskCreatedEvent): TaskCreatedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    requiredCapabilities: BigInt(raw.requiredCapabilities.toString()),
    rewardAmount: BigInt(raw.rewardAmount.toString()),
    taskType: raw.taskType,
    deadline: raw.deadline.toNumber(),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw TaskClaimed event into typed form.
 */
export function parseTaskClaimedEvent(raw: RawTaskClaimedEvent): TaskClaimedEvent {
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
export function parseTaskCompletedEvent(raw: RawTaskCompletedEvent): TaskCompletedEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    worker: raw.worker,
    proofHash: toUint8Array(raw.proofHash),
    rewardPaid: BigInt(raw.rewardPaid.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw TaskCancelled event into typed form.
 */
export function parseTaskCancelledEvent(raw: RawTaskCancelledEvent): TaskCancelledEvent {
  return {
    taskId: toUint8Array(raw.taskId),
    creator: raw.creator,
    refundAmount: BigInt(raw.refundAmount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

// --- Dispute Parse Functions ---

/**
 * Parses a raw DisputeInitiated event into typed form.
 */
export function parseDisputeInitiatedEvent(raw: RawDisputeInitiatedEvent): DisputeInitiatedEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    taskId: toUint8Array(raw.taskId),
    initiator: raw.initiator,
    resolutionType: raw.resolutionType,
    votingDeadline: raw.votingDeadline.toNumber(),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeVoteCast event into typed form.
 */
export function parseDisputeVoteCastEvent(raw: RawDisputeVoteCastEvent): DisputeVoteCastEvent {
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
export function parseDisputeResolvedEvent(raw: RawDisputeResolvedEvent): DisputeResolvedEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    resolutionType: raw.resolutionType,
    votesFor: BigInt(raw.votesFor.toString()),
    votesAgainst: BigInt(raw.votesAgainst.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw DisputeExpired event into typed form.
 */
export function parseDisputeExpiredEvent(raw: RawDisputeExpiredEvent): DisputeExpiredEvent {
  return {
    disputeId: toUint8Array(raw.disputeId),
    taskId: toUint8Array(raw.taskId),
    refundAmount: BigInt(raw.refundAmount.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

// --- Protocol Parse Functions ---

/**
 * Parses a raw StateUpdated event into typed form.
 */
export function parseStateUpdatedEvent(raw: RawStateUpdatedEvent): StateUpdatedEvent {
  return {
    stateKey: toUint8Array(raw.stateKey),
    updater: raw.updater,
    version: BigInt(raw.version.toString()),
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw ProtocolInitialized event into typed form.
 */
export function parseProtocolInitializedEvent(raw: RawProtocolInitializedEvent): ProtocolInitializedEvent {
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
export function parseRewardDistributedEvent(raw: RawRewardDistributedEvent): RewardDistributedEvent {
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
export function parseRateLimitHitEvent(raw: RawRateLimitHitEvent): RateLimitHitEvent {
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
export function parseMigrationCompletedEvent(raw: RawMigrationCompletedEvent): MigrationCompletedEvent {
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
export function parseProtocolVersionUpdatedEvent(raw: RawProtocolVersionUpdatedEvent): ProtocolVersionUpdatedEvent {
  return {
    oldVersion: raw.oldVersion,
    newVersion: raw.newVersion,
    minSupportedVersion: raw.minSupportedVersion,
    timestamp: raw.timestamp.toNumber(),
  };
}
