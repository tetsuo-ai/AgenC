/**
 * Event subscription factory
 *
 * Reduces boilerplate across event subscription modules by extracting
 * the common addEventListener → parse → filter → callback pattern.
 *
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import { agentIdsEqual } from '../utils/encoding.js';
import type { EventSubscription } from './types.js';

/**
 * Configuration for a single event subscription.
 *
 * @typeParam TRaw - Raw event type from Anchor
 * @typeParam TParsed - Parsed event type
 * @typeParam TOptions - Filter options type
 */
export interface EventSubscriptionConfig<TRaw, TParsed, TOptions> {
  /** Anchor event name (camelCase) */
  eventName: string;
  /** Parse raw Anchor event to typed form */
  parse: (raw: TRaw) => TParsed;
  /** Extract the filterable ID from the parsed event (e.g., event.taskId) */
  getFilterId?: (event: TParsed) => Uint8Array;
  /** Extract the filter value from options (e.g., options.taskId) */
  getFilterValue?: (options: TOptions) => Uint8Array | undefined;
}

/**
 * Generic event callback type matching EventCallback<T> from types.ts.
 */
type Callback<T> = (event: T, slot: number, signature: string) => void;

type EventProgram = {
  addEventListener(
    eventName: string,
    callback: (event: unknown, slot: number, signature: string) => void,
  ): number;
  removeEventListener(listenerId: number): Promise<void>;
};

/**
 * Create an event subscription using the common pattern:
 * addEventListener → parse → filter → callback.
 *
 * @param program - The Anchor program instance
 * @param config - Event subscription configuration
 * @param callback - User callback for matching events
 * @param options - Optional filter options
 * @returns Subscription handle for unsubscribing
 */
export function createEventSubscription<TRaw, TParsed, TOptions>(
  program: Program<AgencCoordination>,
  config: EventSubscriptionConfig<TRaw, TParsed, TOptions>,
  callback: Callback<TParsed>,
  options?: TOptions,
): EventSubscription {
  // Avoid deep generic instantiation from the generated Anchor IDL event union.
  const eventProgram = program as unknown as EventProgram;
  const listenerId = eventProgram.addEventListener(
    config.eventName,
    (rawEvent: unknown, slot: number, signature: string) => {
      const event = config.parse(rawEvent as TRaw);

      // Apply filter if configured and options provided
      if (options && config.getFilterId && config.getFilterValue) {
        const filterValue = config.getFilterValue(options);
        if (filterValue) {
          const eventId = config.getFilterId(event);
          if (!agentIdsEqual(eventId, filterValue)) return;
        }
      }

      callback(event, slot, signature);
    },
  );

  return {
    unsubscribe: async () => {
      await eventProgram.removeEventListener(listenerId);
    },
  };
}
