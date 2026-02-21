/**
 * AgenC Coordination Program IDL and Program Factory Functions
 *
 * IMPORTANT: Anchor generates two files with different naming conventions:
 * - target/idl/agenc_coordination.json (snake_case) - Runtime IDL data
 * - target/types/agenc_coordination.ts (camelCase) - TypeScript type helper
 *
 * The raw IDL JSON uses snake_case names. We export it typed as Anchor's
 * generic `Idl` type which correctly represents this structure. The
 * `AgencCoordination` type is only used for `Program<T>` generics where
 * Anchor handles the snake_case to camelCase mapping internally.
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@agenc/sdk";

// Import IDL type from Anchor-generated TypeScript file (for Program<T> generic)
import type { AgencCoordination } from "./types/agenc_coordination";
// Import IDL JSON data (tsconfig has resolveJsonModule: true)
import idlJson from "../idl/agenc_coordination.json";

/** Re-export the IDL type for Program<T> generics */
export type { AgencCoordination };

/**
 * The AgenC Coordination program IDL.
 *
 * Typed as Anchor's generic `Idl` which correctly represents the snake_case
 * JSON structure. Use `Program<AgencCoordination>` for type-safe method access.
 */
export const IDL: Idl = idlJson as Idl;

/**
 * Placeholder public key for read-only providers.
 * Uses a deterministic value derived from ones to avoid Keypair.generate() overhead.
 * This is never used for signing - only as a wallet identity placeholder.
 * Using fill(1) instead of fill(0) avoids PublicKey.default (system program at all zeros).
 */
const READ_ONLY_PLACEHOLDER_PUBKEY = new PublicKey(new Uint8Array(32).fill(1));

/**
 * Validates that an IDL has expected structure.
 * Throws a descriptive error if the IDL is malformed.
 *
 * Note: If the IDL file doesn't exist, Node.js throws ERR_MODULE_NOT_FOUND
 * at import time before this function is called. The copy-idl.js prebuild
 * script handles missing file errors with descriptive messages.
 *
 * @param idl - The IDL to validate (defaults to the imported IDL)
 * @throws Error if IDL is malformed (missing address or instructions)
 */
export function validateIdl(idl: Idl = IDL): void {
  if (!idl.address) {
    throw new Error(
      "IDL is missing program address. The IDL file may be corrupted or from an older Anchor version. " +
        'Run "anchor build" to regenerate the IDL.',
    );
  }
  if (!idl.instructions || idl.instructions.length === 0) {
    throw new Error(
      "IDL has no instructions. The IDL file may be corrupted. " +
        'Run "anchor build" to regenerate the IDL.',
    );
  }
}

/**
 * Returns the IDL configured for a specific program ID.
 * If programId matches the default PROGRAM_ID, returns the original IDL.
 * Otherwise, returns a copy with the address field updated.
 *
 * @internal
 */
function getIdlForProgram(programId: PublicKey): Idl {
  if (programId.equals(PROGRAM_ID)) {
    return IDL;
  }
  // Create IDL copy with custom program address for local testing
  return { ...IDL, address: programId.toBase58() };
}

/**
 * Creates a read-only AnchorProvider that throws on signing attempts.
 * Uses a deterministic placeholder public key as the wallet identity.
 *
 * @internal
 */
function createReadOnlyProvider(connection: Connection): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey: READ_ONLY_PLACEHOLDER_PUBKEY,
      signTransaction: async () => {
        throw new Error(
          "Cannot sign with read-only program. Use createProgram() instead.",
        );
      },
      signAllTransactions: async () => {
        throw new Error(
          "Cannot sign with read-only program. Use createProgram() instead.",
        );
      },
    },
    { commitment: "confirmed" },
  );
}

/**
 * Creates a Program instance for transactions.
 *
 * @param provider - AnchorProvider with connection and wallet
 * @param programId - Optional custom program ID (defaults to PROGRAM_ID)
 * @returns Program instance configured for the specified program ID
 *
 * @example
 * ```typescript
 * const provider = new AnchorProvider(connection, wallet, {});
 * const program = createProgram(provider);
 * await program.methods.createTask(...).rpc();
 * ```
 */
export function createProgram(
  provider: AnchorProvider,
  programId: PublicKey = PROGRAM_ID,
): Program<AgencCoordination> {
  validateIdl();
  // Cast to AgencCoordination for type-safe Program access
  // Anchor's Program class handles snake_case ↔ camelCase mapping internally
  return new Program<AgencCoordination>(
    getIdlForProgram(programId) as AgencCoordination,
    provider,
  );
}

/**
 * Creates a read-only Program instance (no wallet required).
 * Use this for querying account data without signing transactions.
 *
 * @param connection - Solana RPC connection
 * @param programId - Optional custom program ID (defaults to PROGRAM_ID)
 * @returns Program instance that throws on any signing attempt
 *
 * @example
 * ```typescript
 * const connection = new Connection('https://api.devnet.solana.com');
 * const program = createReadOnlyProgram(connection);
 * const task = await program.account.task.fetch(taskPda);
 * ```
 */
export function createReadOnlyProgram(
  connection: Connection,
  programId: PublicKey = PROGRAM_ID,
): Program<AgencCoordination> {
  validateIdl();
  // Cast to AgencCoordination for type-safe Program access
  // Anchor's Program class handles snake_case ↔ camelCase mapping internally
  return new Program<AgencCoordination>(
    getIdlForProgram(programId) as AgencCoordination,
    createReadOnlyProvider(connection),
  );
}
