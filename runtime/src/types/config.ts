/**
 * Configuration types for AgentRuntime
 * @module
 */

import type { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type { Wallet } from './wallet.js';
import type { LogLevel } from '../utils/logger.js';

/**
 * Configuration for AgentRuntime.
 *
 * @example
 * ```typescript
 * const config: AgentRuntimeConfig = {
 *   connection: new Connection('https://api.devnet.solana.com'),
 *   wallet: keypair, // or Wallet interface
 *   capabilities: AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE,
 *   initialStake: 1_000_000_000n, // 1 SOL
 *   logLevel: 'info',
 * };
 * ```
 */
export interface AgentRuntimeConfig {
  /** Solana RPC connection (required) */
  connection: Connection;

  /** Wallet for signing - Keypair or Wallet interface (required) */
  wallet: Keypair | Wallet;

  /** Custom program ID (default: PROGRAM_ID from @agenc/sdk) */
  programId?: PublicKey;

  /** Agent ID to load (default: generates new random 32-byte ID) */
  agentId?: Uint8Array;

  /** Capabilities bitmask (required for new registration) */
  capabilities?: bigint;

  /** Network endpoint (default: agent://<short_id>) */
  endpoint?: string;

  /** Metadata URI for extended agent details */
  metadataUri?: string;

  /** Initial stake in lamports (default: 0n) */
  initialStake?: bigint;

  /** Log level (default: no logging) */
  logLevel?: LogLevel;
}

/**
 * Type guard: check if wallet is a Keypair (has secretKey property).
 *
 * @param wallet - Wallet or Keypair to check
 * @returns True if wallet is a Keypair
 *
 * @example
 * ```typescript
 * if (isKeypair(config.wallet)) {
 *   // config.wallet is typed as Keypair
 *   console.log('Using keypair with public key:', config.wallet.publicKey.toBase58());
 * }
 * ```
 */
export function isKeypair(wallet: Keypair | Wallet): wallet is Keypair {
  return 'secretKey' in wallet;
}
