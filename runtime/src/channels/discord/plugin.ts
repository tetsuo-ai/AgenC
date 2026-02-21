/**
 * Discord channel plugin — bridges the Discord Bot API to the Gateway.
 *
 * Uses discord.js v14+ as a lazy-loaded optional dependency. Supports
 * DMs, server channels, and threads with allowlist-based filtering.
 *
 * @module
 */

import { BaseChannelPlugin } from "../../gateway/channel.js";
import type {
  OutboundMessage,
  MessageAttachment,
} from "../../gateway/message.js";
import { createGatewayMessage } from "../../gateway/message.js";
import type { MessageScope } from "../../gateway/message.js";
import { GatewayConnectionError } from "../../gateway/errors.js";
import { DEFAULT_MAX_ATTACHMENT_BYTES } from "../../gateway/media.js";
import { ensureLazyModule } from "../../utils/lazy-import.js";
import type { DiscordChannelConfig, DiscordIntentName } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const SESSION_PREFIX = "discord";
const SESSION_DM_PREFIX = `${SESSION_PREFIX}:dm:`;
const DEFAULT_INTENTS: readonly DiscordIntentName[] = [
  "Guilds",
  "GuildMessages",
  "GuildMessageReactions",
  "MessageContent",
  "DirectMessages",
];

/** Discord channel type values for thread detection (10=AnnouncementThread, 11=PublicThread, 12=PrivateThread). */
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

// ============================================================================
// Discord.js type shims (loaded lazily)
// ============================================================================

interface DiscordClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<string>;
  destroy(): void;
  channels: { fetch(id: string): Promise<DiscordTextChannel> };
  guilds: { cache: Map<string, unknown> };
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  channelId: string;
  guildId: string | null;
  channel: {
    type: number;
    id: string;
    send: (opts: unknown) => Promise<unknown>;
  };
  attachments: Map<string, DiscordAttachment>;
}

interface DiscordAttachment {
  url: string;
  contentType: string | null;
  name: string;
  size: number;
}

interface DiscordReaction {
  emoji: { name: string | null; id: string | null };
  message: { id: string; channelId: string; guildId: string | null };
}

interface DiscordUser {
  id: string;
  username?: string;
}

interface DiscordInteraction {
  isCommand: () => boolean;
  commandName: string;
  options: { getString: (name: string) => string | null };
  user: { id: string; username: string };
  guildId: string | null;
  channelId: string;
  reply: (content: string | { content: string }) => Promise<void>;
  deferReply: () => Promise<void>;
  editReply: (content: string | { content: string }) => Promise<void>;
}

interface DiscordTextChannel {
  id: string;
  send: (opts: unknown) => Promise<unknown>;
}

interface SlashCommandOption {
  setName: (name: string) => SlashCommandOption;
  setDescription: (desc: string) => SlashCommandOption;
  setRequired: (required: boolean) => SlashCommandOption;
}

interface DiscordJsModule {
  Client: new (opts: { intents: number[] }) => DiscordClient;
  GatewayIntentBits: Record<string, number>;
  ChannelType: Record<string, number>;
  REST: new (opts: { version: string }) => {
    setToken: (token: string) => unknown;
    put: (route: string, opts: { body: unknown[] }) => Promise<unknown>;
  };
  Routes: {
    applicationGuildCommands: (appId: string, guildId: string) => string;
    applicationCommands: (appId: string) => string;
  };
  SlashCommandBuilder: new () => {
    setName: (name: string) => unknown;
    setDescription: (desc: string) => unknown;
    addStringOption: (
      fn: (opt: SlashCommandOption) => SlashCommandOption,
    ) => unknown;
    toJSON: () => unknown;
  };
}

// ============================================================================
// DiscordChannel Plugin
// ============================================================================

export class DiscordChannel extends BaseChannelPlugin {
  readonly name = SESSION_PREFIX;

