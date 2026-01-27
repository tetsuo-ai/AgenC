/**
 * Dispute event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import { agentIdsEqual } from '../utils/encoding.js';
import type {
  EventCallback,
  EventSubscription,
  DisputeInitiatedEvent,
  DisputeVoteCastEvent,
  DisputeResolvedEvent,
  DisputeExpiredEvent,
  DisputeEventCallbacks,
  DisputeEventFilterOptions,
  RawDisputeInitiatedEvent,
  RawDisputeVoteCastEvent,
  RawDisputeResolvedEvent,
  RawDisputeExpiredEvent,
} from './types.js';
import {
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
} from './parse.js';

/**
 * Subscribes to DisputeInitiated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dispute is initiated
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDisputeInitiated(
  program: Program<AgencCoordination>,
  callback: EventCallback<DisputeInitiatedEvent>,
  options?: DisputeEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'disputeInitiated',
    (rawEvent: RawDisputeInitiatedEvent, slot: number, signature: string) => {
      const event = parseDisputeInitiatedEvent(rawEvent);
      if (options?.disputeId && !agentIdsEqual(event.disputeId, options.disputeId)) return;
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
 * Subscribes to DisputeVoteCast events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dispute vote is cast
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDisputeVoteCast(
  program: Program<AgencCoordination>,
  callback: EventCallback<DisputeVoteCastEvent>,
  options?: DisputeEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'disputeVoteCast',
    (rawEvent: RawDisputeVoteCastEvent, slot: number, signature: string) => {
      const event = parseDisputeVoteCastEvent(rawEvent);
      if (options?.disputeId && !agentIdsEqual(event.disputeId, options.disputeId)) return;
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
 * Subscribes to DisputeResolved events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dispute is resolved
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDisputeResolved(
  program: Program<AgencCoordination>,
  callback: EventCallback<DisputeResolvedEvent>,
  options?: DisputeEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'disputeResolved',
    (rawEvent: RawDisputeResolvedEvent, slot: number, signature: string) => {
      const event = parseDisputeResolvedEvent(rawEvent);
      if (options?.disputeId && !agentIdsEqual(event.disputeId, options.disputeId)) return;
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
 * Subscribes to DisputeExpired events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dispute expires
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDisputeExpired(
  program: Program<AgencCoordination>,
  callback: EventCallback<DisputeExpiredEvent>,
  options?: DisputeEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'disputeExpired',
    (rawEvent: RawDisputeExpiredEvent, slot: number, signature: string) => {
      const event = parseDisputeExpiredEvent(rawEvent);
      if (options?.disputeId && !agentIdsEqual(event.disputeId, options.disputeId)) return;
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
 * Subscribes to all dispute-related events with a single subscription object.
 *
 * @param program - The Anchor program instance
 * @param callbacks - Object containing callback functions for each event type
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing from all events
 */
export function subscribeToAllDisputeEvents(
  program: Program<AgencCoordination>,
  callbacks: DisputeEventCallbacks,
  options?: DisputeEventFilterOptions
): EventSubscription {
  const subscriptions: EventSubscription[] = [];

  if (callbacks.onDisputeInitiated) {
    subscriptions.push(subscribeToDisputeInitiated(program, callbacks.onDisputeInitiated, options));
  }
  if (callbacks.onDisputeVoteCast) {
    subscriptions.push(subscribeToDisputeVoteCast(program, callbacks.onDisputeVoteCast, options));
  }
  if (callbacks.onDisputeResolved) {
    subscriptions.push(subscribeToDisputeResolved(program, callbacks.onDisputeResolved, options));
  }
  if (callbacks.onDisputeExpired) {
    subscriptions.push(subscribeToDisputeExpired(program, callbacks.onDisputeExpired, options));
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map(s => s.unsubscribe()));
    },
  };
}
