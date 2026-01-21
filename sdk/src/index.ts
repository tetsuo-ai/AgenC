/**
 * @agenc/sdk - Privacy-preserving agent coordination on Solana
 *
 * AgenC enables agents to complete tasks and receive payments with full privacy:
 * - ZK proofs verify task completion without revealing outputs
 * - Privacy Cash breaks payment linkability via shielded pools
 * - Sunspot on-chain verifier validates Noir circuit proofs
 */

// Privacy exports available when privacycash is installed
// import { AgenCPrivacyClient } from './privacy';

export {
  PrivacyClient,
  PrivacyClientConfig,
} from './client';

export {
  generateProof,
  verifyProofLocally,
  computeHashesViaNargo,
  generateSalt,
  checkToolsAvailable,
  requireTools,
  pubkeyToField,
  FIELD_MODULUS,
  // Types
  ProofGenerationParams,
  ProofResult,
  HashResult,
  ToolsStatus,
  // Legacy (deprecated - use computeHashesViaNargo instead)
  computeExpectedBinding,
  computeConstraintHash,
  computeCommitment,
} from './proofs';

export {
  createTask,
  claimTask,
  completeTask,
  completeTaskPrivate,
  getTask,
  getTasksByCreator,
  deriveTaskPda,
  deriveClaimPda,
  deriveEscrowPda,
  formatTaskState,
  calculateEscrowFee,
  TaskParams,
  TaskState,
  TaskStatus,
  PrivateCompletionProof,
} from './tasks';

export {
  PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  // Size constants
  HASH_SIZE,
  RESULT_DATA_SIZE,
  U64_SIZE,
  DISCRIMINATOR_SIZE,
  OUTPUT_FIELD_COUNT,
  // Fee constants
  PERCENT_BASE,
  DEFAULT_FEE_PERCENT,
  // ZK constants
  PROOF_SIZE_BYTES,
  VERIFICATION_COMPUTE_UNITS,
  PUBLIC_INPUTS_COUNT,
  // PDA seeds
  SEEDS,
} from './constants';

// Version info
export const VERSION = '1.0.0';
