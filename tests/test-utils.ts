/**
 * Shared test utilities for AgenC integration tests.
 *
 * This module provides common helpers to reduce boilerplate across test files:
 * - PDA derivation functions
 * - Capability and task type constants
 * - Helper functions for test setup
 */

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { AgencCoordination } from "../target/types/agenc_coordination";

// ============================================================================
// Capability Constants (matches program)
// ============================================================================

export const CAPABILITY_COMPUTE = 1 << 0;
export const CAPABILITY_INFERENCE = 1 << 1;
export const CAPABILITY_STORAGE = 1 << 2;
export const CAPABILITY_NETWORK = 1 << 3;
export const CAPABILITY_SENSOR = 1 << 4;
export const CAPABILITY_ACTUATOR = 1 << 5;
export const CAPABILITY_COORDINATOR = 1 << 6;
export const CAPABILITY_ARBITER = 1 << 7;
export const CAPABILITY_VALIDATOR = 1 << 8;
export const CAPABILITY_AGGREGATOR = 1 << 9;

// ============================================================================
// Task Type Constants (matches program)
// ============================================================================

export const TASK_TYPE_EXCLUSIVE = 0;
export const TASK_TYPE_COLLABORATIVE = 1;
export const TASK_TYPE_COMPETITIVE = 2;

// ============================================================================
// Resolution Type Constants (matches program)
// ============================================================================

export const RESOLUTION_TYPE_REFUND = 0;
export const RESOLUTION_TYPE_COMPLETE = 1;
export const RESOLUTION_TYPE_SPLIT = 2;

// ============================================================================
// Valid Evidence String (minimum 50 characters required)
// ============================================================================

export const VALID_EVIDENCE =
  "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

// ============================================================================
// PDA Derivation Functions
// ============================================================================

/**
 * Derive the protocol config PDA (singleton).
 */
export function deriveProtocolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId
  )[0];
}

/** BPF Loader Upgradeable program ID */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

/**
 * Derive the ProgramData PDA for an upgradeable program.
 * Used for initialize_protocol's upgrade authority check (fix #839).
 */
export function deriveProgramDataPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
  )[0];
}

/**
 * Derive an agent registration PDA from agent ID.
 */
export function deriveAgentPda(agentId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    programId
  )[0];
}

/**
 * Derive a task PDA from creator pubkey and task ID.
 */
export function deriveTaskPda(
  creatorPubkey: PublicKey,
  taskId: Buffer,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
    programId
  )[0];
}

/**
 * Derive an escrow PDA from task PDA.
 */
export function deriveEscrowPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), taskPda.toBuffer()],
    programId
  )[0];
}

/**
 * Derive a claim PDA from task PDA and worker agent PDA.
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId
  )[0];
}

/**
 * Derive a dispute PDA from dispute ID.
 */
export function deriveDisputePda(disputeId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), disputeId],
    programId
  )[0];
}

/**
 * Derive a vote PDA from dispute PDA and voter agent PDA.
 */
export function deriveVotePda(
  disputePda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), disputePda.toBuffer(), voterAgentPda.toBuffer()],
    programId
  )[0];
}

/**
 * Derive an authority vote PDA from dispute PDA and voter authority.
 */
export function deriveAuthorityVotePda(
  disputePda: PublicKey,
  voterAuthority: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authority_vote"), disputePda.toBuffer(), voterAuthority.toBuffer()],
    programId
  )[0];
}

/**
 * Derive a shared state PDA from key string.
 */
export function deriveStatePda(key: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("state"), Buffer.from(key)],
    programId
  )[0];
}

// ============================================================================
// Buffer Creation Helpers
// ============================================================================

/**
 * Create a 32-byte buffer from a string (padded with zeros).
 */
export function createId(name: string): Buffer {
  return Buffer.from(name.padEnd(32, "\0"));
}

/**
 * Create a 64-byte description array from a string.
 */
export function createDescription(desc: string): number[] {
  const buf = Buffer.alloc(64);
  buf.write(desc);
  return Array.from(buf);
}

/**
 * Create a 32-byte hash array from a string.
 */
export function createHash(data: string): number[] {
  const buf = Buffer.alloc(32);
  buf.write(data);
  return Array.from(buf);
}

// ============================================================================
// Default Protocol Configuration Constants
// ============================================================================

/** Default airdrop amount in SOL for test wallets */
export const AIRDROP_SOL = 2;
/** Minimum balance threshold before re-airdropping */
export const MIN_BALANCE_SOL = 1;
/** Maximum retries for airdrop requests */
export const MAX_AIRDROP_ATTEMPTS = 5;
/** Base delay for exponential backoff (ms) */
export const BASE_DELAY_MS = 500;
/** Maximum delay between retries (ms) */
export const MAX_DELAY_MS = 8000;

