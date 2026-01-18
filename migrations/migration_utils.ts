/**
 * Migration Utilities for AgenC Protocol
 *
 * TypeScript helpers for running protocol migrations.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Commitment } from "@solana/web3.js";

/**
 * Custom error class for migration-related errors
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Validate version number is a positive integer
 */
function validateVersion(version: number, paramName: string): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new MigrationError(
      `${paramName} must be a non-negative integer, got: ${version}`,
      "INVALID_VERSION"
    );
  }
}

/**
 * Get the current protocol version from on-chain state
 */
export async function getProtocolVersion(
  program: Program<any>,
  protocolPda: PublicKey
): Promise<{ version: number; minSupported: number }> {
  try {
    const config = await program.account.protocolConfig.fetch(protocolPda);
    return {
      version: config.protocolVersion,
      minSupported: config.minSupportedVersion,
    };
  } catch (error) {
    throw new MigrationError(
      `Failed to fetch protocol config from ${protocolPda.toBase58()}`,
      "FETCH_CONFIG_FAILED",
      error
    );
  }
}

/**
 * Check if migration is needed
 */
export async function isMigrationNeeded(
  program: Program<any>,
  protocolPda: PublicKey,
  targetVersion: number
): Promise<boolean> {
  validateVersion(targetVersion, "targetVersion");
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
 * @param commitment - Transaction confirmation commitment level (default: "confirmed")
 */
export async function migrateProtocol(
  program: Program<any>,
  protocolPda: PublicKey,
  targetVersion: number,
  multisigSigners: Keypair[],
  commitment: Commitment = "finalized"
): Promise<string> {
  validateVersion(targetVersion, "targetVersion");

  if (!multisigSigners || multisigSigners.length === 0) {
    throw new MigrationError(
      "At least one multisig signer is required",
      "NO_SIGNERS"
    );
  }

  const remainingAccounts = multisigSigners.map((signer) => ({
    pubkey: signer.publicKey,
    isSigner: true,
    isWritable: false,
  }));

  try {
    const tx = await program.methods
      .migrateProtocol(targetVersion)
      .accounts({
        protocolConfig: protocolPda,
      })
      .remainingAccounts(remainingAccounts)
      .signers(multisigSigners)
      .rpc();

    // Confirm transaction to ensure it landed on-chain
    const connection = program.provider.connection;
    await connection.confirmTransaction(tx, commitment);

    return tx;
  } catch (error) {
    // Check if this is an Anchor program error
    if (error && typeof error === "object" && "error" in error) {
      const anchorError = error as { error?: { errorCode?: { code: string }; errorMessage?: string } };
      throw new MigrationError(
        `Migration to version ${targetVersion} failed: ${anchorError.error?.errorMessage || "Unknown error"}`,
        anchorError.error?.errorCode?.code || "MIGRATION_FAILED",
        error
      );
    }
    throw new MigrationError(
      `Migration to version ${targetVersion} failed`,
      "MIGRATION_FAILED",
      error
    );
  }
}

/**
 * Update minimum supported version
 *
 * @param program - Anchor program instance
 * @param protocolPda - Protocol config PDA
 * @param newMinVersion - New minimum supported version
 * @param multisigSigners - Array of multisig signer keypairs
 * @param commitment - Transaction confirmation commitment level (default: "confirmed")
 */
export async function updateMinVersion(
  program: Program<any>,
  protocolPda: PublicKey,
  newMinVersion: number,
  multisigSigners: Keypair[],
  commitment: Commitment = "finalized"
): Promise<string> {
  validateVersion(newMinVersion, "newMinVersion");

  if (!multisigSigners || multisigSigners.length === 0) {
    throw new MigrationError(
      "At least one multisig signer is required",
      "NO_SIGNERS"
    );
  }

  const remainingAccounts = multisigSigners.map((signer) => ({
    pubkey: signer.publicKey,
    isSigner: true,
    isWritable: false,
  }));

  try {
    const tx = await program.methods
      .updateMinVersion(newMinVersion)
      .accounts({
        protocolConfig: protocolPda,
      })
      .remainingAccounts(remainingAccounts)
      .signers(multisigSigners)
      .rpc();

    // Confirm transaction to ensure it landed on-chain
    const connection = program.provider.connection;
    await connection.confirmTransaction(tx, commitment);

    return tx;
  } catch (error) {
    // Check if this is an Anchor program error
    if (error && typeof error === "object" && "error" in error) {
      const anchorError = error as { error?: { errorCode?: { code: string }; errorMessage?: string } };
      throw new MigrationError(
        `Update min version to ${newMinVersion} failed: ${anchorError.error?.errorMessage || "Unknown error"}`,
        anchorError.error?.errorCode?.code || "UPDATE_MIN_VERSION_FAILED",
        error
      );
    }
    throw new MigrationError(
      `Update min version to ${newMinVersion} failed`,
      "UPDATE_MIN_VERSION_FAILED",
      error
    );
  }
}

/**
 * Verify migration was successful
 */
export async function verifyMigration(
  program: Program<any>,
  protocolPda: PublicKey,
  expectedVersion: number
): Promise<{ success: boolean; actualVersion: number; message: string }> {
  validateVersion(expectedVersion, "expectedVersion");

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
  validateVersion(programVersion, "programVersion");

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
