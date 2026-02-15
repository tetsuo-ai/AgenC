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
import { isRecord } from '../utils/type-guards.js';

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

// ============================================================================
// Validation
// ============================================================================

/** Validation result with optional reason for failure. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validate that a value is a well-formed GatewayMessage. */
export function validateGatewayMessage(msg: unknown): ValidationResult {
  if (!isRecord(msg)) return { valid: false, reason: 'Message must be a non-null object' };

  if (!isNonEmptyString(msg.id)) return { valid: false, reason: 'id must be a non-empty string' };
  if (!isNonEmptyString(msg.channel)) return { valid: false, reason: 'channel must be a non-empty string' };
  if (!isNonEmptyString(msg.senderId)) return { valid: false, reason: 'senderId must be a non-empty string' };
  if (!isNonEmptyString(msg.senderName)) return { valid: false, reason: 'senderName must be a non-empty string' };
  if (!isNonEmptyString(msg.sessionId)) return { valid: false, reason: 'sessionId must be a non-empty string' };
  if (typeof msg.content !== 'string') return { valid: false, reason: 'content must be a string' };
  if (typeof msg.timestamp !== 'number') return { valid: false, reason: 'timestamp must be a number' };

  if (!isNonEmptyString(msg.scope) || !VALID_SCOPES.has(msg.scope)) {
    return { valid: false, reason: `scope must be one of: ${[...VALID_SCOPES].join(', ')}` };
  }

  if (msg.attachments !== undefined) {
    if (!Array.isArray(msg.attachments)) return { valid: false, reason: 'attachments must be an array' };
    for (let i = 0; i < msg.attachments.length; i++) {
      const attResult = isValidAttachmentShape(msg.attachments[i]);
      if (!attResult.valid) return { valid: false, reason: `attachments[${i}]: ${attResult.reason}` };
    }
  }

  return { valid: true };
}

function isValidAttachmentShape(att: unknown): ValidationResult {
  if (!isRecord(att)) return { valid: false, reason: 'attachment must be a non-null object' };
  if (!isNonEmptyString(att.type) || !VALID_ATTACHMENT_TYPES.has(att.type)) {
    return { valid: false, reason: `type must be one of: ${[...VALID_ATTACHMENT_TYPES].join(', ')}` };
  }
  if (!isNonEmptyString(att.mimeType)) return { valid: false, reason: 'mimeType must be a non-empty string' };
  return { valid: true };
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
