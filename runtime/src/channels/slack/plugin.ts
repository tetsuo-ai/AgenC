/**
 * Slack channel plugin — bridges the Slack Bot API to the Gateway.
 *
 * Uses @slack/bolt v4+ as a lazy-loaded optional dependency. Connects via
 * Socket Mode (WebSocket), requiring both a bot token and an app-level token.
 * Supports channel filtering and thread reply support.
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
import type { SlackChannelConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const SLACK_MAX_MESSAGE_LENGTH = 4000;
const SESSION_PREFIX = "slack";

// ============================================================================
// @slack/bolt type shims (loaded lazily)
// ============================================================================

interface SlackBoltApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  message(handler: (args: SlackMessageArgs) => Promise<void>): void;
  command(
    command: string,
    handler: (args: SlackCommandArgs) => Promise<void>,
  ): void;
}

interface SlackMessageArgs {
  message: SlackMessage;
  say: (opts: string | SlackSayOptions) => Promise<unknown>;
}

interface SlackCommandArgs {
  command: {
    text: string;
    command: string;
    user_id: string;
    channel_id: string;
    team_id?: string;
  };
  ack: () => Promise<void>;
  say: (opts: string | SlackSayOptions) => Promise<unknown>;
}

interface SlackSayOptions {
  text: string;
  thread_ts?: string;
}

interface SlackMessage {
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  team?: string;
  files?: SlackFile[];
  bot_id?: string;
  subtype?: string;
}

interface SlackFile {
  url_private?: string;
  mimetype?: string;
  name?: string;
  size?: number;
}

interface SlackWebClient {
  chat: {
    postMessage(opts: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<unknown>;
  };
  users: {
    info(opts: {
      user: string;
    }): Promise<{ user?: { real_name?: string; name?: string } }>;
  };
}

interface SlackBoltModule {
  App: new (opts: {
    token: string;
    appToken: string;
    socketMode: true;
  }) => SlackBoltApp & { client: SlackWebClient };
}

// ============================================================================
// SlackChannel Plugin
// ============================================================================

export class SlackChannel extends BaseChannelPlugin {
  readonly name = SESSION_PREFIX;

  private app: (SlackBoltApp & { client: SlackWebClient }) | null = null;
  private healthy = false;
  private readonly config: SlackChannelConfig;
  private readonly sessionMap = new Map<
    string,
    { channel: string; threadTs?: string }
  >();
  private readonly userNameCache = new Map<string, string>();

  constructor(config: SlackChannelConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    const mod = await ensureLazyModule<SlackBoltModule>(
      "@slack/bolt",
      (msg) => new GatewayConnectionError(msg),
      (m) => m as unknown as SlackBoltModule,
    );

    const app = new mod.App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true as const,
    });
    this.app = app;

    try {
      this.wireEventHandlers(app);
      await app.start();
      this.healthy = true;
      this.context.logger.info("Slack bot connected via Socket Mode");
    } catch (err) {
      this.app = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors
      }
      this.app = null;
    }
    this.healthy = false;
    this.sessionMap.clear();
    this.userNameCache.clear();
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<void> {
    if (!this.app) {
      this.context.logger.warn(
        "Cannot send message: Slack client is not connected",
      );
      return;
    }

    const target = this.sessionMap.get(message.sessionId);
    if (!target) {
      this.context.logger.warn(
        `Cannot resolve channel for session: ${message.sessionId}`,
      );
      return;
    }

    const chunks = splitMessage(message.content);
    for (const chunk of chunks) {
      try {
        const opts: { channel: string; text: string; thread_ts?: string } = {
          channel: target.channel,
          text: chunk,
        };
        if (this.config.useThreads && target.threadTs) {
          opts.thread_ts = target.threadTs;
        }
        await this.app.client.chat.postMessage(opts);
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

  private wireEventHandlers(
    app: SlackBoltApp & { client: SlackWebClient },
  ): void {
    app.message(async (args: SlackMessageArgs) => {
      try {
        await this.handleMessage(args.message, app.client);
      } catch (err) {
        this.context.logger.error(
          `Error handling Slack message: ${errorMessage(err)}`,
        );
      }
    });
  }

  // --------------------------------------------------------------------------
  // Inbound: messages
  // --------------------------------------------------------------------------

  private async handleMessage(
    msg: SlackMessage,
    client: SlackWebClient,
  ): Promise<void> {
    // Skip bot messages and subtypes (joins, edits, etc.)
    if (msg.bot_id || msg.subtype) return;
    if (!msg.user) return;

    // Channel filtering
    if (this.config.channelIds && this.config.channelIds.length > 0) {
      if (!this.config.channelIds.includes(msg.channel)) return;
    }

    const isDM = msg.channel_type === "im";
    const isThread = !!msg.thread_ts;
    const sessionId = buildSessionId(isDM, msg.user, msg.team, msg.channel);
    const scope: MessageScope = isDM ? "dm" : isThread ? "thread" : "group";

    // Store mapping for outbound send
    this.sessionMap.set(sessionId, {
      channel: msg.channel,
      threadTs: msg.thread_ts ?? msg.ts,
    });

    const senderName = await this.resolveUserName(msg.user, client);
    const attachments = this.normalizeAttachments(msg.files);

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: msg.user,
      senderName,
      sessionId,
      content: msg.text ?? "",
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        slackTs: msg.ts,
        threadTs: msg.thread_ts,
        teamId: msg.team,
        channelId: msg.channel,
      },
      scope,
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async resolveUserName(
    userId: string,
    client: SlackWebClient,
  ): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await client.users.info({ user: userId });
      const name = result.user?.real_name ?? result.user?.name ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private normalizeAttachments(files?: SlackFile[]): MessageAttachment[] {
    if (!files || files.length === 0) return [];

    const maxBytes =
      this.config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    const result: MessageAttachment[] = [];

    for (const file of files) {
      if (file.size !== undefined && file.size > maxBytes) continue;

      const mimeType = file.mimetype ?? "application/octet-stream";
      let type = "file";
      if (mimeType.startsWith("image/")) type = "image";
      else if (mimeType.startsWith("audio/")) type = "audio";
      else if (mimeType.startsWith("video/")) type = "video";

      result.push({
        type,
        url: file.url_private,
        mimeType,
        filename: file.name,
        sizeBytes: file.size,
      });
    }

    return result;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a session ID from Slack context.
 * DM: `slack:dm:<userId>`, Channel: `slack:<teamId>:<channelId>:<userId>`
 */
function buildSessionId(
  isDM: boolean,
  userId: string,
  teamId: string | undefined,
  channelId: string,
): string {
  if (isDM) {
    return `${SESSION_PREFIX}:dm:${userId}`;
  }
  return `${SESSION_PREFIX}:${teamId ?? "unknown"}:${channelId}:${userId}`;
}

/** Extract a safe error message string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Split content at line boundaries to stay under Slack's message limit.
 */
function splitMessage(content: string): string[] {
  if (content.length <= SLACK_MAX_MESSAGE_LENGTH) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, SLACK_MAX_MESSAGE_LENGTH);
    const lastNewline = slice.lastIndexOf("\n");

    if (lastNewline > 0) {
      chunks.push(remaining.slice(0, lastNewline));
      remaining = remaining.slice(lastNewline + 1);
    } else {
      chunks.push(slice);
      remaining = remaining.slice(SLACK_MAX_MESSAGE_LENGTH);
    }
  }

  return chunks.filter((c) => c.length > 0);
}
