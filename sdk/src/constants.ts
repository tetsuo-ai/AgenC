/**
 * AgenC SDK Constants
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================================
// Program IDs
// ============================================================================

/** AgenC Coordination Program ID */
export const PROGRAM_ID = new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7');

/** Privacy Cash Program ID */
export const PRIVACY_CASH_PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');

/** AgenC verifier program ID — must match TRUSTED_RISC0_VERIFIER_PROGRAM_ID on-chain */
export const VERIFIER_PROGRAM_ID = new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge');

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

/** Size of cryptographic hashes in bytes (SHA-256) */
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

/** Proof body size in bytes (router verifier payload) */
export const PROOF_SIZE_BYTES = 256;

/** RISC0 selector size in bytes */
export const RISC0_SELECTOR_LEN = 4;

/** RISC0 Groth16 seal proof body length in bytes */
export const RISC0_GROTH16_SEAL_LEN = 256;

/** RISC0 borsh-encoded seal length (selector + proof body) */
export const RISC0_SEAL_BORSH_LEN = RISC0_SELECTOR_LEN + RISC0_GROTH16_SEAL_LEN;

/** RISC0 fixed journal length (6 x 32-byte fields) */
export const RISC0_JOURNAL_LEN = 192;

/** RISC0 image ID length in bytes */
export const RISC0_IMAGE_ID_LEN = 32;

/** Trusted RISC0 selector for router verification */
export const TRUSTED_RISC0_SELECTOR = Uint8Array.from([0x52, 0x5a, 0x56, 0x4d]);

/**
 * Trusted RISC0 image ID pinned by protocol policy.
 *
 * TODO(CRIT-3): This is an arithmetic placeholder, not a real SHA-256 digest of
 * the guest ELF. To compute the real image ID:
 *   1. Install rzup (RISC Zero toolchain manager)
 *   2. Build zkvm workspace with `production-prover` feature:
 *      cargo build -p agenc-zkvm-host --features production-prover
 *   3. Extract AGENC_GUEST_ID from agenc-zkvm-methods crate
 *   4. Convert via guest_id_to_image_id() (LE u32x8 → [u8; 32])
 *   5. Update this constant AND the on-chain TRUSTED_RISC0_IMAGE_ID in
 *      programs/agenc-coordination/src/instructions/complete_task_private.rs
 *   Both values MUST match exactly or complete_task_private will reject all proofs.
 */
export const TRUSTED_RISC0_IMAGE_ID = Uint8Array.from([
  6, 15, 16, 25, 34, 43, 44, 53, 62, 71, 72, 81, 90, 99, 100, 109, 118, 127, 128, 137, 146, 155,
  156, 165, 174, 183, 184, 193, 202, 211, 212, 221,
]);

/**
 * @deprecated Since v1.3.0. Use {@link RECOMMENDED_CU_COMPLETE_TASK_PRIVATE} instead.
 * Will be removed in v2.0.0.
 * See: https://github.com/tetsuo-ai/AgenC/issues/983
 */
export const VERIFICATION_COMPUTE_UNITS = 50_000;

/** Number of public inputs in the circuit (32 task_id bytes + 32 agent bytes + constraint_hash + output_commitment + expected_binding) */
export const PUBLIC_INPUTS_COUNT = 67;

// ============================================================================
// Recommended Compute Unit Budgets (issue #40)
// ============================================================================
//
// These values should be used with ComputeBudgetProgram.setComputeUnitLimit()
// when building transactions to avoid paying for the default 200k CU allocation.
// Values are profiled upper bounds with safety margin.

/** CU budget for register_agent instruction */
export const RECOMMENDED_CU_REGISTER_AGENT = 40_000;

/** CU budget for update_agent instruction */
export const RECOMMENDED_CU_UPDATE_AGENT = 20_000;

/** CU budget for create_task instruction */
export const RECOMMENDED_CU_CREATE_TASK = 50_000;

/** CU budget for create_dependent_task instruction */
export const RECOMMENDED_CU_CREATE_DEPENDENT_TASK = 60_000;

