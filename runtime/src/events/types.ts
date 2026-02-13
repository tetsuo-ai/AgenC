/**
 * Phase 2 Event Type Definitions
 *
 * Type definitions for all non-agent protocol events (task, dispute, protocol).
 * Agent events are defined in agent/events.ts (Phase 1).
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Generic event callback type.
 * @typeParam T - The parsed event type
 */
export type EventCallback<T> = (event: T, slot: number, signature: string) => void;

/**
 * Subscription handle for unsubscribing from events.
 * Structurally identical to Phase 1 EventSubscription in agent/events.ts.
 */
export interface EventSubscription {
  unsubscribe(): Promise<void>;
}

// ============================================================================
// Semantic Enums for u8 Event Fields
// ============================================================================

/**
 * Task type values matching on-chain TaskType enum.
 * Used in TaskCreated.taskType field.
 */
export enum TaskType {
  Exclusive = 0,
  Collaborative = 1,
  Competitive = 2,
}

/**
 * Resolution type values matching on-chain ResolutionType enum.
 * Used in DisputeInitiated.resolutionType and DisputeResolved.resolutionType.
 */
export enum ResolutionType {
  Refund = 0,
  Complete = 1,
  Split = 2,
}

/**
 * Rate limit action type values.
 * Used in RateLimitHit.actionType field.
 */
export enum RateLimitActionType {
  TaskCreation = 0,
  DisputeInitiation = 1,
}

/**
 * Rate limit type values.
 * Used in RateLimitHit.limitType field.
 */
export enum RateLimitType {
  Cooldown = 0,
  Window24h = 1,
}

// ============================================================================
// Raw Event Interfaces (as received from Anchor addEventListener)
// ============================================================================
// BN-like objects from Anchor need .toString() for u64 and .toNumber() for i64.
// [u8;32] comes as number[] | Uint8Array. Pubkey comes as PublicKey.
// bool comes as boolean. u8/u16 come as number.

// --- Task Raw Events ---

export interface RawTaskCreatedEvent {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  requiredCapabilities: { toString: () => string }; // u64 -> BN
  rewardAmount: { toString: () => string };          // u64 -> BN
  taskType: number;                                   // u8
  deadline: { toNumber: () => number };               // i64 -> BN
  minReputation: number;                              // u16
  rewardMint: PublicKey | null;                       // Option<Pubkey>
  timestamp: { toNumber: () => number };              // i64 -> BN
}

export interface RawTaskClaimedEvent {
  taskId: number[] | Uint8Array;
  worker: PublicKey;
  currentWorkers: number;                             // u8
  maxWorkers: number;                                 // u8
  timestamp: { toNumber: () => number };
}

export interface RawTaskCompletedEvent {
  taskId: number[] | Uint8Array;
  worker: PublicKey;
  proofHash: number[] | Uint8Array;                   // [u8;32]
  resultData: number[] | Uint8Array;                  // [u8;64]
  rewardPaid: { toString: () => string };             // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawTaskCancelledEvent {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  refundAmount: { toString: () => string };           // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawDependentTaskCreatedEvent {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  dependsOn: PublicKey;
  dependencyType: number;                              // u8
  rewardMint: PublicKey | null;
  timestamp: { toNumber: () => number };
}

// --- Dispute Raw Events ---

export interface RawDisputeInitiatedEvent {
  disputeId: number[] | Uint8Array;
  taskId: number[] | Uint8Array;
  initiator: PublicKey;
  defendant: PublicKey;
  resolutionType: number;                             // u8 enum
  votingDeadline: { toNumber: () => number };         // i64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawDisputeVoteCastEvent {
  disputeId: number[] | Uint8Array;
  voter: PublicKey;
  approved: boolean;
  votesFor: { toString: () => string };               // u64 -> BN
  votesAgainst: { toString: () => string };           // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawDisputeResolvedEvent {
  disputeId: number[] | Uint8Array;
  resolutionType: number;                             // u8 enum
  outcome: number;                                    // u8
  votesFor: { toString: () => string };               // u64 -> BN
  votesAgainst: { toString: () => string };           // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawDisputeExpiredEvent {
  disputeId: number[] | Uint8Array;
  taskId: number[] | Uint8Array;
  refundAmount: { toString: () => string };           // u64 -> BN
  creatorAmount: { toString: () => string };          // u64 -> BN
  workerAmount: { toString: () => string };           // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawDisputeCancelledEvent {
  disputeId: number[] | Uint8Array;
  task: PublicKey;
  initiator: PublicKey;
  cancelledAt: { toNumber: () => number };
}

