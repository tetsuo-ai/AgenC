/**
 * Wallet type definitions and helpers for @agenc/runtime
 *
 * Provides Anchor-compatible wallet interfaces that work with both
 * Node.js Keypairs and browser wallet adapters.
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";

/**
 * Anchor-compatible wallet interface.
 *
 * This interface is compatible with:
 * - Anchor's `Wallet` class (for Keypair wrapping)
 * - Solana wallet adapters (e.g., @solana/wallet-adapter-base)
 */
export interface Wallet {
  /** The wallet's public key */
  publicKey: PublicKey;

  /**
   * Sign a single transaction.
   * @param tx - Transaction to sign (legacy or versioned)
   * @returns The signed transaction
   */
  signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T>;

  /**
   * Sign multiple transactions.
   * @param txs - Array of transactions to sign
   * @returns Array of signed transactions
   */
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]>;
}

/**
 * Extended wallet interface with optional message signing.
 *
 * Some wallets (like Phantom) support signing arbitrary messages.
 * This is useful for authentication and off-chain signatures.
 */
export interface SignMessageWallet extends Wallet {
  /**
   * Sign an arbitrary message (optional capability).
   * @param message - The message bytes to sign
   * @returns The signature bytes
   */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Error thrown when loading a keypair file fails.
 */
export class KeypairFileError extends Error {
  /** The file path that caused the error */
  public readonly filePath: string;
  /** The underlying error, if any */
  public readonly cause?: Error;

  constructor(message: string, filePath: string, cause?: Error) {
    super(message);
    this.name = "KeypairFileError";
    this.filePath = filePath;
    this.cause = cause;
    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KeypairFileError);
    }
  }
}

/**
 * Wrap a Keypair as an Anchor-compatible Wallet.
 *
 * @example
 * ```typescript
 * import { Keypair } from '@solana/web3.js';
 * import { keypairToWallet } from '@agenc/runtime';
 *
 * const keypair = Keypair.generate();
 * const wallet = keypairToWallet(keypair);
 *
 * // Use with AnchorProvider
 * const provider = new AnchorProvider(connection, wallet, {});
 * ```
 *
 * @param keypair - The Keypair to wrap
 * @returns A Wallet interface wrapping the keypair
 */
/**
 * Convert a Keypair or Wallet to a Wallet.
 *
 * If the input is already a Wallet, it is returned as-is.
 * If it is a Keypair, it is wrapped via keypairToWallet().
 */
export function ensureWallet(wallet: Keypair | Wallet): Wallet {
  return "secretKey" in wallet ? keypairToWallet(wallet) : wallet;
}

export function keypairToWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,

    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },

    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      for (const tx of txs) {
        if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
        } else {
          tx.partialSign(keypair);
        }
      }
      return txs;
    },
  };
}

/**
 * Get the default Solana keypair file path.
 *
 * @returns Path to `~/.config/solana/id.json`
 */
export function getDefaultKeypairPath(): string {
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

/**
 * Parse keypair JSON content into a Keypair.
 *
 * @param content - The JSON string content
 * @param filePath - The file path (for error messages)
 * @returns The parsed Keypair
 * @throws KeypairFileError if the content is invalid
 */
function parseKeypairJson(content: string, filePath: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new KeypairFileError(
      `Invalid JSON in keypair file: ${filePath}`,
      filePath,
      err instanceof Error ? err : undefined,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new KeypairFileError(
      `Keypair file must contain a JSON array, got ${typeof parsed}`,
      filePath,
    );
  }

  if (parsed.length !== 64) {
    throw new KeypairFileError(
      `Keypair file must contain 64 bytes, got ${parsed.length}`,
      filePath,
    );
  }

  // Validate each byte value
  for (let i = 0; i < parsed.length; i++) {
    const value = parsed[i];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    ) {
      throw new KeypairFileError(
        `Invalid byte value at index ${i}: ${value}`,
        filePath,
      );
    }
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/**
 * Load a Keypair from a JSON file asynchronously.
 *
 * The file should contain a JSON array of 64 bytes representing
 * the secret key (as exported by `solana-keygen`).
 *
 * @example
 * ```typescript
 * const keypair = await loadKeypairFromFile('./my-keypair.json');
 * ```
 *
 * @param filePath - Path to the keypair JSON file
 * @returns The loaded Keypair
 * @throws KeypairFileError if the file doesn't exist, contains invalid JSON,
 *         or doesn't contain a valid 64-byte array
 */
export async function loadKeypairFromFile(filePath: string): Promise<Keypair> {
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new KeypairFileError(
        `Keypair file not found: ${filePath}`,
        filePath,
        err,
      );
    }
    throw new KeypairFileError(
      `Failed to read keypair file: ${filePath}`,
      filePath,
      err instanceof Error ? err : undefined,
    );
  }

  return parseKeypairJson(content, filePath);
}

/**
 * Load a Keypair from a JSON file synchronously.
 *
 * @example
 * ```typescript
 * const keypair = loadKeypairFromFileSync('./my-keypair.json');
 * ```
 *
 * @param filePath - Path to the keypair JSON file
 * @returns The loaded Keypair
 * @throws KeypairFileError if the file doesn't exist, contains invalid JSON,
 *         or doesn't contain a valid 64-byte array
 */
export function loadKeypairFromFileSync(filePath: string): Keypair {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new KeypairFileError(
        `Keypair file not found: ${filePath}`,
        filePath,
        err,
      );
    }
    throw new KeypairFileError(
      `Failed to read keypair file: ${filePath}`,
      filePath,
      err instanceof Error ? err : undefined,
    );
  }

  return parseKeypairJson(content, filePath);
}

/**
 * Load the default Solana keypair from `~/.config/solana/id.json`.
 *
 * @example
 * ```typescript
 * const keypair = await loadDefaultKeypair();
 * const wallet = keypairToWallet(keypair);
 * ```
 *
 * @returns The loaded Keypair
 * @throws KeypairFileError if the default keypair file doesn't exist or is invalid
 */
export async function loadDefaultKeypair(): Promise<Keypair> {
  return loadKeypairFromFile(getDefaultKeypairPath());
}
