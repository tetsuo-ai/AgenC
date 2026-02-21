/**
 * Skills module — PDA helpers, types, and CU budget constants.
 */

import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants.js";

// ============================================================================
// PDA helpers
// ============================================================================

export function deriveSkillPda(
  authorAgentPda: PublicKey,
  skillId: Uint8Array | Buffer,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL, authorAgentPda.toBuffer(), Buffer.from(skillId)],
    programId,
  );
}

export function deriveSkillRatingPda(
  skillPda: PublicKey,
  raterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL_RATING, skillPda.toBuffer(), raterAgentPda.toBuffer()],
    programId,
  );
}

export function deriveSkillPurchasePda(
  skillPda: PublicKey,
  buyerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SKILL_PURCHASE, skillPda.toBuffer(), buyerAgentPda.toBuffer()],
    programId,
  );
}

// ============================================================================
// Compute unit budgets
// ============================================================================

/** CU budget for register_skill instruction */
export const RECOMMENDED_CU_REGISTER_SKILL = 50_000;

/** CU budget for update_skill instruction */
export const RECOMMENDED_CU_UPDATE_SKILL = 30_000;

/** CU budget for rate_skill instruction */
export const RECOMMENDED_CU_RATE_SKILL = 40_000;

/** CU budget for purchase_skill instruction (SOL path) */
export const RECOMMENDED_CU_PURCHASE_SKILL = 60_000;

/** CU budget for purchase_skill instruction (SPL token path) */
export const RECOMMENDED_CU_PURCHASE_SKILL_TOKEN = 100_000;

// ============================================================================
// Types
// ============================================================================

export interface RegisterSkillParams {
  skillId: Uint8Array;
  name: Uint8Array;
  contentHash: Uint8Array;
  price: bigint;
  priceMint?: PublicKey;
  tags: Uint8Array;
}

export interface UpdateSkillParams {
  contentHash: Uint8Array;
  price: bigint;
  tags?: Uint8Array;
  isActive?: boolean;
}

export interface RateSkillParams {
  rating: number;
  reviewHash?: Uint8Array;
}

export interface SkillState {
  author: PublicKey;
  skillId: Uint8Array;
  name: Uint8Array;
  contentHash: Uint8Array;
  price: bigint;
  priceMint: PublicKey | null;
  tags: Uint8Array;
  totalRating: bigint;
  ratingCount: number;
  downloadCount: number;
  version: number;
  isActive: boolean;
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
}

export interface SkillRatingState {
  skill: PublicKey;
  rater: PublicKey;
  rating: number;
  reviewHash: Uint8Array | null;
  raterReputation: number;
  timestamp: bigint;
  bump: number;
}

export interface PurchaseRecordState {
  skill: PublicKey;
  buyer: PublicKey;
  pricePaid: bigint;
  timestamp: bigint;
  bump: number;
}
