/**
 * Configuration interface for the Discord channel plugin.
 *
 * @module
 */

/** Known Discord gateway intent names supported by the plugin. */
export type DiscordIntentName =
  | "Guilds"
  | "GuildMessages"
  | "GuildMessageReactions"
  | "MessageContent"
  | "DirectMessages"
  | "GuildMembers"
  | "GuildPresences"
  | "GuildVoiceStates"
  | "DirectMessageReactions";

export interface DiscordChannelConfig {
  /** Discord bot token for authentication. */
  readonly botToken: string;
  /** Discord application ID for slash command registration. */
  readonly applicationId: string;
  /** Restrict to specific guild IDs. Empty = all guilds. */
  readonly allowedGuilds?: readonly string[];
  /** Restrict to specific channel IDs. Empty = all channels. */
  readonly allowedChannels?: readonly string[];
  /** Whether to accept DMs. @default true */
  readonly allowDMs?: boolean;
  /** Maximum attachment size in bytes. @default 25 * 1024 * 1024 (25 MB) */
  readonly maxAttachmentBytes?: number;
  /** Gateway intent names to enable. @default ['Guilds','GuildMessages','GuildMessageReactions','MessageContent','DirectMessages'] */
  readonly intents?: readonly DiscordIntentName[];
}
