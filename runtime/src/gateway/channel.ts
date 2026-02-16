/**
 * Channel plugin interface and ChannelContext.
 *
 * Defines the contract that all channel plugins (Telegram, Discord, etc.)
 * implement to bridge external messaging platforms to the Gateway. Includes
 * the ChannelContext provided during initialization, a WebhookRouter for
 * HTTP endpoint registration, and a PluginCatalog for channel management.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { GatewayMessage, OutboundMessage } from './message.js';
import type { SlashCommandContext } from './commands.js';
import type { HookDispatcher } from './hooks.js';
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

// Re-export for consumers importing from channel.js directly
export type { SlashCommandContext } from './commands.js';

// ============================================================================
// Webhook Router
// ============================================================================

/** HTTP method for webhook routes. */
export type WebhookMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** A registered webhook route. */
export interface WebhookRoute {
  readonly method: WebhookMethod;
  readonly path: string;
  readonly handler: WebhookHandler;
}

/** Webhook request passed to handlers. */
export interface WebhookRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly query: Readonly<Record<string, string>>;
}

/** Webhook response returned by handlers. */
export interface WebhookResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/** Handler function for a webhook route. */
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse>;

/**
 * Router for registering channel-specific HTTP webhook endpoints.
 *
 * Channel plugins use this to register webhook handlers (e.g. Telegram
 * webhook updates, Discord interactions endpoint). The gateway exposes
 * these routes on its HTTP server.
 */
export class WebhookRouter {
  private readonly _routes: WebhookRoute[] = [];
  private readonly prefix: string;

  constructor(channelName: string) {
    this.prefix = `/webhooks/${channelName}`;
  }

  /** Register a route. Path is auto-prefixed with /webhooks/{channelName}. */
  route(method: WebhookMethod, path: string, handler: WebhookHandler): void {
    this._routes.push({
      method,
      path: this.prefix + path,
      handler,
    });
  }

  /** Shorthand for POST routes (most common for webhooks). */
  post(path: string, handler: WebhookHandler): void {
    this.route('POST', path, handler);
  }

  /** Shorthand for GET routes (used for webhook verification). */
  get(path: string, handler: WebhookHandler): void {
    this.route('GET', path, handler);
  }

  /** All registered routes (returns a shallow copy). */
  get routes(): ReadonlyArray<WebhookRoute> {
    return [...this._routes];
  }

  /** Internal route access for aggregation (avoids copy). */
  get routesInternal(): ReadonlyArray<WebhookRoute> {
    return this._routes;
  }
}

// ============================================================================
// Reaction Event
// ============================================================================

/** An emoji reaction event from a channel. */
export interface ReactionEvent {
  /** Channel name that produced this event. */
  readonly channel: string;
  /** The user who reacted. */
  readonly senderId: string;
  /** The message ID being reacted to. */
  readonly messageId: string;
  /** The emoji or reaction identifier. */
  readonly emoji: string;
  /** True if the reaction was added, false if removed. */
  readonly added: boolean;
  /** Timestamp of the reaction event (ms since epoch). */
  readonly timestamp?: number;
}

// ============================================================================
// Channel Context
// ============================================================================

/** Context provided to channel plugins during initialization. */
export interface ChannelContext {
  /** Callback to deliver inbound messages to the Gateway. */
  readonly onMessage: (message: GatewayMessage) => Promise<void>;
  /** Logger instance (shared across plugins — not channel-scoped). */
  readonly logger: Logger;
  /** Channel-specific config from gateway config. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Hook dispatcher for lifecycle events. Typed as HookDispatcher when hooks module is loaded. */
  readonly hooks?: HookDispatcher;
}

// ============================================================================
// Channel Plugin
// ============================================================================

/**
 * Contract for channel plugins that bridge external messaging platforms
 * to the Gateway.
 *
 * Lifecycle: `initialize()` → `start()` → (running) → `stop()`
 *
 * Channel plugins must:
 * 1. Normalize inbound messages to `GatewayMessage` via `context.onMessage`
 * 2. Convert `OutboundMessage` to platform-specific format in `send()`
 * 3. Report health status via `isHealthy()`
 */
export interface ChannelPlugin {
  /** Channel name (e.g. 'telegram', 'discord', 'slack'). */
  readonly name: string;

  /** Initialize the channel with gateway context. */
  initialize(context: ChannelContext): Promise<void>;

  /** Start listening for inbound messages. */
  start(): Promise<void>;

  /** Stop listening and clean up resources. */
  stop(): Promise<void>;

  /** Send an outbound message through this channel. */
  send(message: OutboundMessage): Promise<void>;

  /** Health check — returns true if the channel connection is healthy. */
  isHealthy(): boolean;

  /** Optional: register HTTP webhook endpoints. */
  registerWebhooks?(router: WebhookRouter): void;

  /** Optional: handle emoji reactions. */
  handleReaction?(event: ReactionEvent): Promise<void>;

  /** Optional: handle slash commands from this channel. */
  handleSlashCommand?(command: string, args: string, context: SlashCommandContext): Promise<void>;
}

// ============================================================================
// Base Channel Plugin
// ============================================================================

/**
 * Abstract base class for channel plugins with sensible defaults.
 *
 * Subclasses must implement `name`, `start()`, `stop()`, and `send()`.
 * `initialize()` stores context by default; `isHealthy()` returns true.
 *
 * Context is only available after `initialize()` has been called.
 * Accessing it before initialization throws an error.
 */
export abstract class BaseChannelPlugin implements ChannelPlugin {
  private _context: ChannelContext | undefined;

  abstract readonly name: string;

