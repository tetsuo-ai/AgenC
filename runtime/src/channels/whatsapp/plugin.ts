/**
 * WhatsApp channel plugin — bridges WhatsApp to the Gateway.
 *
 * Supports two modes:
 * - **Baileys**: Uses @whiskeysockets/baileys for WebSocket-based connection
 *   (no official API credentials needed). Good for development/self-hosted use.
 * - **Business API**: Uses the official WhatsApp Business API with webhook for
 *   inbound and REST for outbound. Requires a Meta Business account.
 *
 * @module
 */

import { BaseChannelPlugin } from '../../gateway/channel.js';
import type { WebhookRouter } from '../../gateway/channel.js';
import type { OutboundMessage, MessageAttachment } from '../../gateway/message.js';
import { createGatewayMessage } from '../../gateway/message.js';
import { GatewayConnectionError } from '../../gateway/errors.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../../gateway/media.js';
import { ensureLazyModule } from '../../utils/lazy-import.js';
import type { WhatsAppChannelConfig } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const SESSION_PREFIX = 'whatsapp';
const BUSINESS_API_BASE = 'https://graph.facebook.com/v21.0';

// ============================================================================
// @whiskeysockets/baileys type shims (loaded lazily)
// ============================================================================

interface BaileysSocket {
  ev: BaileysEventEmitter;
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  end(reason?: Error): void;
}

interface BaileysEventEmitter {
  on(event: string, handler: (...args: unknown[]) => void): void;
}

interface BaileysMessage {
  key: {
    remoteJid?: string | null;
    fromMe?: boolean;
    id?: string;
  };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { url?: string; mimetype?: string; fileLength?: number | bigint; caption?: string };
    documentMessage?: { url?: string; mimetype?: string; fileName?: string; fileLength?: number | bigint };
    audioMessage?: { url?: string; mimetype?: string; fileLength?: number | bigint };
    videoMessage?: { url?: string; mimetype?: string; fileLength?: number | bigint; caption?: string };
  };
  pushName?: string;
}

interface BaileysAuthState {
  state: unknown;
  saveCreds: () => Promise<void>;
}

interface BaileysModule {
  default: (opts: {
    auth: unknown;
    printQRInTerminal?: boolean;
  }) => BaileysSocket;
  useMultiFileAuthState: (path: string) => Promise<BaileysAuthState>;
}

// ============================================================================
// WhatsAppChannel Plugin
// ============================================================================

export class WhatsAppChannel extends BaseChannelPlugin {
  readonly name = SESSION_PREFIX;

  private socket: BaileysSocket | null = null;
  private healthy = false;
  private readonly config: WhatsAppChannelConfig;
  private readonly sessionMap = new Map<string, string>(); // sessionId → jid/phone

