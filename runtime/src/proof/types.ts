/**
 * Type definitions for the ProofEngine module.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import type { MetricsProvider } from "../task/types.js";

// Re-export HashResult from SDK for convenience
export type { HashResult } from "@agenc/sdk";

export type ProverBackend = "local-binary" | "remote";

export interface RouterConfig {
  /** Trusted verifier-router program id */
  routerProgramId?: PublicKey;
  /** Router PDA account */
  routerPda?: PublicKey;
  /** Verifier-entry PDA account */
  verifierEntryPda?: PublicKey;
  /** Trusted verifier program id */
  verifierProgramId?: PublicKey;
}

export interface ProverBackendConfig {
  /** Prover backend kind */
  kind?: ProverBackend;
  /** Absolute path to the agenc-zkvm-host binary (required when kind is 'local-binary') */
  binaryPath?: string;
  /** Prover endpoint URL (required when kind is 'remote') */
  endpoint?: string;
  /** Prover timeout in milliseconds */
  timeoutMs?: number;
  /** Optional headers for remote prover (e.g. auth tokens) */
  headers?: Record<string, string>;
}

export interface ToolsStatus {
  /** Runtime currently has a RISC0-capable SDK backend wired */
  risc0: boolean;
  /** Active prover backend mode */
  proverBackend: ProverBackend;
  /** Whether a method id is explicitly pinned in config */
  methodIdPinned: boolean;
  /** Whether router/verifier account ids are explicitly pinned in config */
  routerPinned: boolean;
}

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
  /** Optional pinned RISC0 method id (image id, 32 bytes) */
  methodId?: Uint8Array;
  /** Optional trusted router/verifier account config */
  routerConfig?: RouterConfig;
  /** Optional prover backend config */
  proverBackend?: ProverBackendConfig;
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
   * Private witness for the zkVM guest's `agent_secret` input.
   * Used to derive nullifier seed bytes in SDK proof generation.
   *
   * SECURITY: Must be a secret known only to the agent. Using a predictable
   * value allows anyone who knows the agent's
   * public key (always public on-chain) to predict the nullifier and front-run
   * proof submissions.
   */
  agentSecret: bigint;
}

/**
 * Result from the ProofEngine's generate() method.
 */
export interface EngineProofResult {
  /** Router seal bytes (selector + proof, typically 260 bytes) */
  sealBytes: Uint8Array;
  /** Fixed-size journal bytes (192 bytes) */
  journal: Uint8Array;
  /** RISC0 method id (32 bytes) */
  imageId: Uint8Array;
  /** Binding spend seed (32 bytes) */
  bindingSeed: Uint8Array;
  /** Nullifier spend seed (32 bytes) */
  nullifierSeed: Uint8Array;
  /** Size of the seal payload in bytes */
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
