/**
 * LiteSVM test helpers for AgenC integration tests.
 *
 * Replaces the anchor-test-validator approach with an in-process Solana VM
 * for ~10x faster test execution. Provides:
 * - createLiteSVMContext(): fully configured LiteSVM + Anchor provider + program
 * - fundAccount(): instant SOL funding (replaces requestAirdrop + confirmTransaction)
 * - getClockTimestamp() / advanceClock(): clock manipulation
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from "anchor-litesvm";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";
import * as bs58 from "bs58";
import { AgencCoordination } from "../target/types/agenc_coordination";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export interface LiteSVMContext {
  svm: LiteSVM;
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  payer: Keypair;
}

/**
 * Inject the BPF Loader Upgradeable ProgramData PDA.
 * Required because `initialize_protocol` validates the upgrade authority
 * via a remaining_accounts check on the ProgramData account.
 */
function setupProgramDataAccount(
  svm: LiteSVM,
  programId: PublicKey,
  authority: PublicKey,
): void {
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  );

  // ProgramData layout:
  //   4 bytes: AccountType (3 = ProgramData, little-endian u32)
  //   8 bytes: slot (u64 LE)
  //   1 byte:  Option<Pubkey> tag (1 = Some)
  //   32 bytes: upgrade_authority pubkey
  const data = new Uint8Array(45);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true); // AccountType::ProgramData
  view.setBigUint64(4, 0n, true); // slot = 0
  data[12] = 1; // Option::Some
  data.set(authority.toBytes(), 13); // upgrade_authority

  svm.setAccount(programDataPda, {
    lamports: 1_000_000_000,
    data,
    owner: BPF_LOADER_UPGRADEABLE_ID,
    executable: false,
  });
}

/**
 * Extend the LiteSVM connection proxy with methods needed by tests
 * and @solana/spl-token helper functions.
 *
 * The base LiteSVMConnectionProxy only provides getAccountInfo,
 * getAccountInfoAndContext, and getMinimumBalanceForRentExemption.
 * We add: getBalance, getLatestBlockhash, sendTransaction,
 * confirmTransaction, requestAirdrop, getSlot, getBlockTime,
 * getTransaction, and getParsedTransaction.
 */
function extendConnectionProxy(
  svm: LiteSVM,
  connection: any,
  walletRef: { publicKey: PublicKey },
): void {
  // Save original getAccountInfo to wrap it
  const originalGetAccountInfo = connection.getAccountInfo.bind(connection);

  // Override getAccountInfo to return null instead of throwing for non-existent accounts.
  // This matches the real Connection behavior and is required by @solana/spl-token.
  connection.getAccountInfo = async (
    publicKey: PublicKey,
    commitmentOrConfig?: any,
  ) => {
    const account = svm.getAccount(publicKey);
    if (!account) return null;
    return {
      ...account,
      data: Buffer.from(account.data),
    };
  };

  // Also override getAccountInfoAndContext for consistency
  connection.getAccountInfoAndContext = async (
    publicKey: PublicKey,
    commitmentOrConfig?: any,
  ) => {
    const account = svm.getAccount(publicKey);
    if (!account) {
      return {
        context: { slot: Number(svm.getClock().slot) },
        value: null,
      };
    }
    return {
      context: { slot: Number(svm.getClock().slot) },
      value: {
        ...account,
        data: Buffer.from(account.data),
      },
    };
  };

  // getBalance — used ~48 times across tests for balance verification
  connection.getBalance = async (
    address: PublicKey,
    _commitment?: any,
  ): Promise<number> => {
    const balance = svm.getBalance(address);
    return balance !== null ? Number(balance) : 0;
  };

  // getLatestBlockhash — needed by @solana/web3.js sendAndConfirmTransaction
  connection.getLatestBlockhash = async (_commitment?: any) => ({
    blockhash: svm.latestBlockhash(),
    lastValidBlockHeight: 0,
  });

  // sendTransaction — needed by @solana/spl-token's helper functions
  // which call sendAndConfirmTransaction(connection, tx, signers)
  connection.sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    signersOrOptions?: any,
    options?: any,
  ): Promise<string> => {
    if ("version" in transaction) {
      // VersionedTransaction
      const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
      signers.forEach((s: any) => transaction.sign([s]));
      const res = svm.sendTransaction(transaction);
      if (res instanceof FailedTransactionMetadata) {
        throw new SendTransactionError({
          action: "send",
          signature: "unknown",
          transactionMessage: res.err().toString(),
          logs: res.meta().logs(),
        });
      }
      return bs58.encode(transaction.signatures[0]);
    }

    // Legacy Transaction
    const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
    transaction.feePayer = transaction.feePayer || walletRef.publicKey;
    transaction.recentBlockhash = svm.latestBlockhash();
    if (signers.length > 0) {
      transaction.sign(...signers);
    }

    const res = svm.sendTransaction(transaction);
    if (res instanceof FailedTransactionMetadata) {
      const sigRaw = transaction.signature;
      const signature = sigRaw ? bs58.encode(sigRaw) : "unknown";
      throw new SendTransactionError({
        action: "send",
        signature,
        transactionMessage: res.err().toString(),
        logs: res.meta().logs(),
      });
    }

    return bs58.encode(transaction.signature!);
  };

  // confirmTransaction — no-op since LiteSVM is synchronous
  connection.confirmTransaction = async (
    _strategyOrSignature?: any,
    _commitment?: any,
  ): Promise<any> => ({
    context: { slot: Number(svm.getClock().slot) },
    value: { err: null },
  });

  // requestAirdrop — delegates to svm.airdrop(), returns a dummy signature
  connection.requestAirdrop = async (
    address: PublicKey,
    lamports: number,
  ): Promise<string> => {
    svm.airdrop(address, BigInt(lamports));
    return "litesvm-airdrop-" + address.toBase58().slice(0, 8);
  };

  // getSlot — used by test_1.ts for timestamp-related tests
  connection.getSlot = async (_commitment?: any): Promise<number> => {
    return Number(svm.getClock().slot);
  };

  // getBlockTime — used by test_1.ts for timestamp checks
  connection.getBlockTime = async (_slot?: number): Promise<number | null> => {
    return Number(svm.getClock().unixTimestamp);
  };

  // getTransaction — used by test_1.ts for fee verification (~7 calls).
  // Returns a simplified object matching the fields tests actually check.
  connection.getTransaction = async (
    signature: string,
    _opts?: any,
  ): Promise<any> => {
    let sigBytes: Uint8Array;
    try {
      sigBytes = bs58.decode(signature);
    } catch {
      return null;
    }

    const meta = svm.getTransaction(sigBytes);
    if (!meta) return null;

    // LiteSVM's TransactionMetadata doesn't expose fee directly.
    // Standard Solana base fee is 5000 lamports per signature.
    const BASE_FEE = 5000;

    if (meta instanceof FailedTransactionMetadata) {
      return {
        meta: {
          fee: BASE_FEE,
          err: meta.err().toString(),
        },
      };
    }

    return {
      meta: {
        fee: BASE_FEE,
        err: null,
      },
    };
  };

  // getParsedTransaction — some test patterns may use this
  connection.getParsedTransaction = connection.getTransaction;

  // getSignatureStatus — no-op, everything is confirmed
  connection.getSignatureStatuses = async (
    _signatures: string[],
    _config?: any,
  ) => ({
    context: { slot: Number(svm.getClock().slot) },
    value: _signatures.map(() => ({
      slot: Number(svm.getClock().slot),
      confirmations: 1,
      err: null,
      confirmationStatus: "confirmed" as const,
    })),
  });
}