/** Default min stake for protocol initialization (1 SOL) */
export const DEFAULT_MIN_STAKE_LAMPORTS = 1 * LAMPORTS_PER_SOL;
/** Default protocol fee in basis points (1% = 100 bps) */
export const DEFAULT_PROTOCOL_FEE_BPS = 100;
/** Default dispute threshold percentage */
export const DEFAULT_DISPUTE_THRESHOLD = 51;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique run ID to prevent conflicts with persisted validator state.
 * Call once at the start of each test file.
 */
export function generateRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Create a unique agent ID with the given prefix and run ID.
 * Ensures IDs don't collide across test runs.
 */
export function makeAgentId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

/**
 * Create a unique task ID with the given prefix and run ID.
 */
export function makeTaskId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

/**
 * Create a unique dispute ID with the given prefix and run ID.
 */
export function makeDisputeId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

/**
 * Get a default deadline 1 hour in the future.
 */
export function getDefaultDeadline(): BN {
  return new BN(Math.floor(Date.now() / 1000) + 3600);
}

/**
 * Get a deadline N seconds in the future.
 */
export function getDeadlineInSeconds(seconds: number): BN {
  return new BN(Math.floor(Date.now() / 1000) + seconds);
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fund a wallet with SOL via airdrop.
 */
export async function fundWallet(
  connection: Connection,
  wallet: PublicKey,
  lamports: number = 5 * LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await connection.requestAirdrop(wallet, lamports);
  await connection.confirmTransaction(sig, "confirmed");
}

/**
 * Fund multiple wallets in parallel.
 */
export async function fundWallets(
  connection: Connection,
  wallets: PublicKey[],
  lamports: number = 5 * LAMPORTS_PER_SOL
): Promise<void> {
  const sigs = await Promise.all(
    wallets.map((wallet) => connection.requestAirdrop(wallet, lamports))
  );
  await Promise.all(
    sigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
  );
}

// ============================================================================
// Worker Pool for Fast Test Execution
// ============================================================================

export interface PooledWorker {
  wallet: Keypair;
  agentId: Buffer;
  agentPda: PublicKey;
  inUse: boolean;
}

/**
 * Create a worker pool for fast test execution.
 * Pre-funds and registers workers to avoid airdrop delays.
 */
export async function createWorkerPool(
  connection: Connection,
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  runId: string,
  size: number = 20,
  capabilities: number = CAPABILITY_COMPUTE,
  stake: number = LAMPORTS_PER_SOL
): Promise<PooledWorker[]> {
  const pool: PooledWorker[] = [];
  const wallets: Keypair[] = [];
  const airdropSigs: string[] = [];

  // Generate wallets and request airdrops in parallel
  for (let i = 0; i < size; i++) {
    const wallet = Keypair.generate();
    wallets.push(wallet);
    const sig = await connection.requestAirdrop(wallet.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSigs.push(sig);
  }

  // Confirm all airdrops
  await Promise.all(
    airdropSigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
  );

  // Register all workers in parallel
  const registerPromises = wallets.map(async (wallet, i) => {
    const agentId = makeAgentId(`pool${i}`, runId);
    const agentPda = deriveAgentPda(agentId, program.programId);

    await program.methods
      .registerAgent(
        Array.from(agentId),
        new BN(capabilities),
        `https://pool-worker-${i}.example.com`,
        null,
        new BN(stake)
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    pool.push({
      wallet,
      agentId,
      agentPda,
      inUse: false,
    });
  });

  await Promise.all(registerPromises);
  return pool;
}

/**
 * Get a worker from the pool, marking it as in use.
 */
export function getWorkerFromPool(pool: PooledWorker[]): PooledWorker | null {
  const worker = pool.find((w) => !w.inUse);
  if (worker) {
    worker.inUse = true;
  }
  return worker ?? null;
}

/**
 * Return a worker to the pool.
 */
export function returnWorkerToPool(worker: PooledWorker): void {
  worker.inUse = false;
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Check if an error message contains any of the expected patterns.
 */
export function errorContainsAny(error: unknown, patterns: string[]): boolean {
  const message = (error as { message?: string })?.message ?? "";
  const errorCode = (error as { error?: { errorCode?: { code: string } } })?.error?.errorCode?.code ?? "";
  return patterns.some((p) => message.includes(p) || errorCode.includes(p));
}

/**
 * Extract error code from an Anchor error.
 */
export function getErrorCode(error: unknown): string | undefined {
  return (error as { error?: { errorCode?: { code: string } } })?.error?.errorCode?.code;
}
