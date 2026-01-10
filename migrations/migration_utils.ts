/**
 * Migration Utilities for AgenC Protocol
 *
 * TypeScript helpers for running protocol migrations.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";

/**
 * Get the current protocol version from on-chain state
 */
export async function getProtocolVersion(
  program: Program<any>,
  protocolPda: PublicKey
): Promise<{ version: number; minSupported: number }> {
  const config = await program.account.protocolConfig.fetch(protocolPda);
  return {
    version: config.protocolVersion,
    minSupported: config.minSupportedVersion,
  };
}

/**
 * Check if migration is needed
 */
export async function isMigrationNeeded(
  program: Program<any>,
  protocolPda: PublicKey,
  targetVersion: number
): Promise<boolean> {
  const { version } = await getProtocolVersion(program, protocolPda);
  return version < targetVersion;
}

/**
 * Execute protocol migration
 *
 * @param program - Anchor program instance
 * @param protocolPda - Protocol config PDA
 * @param targetVersion - Version to migrate to
 * @param multisigSigners - Array of multisig signer keypairs
 */
export async function migrateProtocol(
  program: Program<any>,
  protocolPda: PublicKey,
  targetVersion: number,
  multisigSigners: Keypair[]
): Promise<string> {
  const remainingAccounts = multisigSigners.map((signer) => ({
    pubkey: signer.publicKey,
    isSigner: true,
    isWritable: false,
  }));

  const tx = await program.methods
    .migrateProtocol(targetVersion)
    .accounts({
      protocolConfig: protocolPda,
    })
    .remainingAccounts(remainingAccounts)
    .signers(multisigSigners)
    .rpc();

  return tx;
}

/**
 * Update minimum supported version
 */
export async function updateMinVersion(
  program: Program<any>,
  protocolPda: PublicKey,
  newMinVersion: number,
  multisigSigners: Keypair[]
): Promise<string> {
  const remainingAccounts = multisigSigners.map((signer) => ({
    pubkey: signer.publicKey,
    isSigner: true,
    isWritable: false,
  }));

  const tx = await program.methods
    .updateMinVersion(newMinVersion)
    .accounts({
      protocolConfig: protocolPda,
    })
    .remainingAccounts(remainingAccounts)
    .signers(multisigSigners)
    .rpc();

  return tx;
}

/**
 * Verify migration was successful
 */
export async function verifyMigration(
  program: Program<any>,
  protocolPda: PublicKey,
  expectedVersion: number
): Promise<{ success: boolean; actualVersion: number; message: string }> {
  const { version } = await getProtocolVersion(program, protocolPda);

  if (version === expectedVersion) {
    return {
      success: true,
      actualVersion: version,
      message: `Migration successful: protocol at version ${version}`,
    };
  } else {
    return {
      success: false,
      actualVersion: version,
      message: `Migration failed: expected version ${expectedVersion}, got ${version}`,
    };
  }
}

/**
 * Get migration status report
 */
export async function getMigrationStatus(
  program: Program<any>,
  protocolPda: PublicKey,
  programVersion: number
): Promise<{
  currentVersion: number;
  programVersion: number;
  minSupportedVersion: number;
  needsMigration: boolean;
  needsUpgrade: boolean;
  status: "current" | "migratable" | "too_old" | "too_new";
}> {
  const { version, minSupported } = await getProtocolVersion(program, protocolPda);

  let status: "current" | "migratable" | "too_old" | "too_new";
  let needsMigration = false;
  let needsUpgrade = false;

  if (version === programVersion) {
    status = "current";
  } else if (version < programVersion && version >= minSupported) {
    status = "migratable";
    needsMigration = true;
  } else if (version < minSupported) {
    status = "too_old";
    needsMigration = true;
  } else {
    status = "too_new";
    needsUpgrade = true;
  }

  return {
    currentVersion: version,
    programVersion,
    minSupportedVersion: minSupported,
    needsMigration,
    needsUpgrade,
    status,
  };
}

/**
 * Print migration status to console
 */
export function printMigrationStatus(status: Awaited<ReturnType<typeof getMigrationStatus>>): void {
  console.log("\n=== Protocol Version Status ===");
  console.log(`  Account Version:     ${status.currentVersion}`);
  console.log(`  Program Version:     ${status.programVersion}`);
  console.log(`  Min Supported:       ${status.minSupportedVersion}`);
  console.log(`  Status:              ${status.status}`);

  if (status.needsMigration) {
    console.log("\n  ACTION REQUIRED: Run migration to update protocol version");
  }
  if (status.needsUpgrade) {
    console.log("\n  ACTION REQUIRED: Upgrade program to newer version");
  }
  console.log("");
}
