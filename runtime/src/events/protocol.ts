/**
 * Protocol event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type {
  EventCallback,
  EventSubscription,
  StateUpdatedEvent,
  ProtocolInitializedEvent,
  RewardDistributedEvent,
  RateLimitHitEvent,
  MigrationCompletedEvent,
  ProtocolVersionUpdatedEvent,
  ProtocolEventCallbacks,
  ProtocolEventFilterOptions,
  RawStateUpdatedEvent,
  RawProtocolInitializedEvent,
  RawRewardDistributedEvent,
  RawRateLimitHitEvent,
  RawMigrationCompletedEvent,
  RawProtocolVersionUpdatedEvent,
} from './types.js';
import {
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,
} from './parse.js';
import { createEventSubscription } from './factory.js';

/**
 * Subscribes to StateUpdated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when shared state is updated
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToStateUpdated(
  program: Program<AgencCoordination>,
  callback: EventCallback<StateUpdatedEvent>,
): EventSubscription {
  return createEventSubscription<RawStateUpdatedEvent, StateUpdatedEvent, never>(
    program,
    { eventName: 'stateUpdated', parse: parseStateUpdatedEvent },
    callback,
  );
}

/**
 * Subscribes to ProtocolInitialized events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when the protocol is initialized
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToProtocolInitialized(
  program: Program<AgencCoordination>,
  callback: EventCallback<ProtocolInitializedEvent>,
): EventSubscription {
  return createEventSubscription<RawProtocolInitializedEvent, ProtocolInitializedEvent, never>(
    program,
    { eventName: 'protocolInitialized', parse: parseProtocolInitializedEvent },
    callback,
  );
}

/**
 * Subscribes to RewardDistributed events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a reward is distributed
 * @param options - Optional filtering options (taskId filter)
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToRewardDistributed(
  program: Program<AgencCoordination>,
  callback: EventCallback<RewardDistributedEvent>,
  options?: ProtocolEventFilterOptions,
): EventSubscription {
  return createEventSubscription<RawRewardDistributedEvent, RewardDistributedEvent, ProtocolEventFilterOptions>(
    program,
    {
      eventName: 'rewardDistributed',
      parse: parseRewardDistributedEvent,
      getFilterId: (event) => event.taskId,
      getFilterValue: (opts) => opts.taskId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to RateLimitHit events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a rate limit is hit
 * @param options - Optional filtering options (agentId filter)
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToRateLimitHit(
  program: Program<AgencCoordination>,
  callback: EventCallback<RateLimitHitEvent>,
  options?: ProtocolEventFilterOptions,
): EventSubscription {
  return createEventSubscription<RawRateLimitHitEvent, RateLimitHitEvent, ProtocolEventFilterOptions>(
    program,
    {
      eventName: 'rateLimitHit',
      parse: parseRateLimitHitEvent,
      getFilterId: (event) => event.agentId,
      getFilterValue: (opts) => opts.agentId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to MigrationCompleted events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a migration completes
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToMigrationCompleted(
  program: Program<AgencCoordination>,
  callback: EventCallback<MigrationCompletedEvent>,
): EventSubscription {
  return createEventSubscription<RawMigrationCompletedEvent, MigrationCompletedEvent, never>(
    program,
    { eventName: 'migrationCompleted', parse: parseMigrationCompletedEvent },
    callback,
  );
}

/**
 * Subscribes to ProtocolVersionUpdated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when the protocol version is updated
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToProtocolVersionUpdated(
  program: Program<AgencCoordination>,
  callback: EventCallback<ProtocolVersionUpdatedEvent>,
): EventSubscription {
  return createEventSubscription<RawProtocolVersionUpdatedEvent, ProtocolVersionUpdatedEvent, never>(
    program,
    { eventName: 'protocolVersionUpdated', parse: parseProtocolVersionUpdatedEvent },
    callback,
  );
}

/**
 * Subscribes to all protocol-related events with a single subscription object.
 *
 * @param program - The Anchor program instance
 * @param callbacks - Object containing callback functions for each event type
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing from all events
 */
export function subscribeToAllProtocolEvents(
  program: Program<AgencCoordination>,
  callbacks: ProtocolEventCallbacks,
  options?: ProtocolEventFilterOptions,
): EventSubscription {
  const subscriptions: EventSubscription[] = [];

  if (callbacks.onStateUpdated) {
    subscriptions.push(subscribeToStateUpdated(program, callbacks.onStateUpdated));
  }
  if (callbacks.onProtocolInitialized) {
    subscriptions.push(subscribeToProtocolInitialized(program, callbacks.onProtocolInitialized));
  }
  if (callbacks.onRewardDistributed) {
    subscriptions.push(subscribeToRewardDistributed(program, callbacks.onRewardDistributed, options));
  }
  if (callbacks.onRateLimitHit) {
    subscriptions.push(subscribeToRateLimitHit(program, callbacks.onRateLimitHit, options));
  }
  if (callbacks.onMigrationCompleted) {
    subscriptions.push(subscribeToMigrationCompleted(program, callbacks.onMigrationCompleted));
  }
  if (callbacks.onProtocolVersionUpdated) {
    subscriptions.push(subscribeToProtocolVersionUpdated(program, callbacks.onProtocolVersionUpdated));
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map(s => s.unsubscribe()));
    },
  };
}
