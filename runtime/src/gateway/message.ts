/**
 * Unified message format for the AgenC Gateway.
 *
 * Defines canonical inbound (`GatewayMessage`) and outbound (`OutboundMessage`)
 * types that all channel plugins normalize to/from. This is the foundational
 * type layer for Phase 1.2 — no dependencies on other gateway modules.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  type ValidationResult,
  validationResult,
  requireNonEmptyString,
  requireFiniteNumber,
  requireOneOf,
} from "../utils/validation.js";
import { isRecord } from "../utils/type-guards.js";

// ============================================================================
// Scope
// ============================================================================

/** Conversation scope for a gateway message. */
export type MessageScope = "dm" | "group" | "thread";

const VALID_SCOPES: ReadonlySet<string> = new Set<string>([
  "dm",
  "group",
  "thread",
]);

// ============================================================================
// Attachments
// ============================================================================

/** A media attachment on a gateway message. */
export interface MessageAttachment {
  /** Attachment kind (e.g. 'image', 'audio', 'video', 'file'). */
  readonly type: string;
  /** Remote URL if the attachment is hosted externally. */
  readonly url?: string;
  /** Raw binary data for inline attachments. */
  readonly data?: Uint8Array;
  /** MIME type (e.g. 'image/png', 'audio/ogg'). */
  readonly mimeType: string;
  /** Original filename, if available. */
  readonly filename?: string;
  /** File size in bytes. */
  readonly sizeBytes?: number;
  /** Duration in seconds for audio/video attachments. */
  readonly durationSeconds?: number;
}

// ============================================================================
// GatewayMessage (inbound)
// ============================================================================

/** Canonical inbound message from any channel plugin. */
export interface GatewayMessage {
  /** Unique message identifier (UUID v4). */
  readonly id: string;
  /** Channel name that produced this message (e.g. 'telegram', 'discord'). */
  readonly channel: string;
  /** Platform-specific sender identifier. */
  readonly senderId: string;
  /** Human-readable sender display name. */
  readonly senderName: string;
  /** Resolved cross-channel identity, if available. */
  readonly identityId?: string;
  /** Session identifier for conversation continuity. */
  readonly sessionId: string;
  /** Message text content. Empty string is valid (e.g. voice-only messages). */
  readonly content: string;
  /** Media attachments. */
  readonly attachments?: readonly MessageAttachment[];
  /** Unix epoch milliseconds when the message was received. */
  readonly timestamp: number;
  /** Arbitrary channel-specific metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Conversation scope. */
  readonly scope: MessageScope;
}

// ============================================================================
// OutboundMessage
// ============================================================================

/** Response message to send back through a channel plugin. */
export interface OutboundMessage {
  /** Target session identifier. */
  readonly sessionId: string;
  /** Response text content. */
  readonly content: string;
  /** Media attachments to include in the response. */
  readonly attachments?: readonly MessageAttachment[];
  /** Whether this is a partial/streaming chunk. */
  readonly isPartial?: boolean;
  /** Whether the message should be spoken via text-to-speech. */
  readonly tts?: boolean;
}

// ============================================================================
// Factory params
// ============================================================================

/** Parameters for creating a GatewayMessage (id and timestamp are generated). */
export type CreateGatewayMessageParams = Omit<
  GatewayMessage,
  "id" | "timestamp"
>;

// ============================================================================
// Factory functions
// ============================================================================

/**
 * Create a new GatewayMessage with an auto-generated UUID and timestamp.
 */
export function createGatewayMessage(
  params: CreateGatewayMessageParams,
): GatewayMessage {
  return {
    ...params,
    id: randomUUID(),
    timestamp: Date.now(),
  };
}

/**
 * Create a new OutboundMessage, validating required fields.
 */
export function createOutboundMessage(
  params: OutboundMessage,
): OutboundMessage {
  const result = validateOutboundMessage(params);
  if (!result.valid) {
    throw new TypeError(`Invalid OutboundMessage: ${result.errors.join("; ")}`);
  }
  return { ...params };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a GatewayMessage-shaped object, accumulating all errors.
 */
export function validateGatewayMessage(msg: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(msg)) {
    return { valid: false, errors: ["Message must be a non-null object"] };
  }

  requireNonEmptyString(msg.id, "id", errors);
  requireNonEmptyString(msg.channel, "channel", errors);
  requireNonEmptyString(msg.senderId, "senderId", errors);
  requireNonEmptyString(msg.senderName, "senderName", errors);
  requireNonEmptyString(msg.sessionId, "sessionId", errors);

  if (typeof msg.content !== "string") {
    errors.push("content must be a string");
  }

  requireFiniteNumber(msg.timestamp, "timestamp", errors);
  requireOneOf(msg.scope, "scope", VALID_SCOPES, errors);

  if (msg.attachments !== undefined) {
    if (!Array.isArray(msg.attachments)) {
      errors.push("attachments must be an array");
    } else {
      for (let i = 0; i < msg.attachments.length; i++) {
        const result = validateAttachment(msg.attachments[i] as unknown);
        if (!result.valid) {
          for (const err of result.errors) {
            errors.push(`attachments[${i}]: ${err}`);
          }
        }
      }
    }
  }

  return validationResult(errors);
}

/**
 * Validate an OutboundMessage-shaped object, accumulating all errors.
 */
export function validateOutboundMessage(msg: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(msg)) {
    return {
      valid: false,
      errors: ["OutboundMessage must be a non-null object"],
    };
  }

  requireNonEmptyString(msg.sessionId, "sessionId", errors);

  if (typeof msg.content !== "string") {
    errors.push("content must be a string");
  }

  return validationResult(errors);
}

/**
 * Validate a single attachment object.
 *
 * Exported separately for reuse by media pipeline (#1059).
 * Returns accumulated errors (consistent with other gateway validators).
 */
export function validateAttachment(
  att: unknown,
  maxSizeBytes?: number,
): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(att)) {
    return { valid: false, errors: ["Attachment must be a non-null object"] };
  }

  requireNonEmptyString(att.type, "type", errors);
  requireNonEmptyString(att.mimeType, "mimeType", errors);

  if (att.sizeBytes !== undefined) {
    if (typeof att.sizeBytes !== "number" || att.sizeBytes < 0) {
      errors.push("sizeBytes must be a non-negative number");
    } else if (maxSizeBytes !== undefined && att.sizeBytes > maxSizeBytes) {
      errors.push(
        `sizeBytes (${att.sizeBytes}) exceeds maximum (${maxSizeBytes})`,
      );
    }
  }

  return validationResult(errors);
}
