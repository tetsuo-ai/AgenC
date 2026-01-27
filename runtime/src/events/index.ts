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

  // Dispute event types (parsed)
  type DisputeInitiatedEvent,
  type DisputeVoteCastEvent,
  type DisputeResolvedEvent,
  type DisputeExpiredEvent,

  // Protocol event types (parsed)
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

// NOTE: Raw event interfaces (RawTaskCreatedEvent, etc.) are intentionally NOT
// exported from this barrel. They are implementation details used by parse functions
// and subscribe internals. Test files import them directly from './types.js'.

// Parse functions (exported for advanced use cases / testing)
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

// Task subscriptions
export {
  subscribeToTaskCreated,
  subscribeToTaskClaimed,
  subscribeToTaskCompleted,
  subscribeToTaskCancelled,
  subscribeToAllTaskEvents,
} from './task.js';

// Dispute subscriptions
export {
  subscribeToDisputeInitiated,
  subscribeToDisputeVoteCast,
  subscribeToDisputeResolved,
  subscribeToDisputeExpired,
  subscribeToAllDisputeEvents,
} from './dispute.js';

// Protocol subscriptions
export {
  subscribeToStateUpdated,
  subscribeToProtocolInitialized,
  subscribeToRewardDistributed,
  subscribeToRateLimitHit,
  subscribeToMigrationCompleted,
  subscribeToProtocolVersionUpdated,
  subscribeToAllProtocolEvents,
} from './protocol.js';

// EventMonitor class
export {
  EventMonitor,
  type EventMonitorConfig,
  type EventMonitorMetrics,
} from './monitor.js';
