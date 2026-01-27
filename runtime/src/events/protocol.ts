/**
 * Protocol event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import { agentIdsEqual } from '../utils/encoding.js';
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
  const listenerId = program.addEventListener(
    'stateUpdated',
    (rawEvent: RawStateUpdatedEvent, slot: number, signature: string) => {
      const event = parseStateUpdatedEvent(rawEvent);
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
  const listenerId = program.addEventListener(
    'protocolInitialized',
    (rawEvent: RawProtocolInitializedEvent, slot: number, signature: string) => {
      const event = parseProtocolInitializedEvent(rawEvent);
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
  const listenerId = program.addEventListener(
    'rewardDistributed',
    (rawEvent: RawRewardDistributedEvent, slot: number, signature: string) => {
      const event = parseRewardDistributedEvent(rawEvent);
      if (options?.taskId && !agentIdsEqual(event.taskId, options.taskId)) return;
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
  const listenerId = program.addEventListener(
    'rateLimitHit',
    (rawEvent: RawRateLimitHitEvent, slot: number, signature: string) => {
      const event = parseRateLimitHitEvent(rawEvent);
      if (options?.agentId && !agentIdsEqual(event.agentId, options.agentId)) return;
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
  const listenerId = program.addEventListener(
    'migrationCompleted',
    (rawEvent: RawMigrationCompletedEvent, slot: number, signature: string) => {
      const event = parseMigrationCompletedEvent(rawEvent);
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
  const listenerId = program.addEventListener(
    'protocolVersionUpdated',
    (rawEvent: RawProtocolVersionUpdatedEvent, slot: number, signature: string) => {
      const event = parseProtocolVersionUpdatedEvent(rawEvent);
      callback(event, slot, signature);
    }
  );
  return {
    unsubscribe: async () => {
      await program.removeEventListener(listenerId);
    },
  };
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
