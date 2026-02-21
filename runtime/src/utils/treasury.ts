/**
 * Shared treasury-fetching helper.
 *
 * Extracts the protocol treasury address from the on-chain ProtocolConfig.
 * Used by TaskOperations, DisputeOperations, and AutonomousAgent.
 *
 * @module
 */

import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import { findProtocolPda } from "../agent/pda.js";

/**
 * Fetch the protocol treasury address from on-chain config.
 *
 * Callers should cache the result to avoid repeated RPC calls.
 */
export async function fetchTreasury(
  program: Program<AgencCoordination>,
  programId: PublicKey,
): Promise<PublicKey> {
  const protocolPda = findProtocolPda(programId);
  const config = await program.account.protocolConfig.fetch(protocolPda);
  return config.treasury as PublicKey;
}
