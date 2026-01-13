/**
 * AgenC SDK Constants
 */

import { PublicKey } from '@solana/web3.js';

/** AgenC Coordination Program ID */
export const PROGRAM_ID = new PublicKey('EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ');

/** Sunspot Groth16 Verifier Program ID */
export const VERIFIER_PROGRAM_ID = new PublicKey('8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ');

/** Privacy Cash Program ID */
export const PRIVACY_CASH_PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');

/** Default Devnet RPC endpoint */
export const DEVNET_RPC = 'https://api.devnet.solana.com';

/** Default Mainnet RPC (Helius recommended) */
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** Proof size in bytes (Groth16) */
export const PROOF_SIZE_BYTES = 388;

/** Approximate verification compute units */
export const VERIFICATION_COMPUTE_UNITS = 50_000;

/** Number of public inputs in the circuit */
export const PUBLIC_INPUTS_COUNT = 35;

/** Task states */
export enum TaskState {
  Open = 0,
  Claimed = 1,
  Completed = 2,
  Disputed = 3,
  Cancelled = 4,
}

/** PDA seeds */
export const SEEDS = {
  PROTOCOL: Buffer.from('protocol'),
  TASK: Buffer.from('task'),
  CLAIM: Buffer.from('claim'),
  AGENT: Buffer.from('agent'),
  ESCROW: Buffer.from('escrow'),
} as const;