  /** Access the channel context. Throws if called before initialize(). */
  protected get context(): ChannelContext {
    if (!this._context) {
      throw new Error(`Channel "${this.name}" context accessed before initialize()`);
    }
    return this._context;
  }

  async initialize(context: ChannelContext): Promise<void> {
    this._context = context;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<void>;

  isHealthy(): boolean {
    return true;
  }
}

// ============================================================================
// Plugin Catalog
// ============================================================================

/** Configuration for the PluginCatalog. */
export interface PluginCatalogConfig {
  readonly logger?: Logger;
}

/**
 * Registry for managing channel plugin instances.
 *
 * Follows the same pattern as ToolRegistry — register, lookup, lifecycle
 * management. The catalog owns the plugin lifecycle: it initializes,
 * starts, and stops plugins, and tracks their health status.
 */
export class PluginCatalog {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly contexts = new Map<string, ChannelContext>();
  private readonly webhookRouters = new Map<string, WebhookRouter>();
  private readonly logger: Logger;

  constructor(config?: PluginCatalogConfig) {
    this.logger = config?.logger ?? silentLogger;
  }

  /**
   * Register a channel plugin. Throws if a plugin with the same name exists.
   */
  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new ChannelAlreadyRegisteredError(plugin.name);
    }
    this.plugins.set(plugin.name, plugin);
    this.logger.info(`Channel plugin registered: "${plugin.name}"`);
  }

  /**
   * Initialize and start a registered plugin.
   *
   * Creates a ChannelContext, calls `initialize()`, optionally registers
   * webhooks, then calls `start()`. If the plugin is already active,
   * it is deactivated first (idempotent re-activation).
   *
   * If `initialize()` throws, the context is cleaned up and the error
   * is re-thrown — no partial activation state is left behind.
   */
  async activate(
    name: string,
    onMessage: (message: GatewayMessage) => Promise<void>,
    channelConfig: Record<string, unknown> = {},
  ): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new ChannelNotFoundError(name);
    }

    // Deactivate first if already active (idempotent re-activation)
    if (this.contexts.has(name)) {
      await this.deactivate(name);
    }

    const context: ChannelContext = {
      onMessage,
      logger: this.logger,
      config: channelConfig,
    };

    try {
      await plugin.initialize(context);
    } catch (err) {
      // Don't leave partial state if initialize() fails
      throw err;
    }

    // Only store context after successful initialization
    this.contexts.set(name, context);

    if (plugin.registerWebhooks) {
      const router = new WebhookRouter(name);
      plugin.registerWebhooks(router);
      this.webhookRouters.set(name, router);
      this.logger.info(`Channel "${name}" registered ${router.routesInternal.length} webhook route(s)`);
    }

    await plugin.start();
    this.logger.info(`Channel "${name}" activated`);
  }

  /**
   * Stop an active channel plugin and clean up its context/webhooks.
   * No-op if the plugin is not registered or was never activated.
   */
  async deactivate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    // Skip if plugin was never activated
    if (!this.contexts.has(name)) return;

    try {
      await plugin.stop();
    } catch (err) {
      this.logger.error(`Error stopping channel "${name}":`, err);
    }

    this.contexts.delete(name);
    this.webhookRouters.delete(name);
    this.logger.info(`Channel "${name}" deactivated`);
  }

  /**
   * Remove a channel plugin from the catalog entirely.
   * Calls deactivate first if the plugin is active.
   */
  async unregister(name: string): Promise<void> {
    await this.deactivate(name);
    this.plugins.delete(name);
    this.logger.info(`Channel plugin unregistered: "${name}"`);
  }

  /** Get a plugin by name. */
  get(name: string): ChannelPlugin | undefined {
    return this.plugins.get(name);
  }

  /** Get a plugin by name, throwing if not found. */
  getOrThrow(name: string): ChannelPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new ChannelNotFoundError(name);
    }
    return plugin;
  }

  /** List all registered plugin names. */
  listNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** List all registered plugins. */
  listAll(): ReadonlyArray<ChannelPlugin> {
    return Array.from(this.plugins.values());
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.plugins.size;
  }

  /** Get webhook routes for a specific channel, or all channels. */
  getWebhookRoutes(channelName?: string): ReadonlyArray<WebhookRoute> {
    if (channelName) {
      const router = this.webhookRouters.get(channelName);
      return router ? [...router.routesInternal] : [];
    }
    const allRoutes: WebhookRoute[] = [];
    for (const router of this.webhookRouters.values()) {
      allRoutes.push(...router.routesInternal);
    }
    return allRoutes;
  }

  /**
   * Get health status for all active channels.
   * Only reports plugins that have been activated (have a stored context).
   * Includes an `active` flag for clarity.
   */
  getHealthStatus(): ReadonlyArray<{ name: string; healthy: boolean; active: boolean }> {
    return Array.from(this.plugins.entries()).map(([name, plugin]) => ({
      name,
      healthy: plugin.isHealthy(),
      active: this.contexts.has(name),
    }));
  }

  /** Stop all active plugins concurrently. One failure does not block others. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.plugins.keys()).map((name) => this.deactivate(name)),
    );
  }
}

// ============================================================================
// Errors
// ============================================================================

export class ChannelAlreadyRegisteredError extends RuntimeError {
  public readonly channelName: string;

  constructor(channelName: string) {
    super(
      `Channel "${channelName}" is already registered`,
      RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR,
    );
    this.name = 'ChannelAlreadyRegisteredError';
    this.channelName = channelName;
  }
}

export class ChannelNotFoundError extends RuntimeError {
  public readonly channelName: string;

  constructor(channelName: string) {
    super(
      `Channel "${channelName}" not found`,
      RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR,
    );
    this.name = 'ChannelNotFoundError';
    this.channelName = channelName;
  }
}