  private client: DiscordClient | null = null;
  private healthy = false;
  private readonly config: DiscordChannelConfig;
  private readonly sessionChannels = new Map<string, string>();

  constructor(config: DiscordChannelConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    const mod = await ensureLazyModule<DiscordJsModule>(
      "discord.js",
      (msg) => new GatewayConnectionError(msg),
      (m) => m as unknown as DiscordJsModule,
    );
    const intents = this.resolveIntents(mod);
    const client = new mod.Client({ intents });
    this.client = client;

    try {
      this.wireEventHandlers(client, mod);
      await client.login(this.config.botToken);
    } catch (err) {
      // Clean up partially-initialized client on failure
      client.destroy();
      this.client = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.healthy = false;
    this.sessionChannels.clear();
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) {
      this.context.logger.warn(
        `Cannot send message: Discord client is not connected`,
      );
      return;
    }

    const channel = await this.resolveChannel(message.sessionId);
    if (!channel) {
      this.context.logger.warn(
        `Cannot resolve channel for session: ${message.sessionId}`,
      );
      return;
    }

    const chunks = splitMessage(message.content);
    for (const chunk of chunks) {
      try {
        await channel.send({ content: chunk });
      } catch (err) {
        this.context.logger.error(
          `Failed to send message to ${message.sessionId}: ${errorMessage(err)}`,
        );
        return;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------

  private resolveIntents(mod: DiscordJsModule): number[] {
    const intentNames = this.config.intents ?? DEFAULT_INTENTS;
    return intentNames.map((name) => {
      const value = mod.GatewayIntentBits[name];
      if (value === undefined) {
        throw new GatewayConnectionError(`Unknown Discord intent: ${name}`);
      }
      return value;
    });
  }

  private wireEventHandlers(client: DiscordClient, mod: DiscordJsModule): void {
    client.on("ready", () => {
      this.healthy = true;
      this.context.logger.info("Discord bot connected");
      // Register slash commands once the client is ready and guild cache is populated
      this.registerSlashCommands(mod).catch((err) => {
        this.context.logger.error(
          `Failed to register slash commands: ${errorMessage(err)}`,
        );
      });
    });

    client.on("error", (err: unknown) => {
      this.context.logger.error(`Discord client error: ${errorMessage(err)}`);
    });

    client.on("shardDisconnect", () => {
      this.healthy = false;
      this.context.logger.warn("Discord shard disconnected");
    });

    client.on("shardReconnecting", () => {
      this.healthy = false;
      this.context.logger.info("Discord shard reconnecting");
    });

    client.on("shardReady", () => {
      this.healthy = true;
      this.context.logger.info("Discord shard ready");
    });

    client.on("messageCreate", (msg: unknown) => {
      this.handleMessageCreate(msg as DiscordMessage, mod).catch((err) => {
        this.context.logger.error(
          `Error handling messageCreate: ${errorMessage(err)}`,
        );
      });
    });

    client.on("messageReactionAdd", (reaction: unknown, user: unknown) => {
      this.handleReactionEvent(
        reaction as DiscordReaction,
        user as DiscordUser,
        true,
      ).catch((err) => {
        this.context.logger.error(
          `Error handling messageReactionAdd: ${errorMessage(err)}`,
        );
      });
    });

    client.on("messageReactionRemove", (reaction: unknown, user: unknown) => {
      this.handleReactionEvent(
        reaction as DiscordReaction,
        user as DiscordUser,
        false,
      ).catch((err) => {
        this.context.logger.error(
          `Error handling messageReactionRemove: ${errorMessage(err)}`,
        );
      });
    });

    client.on("interactionCreate", (interaction: unknown) => {
      this.handleInteraction(interaction as DiscordInteraction).catch((err) => {
        this.context.logger.error(
          `Error handling interactionCreate: ${errorMessage(err)}`,
        );
      });
    });
  }

  // --------------------------------------------------------------------------
  // Inbound: messages
  // --------------------------------------------------------------------------

  private async handleMessageCreate(
    msg: DiscordMessage,
    mod: DiscordJsModule,
  ): Promise<void> {
    if (msg.author.bot) return;

    const isDM = msg.channel.type === mod.ChannelType.DM;
    const isThread = THREAD_CHANNEL_TYPES.has(msg.channel.type);

    if (isDM && this.config.allowDMs === false) return;
    if (!isDM && !this.isAllowed(msg.guildId, msg.channelId)) return;

    const sessionId = buildSessionId(
      isDM,
      msg.author.id,
      msg.guildId,
      msg.channelId,
    );
    const scope: MessageScope = isDM ? "dm" : isThread ? "thread" : "group";

    // Store DM channel mapping for send()
    if (isDM) {
      this.sessionChannels.set(sessionId, msg.channelId);
    }

    const attachments = this.normalizeAttachments(msg.attachments);

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: msg.author.id,
      senderName: msg.author.username,
      sessionId,
      content: msg.content,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        discordMessageId: msg.id,
        guildId: msg.guildId,
        channelId: msg.channelId,
      },
      scope,
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Inbound: reactions
  // --------------------------------------------------------------------------

  private async handleReactionEvent(
    reaction: DiscordReaction,
    user: DiscordUser,
    added: boolean,
  ): Promise<void> {
    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? "unknown";
    const isDM = reaction.message.guildId === null;
    const sessionId = buildSessionId(
      isDM,
      user.id,
      reaction.message.guildId,
      reaction.message.channelId,
    );

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: user.id,
      senderName: user.username ?? "unknown",
      sessionId,
      content: "",
      metadata: {
        isReaction: true,
        emoji,
        reactionAdded: added,
        targetMessageId: reaction.message.id,
      },
      scope: isDM ? "dm" : "group",
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Inbound: slash commands (interactions)
  // --------------------------------------------------------------------------

  private async handleInteraction(
    interaction: DiscordInteraction,
  ): Promise<void> {
    if (!interaction.isCommand()) return;

    const { commandName, user, guildId, channelId } = interaction;
    const isDM = guildId === null;
    const sessionId = buildSessionId(isDM, user.id, guildId, channelId);
    const scope: MessageScope = isDM ? "dm" : "group";

    const content =
      commandName === "ask"
        ? (interaction.options.getString("input") ?? "")
        : `/${commandName}`;

    const replyText =
      commandName === "ask" ? "Processing..." : `Running /${commandName}...`;

    await interaction.reply({ content: replyText });

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: user.id,
      senderName: user.username,
      sessionId,
      content,
      scope,
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Slash command registration
  // --------------------------------------------------------------------------

  private async registerSlashCommands(mod: DiscordJsModule): Promise<void> {
    const rest = new mod.REST({ version: "10" });
    rest.setToken(this.config.botToken);

    const commands: unknown[] = [];

    // /ask command
    const askCmd = new mod.SlashCommandBuilder();
    askCmd.setName("ask");
    askCmd.setDescription("Ask the agent a question");
    askCmd.addStringOption((opt: SlashCommandOption) =>
      opt
        .setName("input")
        .setDescription("Your question or message")
        .setRequired(true),
    );
    commands.push(askCmd.toJSON());

    // /status command
    const statusCmd = new mod.SlashCommandBuilder();
    statusCmd.setName("status");
    statusCmd.setDescription("Show agent status");
    commands.push(statusCmd.toJSON());

    // /task command
    const taskCmd = new mod.SlashCommandBuilder();
    taskCmd.setName("task");
    taskCmd.setDescription("Show current task status");
    commands.push(taskCmd.toJSON());

    // Register guild-scoped for each cached guild (instant propagation)
    const guilds = this.client?.guilds?.cache;
    if (guilds && guilds.size > 0) {
      for (const [guildId] of guilds) {
        try {
          await rest.put(
            mod.Routes.applicationGuildCommands(
              this.config.applicationId,
              guildId,
            ),
            { body: commands },
          );
        } catch (err) {
          this.context.logger.error(
            `Failed to register commands in guild ${guildId}: ${errorMessage(err)}`,
          );
        }
      }
    } else {
      // Fallback: register globally if no guilds in cache
      try {
        await rest.put(
          mod.Routes.applicationCommands(this.config.applicationId),
          { body: commands },
        );
      } catch (err) {
        this.context.logger.error(
          `Failed to register global commands: ${errorMessage(err)}`,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private isAllowed(guildId: string | null, channelId: string): boolean {
    const { allowedGuilds, allowedChannels } = this.config;

    if (allowedGuilds && allowedGuilds.length > 0 && guildId) {
      if (!allowedGuilds.includes(guildId)) return false;
    }

    if (allowedChannels && allowedChannels.length > 0) {
      if (!allowedChannels.includes(channelId)) return false;
    }

    return true;
  }

  private normalizeAttachments(
    discordAttachments: Map<string, DiscordAttachment>,
  ): MessageAttachment[] {
    const maxBytes =
      this.config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    const result: MessageAttachment[] = [];

    for (const [, att] of discordAttachments) {
      if (att.size > maxBytes) continue;

      const mimeType = att.contentType ?? "application/octet-stream";
      let type = "file";
      if (mimeType.startsWith("image/")) type = "image";
      else if (mimeType.startsWith("audio/")) type = "audio";
      else if (mimeType.startsWith("video/")) type = "video";

      result.push({
        type,
        url: att.url,
        mimeType,
        filename: att.name,
        sizeBytes: att.size,
      });
    }

    return result;
  }

  private async resolveChannel(
    sessionId: string,
  ): Promise<DiscordTextChannel | null> {
    if (!this.client) return null;

    // DM session: use stored channel mapping
    if (sessionId.startsWith(SESSION_DM_PREFIX)) {
      const channelId = this.sessionChannels.get(sessionId);
      if (!channelId) return null;
      try {
        return await this.client.channels.fetch(channelId);
      } catch (err) {
        this.context.logger.debug(
          `Failed to fetch DM channel ${channelId}: ${errorMessage(err)}`,
        );
        return null;
      }
    }

    // Guild session: parse channel ID from session ID format discord:<guildId>:<channelId>:<userId>
    const parts = sessionId.split(":");
    if (parts.length >= 3) {
      const channelId = parts[2];
      try {
        return await this.client.channels.fetch(channelId);
      } catch (err) {
        this.context.logger.debug(
          `Failed to fetch guild channel ${channelId}: ${errorMessage(err)}`,
        );
        return null;
      }
    }

    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a session ID from Discord context.
 * DM: `discord:dm:<userId>`, Guild: `discord:<guildId>:<channelId>:<userId>`
 */
function buildSessionId(
  isDM: boolean,
  userId: string,
  guildId: string | null,
  channelId: string,
): string {
  if (isDM) {
    return `${SESSION_DM_PREFIX}${userId}`;
  }
  return `${SESSION_PREFIX}:${guildId}:${channelId}:${userId}`;
}

/** Extract a safe error message string without leaking sensitive data. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ============================================================================
// Message splitting
// ============================================================================

/**
 * Split content at line boundaries to stay under Discord's 2000-char limit.
 * Falls back to hard split if no line boundary is found.
 */
function splitMessage(content: string): string[] {
  if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within the limit
    const slice = remaining.slice(0, DISCORD_MAX_MESSAGE_LENGTH);
    const lastNewline = slice.lastIndexOf("\n");

    if (lastNewline > 0) {
      chunks.push(remaining.slice(0, lastNewline));
      remaining = remaining.slice(lastNewline + 1);
    } else {
      // Hard split if no line boundary found
      chunks.push(slice);
      remaining = remaining.slice(DISCORD_MAX_MESSAGE_LENGTH);
    }
  }

  return chunks.filter((c) => c.length > 0);
}