/** CU budget for claim_task instruction */
export const RECOMMENDED_CU_CLAIM_TASK = 30_000;

/** CU budget for complete_task (public) instruction */
export const RECOMMENDED_CU_COMPLETE_TASK = 60_000;

/** CU budget for complete_task_private (ZK) instruction - highest due to RISC Zero verifier router CPI */
export const RECOMMENDED_CU_COMPLETE_TASK_PRIVATE = 200_000;

/** CU budget for cancel_task instruction */
export const RECOMMENDED_CU_CANCEL_TASK = 40_000;

/** CU budget for initiate_dispute instruction */
export const RECOMMENDED_CU_INITIATE_DISPUTE = 50_000;

/** CU budget for vote_dispute instruction */
export const RECOMMENDED_CU_VOTE_DISPUTE = 30_000;

/** CU budget for resolve_dispute instruction */
export const RECOMMENDED_CU_RESOLVE_DISPUTE = 60_000;

// Token-path CU budgets (higher due to ATA creation/CPI overhead)

/** CU budget for create_task with SPL token escrow */
export const RECOMMENDED_CU_CREATE_TASK_TOKEN = 100_000;

/** CU budget for complete_task with SPL token payment */
export const RECOMMENDED_CU_COMPLETE_TASK_TOKEN = 100_000;

/** CU budget for complete_task_private with SPL token payment */
export const RECOMMENDED_CU_COMPLETE_TASK_PRIVATE_TOKEN = 250_000;

/** CU budget for cancel_task with SPL token refund */
export const RECOMMENDED_CU_CANCEL_TASK_TOKEN = 80_000;

// Reputation economy CU budgets

/** CU budget for stake_reputation instruction */
export const RECOMMENDED_CU_STAKE_REPUTATION = 40_000;

/** CU budget for delegate_reputation instruction */
export const RECOMMENDED_CU_DELEGATE_REPUTATION = 50_000;

/** CU budget for withdraw_reputation_stake instruction */
export const RECOMMENDED_CU_WITHDRAW_REPUTATION_STAKE = 40_000;

/** CU budget for revoke_delegation instruction */
export const RECOMMENDED_CU_REVOKE_DELEGATION = 30_000;

// ============================================================================
// Fee Constants
// ============================================================================

/** Basis points divisor (100% = 10000 bps) - matches on-chain constant */
export const BASIS_POINTS_DIVISOR = 10_000;

/** Base for percentage calculations (100 = 100%) */
export const PERCENT_BASE = 100;

/** Default protocol fee percentage */
export const DEFAULT_FEE_PERCENT = 1;

/** Maximum protocol fee in basis points (10%) */
export const MAX_PROTOCOL_FEE_BPS = 1000;

// ============================================================================
// Fee Tier Thresholds (issue #40)
// ============================================================================
//
// Volume-based fee discounts. Must match on-chain FEE_TIER_THRESHOLDS.

/** Fee tier: [minCompletedTasks, discountBps] */
export const FEE_TIERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],       // Base tier: no discount
  [50, 10],     // Bronze: 10 bps discount
  [200, 25],    // Silver: 25 bps discount
  [1000, 40],   // Gold: 40 bps discount
] as const;

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
  DISPUTE: Buffer.from('dispute'),
  VOTE: Buffer.from('vote'),
  AUTHORITY_VOTE: Buffer.from('authority_vote'),
  NULLIFIER: Buffer.from('nullifier'),
  PROPOSAL: Buffer.from('proposal'),
  GOVERNANCE_VOTE: Buffer.from('governance_vote'),
  GOVERNANCE: Buffer.from('governance'),
  SKILL: Buffer.from('skill'),
  SKILL_RATING: Buffer.from('skill_rating'),
  SKILL_PURCHASE: Buffer.from('skill_purchase'),
  REPUTATION_STAKE: Buffer.from('reputation_stake'),
  REPUTATION_DELEGATION: Buffer.from('reputation_delegation'),
} as const;
