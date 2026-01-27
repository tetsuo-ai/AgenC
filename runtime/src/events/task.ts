/**
 * Task event subscription utilities
 * @module
 */

import { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import { agentIdsEqual } from '../utils/encoding.js';
import type {
  EventCallback,
  EventSubscription,
  TaskCreatedEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  TaskEventCallbacks,
  TaskEventFilterOptions,
  RawTaskCreatedEvent,
  RawTaskClaimedEvent,
  RawTaskCompletedEvent,
  RawTaskCancelledEvent,
} from './types.js';
import {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
} from './parse.js';

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
  options?: TaskEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'taskCreated',
    (rawEvent: RawTaskCreatedEvent, slot: number, signature: string) => {
      const event = parseTaskCreatedEvent(rawEvent);
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
  options?: TaskEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'taskClaimed',
    (rawEvent: RawTaskClaimedEvent, slot: number, signature: string) => {
      const event = parseTaskClaimedEvent(rawEvent);
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
  options?: TaskEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'taskCompleted',
    (rawEvent: RawTaskCompletedEvent, slot: number, signature: string) => {
      const event = parseTaskCompletedEvent(rawEvent);
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
  options?: TaskEventFilterOptions
): EventSubscription {
  const listenerId = program.addEventListener(
    'taskCancelled',
    (rawEvent: RawTaskCancelledEvent, slot: number, signature: string) => {
      const event = parseTaskCancelledEvent(rawEvent);
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
  options?: TaskEventFilterOptions
): EventSubscription {
  const subscriptions: EventSubscription[] = [];

  if (callbacks.onTaskCreated) {
    subscriptions.push(subscribeToTaskCreated(program, callbacks.onTaskCreated, options));
  }
  if (callbacks.onTaskClaimed) {
    subscriptions.push(subscribeToTaskClaimed(program, callbacks.onTaskClaimed, options));
  }
  if (callbacks.onTaskCompleted) {
    subscriptions.push(subscribeToTaskCompleted(program, callbacks.onTaskCompleted, options));
  }
  if (callbacks.onTaskCancelled) {
    subscriptions.push(subscribeToTaskCancelled(program, callbacks.onTaskCancelled, options));
  }

  return {
    unsubscribe: async () => {
      await Promise.all(subscriptions.map(s => s.unsubscribe()));
    },
  };
}
