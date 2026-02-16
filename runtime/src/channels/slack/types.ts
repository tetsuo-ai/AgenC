/**
 * Configuration interface for the Slack channel plugin.
 *
 * @module
 */

export interface SlackChannelConfig {
  /** Slack bot token (xoxb-...) for Web API calls. */
  readonly botToken: string;
  /** Slack app-level token (xapp-...) for Socket Mode. */
  readonly appToken: string;
  /** Restrict to specific channel IDs. Empty = all channels. */
  readonly channelIds?: readonly string[];
  /** Whether to reply in threads when the original message is in a thread. @default false */
  readonly useThreads?: boolean;
  /** Maximum attachment size in bytes. @default 25 * 1024 * 1024 (25 MB) */
  readonly maxAttachmentBytes?: number;
}
