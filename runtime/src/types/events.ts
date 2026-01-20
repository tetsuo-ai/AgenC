/**
 * Event type definitions for @agenc/runtime
 *
 * Matches the 17 events defined in programs/agenc-coordination/src/events.rs
 */

import { PublicKey } from '@solana/web3.js';

/**
 * All supported event types
 */
export type EventType =
  | 'agentRegistered'
  | 'agentUpdated'
  | 'agentDeregistered'
  | 'taskCreated'
  | 'taskClaimed'
  | 'taskCompleted'
  | 'taskCancelled'
  | 'stateUpdated'
  | 'disputeInitiated'
  | 'disputeVoteCast'
  | 'disputeResolved'
  | 'disputeExpired'
  | 'protocolInitialized'
  | 'rewardDistributed'
  | 'rateLimitHit'
  | 'migrationCompleted'
  | 'protocolVersionUpdated';

// ============================================================================
// Agent Events
// ============================================================================

export interface AgentRegisteredEvent {
  agentId: Buffer;
  authority: PublicKey;
  capabilities: bigint;
  endpoint: string;
  stake: bigint;
  timestamp: number;
}

export interface AgentUpdatedEvent {
  agentId: Buffer;
  capabilities: bigint;
  status: number;
  endpoint: string;
  timestamp: number;
}

export interface AgentDeregisteredEvent {
  agentId: Buffer;
  authority: PublicKey;
  stakeReturned: bigint;
  timestamp: number;
}

// ============================================================================
// Task Events
// ============================================================================

export interface TaskCreatedEvent {
  taskId: Buffer;
  creator: PublicKey;
  requiredCapabilities: bigint;
  rewardAmount: bigint;
  taskType: number;
  deadline: number;
  timestamp: number;
}

export interface TaskClaimedEvent {
  taskId: Buffer;
  worker: PublicKey;
  currentWorkers: number;
  maxWorkers: number;
  timestamp: number;
}

export interface TaskCompletedEvent {
  taskId: Buffer;
  worker: PublicKey;
  proofHash: Buffer;
  rewardPaid: bigint;
  timestamp: number;
}

export interface TaskCancelledEvent {
  taskId: Buffer;
  creator: PublicKey;
  refundAmount: bigint;
  timestamp: number;
}

// ============================================================================
// State Events
// ============================================================================

export interface StateUpdatedEvent {
  stateKey: Buffer;
  updater: PublicKey;
  version: bigint;
  timestamp: number;
}

// ============================================================================
// Dispute Events
// ============================================================================

export interface DisputeInitiatedEvent {
  disputeId: Buffer;
  taskId: Buffer;
  initiator: PublicKey;
  resolutionType: number;
  votingDeadline: number;
  timestamp: number;
}

export interface DisputeVoteCastEvent {
  disputeId: Buffer;
  voter: PublicKey;
  approved: boolean;
  votesFor: bigint;
  votesAgainst: bigint;
  timestamp: number;
}

export interface DisputeResolvedEvent {
  disputeId: Buffer;
  taskId: Buffer;
  resolutionType: number;
  votesFor: bigint;
  votesAgainst: bigint;
  timestamp: number;
}

export interface DisputeExpiredEvent {
  disputeId: Buffer;
  taskId: Buffer;
  refundAmount: bigint;
  timestamp: number;
}

// ============================================================================
// Protocol Events
// ============================================================================

export interface ProtocolInitializedEvent {
  authority: PublicKey;
  treasury: PublicKey;
  disputeThreshold: number;
  protocolFeeBps: number;
  timestamp: number;
}

export interface RewardDistributedEvent {
  taskId: Buffer;
  recipient: PublicKey;
  amount: bigint;
  protocolFee: bigint;
  timestamp: number;
}

