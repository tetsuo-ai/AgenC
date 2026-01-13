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
  ProofGenerationParams,
  ProofResult,
} from './proofs';

export {
  createTask,
  claimTask,
  completeTask,
  completeTaskPrivate,
  getTask,
  TaskParams,
  TaskState,
  TaskStatus,
} from './tasks';

export {
  PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  PRIVACY_CASH_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
} from './constants';

// Version info
export const VERSION = '1.0.0';
