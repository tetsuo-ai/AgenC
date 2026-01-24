/**
 * AgenC SDK Constants
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================================
// Program IDs
// ============================================================================

/** AgenC Coordination Program ID */
export const PROGRAM_ID = new PublicKey('EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ');

/** Privacy Cash Program ID */
export const PRIVACY_CASH_PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');

// ============================================================================
// RPC Endpoints
// ============================================================================

/** Default Devnet RPC endpoint */
export const DEVNET_RPC = 'https://api.devnet.solana.com';

/** Default Mainnet RPC (Helius recommended) */
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// ============================================================================
// Size Constants
// ============================================================================

/** Size of cryptographic hashes in bytes (SHA256, Poseidon) */
export const HASH_SIZE = 32;

/** Size of result/description data fields in bytes */
export const RESULT_DATA_SIZE = 64;

/** Size of a u64 in bytes for buffer encoding */
export const U64_SIZE = 8;

/** Anchor account discriminator size in bytes */
export const DISCRIMINATOR_SIZE = 8;

/** Number of field elements in output array (circuit constraint) */
export const OUTPUT_FIELD_COUNT = 4;

// ============================================================================
// ZK Proof Constants
// ============================================================================

/** Proof size in bytes (Groth16 via groth16-solana) */
export const PROOF_SIZE_BYTES = 256;

/** Approximate verification compute units */
export const VERIFICATION_COMPUTE_UNITS = 50_000;

/** Number of public inputs in the circuit (32 task_id bytes + 32 agent bytes + constraint_hash + output_commitment + expected_binding) */
export const PUBLIC_INPUTS_COUNT = 67;

// ============================================================================
// Fee Constants
// ============================================================================

/** Base for percentage calculations (100 = 100%) */
export const PERCENT_BASE = 100;

/** Default protocol fee percentage */
export const DEFAULT_FEE_PERCENT = 1;

/**
 * Task states matching on-chain TaskStatus enum.
 * Values MUST match programs/agenc-coordination/src/state.rs:TaskStatus
 */
export enum TaskState {
  /** Task is open for claims */
  Open = 0,
  /** Task has been claimed and is being worked on */
  InProgress = 1,
  /** Task is awaiting validation */
  PendingValidation = 2,
  /** Task has been completed successfully */
  Completed = 3,
  /** Task has been cancelled by creator */
  Cancelled = 4,
  /** Task is in dispute resolution */
  Disputed = 5,
}

/** PDA seeds */
export const SEEDS = {
  PROTOCOL: Buffer.from('protocol'),
  TASK: Buffer.from('task'),
  CLAIM: Buffer.from('claim'),
  AGENT: Buffer.from('agent'),
  ESCROW: Buffer.from('escrow'),
} as const;