export interface RateLimitHitEvent {
  agentId: Buffer;
  actionType: number; // 0 = task_creation, 1 = dispute_initiation
  limitType: number; // 0 = cooldown, 1 = 24h_window
  currentCount: number;
  maxCount: number;
  cooldownRemaining: number;
  timestamp: number;
}

export interface MigrationCompletedEvent {
  fromVersion: number;
  toVersion: number;
  accountsMigrated: number;
  timestamp: number;
}

export interface ProtocolVersionUpdatedEvent {
  oldVersion: number;
  newVersion: number;
  timestamp: number;
}

// ============================================================================
// Event Map
// ============================================================================

export interface EventMap {
  agentRegistered: AgentRegisteredEvent;
  agentUpdated: AgentUpdatedEvent;
  agentDeregistered: AgentDeregisteredEvent;
  taskCreated: TaskCreatedEvent;
  taskClaimed: TaskClaimedEvent;
  taskCompleted: TaskCompletedEvent;
  taskCancelled: TaskCancelledEvent;
  stateUpdated: StateUpdatedEvent;
  disputeInitiated: DisputeInitiatedEvent;
  disputeVoteCast: DisputeVoteCastEvent;
  disputeResolved: DisputeResolvedEvent;
  disputeExpired: DisputeExpiredEvent;
  protocolInitialized: ProtocolInitializedEvent;
  rewardDistributed: RewardDistributedEvent;
  rateLimitHit: RateLimitHitEvent;
  migrationCompleted: MigrationCompletedEvent;
  protocolVersionUpdated: ProtocolVersionUpdatedEvent;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends EventType> = (event: EventMap[T]) => void | Promise<void>;

/**
 * All event handlers
 */
export type EventHandlers = {
  [K in EventType]?: EventHandler<K>;
};

/**
 * Runtime-specific events (not on-chain)
 */
export type RuntimeEventType =
  | 'started'
  | 'stopped'
  | 'taskFound'
  | 'taskClaimed'
  | 'taskExecuting'
  | 'taskCompleted'
  | 'taskFailed'
  | 'error'
  | 'reconnecting'
  | 'reconnected';

export interface RuntimeStartedEvent {
  type: 'started';
  agentId: Buffer;
  mode: string;
  timestamp: number;
}

export interface RuntimeStoppedEvent {
  type: 'stopped';
  agentId: Buffer;
  completedCount: number;
  failedCount: number;
  timestamp: number;
}

export interface RuntimeTaskFoundEvent {
  type: 'taskFound';
  taskId: Buffer;
  rewardAmount: bigint;
  deadline: number;
}

export interface RuntimeTaskClaimedEvent {
  type: 'taskClaimed';
  taskId: Buffer;
  claimPda: PublicKey;
}

export interface RuntimeTaskExecutingEvent {
  type: 'taskExecuting';
  taskId: Buffer;
  startedAt: number;
}

export interface RuntimeTaskCompletedEvent {
  type: 'taskCompleted';
  taskId: Buffer;
  txSignature: string;
  rewardPaid: bigint;
}

export interface RuntimeTaskFailedEvent {
  type: 'taskFailed';
  taskId: Buffer;
  error: Error;
}

export interface RuntimeErrorEvent {
  type: 'error';
  error: Error;
  context?: string;
}

export interface RuntimeReconnectingEvent {
  type: 'reconnecting';
  attempt: number;
  maxAttempts: number;
}

export interface RuntimeReconnectedEvent {
  type: 'reconnected';
  attempt: number;
}

export type RuntimeEvent =
  | RuntimeStartedEvent
  | RuntimeStoppedEvent
  | RuntimeTaskFoundEvent
  | RuntimeTaskClaimedEvent
  | RuntimeTaskExecutingEvent
  | RuntimeTaskCompletedEvent
  | RuntimeTaskFailedEvent
  | RuntimeErrorEvent
  | RuntimeReconnectingEvent
  | RuntimeReconnectedEvent;

export type RuntimeEventListener = (event: RuntimeEvent) => void;
