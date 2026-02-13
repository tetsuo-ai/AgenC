/**
 * Dispute event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type {
  EventCallback,
  EventSubscription,
  DisputeInitiatedEvent,
  DisputeVoteCastEvent,
  DisputeResolvedEvent,
  DisputeExpiredEvent,
  DisputeCancelledEvent,
  ArbiterVotesCleanedUpEvent,
  DisputeEventCallbacks,
  DisputeEventFilterOptions,
  RawDisputeInitiatedEvent,
  RawDisputeVoteCastEvent,
  RawDisputeResolvedEvent,
  RawDisputeExpiredEvent,
  RawDisputeCancelledEvent,
  RawArbiterVotesCleanedUpEvent,
} from './types.js';
import {
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseDisputeCancelledEvent,
  parseArbiterVotesCleanedUpEvent,
} from './parse.js';
import { createEventSubscription } from './factory.js';

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
  return createEventSubscription<RawDisputeInitiatedEvent, DisputeInitiatedEvent, DisputeEventFilterOptions>(
    program,
    {
      eventName: 'disputeInitiated',
      parse: parseDisputeInitiatedEvent,
      getFilterId: (event) => event.disputeId,
      getFilterValue: (opts) => opts.disputeId,
    },
    callback,
    options,
  );
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
  return createEventSubscription<RawDisputeVoteCastEvent, DisputeVoteCastEvent, DisputeEventFilterOptions>(
    program,
    {
      eventName: 'disputeVoteCast',
      parse: parseDisputeVoteCastEvent,
      getFilterId: (event) => event.disputeId,
      getFilterValue: (opts) => opts.disputeId,
    },
    callback,
    options,
  );
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
  return createEventSubscription<RawDisputeResolvedEvent, DisputeResolvedEvent, DisputeEventFilterOptions>(
    program,
    {
      eventName: 'disputeResolved',
      parse: parseDisputeResolvedEvent,
      getFilterId: (event) => event.disputeId,
      getFilterValue: (opts) => opts.disputeId,
    },
    callback,
    options,
  );
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
  return createEventSubscription<RawDisputeExpiredEvent, DisputeExpiredEvent, DisputeEventFilterOptions>(
    program,
    {
      eventName: 'disputeExpired',
      parse: parseDisputeExpiredEvent,
      getFilterId: (event) => event.disputeId,
      getFilterValue: (opts) => opts.disputeId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to DisputeCancelled events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dispute is cancelled
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDisputeCancelled(
  program: Program<AgencCoordination>,
  callback: EventCallback<DisputeCancelledEvent>
): EventSubscription {
  return createEventSubscription<RawDisputeCancelledEvent, DisputeCancelledEvent, never>(
    program,
    {
      eventName: 'disputeCancelled',
      parse: parseDisputeCancelledEvent,
    },
    callback,
  );
}

/**
 * Subscribes to ArbiterVotesCleanedUp events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when arbiter votes are cleaned up
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToArbiterVotesCleanedUp(
  program: Program<AgencCoordination>,
  callback: EventCallback<ArbiterVotesCleanedUpEvent>
): EventSubscription {
  return createEventSubscription<RawArbiterVotesCleanedUpEvent, ArbiterVotesCleanedUpEvent, never>(
    program,
    {
      eventName: 'arbiterVotesCleanedUp',
      parse: parseArbiterVotesCleanedUpEvent,
    },
    callback,
  );
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
  if (callbacks.onDisputeCancelled) {
    subscriptions.push(subscribeToDisputeCancelled(program, callbacks.onDisputeCancelled));
  }
  if (callbacks.onArbiterVotesCleanedUp) {
    subscriptions.push(subscribeToArbiterVotesCleanedUp(program, callbacks.onArbiterVotesCleanedUp));
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map(s => s.unsubscribe()));
    },
  };
}