export interface RawArbiterVotesCleanedUpEvent {
  disputeId: number[] | Uint8Array;
  arbiterCount: number;
}

// --- Agent Raw Events ---

export interface RawAgentSuspendedEvent {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  timestamp: { toNumber: () => number };
}

export interface RawAgentUnsuspendedEvent {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  timestamp: { toNumber: () => number };
}

// --- Protocol Raw Events ---

export interface RawStateUpdatedEvent {
  stateKey: number[] | Uint8Array;                    // [u8;32]
  stateValue: number[] | Uint8Array;                  // [u8;64]
  updater: PublicKey;
  version: { toString: () => string };                // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawProtocolInitializedEvent {
  authority: PublicKey;
  treasury: PublicKey;
  disputeThreshold: number;                           // u8
  protocolFeeBps: number;                             // u16
  timestamp: { toNumber: () => number };
}

export interface RawRewardDistributedEvent {
  taskId: number[] | Uint8Array;
  recipient: PublicKey;
  amount: { toString: () => string };                 // u64 -> BN
  protocolFee: { toString: () => string };            // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawRateLimitHitEvent {
  agentId: number[] | Uint8Array;                     // [u8;32]
  actionType: number;                                 // u8
  limitType: number;                                  // u8
  currentCount: number;                               // u8
  maxCount: number;                                   // u8
  cooldownRemaining: { toNumber: () => number };      // i64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawMigrationCompletedEvent {
  fromVersion: number;                                // u8
  toVersion: number;                                  // u8
  authority: PublicKey;
  timestamp: { toNumber: () => number };
}

export interface RawProtocolVersionUpdatedEvent {
  oldVersion: number;                                 // u8
  newVersion: number;                                 // u8
  minSupportedVersion: number;                        // u8
  timestamp: { toNumber: () => number };
}

export interface RawRateLimitsUpdatedEvent {
  taskCreationCooldown: { toNumber: () => number };   // i64 -> BN
  maxTasksPer24h: number;                            // u8
  disputeInitiationCooldown: { toNumber: () => number }; // i64 -> BN
  maxDisputesPer24h: number;                         // u8
  minStakeForDispute: { toString: () => string };     // u64 -> BN
  updatedBy: PublicKey;
  timestamp: { toNumber: () => number };
}

export interface RawProtocolFeeUpdatedEvent {
  oldFeeBps: number;                                 // u16
  newFeeBps: number;                                 // u16
  updatedBy: PublicKey;
  timestamp: { toNumber: () => number };
}

export interface RawReputationChangedEvent {
  agentId: number[] | Uint8Array;
  oldReputation: number;                             // u16
  newReputation: number;                             // u16
  reason: number;                                    // u8
  timestamp: { toNumber: () => number };
}

export interface RawBondDepositedEvent {
  agent: PublicKey;
  amount: { toString: () => string };                // u64 -> BN
  newTotal: { toString: () => string };              // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawBondLockedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: { toString: () => string };                // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawBondReleasedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: { toString: () => string };                // u64 -> BN
  timestamp: { toNumber: () => number };
}

export interface RawBondSlashedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: { toString: () => string };                // u64 -> BN
  reason: number;                                    // u8
  timestamp: { toNumber: () => number };
}

export interface RawSpeculativeCommitmentCreatedEvent {
  task: PublicKey;
  producer: PublicKey;
  resultHash: number[] | Uint8Array;                 // [u8; 32]
  bondedStake: { toString: () => string };            // u64 -> BN
  expiresAt: { toNumber: () => number };             // i64 -> BN
  timestamp: { toNumber: () => number };
}

