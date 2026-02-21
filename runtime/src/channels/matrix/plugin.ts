/**
 * Matrix channel plugin — bridges the Matrix protocol to the Gateway.
 *
 * Uses matrix-js-sdk v34+ as a lazy-loaded optional dependency. Connects
 * to a homeserver via access token, listens for room timeline events,
 * and optionally auto-joins rooms on invite.
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
import type { MatrixChannelConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const SESSION_PREFIX = "matrix";

// ============================================================================
// matrix-js-sdk type shims (loaded lazily)
// ============================================================================

interface MatrixClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  startClient(opts?: { initialSyncLimit?: number }): Promise<void>;
  stopClient(): void;
  sendTextMessage(roomId: string, body: string): Promise<unknown>;
  joinRoom(roomId: string): Promise<unknown>;
  getUserId(): string | null;
  getSyncState(): string | null;
}

interface MatrixEvent {
  getType(): string;
  getSender(): string;
  getContent(): MatrixMessageContent;
  event: { origin_server_ts?: number };
}

interface MatrixRoom {
  roomId: string;
  getJoinedMemberCount(): number;
}

interface MatrixMember {
  userId: string;
  membership: string;
  roomId: string;
}

interface MatrixMessageContent {
  msgtype?: string;
  body?: string;
  url?: string;
  info?: {
    mimetype?: string;
    size?: number;
  };
  filename?: string;
}

interface MatrixSdkModule {
  createClient(opts: {
    baseUrl: string;
    accessToken: string;
    userId: string;
  }): MatrixClient;
}

// ============================================================================
// MatrixChannel Plugin
// ============================================================================

export class MatrixChannel extends BaseChannelPlugin {
  readonly name = SESSION_PREFIX;

  private client: MatrixClient | null = null;
  private healthy = false;
  private readonly config: MatrixChannelConfig;

  constructor(config: MatrixChannelConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    const mod = await ensureLazyModule<MatrixSdkModule>(
      "matrix-js-sdk",
      (msg) => new GatewayConnectionError(msg),
      (m) => m as unknown as MatrixSdkModule,
    );

    const client = mod.createClient({
      baseUrl: this.config.homeserverUrl,
      accessToken: this.config.accessToken,
      userId: this.config.userId,
    });
    this.client = client;

    if (this.config.enableE2ee) {
      this.context.logger.warn(
        "Matrix E2EE flag is set but actual crypto support requires @matrix-org/olm — " +
          "messages will be sent unencrypted. E2EE support is reserved for a future release.",
      );
    }

    try {
      this.wireEventHandlers(client);
      await client.startClient({ initialSyncLimit: 0 });
    } catch (err) {
      this.client = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
    this.healthy = false;
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
        "Cannot send message: Matrix client is not connected",
      );
      return;
    }

    const roomId = this.extractRoomId(message.sessionId);
    if (!roomId) {
      this.context.logger.warn(
        `Cannot resolve room for session: ${message.sessionId}`,
      );
      return;
    }

    try {
      await this.client.sendTextMessage(roomId, message.content);
    } catch (err) {
      this.context.logger.error(
        `Failed to send message to ${message.sessionId}: ${errorMessage(err)}`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------

  private wireEventHandlers(client: MatrixClient): void {
    client.on("sync", (state: unknown) => {
      const syncState = state as string;
      if (syncState === "PREPARED" || syncState === "SYNCING") {
        this.healthy = true;
        this.context.logger.info(`Matrix sync state: ${syncState}`);
      } else if (syncState === "ERROR" || syncState === "STOPPED") {
        this.healthy = false;
        this.context.logger.warn(`Matrix sync state: ${syncState}`);
      }
    });

    client.on("Room.timeline", (event: unknown, room: unknown) => {
      this.handleTimelineEvent(event as MatrixEvent, room as MatrixRoom).catch(
        (err) => {
          this.context.logger.error(
            `Error handling Matrix timeline event: ${errorMessage(err)}`,
          );
        },
      );
    });

    if (this.config.autoJoin) {
      client.on("RoomMember.membership", (_event: unknown, member: unknown) => {
        this.handleMembership(member as MatrixMember).catch((err) => {
          this.context.logger.error(
            `Error handling Matrix membership event: ${errorMessage(err)}`,
          );
        });
      });
    }
  }

  // --------------------------------------------------------------------------
  // Inbound: timeline events
  // --------------------------------------------------------------------------

  private async handleTimelineEvent(
    event: MatrixEvent,
    room: MatrixRoom,
  ): Promise<void> {
    if (event.getType() !== "m.room.message") return;

    const senderId = event.getSender();
    if (senderId === this.config.userId) return;

    const roomId = room.roomId;
    if (this.config.roomIds && this.config.roomIds.length > 0) {
      if (!this.config.roomIds.includes(roomId)) return;
    }

    const content = event.getContent();
    const isDM = room.getJoinedMemberCount() <= 2;
    const scope: MessageScope = isDM ? "dm" : "group";
    const sessionId = buildSessionId(isDM, senderId, roomId);

    const text = content.body ?? "";
    const attachments = this.normalizeAttachment(content);

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId,
      senderName: senderId,
      sessionId,
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        roomId,
        msgtype: content.msgtype,
      },
      scope,
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Inbound: membership (auto-join)
  // --------------------------------------------------------------------------

  private async handleMembership(member: MatrixMember): Promise<void> {
    if (member.userId !== this.config.userId) return;
    if (member.membership !== "invite") return;

    try {
      await this.client!.joinRoom(member.roomId);
      this.context.logger.info(`Auto-joined Matrix room: ${member.roomId}`);
    } catch (err) {
      this.context.logger.error(
        `Failed to auto-join room ${member.roomId}: ${errorMessage(err)}`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private extractRoomId(sessionId: string): string | null {
    // Session ID format: matrix:dm:<userId> or matrix:<roomId>:<userId>
    const parts = sessionId.split(":");
    if (parts.length < 3) return null;

    if (parts[1] === "dm") {
      // For DMs we don't store roomId in session — not resolvable without lookup
      // This is a limitation; callers should use the room-based session format
      return null;
    }

    // Reconstruct the roomId (may contain colons, e.g. !abc:matrix.org)
    // Format: matrix:<roomId>:<userId> where roomId itself has colons
    // We need to find the userId part at the end — it starts with @
    const rest = parts.slice(1).join(":");
    const lastAt = rest.lastIndexOf("@");
    if (lastAt <= 0) return null;

    // roomId is everything before the last @, minus the trailing :
    const roomId = rest.slice(0, lastAt - 1);
    return roomId || null;
  }

  private normalizeAttachment(
    content: MatrixMessageContent,
  ): MessageAttachment[] {
    const msgtype = content.msgtype;
    if (!msgtype || msgtype === "m.text" || msgtype === "m.notice") return [];
    if (!content.url) return [];

    const maxBytes =
      this.config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    const size = content.info?.size;
    if (size !== undefined && size > maxBytes) return [];

    const mimeType = content.info?.mimetype ?? "application/octet-stream";
    let type = "file";
    if (msgtype === "m.image") type = "image";
    else if (msgtype === "m.audio") type = "audio";
    else if (msgtype === "m.video") type = "video";

    return [
      {
        type,
        url: content.url,
        mimeType,
        filename: content.filename ?? content.body,
        sizeBytes: size,
      },
    ];
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a session ID from Matrix context.
 * DM: `matrix:dm:<userId>`, Room: `matrix:<roomId>:<userId>`
 */
function buildSessionId(isDM: boolean, userId: string, roomId: string): string {
  if (isDM) {
    return `${SESSION_PREFIX}:dm:${userId}`;
  }
  return `${SESSION_PREFIX}:${roomId}:${userId}`;
}

/** Extract a safe error message string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
