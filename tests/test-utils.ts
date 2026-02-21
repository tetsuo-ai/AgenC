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
import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { AgencCoordination } from "../target/types/agenc_coordination";

// Re-export SDK ZK helpers for integration tests
export {
  computeHashes,
  computeConstraintHash,
  generateSalt,
  bigintToBytes32,
} from "@agenc/sdk";

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
// Rate Limit Constants (matches program update_rate_limits.rs)
// ============================================================================

/**
 * On-chain minimum for min_stake_for_dispute (update_rate_limits.rs:MIN_DISPUTE_STAKE).
 * The updateRateLimits instruction rejects values below this with InvalidInput.
 */
export const MIN_DISPUTE_STAKE_LAMPORTS = 1000;

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
    programId,
  )[0];
}

/** BPF Loader Upgradeable program ID */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * Derive the ProgramData PDA for an upgradeable program.
 * Used for initialize_protocol's upgrade authority check (fix #839).
 */
export function deriveProgramDataPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  )[0];
}

/**
 * Derive an agent registration PDA from agent ID.
 */
export function deriveAgentPda(
  agentId: Buffer,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    programId,
  )[0];
}

/**
 * Derive a task PDA from creator pubkey and task ID.
 */
export function deriveTaskPda(
  creatorPubkey: PublicKey,
  taskId: Buffer,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
    programId,
  )[0];
}

/**
 * Derive an escrow PDA from task PDA.
 */
export function deriveEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), taskPda.toBuffer()],
    programId,
  )[0];
}

/**
 * Derive a claim PDA from task PDA and worker agent PDA.
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId,
  )[0];
}

/**
 * Derive a dispute PDA from dispute ID.
 */
export function deriveDisputePda(
  disputeId: Buffer,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), disputeId],
    programId,
  )[0];
}

/**
 * Derive a vote PDA from dispute PDA and voter agent PDA.
 */
export function deriveVotePda(
  disputePda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), disputePda.toBuffer(), voterAgentPda.toBuffer()],
    programId,
  )[0];
}

/**
 * Derive an authority vote PDA from dispute PDA and voter authority.
 */
export function deriveAuthorityVotePda(
  disputePda: PublicKey,
  voterAuthority: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("authority_vote"),
      disputePda.toBuffer(),
      voterAuthority.toBuffer(),
    ],
    programId,
  )[0];
}

/**
 * Derive a shared state PDA from key string.
 */
export function deriveStatePda(key: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("state"), Buffer.from(key)],
    programId,
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
  lamports: number = 5 * LAMPORTS_PER_SOL,
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
  lamports: number = 5 * LAMPORTS_PER_SOL,
): Promise<void> {
  const sigs = await Promise.all(
    wallets.map((wallet) => connection.requestAirdrop(wallet, lamports)),
  );
  await Promise.all(
    sigs.map((sig) => connection.confirmTransaction(sig, "confirmed")),
  );
}

/**
 * Disable protocol rate limits for deterministic integration tests.
 *
 * Sets cooldowns to 0 and per-24h limits to 0 (unlimited).
 * The on-chain MIN_DISPUTE_STAKE (1000 lamports) is used by default for
 * min_stake_for_dispute — passing 0 will be rejected by the program.
 *
 * Safe to call repeatedly in before hooks; silently succeeds if rate limits
 * are already configured with the same values.
 */
export async function disableRateLimitsForTests(params: {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  authority: PublicKey;
  /** Additional multisig signers (required for threshold >= 2). */
  additionalSigners?: Keypair[];
  /** Defaults to MIN_DISPUTE_STAKE_LAMPORTS (1000). Must be >= 1000. */
  minStakeForDisputeLamports?: number;
  skipPreflight?: boolean;
}): Promise<void> {
  const {
    program,
    protocolPda,
    authority,
    additionalSigners = [],
    minStakeForDisputeLamports = MIN_DISPUTE_STAKE_LAMPORTS,
    skipPreflight = true,
  } = params;

  const remainingAccounts = [
    { pubkey: authority, isSigner: true, isWritable: false },
    ...additionalSigners.map((s) => ({
      pubkey: s.publicKey,
      isSigner: true,
      isWritable: false,
    })),
  ];

  const builder = program.methods
    .updateRateLimits(
      new BN(0), // task_creation_cooldown = 0 (disabled)
      0, // max_tasks_per_24h = 0 (unlimited)
      new BN(0), // dispute_initiation_cooldown = 0 (disabled)
      0, // max_disputes_per_24h = 0 (unlimited)
      new BN(minStakeForDisputeLamports), // min_stake_for_dispute (>= 1000)
    )
    .accountsPartial({ protocolConfig: protocolPda })
    .remainingAccounts(remainingAccounts);

  if (additionalSigners.length > 0) {
    builder.signers(additionalSigners);
  }

  await builder.rpc({ skipPreflight });
}

