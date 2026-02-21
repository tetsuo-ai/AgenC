/**
 * Task event subscription utilities
 * @module
 */

import { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type {
  EventCallback,
  EventSubscription,
  TaskCreatedEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  TaskEventCallbacks,
  TaskEventFilterOptions,
  DependentTaskCreatedEvent,
  RawDependentTaskCreatedEvent,
  RawTaskCreatedEvent,
  RawTaskClaimedEvent,
  RawTaskCompletedEvent,
  RawTaskCancelledEvent,
} from "./types.js";
import {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDependentTaskCreatedEvent,
} from "./parse.js";
import { createEventSubscription } from "./factory.js";

/**
 * Subscribes to TaskCreated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a task is created
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToTaskCreated(
  program: Program<AgencCoordination>,
  callback: EventCallback<TaskCreatedEvent>,
  options?: TaskEventFilterOptions,
): EventSubscription {
  return createEventSubscription<
    RawTaskCreatedEvent,
    TaskCreatedEvent,
    TaskEventFilterOptions
  >(
    program,
    {
      eventName: "taskCreated",
      parse: parseTaskCreatedEvent,
      getFilterId: (event) => event.taskId,
      getFilterValue: (opts) => opts.taskId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to TaskClaimed events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a task is claimed
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToTaskClaimed(
  program: Program<AgencCoordination>,
  callback: EventCallback<TaskClaimedEvent>,
  options?: TaskEventFilterOptions,
): EventSubscription {
  return createEventSubscription<
    RawTaskClaimedEvent,
    TaskClaimedEvent,
    TaskEventFilterOptions
  >(
    program,
    {
      eventName: "taskClaimed",
      parse: parseTaskClaimedEvent,
      getFilterId: (event) => event.taskId,
      getFilterValue: (opts) => opts.taskId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to TaskCompleted events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a task is completed
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToTaskCompleted(
  program: Program<AgencCoordination>,
  callback: EventCallback<TaskCompletedEvent>,
  options?: TaskEventFilterOptions,
): EventSubscription {
  return createEventSubscription<
    RawTaskCompletedEvent,
    TaskCompletedEvent,
    TaskEventFilterOptions
  >(
    program,
    {
      eventName: "taskCompleted",
      parse: parseTaskCompletedEvent,
      getFilterId: (event) => event.taskId,
      getFilterValue: (opts) => opts.taskId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to TaskCancelled events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a task is cancelled
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToTaskCancelled(
  program: Program<AgencCoordination>,
  callback: EventCallback<TaskCancelledEvent>,
  options?: TaskEventFilterOptions,
): EventSubscription {
  return createEventSubscription<
    RawTaskCancelledEvent,
    TaskCancelledEvent,
    TaskEventFilterOptions
  >(
    program,
    {
      eventName: "taskCancelled",
      parse: parseTaskCancelledEvent,
      getFilterId: (event) => event.taskId,
      getFilterValue: (opts) => opts.taskId,
    },
    callback,
    options,
  );
}

/**
 * Subscribes to DependentTaskCreated events.
 *
 * @param program - The Anchor program instance
 * @param callback - Function called when a dependent task is created
 * @param options - Optional filtering options (not currently supported for this event)
 * @returns Subscription handle for unsubscribing
 */
export function subscribeToDependentTaskCreated(
  program: Program<AgencCoordination>,
  callback: EventCallback<DependentTaskCreatedEvent>,
): EventSubscription {
  return createEventSubscription<
    RawDependentTaskCreatedEvent,
    DependentTaskCreatedEvent,
    never
  >(
    program,
    {
      eventName: "dependentTaskCreated",
      parse: parseDependentTaskCreatedEvent,
    },
    callback,
  );
}

/**
 * Subscribes to all task-related events with a single subscription object.
 *
 * @param program - The Anchor program instance
 * @param callbacks - Object containing callback functions for each event type
 * @param options - Optional filtering options
 * @returns Subscription handle for unsubscribing from all events
 */
export function subscribeToAllTaskEvents(
  program: Program<AgencCoordination>,
  callbacks: TaskEventCallbacks,
  options?: TaskEventFilterOptions,
): EventSubscription {
  const subscriptions: EventSubscription[] = [];

  if (callbacks.onTaskCreated) {
    subscriptions.push(
      subscribeToTaskCreated(program, callbacks.onTaskCreated, options),
    );
  }
  if (callbacks.onTaskClaimed) {
    subscriptions.push(
      subscribeToTaskClaimed(program, callbacks.onTaskClaimed, options),
    );
  }
  if (callbacks.onTaskCompleted) {
    subscriptions.push(
      subscribeToTaskCompleted(program, callbacks.onTaskCompleted, options),
    );
  }
  if (callbacks.onTaskCancelled) {
    subscriptions.push(
      subscribeToTaskCancelled(program, callbacks.onTaskCancelled, options),
    );
  }
  if (callbacks.onDependentTaskCreated) {
    subscriptions.push(
      subscribeToDependentTaskCreated(
        program,
        callbacks.onDependentTaskCreated,
      ),
    );
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map((s) => s.unsubscribe()));
    },
  };
}
