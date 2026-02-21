/**
 * Phase 2 Event Monitoring
 *
 * Type definitions, parse functions, subscription utilities,
 * and EventMonitor for all non-agent protocol events.
 * Agent events are handled in agent/events.ts (Phase 1).
 *
 * @module
 */

// Types
export {
  // Shared types
  type EventCallback,
  // NOTE: EventSubscription is NOT re-exported here to avoid
  // duplicate export with agent/events.ts path

  // Enums
  TaskType,
  ResolutionType,
  RateLimitActionType,
  RateLimitType,

  // Task event types (parsed)
  type TaskCreatedEvent,
  type TaskClaimedEvent,
  type TaskCompletedEvent,
  type TaskCancelledEvent,
  type DependentTaskCreatedEvent,

  // Dispute event types (parsed)
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,
  type DisputeCancelledEvent,
  type ArbiterVotesCleanedUpEvent,

  // Protocol event types (parsed)
  type StateUpdatedEvent,
  type ProtocolInitializedEvent,
  type RewardDistributedEvent,
  type RateLimitHitEvent,
  type MigrationCompletedEvent,
  type ProtocolVersionUpdatedEvent,
  type RateLimitsUpdatedEvent,
  type ProtocolFeeUpdatedEvent,
  type ReputationChangedEvent,
  type BondDepositedEvent,
  type BondLockedEvent,
  type BondReleasedEvent,
  type BondSlashedEvent,
  type SpeculativeCommitmentCreatedEvent,

  // Callback interfaces
  type TaskEventCallbacks,
  type TaskEventFilterOptions,
  type DisputeEventCallbacks,
  type DisputeEventFilterOptions,
  type ProtocolEventCallbacks,
  type ProtocolEventFilterOptions,
} from "./types.js";

// NOTE: Raw event interfaces (RawTaskCreatedEvent, etc.) are intentionally NOT
// exported from this barrel. They are implementation details used by parse functions
// and subscribe internals. Test files import them directly from './types.js'.

// Parse functions (exported for advanced use cases / testing)
export {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDependentTaskCreatedEvent,
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseDisputeCancelledEvent,
  parseArbiterVotesCleanedUpEvent,
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,
  parseRateLimitsUpdatedEvent,
  parseProtocolFeeUpdatedEvent,
  parseReputationChangedEvent,
  parseBondDepositedEvent,
  parseBondLockedEvent,
  parseBondReleasedEvent,
  parseBondSlashedEvent,
  parseSpeculativeCommitmentCreatedEvent,
} from "./parse.js";

// Task subscriptions
export {
  subscribeToTaskCreated,
  subscribeToTaskClaimed,
  subscribeToTaskCompleted,
  subscribeToTaskCancelled,
  subscribeToDependentTaskCreated,
  subscribeToAllTaskEvents,
} from "./task.js";

// Dispute subscriptions
export {
  subscribeToDisputeInitiated,
  subscribeToDisputeVoteCast,
  subscribeToDisputeResolved,
  subscribeToDisputeExpired,
  subscribeToDisputeCancelled,
  subscribeToArbiterVotesCleanedUp,
  subscribeToAllDisputeEvents,
} from "./dispute.js";

// Protocol subscriptions
export {
  subscribeToStateUpdated,
  subscribeToProtocolInitialized,
  subscribeToRewardDistributed,
  subscribeToRateLimitHit,
  subscribeToMigrationCompleted,
  subscribeToProtocolVersionUpdated,
  subscribeToRateLimitsUpdated,
  subscribeToProtocolFeeUpdated,
  subscribeToReputationChanged,
  subscribeToBondDeposited,
  subscribeToBondLocked,
  subscribeToBondReleased,
  subscribeToBondSlashed,
  subscribeToSpeculativeCommitmentCreated,
  subscribeToAllProtocolEvents,
} from "./protocol.js";

// Event subscription factory
export {
  createEventSubscription,
  type EventSubscriptionConfig,
} from "./factory.js";

// EventMonitor class
export {
  EventMonitor,
  type EventMonitorConfig,
  type EventMonitorMetrics,
} from "./monitor.js";
