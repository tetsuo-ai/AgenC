/**
 * Internal Anchor utilities shared across SDK modules.
 *
 * Provides type-safe dynamic account access for Anchor programs,
 * since Program<T> doesn't expose individual account types at the
 * type level when using the generic Idl.
 */

import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";

/**
 * Dynamic account accessor returned by Anchor's `program.account[name]`.
 */
export type AccountFetcher = {
  fetch: (key: PublicKey) => Promise<unknown>;
  all: (
    filters?: Array<{ memcmp: { offset: number; bytes: string } }>,
  ) => Promise<Array<{ account: unknown; publicKey: PublicKey }>>;
};

/**
 * Retrieve an account accessor from an Anchor program by name.
 * Throws with a helpful message listing available accounts if the name is invalid.
 */
export function getAccount(program: Program, name: string): AccountFetcher {
  const accounts = program.account as Record<
    string,
    AccountFetcher | undefined
  >;
  const account = accounts[name];
  if (!account) {
    throw new Error(
      `Account "${name}" not found in program. ` +
        `Available accounts: ${Object.keys(accounts).join(", ") || "none"}`,
    );
  }
  return account;
}
