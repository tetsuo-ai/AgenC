/**
 * Configuration and internal types for the Telegram channel plugin.
 *
 * @module
 */

// ============================================================================
// Configuration
// ============================================================================

/** Webhook mode configuration for receiving Telegram updates via HTTP. */
export interface TelegramWebhookConfig {
  /** Public URL where Telegram will send updates. */
  readonly url: string;
  /** Local port for the webhook HTTP server. */
  readonly port: number;
  /** URL path for the webhook endpoint (default: '/update'). */
  readonly path?: string;
  /** Secret token validated via X-Telegram-Bot-Api-Secret-Token header. */
  readonly secretToken?: string;
}

/** Configuration for the Telegram channel plugin. */
export interface TelegramChannelConfig {
  /** Bot token from @BotFather. */
  readonly botToken: string;
  /** Telegram user IDs allowed to interact; empty/omitted = allow all. */
  readonly allowedUsers?: readonly number[];
  /** Delay in ms between polling cycles (default: 1000). */
  readonly pollingIntervalMs?: number;
  /** If set, uses webhook mode instead of long-polling. */
  readonly webhook?: TelegramWebhookConfig;
  /** Maximum inbound attachment size in bytes (default: 20 MB). */
  readonly maxAttachmentBytes?: number;
  /** Outbound messages per second per chat (default: 1). */
  readonly rateLimitPerChat?: number;
}

// ============================================================================
// Internal types
// ============================================================================

/** Token bucket state for rate limiting. */
export interface TokenBucket {
  tokens: number;
  lastRefill: number;
}
