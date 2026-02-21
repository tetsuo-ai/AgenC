/**
 * Lifecycle hook system (HookDispatcher).
 *
 * Hooks allow plugins and users to intercept and react to Gateway lifecycle
 * events. Handlers run in priority order (lower = first) and can transform
 * payloads via middleware-style composition. A handler returning
 * `{ continue: false }` aborts the dispatch chain.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Hook Events
// ============================================================================

/** All hook event types the gateway can dispatch. */
export type HookEvent =
  | "gateway:startup"
  | "gateway:shutdown"
  | "agent:bootstrap"
  | "session:start"
  | "session:end"
  | "session:compact"
  | "message:inbound"
  | "message:outbound"
  | "tool:before"
  | "tool:after"
  | "heartbeat:before"
  | "heartbeat:after"
  | "command:new"
  | "command:reset"
  | "command:stop"
  | "config:reload";

// ============================================================================
// Hook Types
// ============================================================================

/** Context passed to hook handlers. */
export interface HookContext {
  /** The event that triggered this hook. */
  readonly event: HookEvent;
  /** Event-specific payload (mutable — handlers can transform it). */
  payload: Record<string, unknown>;
  /** Logger scoped to the hook system. */
  readonly logger: Logger;
  /** Timestamp when the event was dispatched. */
  readonly timestamp: number;
}

/** Result returned by a hook handler. */
export interface HookResult {
  /** Whether to continue processing subsequent handlers (false = abort chain). */
  continue: boolean;
  /** Optional modified payload for transform hooks. */
  payload?: Record<string, unknown>;
}

/** A registered hook handler. */
export interface HookHandler {
  /** Hook event to listen for. */
  readonly event: HookEvent;
  /** Handler name for logging and removal. */
  readonly name: string;
  /** Priority (lower = runs first, default: 100). */
  readonly priority?: number;
  /** The handler function. */
  readonly handler: (context: HookContext) => Promise<HookResult>;
}

/** Hook configuration for gateway config file integration. */
export interface HookConfig {
  /** Handlers to register on startup. */
  readonly handlers?: ReadonlyArray<{
    readonly event: HookEvent;
    readonly name: string;
    /** Whether this is a built-in handler or a user script. */
    readonly type: "builtin" | "script";
    /** Built-in handler name or path to user script. */
    readonly handler: string;
    readonly priority?: number;
    /** Whether this hook is enabled (default: true). */
    readonly enabled?: boolean;
  }>;
}

// ============================================================================
// Dispatch Result
// ============================================================================

/** Result of dispatching a hook event to all handlers. */
export interface DispatchResult {
  /** Whether all handlers completed (false if any handler aborted). */
  readonly completed: boolean;
  /** The final (possibly transformed) payload. */
  readonly payload: Record<string, unknown>;
  /** Number of handlers that executed. */
  readonly handlersRun: number;
  /** Name of the handler that aborted, if any. */
  readonly abortedBy?: string;
}

// ============================================================================
// HookDispatcher
// ============================================================================

const DEFAULT_PRIORITY = 100;

export interface HookDispatcherConfig {
  readonly logger?: Logger;
  /** Clock function for testing (default: Date.now). */
  readonly now?: () => number;
}

/**
 * Dispatches lifecycle events to registered hook handlers.
 *
 * Handlers are sorted by priority (ascending) and run sequentially.
 * Each handler can:
 * - Observe the event (return `{ continue: true }`)
 * - Transform the payload (return `{ continue: true, payload: { ... } }`)
 * - Abort the chain (return `{ continue: false }`)
 *
 * Handler errors are caught and logged — a failing handler does not
 * prevent subsequent handlers from running.
 */
export class HookDispatcher {
  private readonly handlers = new Map<HookEvent, HookHandler[]>();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(config?: HookDispatcherConfig) {
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? Date.now;
  }

