/**
 * Jupiter skill type definitions.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";

/**
 * Well-known token mint descriptor.
 */
export interface TokenMint {
  /** Mint address (base58) */
  readonly address: string;
  /** Token symbol (e.g. "SOL", "USDC") */
  readonly symbol: string;
  /** Token decimals */
  readonly decimals: number;
}

/**
 * Configuration for JupiterSkill.
 */
export interface JupiterSkillConfig {
  /** Jupiter V6 API base URL (default: https://quote-api.jup.ag/v6) */
  apiBaseUrl?: string;
  /** Default slippage in basis points (default: 50 = 0.5%) */
  defaultSlippageBps?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Parameters for requesting a swap quote.
 */
export interface SwapQuoteParams {
  /** Input token mint address (base58) */
  inputMint: string;
  /** Output token mint address (base58) */
  outputMint: string;
  /** Amount in smallest unit (lamports for SOL) */
  amount: bigint;
  /** Slippage tolerance in basis points (overrides default) */
  slippageBps?: number;
  /** Restrict to direct routes only */
  onlyDirectRoutes?: boolean;
}

/**
 * Swap quote response from Jupiter.
 */
export interface SwapQuote {
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
  /** Input amount in smallest unit */
  inAmount: bigint;
  /** Expected output amount in smallest unit */
  outAmount: bigint;
  /** Minimum output amount with slippage applied */
  otherAmountThreshold: bigint;
  /** Price impact percentage (0-100) */
  priceImpactPct: number;
  /** Raw quote response (needed for swap execution) */
  rawQuote: Record<string, unknown>;
}

/**
 * Result of a swap execution.
 */
export interface SwapResult {
  /** Transaction signature */
  txSignature: string;
  /** Input amount consumed */
  inputAmount: bigint;
  /** Output amount received */
  outputAmount: bigint;
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
}

/**
 * Token balance information.
 */
export interface TokenBalance {
  /** Token mint address */
  mint: string;
  /** Token symbol if known */
  symbol: string | null;
  /** Balance in smallest unit */
  amount: bigint;
  /** Token decimals */
  decimals: number;
  /** Balance as human-readable number */
  uiAmount: number;
}

/**
 * Parameters for transferring SOL.
 */
export interface TransferSolParams {
  /** Recipient public key */
  recipient: PublicKey;
  /** Amount in lamports */
  lamports: bigint;
}

/**
 * Parameters for transferring an SPL token.
 */
export interface TransferTokenParams {
  /** Recipient wallet public key (not ATA) */
  recipient: PublicKey;
  /** Token mint address */
  mint: PublicKey;
  /** Amount in smallest unit */
  amount: bigint;
}

/**
 * Result of a transfer operation.
 */
export interface TransferResult {
  /** Transaction signature */
  txSignature: string;
  /** Amount transferred */
  amount: bigint;
}

/**
 * Token price information.
 */
export interface TokenPrice {
  /** Token mint address */
  mint: string;
  /** Price in USD */
  priceUsd: number;
}
