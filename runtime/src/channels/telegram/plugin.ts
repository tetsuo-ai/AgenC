/**
 * Telegram channel plugin for the AgenC Gateway.
 *
 * Bridges the Telegram Bot API to the Gateway using the `grammy` library
 * (lazy-loaded as an optional dependency). Supports both long-polling and
 * webhook modes for receiving updates.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto';

import { BaseChannelPlugin } from '../../gateway/channel.js';
import type { ChannelContext, WebhookRouter } from '../../gateway/channel.js';
import type { OutboundMessage } from '../../gateway/message.js';
import { createGatewayMessage } from '../../gateway/message.js';
import type { MessageScope, MessageAttachment } from '../../gateway/message.js';
import { deriveSessionId } from '../../gateway/session.js';
import { DEFAULT_WORKSPACE_ID } from '../../gateway/workspace.js';
import { RuntimeError, RuntimeErrorCodes } from '../../types/errors.js';
import { ensureLazyChannel } from './lazy-import.js';
import type { TelegramChannelConfig, TokenBucket } from './types.js';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_POLLING_INTERVAL_MS = 1000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB (Telegram getFile limit)
const DEFAULT_RATE_LIMIT_PER_CHAT = 1; // 1 msg/sec per chat
const GLOBAL_RATE_LIMIT = 30; // Telegram global limit: 30 msg/sec
const LONG_POLL_TIMEOUT_SECONDS = 25; // Telegram recommended long-poll timeout
const DEFAULT_WEBHOOK_PATH = '/update';
const TELEGRAM_FILE_BASE_URL = 'https://api.telegram.org/file/bot';
const MS_PER_SECOND = 1000;

// ============================================================================
// Bot API type alias (grammy is lazy-loaded, so we use a structural type)
// ============================================================================

type BotApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

// ============================================================================
// TelegramChannel
// ============================================================================

/**
 * Channel plugin that bridges Telegram Bot API to the AgenC Gateway.
 *
 * Uses grammy (lazy-loaded) for Telegram API communication. Supports
 * long-polling (default) and webhook modes.
 *
 * Note: `OutboundMessage.isPartial` and `tts` are not supported by this
 * plugin — partial messages are sent as-is and TTS is ignored.
 */
export class TelegramChannel extends BaseChannelPlugin {
  readonly name = 'telegram';

  // -- Config (set during initialize) --
  private config!: Required<
    Pick<TelegramChannelConfig, 'botToken' | 'pollingIntervalMs' | 'maxAttachmentBytes' | 'rateLimitPerChat'>
  > & Pick<TelegramChannelConfig, 'allowedUsers' | 'webhook'>;

  // -- Bot instance (set during start) --
  private bot: unknown;

  // -- Polling state --
  private pollingActive = false;
  private updateOffset = 0;
  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private pollingPromise: Promise<void> | undefined;

  // -- Health --
  private healthy = true;

  // -- Rate limiting --
  private readonly chatBuckets = new Map<number, TokenBucket>();
  private readonly globalBucket: TokenBucket = { tokens: GLOBAL_RATE_LIMIT, lastRefill: Date.now() };

  // -- Session → Chat reverse mapping --
  private readonly sessionToChatId = new Map<string, number>();

  // --------------------------------------------------------------------------
  // Bot API accessor (avoids repeated unsafe casts)
  // --------------------------------------------------------------------------

