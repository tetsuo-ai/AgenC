/**
 * Type definitions for cross-protocol bridge adapters.
 *
 * Covers LangChain tool compatibility, x402 micropayments,
 * and Farcaster social posting.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';

// ============================================================================
// LangChain Bridge Types
// ============================================================================

/**
 * LangChain-compatible tool definition.
 *
 * Matches the shape expected by LangChain's `DynamicTool` constructor
 * without importing the langchain package.
 */
export interface LangChainTool {
  /** Tool name (matches Tool.name) */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /**
   * Execute the tool. Takes a JSON string input and returns a string result.
   * Matches LangChain's `DynamicTool.call` signature.
   */
  call(input: string): Promise<string>;
}

/** Configuration for the LangChain bridge. */
export interface LangChainBridgeConfig {
  /** Logger instance */
  logger?: Logger;
}

// ============================================================================
// x402 Bridge Types
// ============================================================================

/** A payment request conforming to x402 HTTP payment protocol semantics. */
export interface X402PaymentRequest {
  /** Recipient Solana address (base58) */
  readonly recipient: string;
  /** Payment amount in lamports */
  readonly amountLamports: bigint;
  /** Optional memo attached to the transfer */
  readonly memo?: string;
}

/** Result of processing an x402 payment. */
export interface X402PaymentResponse {
  /** Transaction signature */
  readonly signature: string;
  /** Amount transferred in lamports */
  readonly amountLamports: bigint;
  /** Recipient address */
  readonly recipient: string;
}

/** Configuration for the x402 bridge. */
export interface X402BridgeConfig {
  /** Maximum payment amount in lamports (default: 1 SOL = 1_000_000_000) */
  maxPaymentLamports?: bigint;
  /** Logger instance */
  logger?: Logger;
}

// ============================================================================
// Farcaster Bridge Types
// ============================================================================

/** Parameters for posting a cast to Farcaster. */
export interface FarcasterPostParams {
  /** Cast text content (max 320 characters) */
  readonly text: string;
  /** Optional channel to post in */
  readonly channelId?: string;
  /** Optional parent cast URL for replies */
  readonly parentUrl?: string;
}

/** Result of posting a cast to Farcaster via Neynar API. */
export interface FarcasterPostResult {
  /** Whether the post was successful */
  readonly success: boolean;
  /** Cast hash if successful */
  readonly castHash?: string;
}

/** Configuration for the Farcaster bridge. */
export interface FarcasterBridgeConfig {
  /** Neynar API key */
  readonly apiKey: string;
  /** Neynar signer UUID for posting */
  readonly signerUuid: string;
  /** Neynar API base URL (default: https://api.neynar.com/v2) */
  apiBaseUrl?: string;
  /** Delay in ms between sequential posts in syncFeedToFarcaster (default: 1000) */
  delayBetweenPostsMs?: number;
  /** Logger instance */
  logger?: Logger;
}
