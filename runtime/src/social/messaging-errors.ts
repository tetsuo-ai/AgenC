/**
 * Messaging-specific error classes for @agenc/runtime
 *
 * All messaging errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a message send operation fails (on-chain tx or off-chain delivery).
 */
export class MessagingSendError extends RuntimeError {
  /** The recipient public key (base58 string) */
  public readonly recipient: string;
  /** The reason the send failed */
  public readonly reason: string;

  constructor(recipient: string, reason: string) {
    super(
      `Message send failed to ${recipient}: ${reason}`,
      RuntimeErrorCodes.MESSAGING_SEND_ERROR,
    );
    this.name = 'MessagingSendError';
    this.recipient = recipient;
    this.reason = reason;
  }
}

/**
 * Error thrown when an off-chain WebSocket connection fails.
 */
export class MessagingConnectionError extends RuntimeError {
  /** The endpoint that failed to connect */
  public readonly endpoint: string;
  /** The reason the connection failed */
  public readonly reason: string;

  constructor(endpoint: string, reason: string) {
    super(
      `Messaging connection failed to ${endpoint}: ${reason}`,
      RuntimeErrorCodes.MESSAGING_CONNECTION_ERROR,
    );
    this.name = 'MessagingConnectionError';
    this.endpoint = endpoint;
    this.reason = reason;
  }
}

/**
 * Error thrown when Ed25519 signature verification fails.
 */
export class MessagingSignatureError extends RuntimeError {
  /** The sender public key (base58 string) */
  public readonly sender: string;
  /** The reason verification failed */
  public readonly reason: string;

  constructor(sender: string, reason: string) {
    super(
      `Messaging signature verification failed for ${sender}: ${reason}`,
      RuntimeErrorCodes.MESSAGING_SIGNATURE_ERROR,
    );
    this.name = 'MessagingSignatureError';
    this.sender = sender;
    this.reason = reason;
  }
}
