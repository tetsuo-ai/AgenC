/**
 * LiteSVM test helpers for @agenc/runtime integration tests.
 *
 * Adapted from tests/litesvm-helpers.ts for use within the runtime/ directory.
 * Provides createRuntimeTestContext(), initializeProtocol(), advanceClock(), fundAccount().
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { fromWorkspace, LiteSVMProvider } from 'anchor-litesvm';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from '@solana/web3.js';
import * as bs58 from 'bs58';
import { fileURLToPath } from 'node:url';
import type { AgencCoordination } from '../src/types/agenc_coordination.js';

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
);

/**
 * Patch LiteSVMProvider.sendAndConfirm to fix anchor-litesvm's sendWithErr
 * which crashes on bs58.encode(sigRaw) when sigRaw is null or Uint8Array.
 *
 * The underlying transaction error is masked by the bs58 crash in the error
 * handler. This patch handles signature encoding defensively so the real
 * transaction error is surfaced.
 */
function patchSendAndConfirm(): void {
  const origSendAndConfirm = LiteSVMProvider.prototype.sendAndConfirm;

  (LiteSVMProvider.prototype as any).sendAndConfirm = async function (
    tx: Transaction | VersionedTransaction,
    signers?: any[],
    opts?: any,
  ): Promise<string> {
    // Prepare the transaction exactly as the original does
    if ('version' in tx) {
      signers?.forEach((s: any) => (tx as VersionedTransaction).sign([s]));
    } else {
      (tx as Transaction).feePayer =
        (tx as Transaction).feePayer ?? this.wallet.publicKey;
      (tx as Transaction).recentBlockhash = this.client.latestBlockhash();
      signers?.forEach((s: any) => (tx as Transaction).partialSign(s));
    }
    this.wallet.signTransaction(tx);

    // Encode signature defensively (the original crashes here on error path)
    let signature: string;
    try {
      if ('version' in tx) {
        signature = bs58.encode(Buffer.from(tx.signatures[0]));
      } else {
        if (!(tx as Transaction).signature) throw new Error('no sig');
        signature = bs58.encode(Buffer.from((tx as Transaction).signature!));
      }
    } catch {
      signature = 'unknown';
    }

    // Send and check for failure
    const res = this.client.sendTransaction(tx);

    // instanceof can fail across module boundaries, so also check duck-typing
    const isFailed = res instanceof FailedTransactionMetadata
      || (res && typeof res === 'object' && typeof (res as any).err === 'function' && typeof (res as any).meta === 'function'
          && !(typeof (res as any).confirmations === 'function'));
    if (isFailed) {
      const failedRes = res as FailedTransactionMetadata;
      throw new SendTransactionError({
        action: 'send',
        signature,
        transactionMessage: failedRes.err().toString(),
        logs: failedRes.meta().logs(),
      });
    }

    return signature;
  };
}

