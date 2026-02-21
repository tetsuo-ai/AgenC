/**
 * x402 bridge adapter.
 *
 * Converts x402 HTTP payment protocol requests into SOL transfers
 * on Solana. SOL-only for now; SPL token support deferred.
 *
 * @module
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Keypair,
} from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { ValidationError } from "../types/errors.js";
import type {
  X402PaymentRequest,
  X402PaymentResponse,
  X402BridgeConfig,
} from "./types.js";
import { BridgePaymentError } from "./errors.js";

/** Default maximum payment: 1 SOL */
const DEFAULT_MAX_PAYMENT_LAMPORTS = 1_000_000_000n;

/** Maximum memo length in bytes */
const MAX_MEMO_LENGTH = 256;

/**
 * Bridge that processes x402 micropayment requests as SOL transfers.
 *
 * Security measures:
 * - Maximum payment cap (configurable, default 1 SOL)
 * - Balance check before transfer
 * - Address validation
 * - Uses `sendAndConfirmTransaction` for reliable confirmation
 *
 * @example
 * ```typescript
 * const bridge = new X402Bridge(connection, payer);
 * const result = await bridge.processPayment({
 *   recipient: 'base58address...',
 *   amountLamports: 100_000n,
 * });
 * ```
 */
export class X402Bridge {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly maxPaymentLamports: bigint;
  private readonly logger: Logger;

  constructor(
    connection: Connection,
    payer: Keypair,
    config?: X402BridgeConfig,
  ) {
    this.connection = connection;
    this.payer = payer;
    this.maxPaymentLamports =
      config?.maxPaymentLamports ?? DEFAULT_MAX_PAYMENT_LAMPORTS;
    this.logger = config?.logger ?? silentLogger;
  }

  /**
   * Validate a payment request without executing it.
   *
   * @throws {ValidationError} If the request is invalid.
   */
  validatePaymentRequest(request: X402PaymentRequest): void {
    // Validate recipient address
    try {
      new PublicKey(request.recipient);
    } catch {
      throw new ValidationError(
        `Invalid recipient address: ${request.recipient}`,
      );
    }

    // Validate amount
    if (request.amountLamports <= 0n) {
      throw new ValidationError("Payment amount must be greater than zero");
    }

    // Validate against max cap
    if (request.amountLamports > this.maxPaymentLamports) {
      throw new BridgePaymentError(
        request.recipient,
        request.amountLamports,
        `Amount ${request.amountLamports} exceeds maximum ${this.maxPaymentLamports} lamports`,
      );
    }

    // Validate memo length
    if (
      request.memo &&
      Buffer.byteLength(request.memo, "utf8") > MAX_MEMO_LENGTH
    ) {
      throw new ValidationError(
        `Memo exceeds maximum length of ${MAX_MEMO_LENGTH} bytes`,
      );
    }
  }

  /**
   * Create a validated payment request.
   *
   * @throws {ValidationError} If any parameter is invalid.
   */
  createPaymentRequest(
    recipient: string,
    amountLamports: bigint,
    memo?: string,
  ): X402PaymentRequest {
    const request: X402PaymentRequest = { recipient, amountLamports, memo };
    this.validatePaymentRequest(request);
    return request;
  }

  /**
   * Process a payment request by transferring SOL.
   *
   * @throws {BridgePaymentError} If balance is insufficient or transfer fails.
   * @throws {ValidationError} If the request is invalid.
   */
  async processPayment(
    request: X402PaymentRequest,
  ): Promise<X402PaymentResponse> {
    this.validatePaymentRequest(request);

    const recipientPubkey = new PublicKey(request.recipient);

    // Check balance
    const balance = await this.connection.getBalance(this.payer.publicKey);
    if (BigInt(balance) < request.amountLamports) {
      throw new BridgePaymentError(
        request.recipient,
        request.amountLamports,
        `Insufficient balance: have ${balance} lamports, need ${request.amountLamports}`,
      );
    }

    this.logger.info(
      `Processing x402 payment: ${request.amountLamports} lamports to ${request.recipient}`,
    );

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: recipientPubkey,
        lamports: Number(request.amountLamports),
      }),
    );

    try {
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.payer],
      );

      this.logger.info(`x402 payment confirmed: ${signature}`);

      return {
        signature,
        amountLamports: request.amountLamports,
        recipient: request.recipient,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BridgePaymentError(
        request.recipient,
        request.amountLamports,
        `Transfer failed: ${message}`,
      );
    }
  }
}
