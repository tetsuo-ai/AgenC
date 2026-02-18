/**
 * Type definitions for the ProofEngine module (Phase 7).
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Logger } from '../utils/logger.js';
import type { MetricsProvider } from '../task/types.js';

// Re-export HashResult from SDK for convenience
export type { HashResult } from '@agenc/sdk';
export type { ToolsStatus } from '@agenc/sdk';

/**
 * Configuration for the proof cache.
 */
export interface ProofCacheConfig {
  /** Time-to-live in milliseconds. Default: 300_000 (5 min) */
  ttlMs?: number;
  /** Maximum number of cached entries. Default: 100 */
  maxEntries?: number;
}

/**
 * Configuration for the ProofEngine.
 */
export interface ProofEngineConfig {
  /** Path to the circuit directory. Default: './circuits-circom/task_completion' */
  circuitPath?: string;
  /** Whether to verify proofs after generation. Default: false */
  verifyAfterGeneration?: boolean;
  /** Cache configuration. Omit to disable caching. */
  cache?: ProofCacheConfig;
  /** Logger instance */
  logger?: Logger;
  /** Optional metrics provider for telemetry */
  metrics?: MetricsProvider;
}

/**
 * Input parameters for proof generation.
 */
export interface ProofInputs {
  /** Task PDA address */
  taskPda: PublicKey;
  /** Agent's public key */
  agentPubkey: PublicKey;
  /** Task output (4 field elements) */
  output: bigint[];
  /** Random salt for commitment */
  salt: bigint;
  /**
   * Private witness for the circuit's `agent_secret` input.
   * Used to derive the nullifier: `Poseidon(constraint_hash, agent_secret)`.
   *
   * SECURITY: If omitted, the SDK falls back to `pubkeyToField(agentPubkey)`,
   * which makes the nullifier predictable by anyone who knows the agent's
   * public key (always public on-chain). Pass an explicit secret for production use.
   */
  agentSecret?: bigint;
}

/**
 * Result from the ProofEngine's generate() method.
 */
export interface EngineProofResult {
  /** Generated proof bytes (256 bytes Groth16) */
  proof: Uint8Array;
  /** Constraint hash (32 bytes) */
  constraintHash: Uint8Array;
  /** Output commitment (32 bytes) */
  outputCommitment: Uint8Array;
  /** Expected binding (32 bytes) */
  expectedBinding: Uint8Array;
  /** Nullifier to prevent proof/knowledge reuse (32 bytes) */
  nullifier: Uint8Array;
  /** Size of the proof in bytes */
  proofSize: number;
  /** Time taken for proof generation in milliseconds */
  generationTimeMs: number;
  /** Whether the result was served from cache */
  fromCache: boolean;
  /** Whether the proof was verified after generation */
  verified: boolean;
}

/**
 * Statistics snapshot from the ProofEngine.
 */
export interface ProofEngineStats {
  /** Number of proofs actually generated (excludes cache hits) */
  proofsGenerated: number;
  /** Total number of generate() calls */
  totalRequests: number;
  /** Number of cache hits */
  cacheHits: number;
  /** Number of cache misses */
  cacheMisses: number;
  /** Average generation time in ms (excludes cache hits) */
  avgGenerationTimeMs: number;
  /** Number of verification checks performed */
  verificationsPerformed: number;
  /** Number of verification failures */
  verificationsFailed: number;
  /** Current cache size */
  cacheSize: number;
}