export interface RuntimeTestContext {
  svm: LiteSVM;
  program: Program<AgencCoordination>;
  connection: any; // LiteSVM's proxied Connection
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
  authority: PublicKey
): void {
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
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
 * Extend the LiteSVM connection proxy with methods needed by Anchor's
 * AnchorProvider (via AgentManager) and static query methods.
 */
function extendConnectionProxy(
  svm: LiteSVM,
  connection: any,
  walletRef: { publicKey: PublicKey }
): void {
  // Override getAccountInfo to return null instead of throwing for non-existent accounts
  connection.getAccountInfo = async (
    publicKey: PublicKey,
    _commitmentOrConfig?: any
  ) => {
    const account = svm.getAccount(publicKey);
    if (!account) return null;
    return {
      ...account,
      data: Buffer.from(account.data),
    };
  };

  connection.getAccountInfoAndContext = async (
    publicKey: PublicKey,
    _commitmentOrConfig?: any
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

  connection.getBalance = async (
    address: PublicKey,
    _commitment?: any
  ): Promise<number> => {
    const balance = svm.getBalance(address);
    return balance !== null ? Number(balance) : 0;
  };

  connection.getLatestBlockhash = async (_commitment?: any) => ({
    blockhash: svm.latestBlockhash(),
    lastValidBlockHeight: 0,
  });

  connection.sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    signersOrOptions?: any,
    _options?: any
  ): Promise<string> => {
    if ('version' in transaction) {
      const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
      signers.forEach((s: any) => transaction.sign([s]));
      const res = svm.sendTransaction(transaction);
      if (res instanceof FailedTransactionMetadata) {
        throw new SendTransactionError({
          action: 'send',
          signature: 'unknown',
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
      const signature = sigRaw ? bs58.encode(sigRaw) : 'unknown';
      throw new SendTransactionError({
        action: 'send',
        signature,
        transactionMessage: res.err().toString(),
        logs: res.meta().logs(),
      });
    }

    return bs58.encode(transaction.signature!);
  };

  connection.confirmTransaction = async (
    _strategyOrSignature?: any,
    _commitment?: any
  ): Promise<any> => ({
    context: { slot: Number(svm.getClock().slot) },
    value: { err: null },
  });

  connection.requestAirdrop = async (
    address: PublicKey,
    lamports: number
  ): Promise<string> => {
    svm.airdrop(address, BigInt(lamports));
    return 'litesvm-airdrop-' + address.toBase58().slice(0, 8);
  };

  connection.getSlot = async (_commitment?: any): Promise<number> => {
    return Number(svm.getClock().slot);
  };

  connection.getSignatureStatuses = async (
    _signatures: string[],
    _config?: any
  ) => ({
    context: { slot: Number(svm.getClock().slot) },
    value: _signatures.map(() => ({
      slot: Number(svm.getClock().slot),
      confirmations: 1,
      err: null,
      confirmationStatus: 'confirmed' as const,
    })),
  });
}

/**
 * Create a fully configured LiteSVM test context for runtime integration tests.
 *
 * Loads the program from the Anchor workspace (one directory up from runtime/),
 * sets up the ProgramData PDA, creates a funded payer, and returns everything
 * needed for AgentManager/AgentRuntime tests.
 */
export function createRuntimeTestContext(): RuntimeTestContext {
  // Fix anchor-litesvm's sendWithErr bs58 crash that masks real errors
  patchSendAndConfirm();

  // CWD is runtime/, Anchor.toml is in parent directory
  const svm = fromWorkspace('..');

  // Set initial clock to a realistic timestamp
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
  clock.slot = 1000n;
  svm.setClock(clock);

  // Create and fund the payer
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(1000 * LAMPORTS_PER_SOL));

  // Create Anchor-compatible provider
  const wallet = new anchor.Wallet(payer);
  const provider = new LiteSVMProvider(svm, wallet) as unknown as anchor.AnchorProvider;

  // Extend the connection proxy with methods needed by Anchor + AgentManager
  extendConnectionProxy(svm, (provider as any).connection, wallet);

  // Use canonical workspace instruction shapes and ensure the corresponding
  // program binary is loaded at the IDL-declared address.
  const idl = require('../../target/idl/agenc_coordination.json');
  const canonicalProgramId = new PublicKey(idl.address);
  if (!svm.getAccount(canonicalProgramId)) {
    const programBinaryPath = fileURLToPath(
      new URL('../../target/deploy/agenc_coordination.so', import.meta.url)
    );
    svm.addProgramFromFile(canonicalProgramId, programBinaryPath);
  }
  const program = new Program<AgencCoordination>(idl as any, provider);

  // Inject BPF Loader Upgradeable ProgramData PDA
  setupProgramDataAccount(svm, program.programId, payer.publicKey);

  // Set global provider for Anchor
  anchor.setProvider(provider);

  const connection = (provider as any).connection;

  return { svm, program, connection, payer };
}

/**
 * Initialize the protocol for testing.
 * Sets min_agent_stake=0 so tests can register without needing SOL stakes,
 * and disables rate limits for simpler test flow.
 */
export async function initializeProtocol(ctx: RuntimeTestContext): Promise<void> {
  const { program, payer, svm } = ctx;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('protocol')],
    program.programId
  );

  // Use the payer as treasury so treasury signer requirements are satisfied
  // without introducing additional unknown-signer edges in LiteSVM tx assembly.
  const treasury = payer;

  const secondSigner = Keypair.generate();
  svm.airdrop(secondSigner.publicKey, BigInt(LAMPORTS_PER_SOL));

  const thirdSigner = Keypair.generate();
  svm.airdrop(thirdSigner.publicKey, BigInt(LAMPORTS_PER_SOL));

  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
  );

  const minStake = new BN(LAMPORTS_PER_SOL / 100); // 0.01 SOL
  const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 100); // 0.01 SOL
  const initializeProtocolIx = (program.idl as any).instructions?.find((ix: any) => (
    ix?.name === 'initialize_protocol' || ix?.name === 'initializeProtocol'
  ));
  const initializeArgNames = new Set<string>(
    (initializeProtocolIx?.args ?? []).map((arg: any) => String(arg?.name))
  );
  const initializeAccountNames = new Set<string>(
    (initializeProtocolIx?.accounts ?? []).map((account: any) => String(account?.name))
  );
  const includesDisputeStakeArg = initializeArgNames.has('min_stake_for_dispute')
    || initializeArgNames.has('minStakeForDispute');
  const includesMultisigArgs = initializeArgNames.has('multisig_threshold')
    || initializeArgNames.has('multisigThreshold')
    || initializeArgNames.has('multisig_owners')
    || initializeArgNames.has('multisigOwners');
  const includesSecondSignerAccount = initializeAccountNames.has('second_signer')
    || initializeAccountNames.has('secondSigner');

  const initializeArgs: unknown[] = [
    51, // dispute_threshold
    100, // protocol_fee_bps
    minStake, // min_stake
  ];
  if (includesDisputeStakeArg) {
    initializeArgs.push(minStakeForDispute); // min_stake_for_dispute
  }
  if (includesMultisigArgs) {
    initializeArgs.push(
      2, // multisig_threshold (must be >= 2 and < owners.len())
      [payer.publicKey, secondSigner.publicKey, thirdSigner.publicKey], // multisig_owners
    );
  }

  const initializeRemainingAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    // Some program variants validate upgrade authority through ProgramData.
    // Passing it is harmless for variants that ignore remaining accounts.
    { pubkey: programDataPda, isSigner: false, isWritable: false },
  ];

  if (includesMultisigArgs && !includesSecondSignerAccount) {
    // Older canonical program variants collect additional multisig signers
    // from remaining accounts rather than a dedicated secondSigner account.
    initializeRemainingAccounts.push({
      pubkey: secondSigner.publicKey,
      isSigner: true,
      isWritable: false,
    });
  }

  let initializeBuilder = (program.methods as any)
    .initializeProtocol(...initializeArgs)
    .accountsPartial({
      protocolConfig: protocolPda,
      treasury: treasury.publicKey,
      authority: payer.publicKey,
      ...(includesSecondSignerAccount ? { secondSigner: secondSigner.publicKey } : {}),
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(initializeRemainingAccounts);

  if (includesSecondSignerAccount || includesMultisigArgs) {
    initializeBuilder = initializeBuilder.signers([secondSigner]);
  }

  try {
    await initializeBuilder.rpc();
  } catch (error) {
    throw new Error(
      `initialize_protocol failed in LiteSVM setup: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Set rate limits to the most permissive valid values for tests.
  // On-chain enforces minimums: cooldowns >= 1s, per-24h limits >= 1,
  // min_stake_for_dispute >= 1000 lamports.
  try {
    await program.methods
      .updateRateLimits(
        new BN(1), // task_creation_cooldown = 1s (minimum)
        255, // max_tasks_per_24h = 255 (max u8)
        new BN(1), // dispute_initiation_cooldown = 1s (minimum)
        255, // max_disputes_per_24h = 255 (max u8)
        new BN(1000) // min_stake_for_dispute = 1000 lamports (minimum)
      )
      .accountsPartial({
        protocolConfig: protocolPda,
      })
      .remainingAccounts([
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: secondSigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([secondSigner])
      .rpc();
  } catch (error) {
    throw new Error(
      `update_rate_limits failed in LiteSVM setup: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Fund an account instantly via LiteSVM airdrop.
 */
export function fundAccount(
  svm: LiteSVM,
  pubkey: PublicKey,
  lamports: number | bigint
): void {
  svm.airdrop(pubkey, BigInt(lamports));
}

/**
 * Advance the LiteSVM clock by the specified number of seconds.
 */
export function advanceClock(svm: LiteSVM, seconds: number): void {
  const clock = svm.getClock();
  const newTimestamp = clock.unixTimestamp + BigInt(seconds);
  const newSlot = clock.slot + BigInt(seconds * 2);
  clock.unixTimestamp = newTimestamp;
  clock.slot = newSlot;
  svm.setClock(clock);
}
