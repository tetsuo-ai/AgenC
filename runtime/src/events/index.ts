/**
 * Phase 2 Event Monitoring
 *
 * Type definitions and parse functions for all non-agent protocol events.
 * Agent events are handled in agent/events.ts (Phase 1).
 *
 * @module
 */

export {
  // Enums
  TaskType,
  ResolutionType,
  RateLimitActionType,
  RateLimitType,
  // Shared types
  type EventCallback,
  type EventSubscription,
  // Task raw events
  type RawTaskCreatedEvent,
  type RawTaskClaimedEvent,
  type RawTaskCompletedEvent,
  type RawTaskCancelledEvent,
  // Dispute raw events
  type RawDisputeInitiatedEvent,
  type RawDisputeVoteCastEvent,
  type RawDisputeResolvedEvent,
  type RawDisputeExpiredEvent,
  // Protocol raw events
  type RawStateUpdatedEvent,
  type RawProtocolInitializedEvent,
  type RawRewardDistributedEvent,
  type RawRateLimitHitEvent,
  type RawMigrationCompletedEvent,
  type RawProtocolVersionUpdatedEvent,
  // Task parsed events
  type TaskCreatedEvent,
  type TaskClaimedEvent,
  type TaskCompletedEvent,
  type TaskCancelledEvent,
  // Dispute parsed events
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  // Protocol parsed events
  type StateUpdatedEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type MigrationCompletedEvent,
  type ProtocolVersionUpdatedEvent,
  // Callback interfaces
  type TaskEventCallbacks,
  type TaskEventFilterOptions,
  type DisputeEventCallbacks,
  type DisputeEventFilterOptions,
  type ProtocolEventCallbacks,
  type ProtocolEventFilterOptions,
} from './types.js';

export {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,
} from './parse.js';