/**
 * Ensure an agent registration exists, creating it if needed.
 */
export async function ensureAgentRegistered(params: {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  agentId: Buffer;
  authority: Keypair;
  capabilities: number;
  endpoint?: string;
  stakeLamports?: number;
  skipPreflight?: boolean;
}): Promise<PublicKey> {
  const {
    program,
    protocolPda,
    agentId,
    authority,
    capabilities,
    endpoint = "https://example.com",
    stakeLamports = LAMPORTS_PER_SOL,
    skipPreflight = true,
  } = params;

  const agentPda = deriveAgentPda(agentId, program.programId);
  try {
    await program.methods
      .registerAgent(
        Array.from(agentId),
        new BN(capabilities),
        endpoint,
        null,
        new BN(stakeLamports),
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc({ skipPreflight });
  } catch (error) {
    const message = (error as { message?: string }).message ?? "";
    if (!message.includes("already in use")) {
      throw error;
    }
  }

  return agentPda;
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
  stake: number = LAMPORTS_PER_SOL,
): Promise<PooledWorker[]> {
  const pool: PooledWorker[] = [];
  const wallets: Keypair[] = [];
  const airdropSigs: string[] = [];

  // Generate wallets and request airdrops in parallel
  for (let i = 0; i < size; i++) {
    const wallet = Keypair.generate();
    wallets.push(wallet);
    const sig = await connection.requestAirdrop(
      wallet.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    airdropSigs.push(sig);
  }

  // Confirm all airdrops
  await Promise.all(
    airdropSigs.map((sig) => connection.confirmTransaction(sig, "confirmed")),
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
        new BN(stake),
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
// Proposal Type Constants (matches program ProposalType enum)
// ============================================================================

export const PROPOSAL_TYPE_PROTOCOL_UPGRADE = 0;
export const PROPOSAL_TYPE_FEE_CHANGE = 1;
export const PROPOSAL_TYPE_TREASURY_SPEND = 2;
export const PROPOSAL_TYPE_RATE_LIMIT_CHANGE = 3;

// ============================================================================
// Proposal Status Constants (matches program ProposalStatus enum)
// ============================================================================

export const PROPOSAL_STATUS_ACTIVE = 0;
export const PROPOSAL_STATUS_EXECUTED = 1;
export const PROPOSAL_STATUS_DEFEATED = 2;
export const PROPOSAL_STATUS_CANCELLED = 3;

// ============================================================================
// Governance PDA Derivation Functions
// ============================================================================

/**
 * Derive the governance config PDA (singleton).
 */
export function deriveGovernanceConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    programId,
  )[0];
}

/**
 * Derive a proposal PDA from proposer agent PDA and nonce.
 */
export function deriveProposalPda(
  proposerAgentPda: PublicKey,
  nonce: number | bigint,
  programId: PublicKey,
): PublicKey {
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), proposerAgentPda.toBuffer(), nonceBuffer],
    programId,
  )[0];
}

/**
 * Derive a governance vote PDA from proposal PDA and voter authority pubkey.
 * Seeds: ["governance_vote", proposal_pda, authority_pubkey]
 */
export function deriveGovernanceVotePda(
  proposalPda: PublicKey,
  voterAuthorityPubkey: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("governance_vote"),
      proposalPda.toBuffer(),
      voterAuthorityPubkey.toBuffer(),
    ],
    programId,
  )[0];
}

// ============================================================================
// Feed PDA Derivation Functions
// ============================================================================

/**
 * Derive a feed post PDA from author agent PDA and nonce.
 * Seeds: ["post", author_agent_pda, nonce]
 */
export function deriveFeedPostPda(
  authorPda: PublicKey,
  nonce: Buffer | Uint8Array,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("post"), authorPda.toBuffer(), Buffer.from(nonce)],
    programId,
  )[0];
}

/**
 * Derive a feed vote PDA from post PDA and voter agent PDA.
 * Seeds: ["upvote", post_pda, voter_agent_pda]
 */