  private get api(): BotApi {
    return (this.bot as { api: BotApi }).api;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  override async initialize(context: ChannelContext): Promise<void> {
    await super.initialize(context);

    const raw = context.config as unknown as TelegramChannelConfig;
    if (!raw.botToken || typeof raw.botToken !== 'string') {
      throw new RuntimeError(
        'Telegram channel requires a "botToken" in config',
        RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR,
      );
    }

    this.config = {
      botToken: raw.botToken,
      allowedUsers: raw.allowedUsers,
      pollingIntervalMs: raw.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
      maxAttachmentBytes: raw.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
      rateLimitPerChat: raw.rateLimitPerChat ?? DEFAULT_RATE_LIMIT_PER_CHAT,
      webhook: raw.webhook,
    };
  }

  override async start(): Promise<void> {
    const BotClass = await ensureLazyChannel<new (token: string) => unknown>(
      'grammy',
      'telegram',
      (mod) => mod.Bot as new (token: string) => unknown,
    );

    this.bot = new BotClass(this.config.botToken);

    if (this.config.webhook) {
      const { url, path: webhookPath, secretToken } = this.config.webhook;
      const fullUrl = url + (webhookPath ?? DEFAULT_WEBHOOK_PATH);
      await this.api.setWebhook(fullUrl, ...(secretToken ? [{ secret_token: secretToken }] : []));
      this.context.logger.info(`Telegram webhook set: ${fullUrl}`);
    } else {
      this.pollingActive = true;
      this.pollingPromise = this.pollUpdates();
      this.context.logger.info('Telegram long-polling started');
    }
  }

  override async stop(): Promise<void> {
    this.pollingActive = false;

    if (this.pollingTimer !== undefined) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    // Await any in-flight polling request before tearing down
    if (this.pollingPromise) {
      await this.pollingPromise;
      this.pollingPromise = undefined;
    }

    if (this.config.webhook && this.bot) {
      try {
        await this.api.deleteWebhook();
      } catch (err) {
        this.context.logger.debug?.('Telegram: error deleting webhook during stop:', err);
      }
    }

    this.chatBuckets.clear();
    this.sessionToChatId.clear();
    this.healthy = true;
    this.bot = undefined;
    this.globalBucket.tokens = GLOBAL_RATE_LIMIT;
    this.globalBucket.lastRefill = Date.now();
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  override async send(message: OutboundMessage): Promise<void> {
    const chatId = this.sessionToChatId.get(message.sessionId);
    if (chatId === undefined) {
      throw new RuntimeError(
        `No chat mapping for session "${message.sessionId}". The user must send a message first.`,
        RuntimeErrorCodes.GATEWAY_LIFECYCLE_ERROR,
      );
    }

    // Rate limiting — try once, then wait and retry once
    if (!this.acquireToken(chatId)) {
      await this.delay(MS_PER_SECOND / this.config.rateLimitPerChat);
      if (!this.acquireToken(chatId)) {
        throw new RuntimeError(
          `Rate limit exceeded for chat ${chatId}`,
          RuntimeErrorCodes.RATE_LIMIT_ERROR,
        );
      }
    }

    // Send text (skip empty strings)
    if (message.content.length > 0) {
      await this.api.sendMessage(chatId, message.content);
    }

    // Send attachments
    if (message.attachments) {
      for (const att of message.attachments) {
        const source = att.url ?? att.data;
        if (!source) continue;

        switch (att.type) {
          case 'image':
            await this.api.sendPhoto(chatId, source);
            break;
          case 'audio':
            await this.api.sendVoice(chatId, source);
            break;
          default:
            await this.api.sendDocument(chatId, source);
            break;
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Webhooks
  // --------------------------------------------------------------------------

  registerWebhooks(router: WebhookRouter): void {
    router.post('/update', async (req) => {
      // Validate secret token if configured (timing-safe to prevent oracle attacks)
      if (this.config.webhook?.secretToken) {
        const expected = this.config.webhook.secretToken;
        const header = req.headers['x-telegram-bot-api-secret-token'];
        if (
          typeof header !== 'string' ||
          header.length !== expected.length ||
          !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
        ) {
          return { status: 403 };
        }
      }

      await this.handleUpdate(req.body);
      return { status: 200 };
    });

    router.get('/verify', async () => {
      return { status: 200, body: 'ok' };
    });
  }

  // --------------------------------------------------------------------------
  // Polling
  // --------------------------------------------------------------------------

  private async pollUpdates(): Promise<void> {
    if (!this.pollingActive) return;

    try {
      const updates = (await this.api.getUpdates({
        offset: this.updateOffset,
        timeout: LONG_POLL_TIMEOUT_SECONDS,
      })) as Array<Record<string, unknown>>;

      for (const update of updates) {
        this.updateOffset = (update.update_id as number) + 1;
        await this.handleUpdate(update);
      }

      this.healthy = true;
    } catch (err) {
      this.healthy = false;
      this.context.logger.error('Telegram polling error:', err);
    }

    if (this.pollingActive) {
      this.pollingTimer = setTimeout(() => {
        this.pollingPromise = this.pollUpdates();
      }, this.config.pollingIntervalMs);
    }
  }

  // --------------------------------------------------------------------------
  // Update handling
  // --------------------------------------------------------------------------

  private async handleUpdate(update: unknown): Promise<void> {
    const u = update as Record<string, unknown>;

    // Only handle plain messages — skip edited_message, channel_post, callback_query.
    // Within messages, only text/voice/photo/document are processed; video, sticker,
    // animation, audio, and other media types are silently dropped (delivered as empty
    // content with no attachments).
    if (u.edited_message || u.channel_post || u.callback_query) return;

    const message = u.message as Record<string, unknown> | undefined;
    if (!message) return;

    const from = message.from as Record<string, unknown> | undefined;
    if (!from) return;

    const fromId = from.id as number;

    // Allowed users filter
    if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
      if (!this.config.allowedUsers.includes(fromId)) {
        this.context.logger.debug?.(`Telegram: ignoring message from unauthorized user ${fromId}`);
        return;
      }
    }

    const chat = message.chat as Record<string, unknown>;
    const chatType = chat.type as string;
    const messageScope: MessageScope = chatType === 'private' ? 'dm' : 'group';

    const sessionId = deriveSessionId(
      {
        channel: 'telegram',
        senderId: String(fromId),
        scope: messageScope,
        workspaceId: DEFAULT_WORKSPACE_ID,
        guildId: String(chat.id as number),
      },
      'per-channel-peer',
    );

    this.sessionToChatId.set(sessionId, chat.id as number);

    const senderName =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      (from.username as string) ||
      'Unknown';

    const metadata: Record<string, unknown> = {
      chatId: chat.id,
      messageId: message.message_id,
      chatType,
    };

    const { content, attachments } = await this.normalizeContent(message, metadata);

    const gatewayMsg = createGatewayMessage({
      channel: 'telegram',
      senderId: String(fromId),
      senderName,
      sessionId,
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      scope: messageScope,
      metadata,
    });

    try {
      await this.context.onMessage(gatewayMsg);
    } catch (err) {
      this.context.logger.warn?.('Telegram: error delivering message to gateway:', err);
    }
  }

  // --------------------------------------------------------------------------
  // Content normalization
  // --------------------------------------------------------------------------

  private async normalizeContent(
    message: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): Promise<{ content: string; attachments: MessageAttachment[] }> {
    const attachments: MessageAttachment[] = [];

    if (typeof message.text === 'string') {
      return { content: message.text, attachments };
    }

    if (message.voice) {
      const voice = message.voice as Record<string, unknown>;
      const fileUrl = await this.getFileUrl(voice.file_id as string, metadata);
      if (fileUrl) {
        attachments.push({ type: 'audio', mimeType: 'audio/ogg', url: fileUrl });
      }
      return { content: '', attachments };
    }

    if (message.photo) {
      const photos = message.photo as Array<Record<string, unknown>>;
      const largest = photos[photos.length - 1];
      const fileUrl = await this.getFileUrl(largest.file_id as string, metadata);
      if (fileUrl) {
        attachments.push({ type: 'image', mimeType: 'image/jpeg', url: fileUrl });
      }
      return { content: (message.caption as string) ?? '', attachments };
    }

    if (message.document) {
      const doc = message.document as Record<string, unknown>;
      const fileUrl = await this.getFileUrl(doc.file_id as string, metadata);
      if (fileUrl) {
        attachments.push({
          type: 'file',
          mimeType: (doc.mime_type as string) ?? 'application/octet-stream',
          url: fileUrl,
          filename: doc.file_name as string | undefined,
        });
      }
      return { content: (message.caption as string) ?? '', attachments };
    }

    return { content: '', attachments };
  }

  // --------------------------------------------------------------------------
  // File URL
  // --------------------------------------------------------------------------

  /**
   * Resolves a Telegram file ID to a download URL.
   *
   * **Security note:** The returned URL embeds the bot token
   * (`https://api.telegram.org/file/bot<token>/...`). This is inherent to
   * the Telegram Bot API — treat these URLs as sensitive and avoid logging
   * or persisting them in user-visible contexts.
   */
  private async getFileUrl(
    fileId: string,
    metadata: Record<string, unknown>,
  ): Promise<string | undefined> {
    try {
      const file = (await this.api.getFile(fileId)) as Record<string, unknown>;
      const filePath = file.file_path as string;
      const fileSize = file.file_size as number | undefined;

      if (fileSize !== undefined && fileSize > this.config.maxAttachmentBytes) {
        const limitMB = Math.round(this.config.maxAttachmentBytes / (1024 * 1024));
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        this.context.logger.warn?.(
          `Telegram: attachment ${fileId} exceeds size limit (${sizeMB} MB > ${limitMB} MB)`,
        );
        metadata.attachmentError = `File size ${sizeMB} MB exceeds ${limitMB} MB limit`;
        return undefined;
      }

      return `${TELEGRAM_FILE_BASE_URL}${this.config.botToken}/${filePath}`;
    } catch (err) {
      this.context.logger.warn?.('Telegram: failed to get file URL:', err);
      metadata.attachmentError = (err as Error).message;
      return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  private acquireToken(chatId: number): boolean {
    if (!this.refillAndConsume(this.globalBucket, GLOBAL_RATE_LIMIT)) return false;

    let bucket = this.chatBuckets.get(chatId);
    if (!bucket) {
      bucket = { tokens: this.config.rateLimitPerChat, lastRefill: Date.now() };
      this.chatBuckets.set(chatId, bucket);
    }

    return this.refillAndConsume(bucket, this.config.rateLimitPerChat);
  }

  private refillAndConsume(bucket: TokenBucket, ratePerSecond: number): boolean {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / MS_PER_SECOND;
    bucket.tokens = Math.min(ratePerSecond, bucket.tokens + elapsed * ratePerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
