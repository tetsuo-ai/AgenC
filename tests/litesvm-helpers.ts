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
import { LiteSVM, Clock } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from "anchor-litesvm";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as bs58Module from "bs58";
import * as fs from "fs";
import * as path from "path";
import { extendLiteSVMConnectionProxy } from "./litesvm-connection-proxy.ts";
import { syncAgencProgramBinary } from "./litesvm-program-artifact.ts";
import {
  loadProtocolIdl,
  type AgencCoordination,
} from "./protocol-artifacts.ts";
import {
  BPF_LOADER_UPGRADEABLE_ID,
  resolveBs58Codec,
  seedLiteSVMClock,
  setupProgramDataAccount,
} from "./litesvm-shared.ts";

const bs58 = resolveBs58Codec(bs58Module);

export interface LiteSVMContext {
  svm: LiteSVM;
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  payer: Keypair;
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
  syncAgencProgramBinary(process.cwd());

  // Load the workspace, then ensure the compiled program binary is available at
  // the IDL-declared address so the client, PDA derivations, and on-chain
  // execution all target the same program id.
  const svm = fromWorkspace(".");
  const idl = loadProtocolIdl() as {
    address: string;
  };
  const canonicalProgramId = new PublicKey(idl.address);
  const soPath = path.resolve(process.cwd(), "target", "deploy", "agenc_coordination.so");
  if (!svm.getAccount(canonicalProgramId) && fs.existsSync(soPath)) {
    svm.addProgramFromFile(canonicalProgramId, soPath);
  }

  // Add SPL token programs if requested
  if (opts?.splTokens) {
    svm.withDefaultPrograms();
  }

  // Enable transaction history for getTransaction() support
  svm.withTransactionHistory(10000n);

  // Set initial clock to a realistic timestamp so on-chain time checks work
  // (LiteSVM defaults to unix_timestamp=0 which breaks cooldowns and deadlines)
  seedLiteSVMClock(svm);

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
  extendLiteSVMConnectionProxy(svm, (provider as any).connection, wallet, bs58, {
    allowConstructorNameFallback: true,
  });

  const program = new Program<AgencCoordination>(
    {
      ...idl,
      address: canonicalProgramId.toBase58(),
    } as any,
    provider,
  );

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
  // Expire the current blockhash so subsequent transactions get a fresh one.
  // Without this, two identical transactions (same accounts, instruction, signers)
  // sent before and after a clock advance would share the same blockhash,
  // producing identical bytes and triggering AlreadyProcessed (error 6).
  svm.expireBlockhash();
}

// ============================================================================
// Mock Verifier Router for ZK integration tests
// ============================================================================

const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey(
  "E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ",
);
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey(
  "3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc",
);
const TRUSTED_RISC0_SELECTOR = Uint8Array.from([0x52, 0x5a, 0x56, 0x4d]);
const VERIFIER_ENTRY_DISCRIMINATOR = Uint8Array.from([
  102, 247, 148, 158, 33, 153, 100, 93,
]);

/**
 * Inject a mock Verifier Router into LiteSVM for ZK integration tests.
 *
 * Loads a no-op BPF program at both the trusted Router and Verifier program IDs,
 * then injects the router PDA and verifier-entry PDA with correct data layouts.
 * The mock router accepts any CPI call (returns Ok), allowing positive-path
 * testing of complete_task_private without a real RISC Zero prover.
 */
export function injectMockVerifierRouter(svm: LiteSVM): void {
  const mockSoPath = path.resolve(
    __dirname,
    "mock-router",
    "target",
    "deploy",
    "mock_router.so",
  );

  if (!fs.existsSync(mockSoPath)) {
    throw new Error(
      `Missing mock verifier router artifact at ${mockSoPath}. Build it from source with scripts/build-mock-verifier-router.sh.`,
    );
  }

  // Load mock program at both trusted program IDs
  svm.addProgramFromFile(TRUSTED_RISC0_ROUTER_PROGRAM_ID, mockSoPath);
  svm.addProgramFromFile(TRUSTED_RISC0_VERIFIER_PROGRAM_ID, mockSoPath);

  // Inject router PDA: seeds=["router"] under router program
  const [routerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("router")],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  );
  svm.setAccount(routerPda, {
    lamports: 1_000_000,
    data: new Uint8Array(0),
    owner: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    executable: false,
  });

  // Inject verifier-entry PDA: seeds=["verifier", selector] under router program
  // Data layout (45 bytes):
  //   [0..8]   discriminator
  //   [8..12]  selector (RISC0_SELECTOR_LEN)
  //   [12..44] verifier pubkey (32 bytes)
  //   [44]     estopped flag (1 byte, 0 = not estopped)
  const [verifierEntryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), Buffer.from(TRUSTED_RISC0_SELECTOR)],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  );
  const verifierEntryData = new Uint8Array(45);
  verifierEntryData.set(VERIFIER_ENTRY_DISCRIMINATOR, 0);
  verifierEntryData.set(TRUSTED_RISC0_SELECTOR, 8);
  verifierEntryData.set(TRUSTED_RISC0_VERIFIER_PROGRAM_ID.toBytes(), 12);
  verifierEntryData[44] = 0; // not estopped

  svm.setAccount(verifierEntryPda, {
    lamports: 1_000_000,
    data: verifierEntryData,
    owner: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
    executable: false,
  });
}