// ============================================================================
// Parsed Event Interfaces (developer-friendly types)
// ============================================================================

// --- Task Parsed Events ---

export interface TaskCreatedEvent {
  taskId: Uint8Array;
  creator: PublicKey;
  requiredCapabilities: bigint;
  rewardAmount: bigint;
  taskType: number;
  deadline: number;
  minReputation: number;
  rewardMint: PublicKey | null;
  timestamp: number;
}

export interface TaskClaimedEvent {
  taskId: Uint8Array;
  worker: PublicKey;
  currentWorkers: number;
  maxWorkers: number;
  timestamp: number;
}

export interface TaskCompletedEvent {
  taskId: Uint8Array;
  worker: PublicKey;
  proofHash: Uint8Array;
  resultData: Uint8Array;
  rewardPaid: bigint;
  timestamp: number;
}

export interface TaskCancelledEvent {
  taskId: Uint8Array;
  creator: PublicKey;
  refundAmount: bigint;
  timestamp: number;
}

export interface DependentTaskCreatedEvent {
  taskId: Uint8Array;
  creator: PublicKey;
  dependsOn: PublicKey;
  dependencyType: number;
  rewardMint: PublicKey | null;
  timestamp: number;
}

// --- Dispute Parsed Events ---

export interface DisputeInitiatedEvent {
  disputeId: Uint8Array;
  taskId: Uint8Array;
  initiator: PublicKey;
  defendant: PublicKey;
  resolutionType: number;
  votingDeadline: number;
  timestamp: number;
}

export interface DisputeVoteCastEvent {
  disputeId: Uint8Array;
  voter: PublicKey;
  approved: boolean;
  votesFor: bigint;
  votesAgainst: bigint;
  timestamp: number;
}

export interface DisputeResolvedEvent {
  disputeId: Uint8Array;
  resolutionType: number;
  outcome: number;
  votesFor: bigint;
  votesAgainst: bigint;
  timestamp: number;
}

export interface DisputeExpiredEvent {
  disputeId: Uint8Array;
  taskId: Uint8Array;
  refundAmount: bigint;
  creatorAmount: bigint;
  workerAmount: bigint;
  timestamp: number;
}

export interface DisputeCancelledEvent {
  disputeId: Uint8Array;
  task: PublicKey;
  initiator: PublicKey;
  cancelledAt: number;
}

export interface ArbiterVotesCleanedUpEvent {
  disputeId: Uint8Array;
  arbiterCount: number;
}

export interface AgentSuspendedEvent {
  agentId: Uint8Array;
  authority: PublicKey;
  timestamp: number;
}

export interface AgentUnsuspendedEvent {
  agentId: Uint8Array;
  authority: PublicKey;
  timestamp: number;
}

// --- Protocol Parsed Events ---

export interface StateUpdatedEvent {
  stateKey: Uint8Array;
  stateValue: Uint8Array;
  updater: PublicKey;
  version: bigint;
  timestamp: number;
}

export interface ProtocolInitializedEvent {
  authority: PublicKey;
  treasury: PublicKey;
  disputeThreshold: number;
  protocolFeeBps: number;
  timestamp: number;
}

export interface RewardDistributedEvent {
  taskId: Uint8Array;
  recipient: PublicKey;
  amount: bigint;
  protocolFee: bigint;
  timestamp: number;
}

export interface RateLimitHitEvent {
  agentId: Uint8Array;
  actionType: number;
  limitType: number;
  currentCount: number;
  maxCount: number;
  cooldownRemaining: number;
  timestamp: number;
}

export interface MigrationCompletedEvent {
  fromVersion: number;
  toVersion: number;
  authority: PublicKey;
  timestamp: number;
}

export interface ProtocolVersionUpdatedEvent {
  oldVersion: number;
  newVersion: number;
  minSupportedVersion: number;
  timestamp: number;
}