export function deriveFeedVotePda(
  postPda: PublicKey,
  voterPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("upvote"), postPda.toBuffer(), voterPda.toBuffer()],
    programId,
  )[0];
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Check if an error message contains any of the expected patterns.
 */
export function errorContainsAny(error: unknown, patterns: string[]): boolean {
  const message = (error as { message?: string })?.message ?? "";
  const errorCode =
    (error as { error?: { errorCode?: { code: string } } })?.error?.errorCode
      ?.code ?? "";
  return patterns.some((p) => message.includes(p) || errorCode.includes(p));
}

/**
 * Extract error code from an Anchor error.
 */
export function getErrorCode(error: unknown): string | undefined {
  return (error as { error?: { errorCode?: { code: string } } })?.error
    ?.errorCode?.code;
}

// ============================================================================
// ZK Proof Test Helpers
// ============================================================================

/** Trusted RISC0 selector bytes */
const ZK_TRUSTED_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);

/** Trusted RISC0 image ID — must match on-chain constant */
export const TRUSTED_IMAGE_ID = Buffer.from([
  202, 175, 194, 115, 244, 76, 8, 9, 197, 55, 54, 103, 21, 34, 178, 245, 211,
  97, 58, 48, 7, 14, 121, 214, 109, 60, 64, 137, 170, 156, 79, 219,
]);

/** Trusted router program ID */
export const TRUSTED_ROUTER_PROGRAM_ID = new PublicKey(
  "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7",
);

/** Trusted verifier program ID */
export const TRUSTED_VERIFIER_PROGRAM_ID = new PublicKey(
  "THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge",
);

/**
 * Build a 260-byte Borsh-encoded Risc0Seal with the trusted selector
 * and non-zero proof body. Valid for on-chain decode_and_validate_seal().
 */
export function buildTestSealBytes(): Buffer {
  const seal = Buffer.alloc(260);
  // Selector (4 bytes)
  ZK_TRUSTED_SELECTOR.copy(seal, 0);
  // Groth16 proof body (256 bytes): pi_a(64) + pi_b(128) + pi_c(64)
  // Fill with non-zero bytes to pass Borsh deserialization
  for (let i = 4; i < 260; i++) {
    seal[i] = ((i * 7 + 13) % 255) + 1; // non-zero pseudo-random fill
  }
  return seal;
}

/**
 * Build a 192-byte journal from 6 x 32-byte fields.
 * Field order: taskPda, authority, constraintHash, outputCommitment, binding, nullifier
 */
export function buildTestJournal(fields: {
  taskPda: Buffer | Uint8Array;
  authority: Buffer | Uint8Array;
  constraintHash: Buffer | Uint8Array;
  outputCommitment: Buffer | Uint8Array;
  binding: Buffer | Uint8Array;
  nullifier: Buffer | Uint8Array;
}): Buffer {
  return Buffer.concat([
    Buffer.from(fields.taskPda),
    Buffer.from(fields.authority),
    Buffer.from(fields.constraintHash),
    Buffer.from(fields.outputCommitment),
    Buffer.from(fields.binding),
    Buffer.from(fields.nullifier),
  ]);
}

/**
 * Derive a binding_spend PDA.
 * Seeds: ["binding_spend", bindingSeed]
 */
export function deriveBindingSpendPda(
  bindingSeed: Buffer | Uint8Array,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("binding_spend"), Buffer.from(bindingSeed)],
    programId,
  )[0];
}

/**
 * Derive a nullifier_spend PDA.
 * Seeds: ["nullifier_spend", nullifierSeed]
 */
export function deriveNullifierSpendPda(
  nullifierSeed: Buffer | Uint8Array,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_spend"), Buffer.from(nullifierSeed)],
    programId,
  )[0];
}

/**
 * Derive the router PDA under the trusted router program.
 * Seeds: ["router"] under TRUSTED_RISC0_ROUTER_PROGRAM_ID
 */
export function deriveRouterPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("router")],
    TRUSTED_ROUTER_PROGRAM_ID,
  )[0];
}

/**
 * Derive the verifier-entry PDA under the trusted router program.
 * Seeds: ["verifier", selector] under TRUSTED_RISC0_ROUTER_PROGRAM_ID
 */
export function deriveVerifierEntryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), ZK_TRUSTED_SELECTOR],
    TRUSTED_ROUTER_PROGRAM_ID,
  )[0];
}
