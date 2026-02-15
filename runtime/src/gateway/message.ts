/**
 * Unified message format for the AgenC Gateway.
 *
 * All messaging channels normalize inbound messages into `GatewayMessage`
 * before reaching the agent. Outbound responses use `OutboundMessage`.
 * This decouples channel-specific wire formats from the core agent loop.
 *
 * Zero dependencies on other gateway modules — this is the contract
 * between channel plugins and the core agent loop.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

// ============================================================================
// Message Scope
// ============================================================================

/** Message scope discriminator. */
export type MessageScope = 'dm' | 'group' | 'thread';

const VALID_SCOPES: ReadonlySet<string> = new Set<MessageScope>(['dm', 'group', 'thread']);

// ============================================================================
// Attachment
// ============================================================================

/** Attachment type discriminator. */
export type AttachmentType = 'image' | 'file' | 'voice' | 'video';

const VALID_ATTACHMENT_TYPES: ReadonlySet<string> = new Set<AttachmentType>([
  'image',
  'file',
  'voice',
  'video',
]);

/** Attachment on an inbound or outbound message. */
export interface MessageAttachment {
  /** Attachment type discriminator. */
  readonly type: AttachmentType;
  /** Remote URL (if hosted). */
  readonly url?: string;
  /** Raw binary data (if inline). */
  readonly data?: Uint8Array;
  /** MIME type (e.g. 'image/png', 'audio/ogg'). */
  readonly mimeType: string;
  /** Original filename. */
  readonly filename?: string;
  /** Size in bytes (for quota enforcement). */
  readonly sizeBytes?: number;
  /** Duration in seconds (for audio/video). */
  readonly durationSeconds?: number;
}

// ============================================================================
// GatewayMessage (Inbound)
// ============================================================================

/** Inbound message normalized from any channel plugin. */
export interface GatewayMessage {
  /** Unique message ID (UUID v4). */
  readonly id: string;
  /** Source channel name (e.g. 'telegram', 'discord'). */
  readonly channel: string;
  /** Channel-specific sender identifier (e.g. Telegram user ID). */
  readonly senderId: string;
  /** Display name of sender. */
  readonly senderName: string;
  /** Resolved cross-channel identity ID (see Phase 1.9). */
  readonly identityId?: string;
  /** Session ID derived from scope rules + channel + sender. */
  readonly sessionId: string;
  /** Message text content. */
  readonly content: string;
  /** Optional attachments (images, files, voice, video). */
  readonly attachments?: readonly MessageAttachment[];
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
  /** Channel-specific metadata (thread ID, reply-to, guild, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Whether this is a DM, group message, or thread reply. */
  readonly scope: MessageScope;
}

// ============================================================================
// OutboundMessage
// ============================================================================

/** Outbound message from agent to a channel. */
export interface OutboundMessage {
  /** Target session ID. */
  readonly sessionId: string;
  /** Text content (markdown). */
  readonly content: string;
  /** Optional attachments. */
  readonly attachments?: readonly MessageAttachment[];
  /** Whether this is a streaming partial update. */
  readonly isPartial?: boolean;
  /** Whether to synthesize and send as voice note. */
  readonly tts?: boolean;
}

// ============================================================================
// Factory Functions
// ============================================================================

/** Factory function to create a GatewayMessage with generated ID and timestamp. */
export function createGatewayMessage(
  params: Omit<GatewayMessage, 'id' | 'timestamp'>,
): GatewayMessage {
  return {
    ...params,
    id: randomUUID(),
    timestamp: Date.now(),
  };
}

/** Factory function to create an OutboundMessage. */
export function createOutboundMessage(params: OutboundMessage): OutboundMessage {
  return { ...params };
}

// ============================================================================
// Validation
// ============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate that a GatewayMessage has all required fields. */
export function validateGatewayMessage(msg: unknown): msg is GatewayMessage {
  if (!isObject(msg)) return false;

  if (!isNonEmptyString(msg.id)) return false;
  if (!isNonEmptyString(msg.channel)) return false;
  if (!isNonEmptyString(msg.senderId)) return false;
  if (!isNonEmptyString(msg.senderName)) return false;
  if (!isNonEmptyString(msg.sessionId)) return false;
  if (typeof msg.content !== 'string') return false;
  if (typeof msg.timestamp !== 'number') return false;

  if (!isNonEmptyString(msg.scope) || !VALID_SCOPES.has(msg.scope)) return false;

  if (msg.attachments !== undefined) {
    if (!Array.isArray(msg.attachments)) return false;
    for (const att of msg.attachments) {
      if (!isValidAttachmentShape(att)) return false;
    }
  }

  return true;
}

function isValidAttachmentShape(att: unknown): boolean {
  if (!isObject(att)) return false;
  if (!isNonEmptyString(att.type) || !VALID_ATTACHMENT_TYPES.has(att.type)) return false;
  if (!isNonEmptyString(att.mimeType)) return false;
  return true;
}

/** Validate attachment constraints (size, MIME type). */
export function validateAttachment(
  attachment: MessageAttachment,
  maxSizeBytes?: number,
): { valid: boolean; reason?: string } {
  if (!attachment.mimeType || attachment.mimeType.length === 0) {
    return { valid: false, reason: 'Attachment MIME type must not be empty' };
  }

  if (
    maxSizeBytes !== undefined &&
    attachment.sizeBytes !== undefined &&
    attachment.sizeBytes > maxSizeBytes
  ) {
    return {
      valid: false,
      reason: `Attachment size ${attachment.sizeBytes} bytes exceeds limit of ${maxSizeBytes} bytes`,
    };
  }

  return { valid: true };
}