/**
 * Create a fully configured LiteSVM test context.
 *
 * Loads the program from the workspace (target/deploy/*.so),
 * sets up the ProgramData PDA for initialize_protocol,
 * creates a funded payer wallet, and returns everything needed for tests.
 *
 * @param opts.splTokens - If true, loads SPL Token, Token-2022, and ATA programs
 */
export function createLiteSVMContext(opts?: {
  splTokens?: boolean;
}): LiteSVMContext {
  // Load the program from Anchor.toml + target/deploy/
  const svm = fromWorkspace(".");

  // Add SPL token programs if requested
  if (opts?.splTokens) {
    svm.withDefaultPrograms();
  }

  // Enable transaction history for getTransaction() support
  svm.withTransactionHistory(10000n);

  // Set initial clock to a realistic timestamp so on-chain time checks work
  // (LiteSVM defaults to unix_timestamp=0 which breaks cooldowns and deadlines)
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
  clock.slot = 1000n;
  svm.setClock(clock);

  // Create and fund the payer keypair
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(1000 * LAMPORTS_PER_SOL));

  // Create Anchor-compatible provider
  const wallet = new anchor.Wallet(payer);
  const provider = new LiteSVMProvider(
    svm,
    wallet,
  ) as unknown as anchor.AnchorProvider;

  // Extend the connection proxy with missing methods
  extendConnectionProxy(svm, (provider as any).connection, wallet);

  // Load IDL and create typed Program instance
  const idl = require("../target/idl/agenc_coordination.json");
  const program = new Program<AgencCoordination>(idl as any, provider);

  // Inject BPF Loader Upgradeable ProgramData PDA
  // (required for initialize_protocol's upgrade authority check)
  setupProgramDataAccount(svm, program.programId, payer.publicKey);

  // Set global provider for Anchor
  anchor.setProvider(provider);

  return { svm, provider, program, payer };
}

/**
 * Fund an account instantly via LiteSVM airdrop.
 * Replaces the requestAirdrop + confirmTransaction pattern.
 */
export function fundAccount(
  svm: LiteSVM,
  pubkey: PublicKey,
  lamports: number | bigint,
): void {
  svm.airdrop(pubkey, BigInt(lamports));
}

/**
 * Get the current clock timestamp from LiteSVM.
 */
export function getClockTimestamp(svm: LiteSVM): number {
  return Number(svm.getClock().unixTimestamp);
}

/**
 * Advance the LiteSVM clock by the specified number of seconds.
 * Also advances the slot proportionally (~2 slots per second).
 */
export function advanceClock(svm: LiteSVM, seconds: number): void {
  const clock = svm.getClock();
  const newTimestamp = clock.unixTimestamp + BigInt(seconds);
  const newSlot = clock.slot + BigInt(seconds * 2);
  clock.unixTimestamp = newTimestamp;
  clock.slot = newSlot;
  svm.setClock(clock);
}
