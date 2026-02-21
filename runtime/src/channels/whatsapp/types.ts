/**
 * Configuration interface for the WhatsApp channel plugin.
 *
 * Supports two modes:
 * - `baileys`: WebSocket-based connection via @whiskeysockets/baileys (no business API needed)
 * - `business-api`: Official WhatsApp Business API via webhook + REST
 *
 * @module
 */

export interface WhatsAppChannelConfig {
  /** Connection mode. */
  readonly mode: "baileys" | "business-api";

  // --- Baileys mode ---
  /** Path to store authentication state (baileys mode). */
  readonly sessionPath?: string;

  // --- Business API mode ---
  /** WhatsApp Business API phone number ID (business-api mode). */
  readonly phoneNumberId?: string;
  /** Access token for the WhatsApp Business API (business-api mode). */
  readonly accessToken?: string;
  /** Webhook verify token for the Business API (business-api mode). */
  readonly webhookVerifyToken?: string;

  // --- Common ---
  /** Restrict to specific phone numbers. Empty = all numbers. */
  readonly allowedNumbers?: readonly string[];
  /** Maximum attachment size in bytes. @default 25 * 1024 * 1024 (25 MB) */
  readonly maxAttachmentBytes?: number;
}
