/**
 * Protocol event subscription utilities
 * @module
 */

import { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type {
  EventCallback,
  EventSubscription,
  StateUpdatedEvent,
  ProtocolInitializedEvent,
  RewardDistributedEvent,
  RateLimitHitEvent,
  MigrationCompletedEvent,
  ProtocolVersionUpdatedEvent,
  RateLimitsUpdatedEvent,
  ProtocolFeeUpdatedEvent,
  ReputationChangedEvent,
  BondDepositedEvent,
  BondLockedEvent,
  BondReleasedEvent,
  BondSlashedEvent,
  SpeculativeCommitmentCreatedEvent,
  ProtocolEventCallbacks,
  ProtocolEventFilterOptions,
  RawStateUpdatedEvent,
  RawProtocolInitializedEvent,
  RawRewardDistributedEvent,
  RawRateLimitHitEvent,
  RawMigrationCompletedEvent,
  RawProtocolVersionUpdatedEvent,
  RawRateLimitsUpdatedEvent,
  RawProtocolFeeUpdatedEvent,
  RawReputationChangedEvent,
  RawBondDepositedEvent,
  RawBondLockedEvent,
  RawBondReleasedEvent,
  RawBondSlashedEvent,
  RawSpeculativeCommitmentCreatedEvent,
} from "./types.js";
import {
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
import { createEventSubscription } from "./factory.js";

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
  return createEventSubscription<
    RawStateUpdatedEvent,
    StateUpdatedEvent,
    never
  >(
    program,
    { eventName: "stateUpdated", parse: parseStateUpdatedEvent },
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
  return createEventSubscription<
    RawProtocolInitializedEvent,
    ProtocolInitializedEvent,
    never
  >(
    program,
    { eventName: "protocolInitialized", parse: parseProtocolInitializedEvent },
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
  return createEventSubscription<
    RawRewardDistributedEvent,
    RewardDistributedEvent,
    ProtocolEventFilterOptions
  >(
    program,
    {
      eventName: "rewardDistributed",
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
  return createEventSubscription<
    RawRateLimitHitEvent,
    RateLimitHitEvent,
    ProtocolEventFilterOptions
  >(
    program,
    {
      eventName: "rateLimitHit",
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
  return createEventSubscription<
    RawMigrationCompletedEvent,
    MigrationCompletedEvent,
    never
  >(
    program,
    { eventName: "migrationCompleted", parse: parseMigrationCompletedEvent },
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
  return createEventSubscription<
    RawProtocolVersionUpdatedEvent,
    ProtocolVersionUpdatedEvent,
    never
  >(
    program,
    {
      eventName: "protocolVersionUpdated",
      parse: parseProtocolVersionUpdatedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to RateLimitsUpdated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when rate limits are updated
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToRateLimitsUpdated(
  program: Program<AgencCoordination>,
  callback: EventCallback<RateLimitsUpdatedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawRateLimitsUpdatedEvent,
    RateLimitsUpdatedEvent,
    never
  >(
    program,
    {
      eventName: "rateLimitsUpdated",
      parse: parseRateLimitsUpdatedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to ProtocolFeeUpdated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when protocol fee is updated
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToProtocolFeeUpdated(
  program: Program<AgencCoordination>,
  callback: EventCallback<ProtocolFeeUpdatedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawProtocolFeeUpdatedEvent,
    ProtocolFeeUpdatedEvent,
    never
  >(
    program,
    {
      eventName: "protocolFeeUpdated",
      parse: parseProtocolFeeUpdatedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to ReputationChanged events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when an agent reputation changes
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToReputationChanged(
  program: Program<AgencCoordination>,
  callback: EventCallback<ReputationChangedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawReputationChangedEvent,
    ReputationChangedEvent,
    never
  >(
    program,
    {
      eventName: "reputationChanged",
      parse: parseReputationChangedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to BondDeposited events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a bond is deposited
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToBondDeposited(
  program: Program<AgencCoordination>,
  callback: EventCallback<BondDepositedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawBondDepositedEvent,
    BondDepositedEvent,
    never
  >(
    program,
    {
      eventName: "bondDeposited",
      parse: parseBondDepositedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to BondLocked events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a commitment is bond-locked
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToBondLocked(
  program: Program<AgencCoordination>,
  callback: EventCallback<BondLockedEvent>,
): EventSubscription {
  return createEventSubscription<RawBondLockedEvent, BondLockedEvent, never>(
    program,
    {
      eventName: "bondLocked",
      parse: parseBondLockedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to BondReleased events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a commitment lock is released
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToBondReleased(
  program: Program<AgencCoordination>,
  callback: EventCallback<BondReleasedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawBondReleasedEvent,
    BondReleasedEvent,
    never
  >(
    program,
    {
      eventName: "bondReleased",
      parse: parseBondReleasedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to BondSlashed events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a bond is slashed
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToBondSlashed(
  program: Program<AgencCoordination>,
  callback: EventCallback<BondSlashedEvent>,
): EventSubscription {
  return createEventSubscription<RawBondSlashedEvent, BondSlashedEvent, never>(
    program,
    {
      eventName: "bondSlashed",
      parse: parseBondSlashedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to SpeculativeCommitmentCreated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a speculative commitment is created
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToSpeculativeCommitmentCreated(
  program: Program<AgencCoordination>,
  callback: EventCallback<SpeculativeCommitmentCreatedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawSpeculativeCommitmentCreatedEvent,
    SpeculativeCommitmentCreatedEvent,
    never
  >(
    program,
    {
      eventName: "speculativeCommitmentCreated",
      parse: parseSpeculativeCommitmentCreatedEvent,
    },
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
    subscriptions.push(
      subscribeToStateUpdated(program, callbacks.onStateUpdated),
    );
  }
  if (callbacks.onProtocolInitialized) {
    subscriptions.push(
      subscribeToProtocolInitialized(program, callbacks.onProtocolInitialized),
    );
  }
  if (callbacks.onRewardDistributed) {
    subscriptions.push(
      subscribeToRewardDistributed(
        program,
        callbacks.onRewardDistributed,
        options,
      ),
    );
  }
  if (callbacks.onRateLimitHit) {
    subscriptions.push(
      subscribeToRateLimitHit(program, callbacks.onRateLimitHit, options),
    );
  }
  if (callbacks.onMigrationCompleted) {
    subscriptions.push(
      subscribeToMigrationCompleted(program, callbacks.onMigrationCompleted),
    );
  }
  if (callbacks.onProtocolVersionUpdated) {
    subscriptions.push(
      subscribeToProtocolVersionUpdated(
        program,
        callbacks.onProtocolVersionUpdated,
      ),
    );
  }
  if (callbacks.onRateLimitsUpdated) {
    subscriptions.push(
      subscribeToRateLimitsUpdated(program, callbacks.onRateLimitsUpdated),
    );
  }
  if (callbacks.onProtocolFeeUpdated) {
    subscriptions.push(
      subscribeToProtocolFeeUpdated(program, callbacks.onProtocolFeeUpdated),
    );
  }
  if (callbacks.onReputationChanged) {
    subscriptions.push(
      subscribeToReputationChanged(program, callbacks.onReputationChanged),
    );
  }
  if (callbacks.onBondDeposited) {
    subscriptions.push(
      subscribeToBondDeposited(program, callbacks.onBondDeposited),
    );
  }
  if (callbacks.onBondLocked) {
    subscriptions.push(subscribeToBondLocked(program, callbacks.onBondLocked));
  }
  if (callbacks.onBondReleased) {
    subscriptions.push(
      subscribeToBondReleased(program, callbacks.onBondReleased),
    );
  }
  if (callbacks.onBondSlashed) {
    subscriptions.push(
      subscribeToBondSlashed(program, callbacks.onBondSlashed),
    );
  }
  if (callbacks.onSpeculativeCommitmentCreated) {
    subscriptions.push(
      subscribeToSpeculativeCommitmentCreated(
        program,
        callbacks.onSpeculativeCommitmentCreated,
      ),
    );
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map((s) => s.unsubscribe()));
    },
  };
}
