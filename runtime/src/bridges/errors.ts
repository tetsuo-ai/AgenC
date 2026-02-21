/**
 * Bridge-specific error classes for @agenc/runtime
 *
 * All bridge errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when a cross-protocol bridge operation fails.
 */
export class BridgeError extends RuntimeError {
  /** The bridge that produced the error (e.g. "langchain", "x402", "farcaster") */
  public readonly bridge: string;
  /** The reason the bridge operation failed */
  public readonly reason: string;

  constructor(bridge: string, reason: string) {
    super(
      `Bridge "${bridge}" error: ${reason}`,
      RuntimeErrorCodes.BRIDGE_ERROR,
    );
    this.name = "BridgeError";
    this.bridge = bridge;
    this.reason = reason;
  }
}

/**
 * Error thrown when an x402 payment transfer fails.
 */
export class BridgePaymentError extends RuntimeError {
  /** Payment recipient address */
  public readonly recipient: string;
  /** Requested amount in lamports */
  public readonly amountLamports: bigint;
  /** The reason the payment failed */
  public readonly reason: string;

  constructor(recipient: string, amountLamports: bigint, reason: string) {
    super(
      `Payment to ${recipient} failed: ${reason}`,
      RuntimeErrorCodes.BRIDGE_PAYMENT_ERROR,
    );
    this.name = "BridgePaymentError";
    this.recipient = recipient;
    this.amountLamports = amountLamports;
    this.reason = reason;
  }
}