  constructor(config: WhatsAppChannelConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.config.mode === 'baileys') {
      await this.startBaileys();
    } else {
      this.startBusinessApi();
    }
  }

  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.healthy = false;
    this.sessionMap.clear();
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Webhooks (Business API mode)
  // --------------------------------------------------------------------------

  registerWebhooks(router: WebhookRouter): void {
    if (this.config.mode !== 'business-api') return;

    router.get('/verify', async (req) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === this.config.webhookVerifyToken) {
        return { status: 200, body: challenge };
      }
      return { status: 403, body: 'Forbidden' };
    });

    router.post('/incoming', async (req) => {
      try {
        await this.handleBusinessApiWebhook(req.body);
      } catch (err) {
        this.context.logger.error(`Error handling WhatsApp webhook: ${errorMessage(err)}`);
      }
      return { status: 200, body: 'OK' };
    });
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<void> {
    const target = this.sessionMap.get(message.sessionId);
    if (!target) {
      this.context.logger.warn(`Cannot resolve target for session: ${message.sessionId}`);
      return;
    }

    try {
      if (this.config.mode === 'baileys') {
        await this.sendBaileys(target, message.content);
      } else {
        await this.sendBusinessApi(target, message.content);
      }
    } catch (err) {
      this.context.logger.error(`Failed to send message to ${message.sessionId}: ${errorMessage(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Baileys mode
  // --------------------------------------------------------------------------

  private async startBaileys(): Promise<void> {
    const mod = await ensureLazyModule<BaileysModule>(
      '@whiskeysockets/baileys',
      (msg) => new GatewayConnectionError(msg),
      (m) => m as unknown as BaileysModule,
    );

    const sessionPath = this.config.sessionPath ?? './whatsapp-session';
    const { state, saveCreds } = await mod.useMultiFileAuthState(sessionPath);

    const socket = mod.default({
      auth: state,
      printQRInTerminal: true,
    });
    this.socket = socket;

    socket.ev.on('creds.update', () => {
      saveCreds().catch((err) => {
        this.context.logger.error(`Failed to save credentials: ${errorMessage(err)}`);
      });
    });

    socket.ev.on('connection.update', (update: unknown) => {
      const u = update as { connection?: string; lastDisconnect?: { error?: Error } };
      if (u.connection === 'open') {
        this.healthy = true;
        this.context.logger.info('WhatsApp connected via Baileys');
      } else if (u.connection === 'close') {
        this.healthy = false;
        this.context.logger.warn('WhatsApp connection closed');
      }
    });

    socket.ev.on('messages.upsert', (upsert: unknown) => {
      const { messages } = upsert as { messages: BaileysMessage[] };
      for (const msg of messages) {
        this.handleBaileysMessage(msg).catch((err) => {
          this.context.logger.error(`Error handling WhatsApp message: ${errorMessage(err)}`);
        });
      }
    });
  }

  private async handleBaileysMessage(msg: BaileysMessage): Promise<void> {
    if (msg.key.fromMe) return;
    if (!msg.key.remoteJid) return;
    if (!msg.message) return;

    const jid = msg.key.remoteJid;
    const phone = jid.split('@')[0];

    if (this.config.allowedNumbers && this.config.allowedNumbers.length > 0) {
      if (!this.config.allowedNumbers.includes(phone)) return;
    }

    const sessionId = `${SESSION_PREFIX}:${jid}`;
    this.sessionMap.set(sessionId, jid);

    const text = this.extractBaileysText(msg);
    const attachments = this.extractBaileysAttachments(msg);

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: phone,
      senderName: msg.pushName ?? phone,
      sessionId,
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        remoteJid: jid,
        messageId: msg.key.id,
      },
      scope: 'dm',
    });

    await this.context.onMessage(gateway);
  }

  private extractBaileysText(msg: BaileysMessage): string {
    if (!msg.message) return '';
    return msg.message.conversation
      ?? msg.message.extendedTextMessage?.text
      ?? msg.message.imageMessage?.caption
      ?? msg.message.videoMessage?.caption
      ?? '';
  }

  private extractBaileysAttachments(msg: BaileysMessage): MessageAttachment[] {
    if (!msg.message) return [];
    const maxBytes = this.config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    const result: MessageAttachment[] = [];

    const checks: Array<{ data: { url?: string; mimetype?: string; fileLength?: number | bigint; fileName?: string } | undefined; type: string }> = [
      { data: msg.message.imageMessage, type: 'image' },
      { data: msg.message.audioMessage, type: 'audio' },
      { data: msg.message.videoMessage, type: 'video' },
      { data: msg.message.documentMessage, type: 'file' },
    ];

    for (const { data, type } of checks) {
      if (!data?.url) continue;
      const size = Number(data.fileLength ?? 0);
      if (size > maxBytes) continue;

      result.push({
        type,
        url: data.url,
        mimeType: data.mimetype ?? 'application/octet-stream',
        filename: (data as { fileName?: string }).fileName,
        sizeBytes: size || undefined,
      });
    }

    return result;
  }

  private async sendBaileys(jid: string, text: string): Promise<void> {
    if (!this.socket) {
      this.context.logger.warn('Cannot send message: WhatsApp socket is not connected');
      return;
    }
    await this.socket.sendMessage(jid, { text });
  }

  // --------------------------------------------------------------------------
  // Business API mode
  // --------------------------------------------------------------------------

  private startBusinessApi(): void {
    if (!this.config.phoneNumberId || !this.config.accessToken) {
      throw new GatewayConnectionError(
        'WhatsApp Business API mode requires phoneNumberId and accessToken',
      );
    }
    this.healthy = true;
    this.context.logger.info('WhatsApp Business API mode ready (webhook-based)');
  }

  private async handleBusinessApiWebhook(body: unknown): Promise<void> {
    const payload = body as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              from: string;
              id: string;
              type: string;
              text?: { body: string };
              timestamp: string;
            }>;
            contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
          };
        }>;
      }>;
    };

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry.changes ?? [];
      for (const change of changes) {
        const messages = change.value?.messages ?? [];
        const contacts = change.value?.contacts ?? [];

        for (const msg of messages) {
          const phone = msg.from;

          if (this.config.allowedNumbers && this.config.allowedNumbers.length > 0) {
            if (!this.config.allowedNumbers.includes(phone)) continue;
          }

          const sessionId = `${SESSION_PREFIX}:${phone}@s.whatsapp.net`;
          this.sessionMap.set(sessionId, phone);

          const contact = contacts.find((c) => c.wa_id === phone);
          const senderName = contact?.profile?.name ?? phone;

          const gateway = createGatewayMessage({
            channel: this.name,
            senderId: phone,
            senderName,
            sessionId,
            content: msg.text?.body ?? '',
            metadata: {
              messageId: msg.id,
              messageType: msg.type,
              phone,
            },
            scope: 'dm',
          });

          await this.context.onMessage(gateway);
        }
      }
    }
  }

  private async sendBusinessApi(phone: string, text: string): Promise<void> {
    const url = `${BUSINESS_API_BASE}/${this.config.phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        text: { body: text },
      }),
    });

    if (!response.ok) {
      throw new Error(`WhatsApp Business API error: ${response.status} ${response.statusText}`);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract a safe error message string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