export interface RateLimitsUpdatedEvent {
  taskCreationCooldown: number;
  maxTasksPer24h: number;
  disputeInitiationCooldown: number;
  maxDisputesPer24h: number;
  minStakeForDispute: bigint;
  updatedBy: PublicKey;
  timestamp: number;
}

export interface ProtocolFeeUpdatedEvent {
  oldFeeBps: number;
  newFeeBps: number;
  updatedBy: PublicKey;
  timestamp: number;
}

export interface ReputationChangedEvent {
  agentId: Uint8Array;
  oldReputation: number;
  newReputation: number;
  reason: number;
  timestamp: number;
}

export interface BondDepositedEvent {
  agent: PublicKey;
  amount: bigint;
  newTotal: bigint;
  timestamp: number;
}

export interface BondLockedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: bigint;
  timestamp: number;
}

export interface BondReleasedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: bigint;
  timestamp: number;
}

export interface BondSlashedEvent {
  agent: PublicKey;
  commitment: PublicKey;
  amount: bigint;
  reason: number;
  timestamp: number;
}

export interface SpeculativeCommitmentCreatedEvent {
  task: PublicKey;
  producer: PublicKey;
  resultHash: Uint8Array;
  bondedStake: bigint;
  expiresAt: number;
  timestamp: number;
}

// ============================================================================
// Callback Interfaces
// ============================================================================

// --- Task Event Callbacks ---

export interface TaskEventCallbacks {
  onTaskCreated?: EventCallback<TaskCreatedEvent>;
  onTaskClaimed?: EventCallback<TaskClaimedEvent>;
  onTaskCompleted?: EventCallback<TaskCompletedEvent>;
  onTaskCancelled?: EventCallback<TaskCancelledEvent>;
  onDependentTaskCreated?: EventCallback<DependentTaskCreatedEvent>;
}

export interface TaskEventFilterOptions {
  /** Only receive events for this task ID */
  taskId?: Uint8Array;
}

// --- Dispute Event Callbacks ---

export interface DisputeEventCallbacks {
  onDisputeInitiated?: EventCallback<DisputeInitiatedEvent>;
  onDisputeVoteCast?: EventCallback<DisputeVoteCastEvent>;
  onDisputeResolved?: EventCallback<DisputeResolvedEvent>;
  onDisputeExpired?: EventCallback<DisputeExpiredEvent>;
  onDisputeCancelled?: EventCallback<DisputeCancelledEvent>;
  onArbiterVotesCleanedUp?: EventCallback<ArbiterVotesCleanedUpEvent>;
}

export interface DisputeEventFilterOptions {
  /** Only receive events for this dispute ID */
  disputeId?: Uint8Array;
}

// --- Protocol Event Callbacks ---

export interface ProtocolEventCallbacks {
  onStateUpdated?: EventCallback<StateUpdatedEvent>;
  onProtocolInitialized?: EventCallback<ProtocolInitializedEvent>;
  onRewardDistributed?: EventCallback<RewardDistributedEvent>;
  onRateLimitHit?: EventCallback<RateLimitHitEvent>;
  onMigrationCompleted?: EventCallback<MigrationCompletedEvent>;
  onProtocolVersionUpdated?: EventCallback<ProtocolVersionUpdatedEvent>;
  onRateLimitsUpdated?: EventCallback<RateLimitsUpdatedEvent>;
  onProtocolFeeUpdated?: EventCallback<ProtocolFeeUpdatedEvent>;
  onReputationChanged?: EventCallback<ReputationChangedEvent>;
  onBondDeposited?: EventCallback<BondDepositedEvent>;
  onBondLocked?: EventCallback<BondLockedEvent>;
  onBondReleased?: EventCallback<BondReleasedEvent>;
  onBondSlashed?: EventCallback<BondSlashedEvent>;
  onSpeculativeCommitmentCreated?: EventCallback<SpeculativeCommitmentCreatedEvent>;
}

export interface ProtocolEventFilterOptions {
  /** Only receive RateLimitHit events for this agent ID */
  agentId?: Uint8Array;
  /** Only receive RewardDistributed events for this task ID */
  taskId?: Uint8Array;
}