  /** Register a hook handler. Rejects duplicate (event, name) pairs. */
  on(handler: HookHandler): boolean {
    let list = this.handlers.get(handler.event);
    if (!list) {
      list = [];
      this.handlers.set(handler.event, list);
    }

    if (list.some((h) => h.name === handler.name)) {
      this.logger.warn(
        `Hook "${handler.name}" already registered for ${handler.event} — skipping duplicate`,
      );
      return false;
    }

    list.push(handler);
    // Re-sort by priority after insertion
    list.sort(
      (a, b) =>
        (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
    );

    this.logger.debug(
      `Hook registered: "${handler.name}" for ${handler.event} (priority: ${handler.priority ?? DEFAULT_PRIORITY})`,
    );
    return true;
  }

  /** Remove a hook handler by event and name. */
  off(event: HookEvent, name: string): boolean {
    const list = this.handlers.get(event);
    if (!list) return false;

    const idx = list.findIndex((h) => h.name === name);
    if (idx === -1) return false;

    list.splice(idx, 1);
    if (list.length === 0) {
      this.handlers.delete(event);
    }

    this.logger.debug(`Hook removed: "${name}" from ${event}`);
    return true;
  }

  /** Remove all handlers for a specific event, or all handlers if no event given. */
  clear(event?: HookEvent): void {
    if (event) {
      this.handlers.delete(event);
      this.logger.debug(`All hooks cleared for ${event}`);
    } else {
      this.handlers.clear();
      this.logger.debug("All hooks cleared");
    }
  }

  /**
   * Dispatch an event to all registered handlers in priority order.
   *
   * Returns a DispatchResult with the final payload and completion status.
   * If a handler returns `{ continue: false }`, the chain is aborted and
   * `completed` will be false.
   *
   * Note: The spec defines this as `Promise<boolean>`. This implementation
   * returns `DispatchResult` instead — an intentional deviation that provides
   * richer information (handlers run, abort source, transformed payload).
   */
  async dispatch(
    event: HookEvent,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) {
      return { completed: true, payload, handlersRun: 0 };
    }

    let currentPayload = { ...payload };
    let handlersRun = 0;

    // Snapshot to prevent reentrancy issues if a handler calls on()/off()
    const snapshot = [...list];
    for (const handler of snapshot) {
      const context: HookContext = {
        event,
        payload: currentPayload,
        logger: this.logger,
        timestamp: this.now(),
      };

      try {
        const result = await handler.handler(context);
        handlersRun++;

        // Apply transformed payload if provided
        if (result.payload) {
          currentPayload = result.payload;
        }

        if (!result.continue) {
          this.logger.debug(
            `Hook chain aborted by "${handler.name}" for ${event}`,
          );
          return {
            completed: false,
            payload: currentPayload,
            handlersRun,
            abortedBy: handler.name,
          };
        }
      } catch (err) {
        handlersRun++;
        this.logger.error(
          `Hook handler "${handler.name}" for ${event} threw:`,
          err,
        );
        // Continue to next handler — one failure should not break the chain
      }
    }

    return { completed: true, payload: currentPayload, handlersRun };
  }

  /** Check if any handlers are registered for an event. */
  hasHandlers(event: HookEvent): boolean {
    const list = this.handlers.get(event);
    return list !== undefined && list.length > 0;
  }

  /** Get count of handlers for a specific event, or total if no event given. */
  getHandlerCount(event?: HookEvent): number {
    if (event) {
      return this.handlers.get(event)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.handlers.values()) {
      total += list.length;
    }
    return total;
  }

  /** Get all handlers registered for a specific event (returns a shallow copy). */
  getHandlers(event: HookEvent): readonly HookHandler[] {
    return [...(this.handlers.get(event) ?? [])];
  }

  /** List all registered handler names, grouped by event. */
  listHandlers(): ReadonlyMap<
    HookEvent,
    ReadonlyArray<{ name: string; priority: number }>
  > {
    const result = new Map<
      HookEvent,
      ReadonlyArray<{ name: string; priority: number }>
    >();
    for (const [event, list] of this.handlers) {
      result.set(
        event,
        list.map((h) => ({
          name: h.name,
          priority: h.priority ?? DEFAULT_PRIORITY,
        })),
      );
    }
    return result;
  }
}

// ============================================================================
// Built-in hooks
// ============================================================================

/**
 * Create stub HookHandlers for the built-in gateway hooks.
 *
 * These are no-op stubs that will be replaced with real implementations
 * as their respective systems are built (memory recorder in Phase 5,
 * audit logger in Phase 5, boot executor in Phase 2, approval gate in Phase 5).
 */
export function createBuiltinHooks(): HookHandler[] {
  return [
    {
      event: "message:inbound",
      name: "session-memory-recorder",
      priority: 50,
      handler: async () => ({ continue: true }),
    },
    {
      event: "tool:after",
      name: "tool-audit-logger",
      priority: 90,
      handler: async () => ({ continue: true }),
    },
    {
      event: "gateway:startup",
      name: "boot-executor",
      priority: 10,
      handler: async () => ({ continue: true }),
    },
    {
      event: "tool:before",
      name: "approval-gate",
      priority: 5,
      handler: async () => ({ continue: true }),
    },
  ];
}
