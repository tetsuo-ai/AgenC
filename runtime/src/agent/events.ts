/**
 * Agent event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type {
  AgentRegisteredEvent,
  AgentUpdatedEvent,
  AgentDeregisteredEvent,
} from './types.js';
import type { EventSubscription } from '../events/types.js';
export type { EventSubscription };
import { createEventSubscription } from '../events/factory.js';

/**
 * Callback type for event handlers.
 * @typeParam T - The event type
 */
export type AgentEventCallback<T> = (event: T, slot: number, signature: string) => void;

/**
 * Callbacks for all agent events (used with subscribeToAllAgentEvents)
 */
export interface AgentEventCallbacks {
  /** Called when a new agent is registered */
  onRegistered?: AgentEventCallback<AgentRegisteredEvent>;
  /** Called when an agent is updated */
  onUpdated?: AgentEventCallback<AgentUpdatedEvent>;
  /** Called when an agent is deregistered */
  onDeregistered?: AgentEventCallback<AgentDeregisteredEvent>;
}

/**
 * Options for event subscription
 */
export interface EventSubscriptionOptions {
  /** Optional filter: only receive events for this agent ID */
  agentId?: Uint8Array;
}

/**
 * Raw event data from Anchor (before parsing)
 */
interface RawAgentRegisteredEvent {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  capabilities: { toString: () => string };
  endpoint: string;
  timestamp: { toNumber: () => number };
}

interface RawAgentUpdatedEvent {
  agentId: number[] | Uint8Array;
  capabilities: { toString: () => string };
  status: number;
  timestamp: { toNumber: () => number };
}

interface RawAgentDeregisteredEvent {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  timestamp: { toNumber: () => number };
}

/**
 * Converts array-like value to Uint8Array
 */
function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

/**
 * Parses a raw AgentRegistered event into typed form
 */
function parseAgentRegisteredEvent(raw: RawAgentRegisteredEvent): AgentRegisteredEvent {
  return {
    agentId: toUint8Array(raw.agentId),
    authority: raw.authority,
    capabilities: BigInt(raw.capabilities.toString()),
    endpoint: raw.endpoint,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw AgentUpdated event into typed form
 */
function parseAgentUpdatedEvent(raw: RawAgentUpdatedEvent): AgentUpdatedEvent {
  return {
    agentId: toUint8Array(raw.agentId),
    capabilities: BigInt(raw.capabilities.toString()),
    status: raw.status,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Parses a raw AgentDeregistered event into typed form
 */
function parseAgentDeregisteredEvent(raw: RawAgentDeregisteredEvent): AgentDeregisteredEvent {
  return {
    agentId: toUint8Array(raw.agentId),
    authority: raw.authority,
    timestamp: raw.timestamp.toNumber(),
  };
}

/**
 * Subscribes to AgentRegistered events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when an agent is registered
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 *
 * @example
 * ```typescript
 * const subscription = subscribeToAgentRegistered(program, (event, slot, sig) => {
 *   console.log(`Agent ${bytesToHex(event.agentId)} registered at slot ${slot}`);
 * });
 *
 * // Later: unsubscribe
 * await subscription.unsubscribe();
 * ```
 */
export function subscribeToAgentRegistered(
  program: Program<AgencCoordination>,
  callback: AgentEventCallback<AgentRegisteredEvent>,
  options?: EventSubscriptionOptions
): EventSubscription {
  return createEventSubscription<RawAgentRegisteredEvent, AgentRegisteredEvent, EventSubscriptionOptions>(
    program,
    {
      eventName: 'agentRegistered',
      parse: parseAgentRegisteredEvent,
      getFilterId: (event) => event.agentId,
      getFilterValue: (opts) => opts.agentId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to AgentUpdated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when an agent is updated
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 *
 * @example
 * ```typescript
 * const subscription = subscribeToAgentUpdated(program, (event, slot, sig) => {
 *   console.log(`Agent ${bytesToHex(event.agentId)} updated to status ${event.status}`);
 * });
 * ```
 */
export function subscribeToAgentUpdated(
  program: Program<AgencCoordination>,
  callback: AgentEventCallback<AgentUpdatedEvent>,
  options?: EventSubscriptionOptions
): EventSubscription {
  return createEventSubscription<RawAgentUpdatedEvent, AgentUpdatedEvent, EventSubscriptionOptions>(
    program,
    {
      eventName: 'agentUpdated',
      parse: parseAgentUpdatedEvent,
      getFilterId: (event) => event.agentId,
      getFilterValue: (opts) => opts.agentId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to AgentDeregistered events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when an agent is deregistered
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 *
 * @example
 * ```typescript
 * const subscription = subscribeToAgentDeregistered(program, (event, slot, sig) => {
 *   console.log(`Agent ${bytesToHex(event.agentId)} deregistered`);
 * });
 * ```
 */
export function subscribeToAgentDeregistered(
  program: Program<AgencCoordination>,
  callback: AgentEventCallback<AgentDeregisteredEvent>,
  options?: EventSubscriptionOptions
): EventSubscription {
  return createEventSubscription<RawAgentDeregisteredEvent, AgentDeregisteredEvent, EventSubscriptionOptions>(
    program,
    {
      eventName: 'agentDeregistered',
      parse: parseAgentDeregisteredEvent,
      getFilterId: (event) => event.agentId,
      getFilterValue: (opts) => opts.agentId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to all agent-related events with a single subscription object.
 *
 * @param program - The Anchor program instance
 * @param callbacks - Object containing callback functions for each event type
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing from all events
 *
 * @example
 * ```typescript
 * const subscription = subscribeToAllAgentEvents(program, {
 *   onRegistered: (event, slot) => console.log('Agent registered:', event.agentId),
 *   onUpdated: (event, slot) => console.log('Agent updated:', event.status),
 *   onDeregistered: (event, slot) => console.log('Agent deregistered:', event.agentId),
 * });
 *
 * // Later: unsubscribe from all
 * await subscription.unsubscribe();
 * ```
 */
export function subscribeToAllAgentEvents(
  program: Program<AgencCoordination>,
  callbacks: AgentEventCallbacks,
  options?: EventSubscriptionOptions
): EventSubscription {
  const subscriptions: EventSubscription[] = [];

  // Subscribe to each event type if callback is provided
  if (callbacks.onRegistered) {
    subscriptions.push(
      subscribeToAgentRegistered(program, callbacks.onRegistered, options)
    );
  }

  if (callbacks.onUpdated) {
    subscriptions.push(
      subscribeToAgentUpdated(program, callbacks.onUpdated, options)
    );
  }

  if (callbacks.onDeregistered) {
    subscriptions.push(
      subscribeToAgentDeregistered(program, callbacks.onDeregistered, options)
    );
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map((sub) => sub.unsubscribe()));
    },
  };
}
