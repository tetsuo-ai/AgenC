/**
 * Shared test utilities for AgenC integration tests.
 *
 * Provides common setup, PDA derivation, worker pool management,
 * and helper functions used across test files.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../../target/types/agenc_coordination";

// ============================================================================
// Constants
// ============================================================================

export const CAPABILITY_COMPUTE = 1 << 0;
export const CAPABILITY_STORAGE = 1 << 1;
export const CAPABILITY_INFERENCE = 1 << 2;
export const CAPABILITY_NETWORK = 1 << 3;
export const CAPABILITY_COORDINATOR = 1 << 4;
export const CAPABILITY_ARBITER = 1 << 7;

export const TASK_TYPE_EXCLUSIVE = 0;
export const TASK_TYPE_COLLABORATIVE = 1;
export const TASK_TYPE_COMPETITIVE = 2;

export const HASH_SIZE = 32;
export const RESULT_DATA_SIZE = 64;

export const ZK_VERIFIER_PROGRAM_ID = new PublicKey("8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ");

// Evidence must be at least 50 characters per initiate_dispute.rs requirements
export const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

// ============================================================================
// Test Context
// ============================================================================

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  runId: string;
  treasury: Keypair;
  treasuryPubkey: PublicKey;
}

export interface WorkerInfo {
  wallet: Keypair;
  agentId: Buffer;
  agentPda: PublicKey;
  inUse?: boolean;
}

// ============================================================================
// PDA Derivation
// ============================================================================

export function deriveProtocolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId
  )[0];
}

export function deriveAgentPda(agentId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    programId
  )[0];
}

export function deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
    programId
  )[0];
}

export function deriveEscrowPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), taskPda.toBuffer()],
    programId
  )[0];
}

export function deriveClaimPda(taskPda: PublicKey, workerPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
    programId
  )[0];
}

export function deriveDisputePda(disputeId: Buffer, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), disputeId],
    programId
  )[0];
}

export function deriveVotePda(disputePda: PublicKey, voterPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), disputePda.toBuffer(), voterPda.toBuffer()],
    programId
  )[0];
}

// ============================================================================
// ID Generation
// ============================================================================

export function generateRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeAgentId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

export function makeTaskId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

export function makeDisputeId(prefix: string, runId: string): Buffer {
  return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
}

// ============================================================================
// Setup Helpers
// ============================================================================

export async function fundWallet(
  connection: anchor.web3.Connection,
  wallet: Keypair,
  amount: number = 10 * LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await connection.requestAirdrop(wallet.publicKey, amount);
  await connection.confirmTransaction(sig, "confirmed");
}

export async function fundWallets(
  connection: anchor.web3.Connection,
  wallets: Keypair[],
  amount: number = 10 * LAMPORTS_PER_SOL
): Promise<void> {
  const sigs = await Promise.all(
    wallets.map(w => connection.requestAirdrop(w.publicKey, amount))
  );
  await Promise.all(
    sigs.map(sig => connection.confirmTransaction(sig, "confirmed"))
  );
}

export async function initializeProtocolIfNeeded(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  treasury: Keypair,
  authority: anchor.Wallet
): Promise<PublicKey> {
  try {
    await program.methods
      .initializeProtocol(
        51,                              // dispute_quorum_percent
        100,                             // dispute_vote_period
        new BN(LAMPORTS_PER_SOL / 10),   // min_stake
        1,                               // min_multisig_signers
        [authority.publicKey]            // multisig_signers
      )
      .accountsPartial({
        protocolConfig: protocolPda,
        treasury: treasury.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ])
      .rpc({ skipPreflight: true });
    return treasury.publicKey;
  } catch (e: any) {
    // Protocol may already be initialized
    if (e.message?.includes("already in use")) {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      return config.treasury;
    }
    throw e;
  }
}

export async function disableRateLimits(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  authority: anchor.Wallet
): Promise<void> {
  try {
    await program.methods
      .updateRateLimits(
        new BN(0),  // task_creation_cooldown = 0 (disabled)
        0,          // max_tasks_per_24h = 0 (unlimited)
        new BN(0),  // dispute_initiation_cooldown = 0 (disabled)
        0,          // max_disputes_per_24h = 0 (unlimited)
        new BN(0)   // min_stake_for_dispute = 0
      )
      .accountsPartial({
        protocolConfig: protocolPda,
      })
      .remainingAccounts([
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ])
      .rpc();
  } catch (e) {
    // May already be configured
  }
}

// ============================================================================
// Agent Registration
// ============================================================================

export async function registerAgent(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  agentId: Buffer,
  wallet: Keypair,
  capabilities: number = CAPABILITY_COMPUTE,
  stake: number = LAMPORTS_PER_SOL / 10
): Promise<PublicKey> {
  const agentPda = deriveAgentPda(agentId, program.programId);

  await program.methods
    .registerAgent(
      Array.from(agentId),
      new BN(capabilities),
      `https://agent-${agentId.toString("hex").slice(0, 8)}.example.com`,
      null,
      new BN(stake)
    )
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc({ skipPreflight: true });

  return agentPda;
}

export async function registerAgentSafe(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  agentId: Buffer,
  wallet: Keypair,
  capabilities: number = CAPABILITY_COMPUTE,
  stake: number = LAMPORTS_PER_SOL / 10
): Promise<PublicKey> {
  const agentPda = deriveAgentPda(agentId, program.programId);

  try {
    await program.methods
      .registerAgent(
        Array.from(agentId),
        new BN(capabilities),
        `https://agent-${agentId.toString("hex").slice(0, 8)}.example.com`,
        null,
        new BN(stake)
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc({ skipPreflight: true });
  } catch (e: any) {
    // Agent may already be registered
    if (!e.message?.includes("already")) {
      throw e;
    }
  }

  return agentPda;
}

// ============================================================================
// Task Operations
// ============================================================================

export interface CreateTaskParams {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  taskId: Buffer;
  creatorAgentPda: PublicKey;
  creatorWallet: Keypair;
  capabilities?: number;
  reward?: number;
  maxWorkers?: number;
  taskType?: number;
  constraintHash?: Buffer;
  deadline?: number;
}

export async function createTask(params: CreateTaskParams): Promise<{
  taskPda: PublicKey;
  escrowPda: PublicKey;
}> {
  const {
    program,
    protocolPda,
    taskId,
    creatorAgentPda,
    creatorWallet,
    capabilities = CAPABILITY_COMPUTE,
    reward = LAMPORTS_PER_SOL / 10,
    maxWorkers = 1,
    taskType = TASK_TYPE_EXCLUSIVE,
    constraintHash = Buffer.alloc(HASH_SIZE, 0),
    deadline = 0,
  } = params;

  const taskPda = deriveTaskPda(creatorWallet.publicKey, taskId, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);

  await program.methods
    .createTask(
      Array.from(taskId),
      new BN(capabilities),
      Array.from(Buffer.alloc(64, 0)), // description
      new BN(reward),
      maxWorkers,
      new BN(deadline),
      taskType,
      Array.from(constraintHash)
    )
    .accountsPartial({
      task: taskPda,
      escrow: escrowPda,
      creatorAgent: creatorAgentPda,
      protocolConfig: protocolPda,
      authority: creatorWallet.publicKey,
      creator: creatorWallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([creatorWallet])
    .rpc({ skipPreflight: true });

  return { taskPda, escrowPda };
}

export async function claimTask(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  workerWallet: Keypair
): Promise<PublicKey> {
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);

  await program.methods
    .claimTask()
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      authority: workerWallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([workerWallet])
    .rpc({ skipPreflight: true });

  return claimPda;
}

export async function completeTask(
  program: Program<AgencCoordination>,
  protocolPda: PublicKey,
  taskPda: PublicKey,
  claimPda: PublicKey,
  escrowPda: PublicKey,
  workerAgentPda: PublicKey,
  workerWallet: Keypair,
  treasuryPubkey: PublicKey
): Promise<void> {
  const proofHash = Buffer.alloc(HASH_SIZE, 0x11);
  const resultData = Buffer.alloc(RESULT_DATA_SIZE, 0x22);

  await program.methods
    .completeTask(Array.from(proofHash), Array.from(resultData))
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      escrow: escrowPda,
      worker: workerAgentPda,
      authority: workerWallet.publicKey,
      treasury: treasuryPubkey,
      protocolConfig: protocolPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([workerWallet])
    .rpc({ skipPreflight: true });
}

export async function cancelTask(
  program: Program<AgencCoordination>,
  taskPda: PublicKey,
  escrowPda: PublicKey,
  creatorWallet: Keypair
): Promise<void> {
  await program.methods
    .cancelTask()
    .accountsPartial({
      task: taskPda,
      escrow: escrowPda,
      creator: creatorWallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([creatorWallet])
    .rpc({ skipPreflight: true });
}

// ============================================================================
// Worker Pool
// ============================================================================

export class WorkerPool {
  private workers: WorkerInfo[] = [];
  private program: Program<AgencCoordination>;
  private protocolPda: PublicKey;
  private provider: anchor.AnchorProvider;
  private runId: string;
  private counter: number = 0;

  constructor(
    program: Program<AgencCoordination>,
    protocolPda: PublicKey,
    provider: anchor.AnchorProvider,
    runId: string
  ) {
    this.program = program;
    this.protocolPda = protocolPda;
    this.provider = provider;
    this.runId = runId;
  }

  async initialize(size: number = 20): Promise<void> {
    const wallets: Keypair[] = [];
    const airdropSigs: string[] = [];

    for (let i = 0; i < size; i++) {
      const wallet = Keypair.generate();
      wallets.push(wallet);
      const sig = await this.provider.connection.requestAirdrop(
        wallet.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      airdropSigs.push(sig);
    }

    await Promise.all(
      airdropSigs.map(sig =>
        this.provider.connection.confirmTransaction(sig, "confirmed")
      )
    );

    const registerPromises = wallets.map(async (wallet, i) => {
      const agentId = makeAgentId(`pool${i}`, this.runId);
      const agentPda = deriveAgentPda(agentId, this.program.programId);

      await this.program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE | CAPABILITY_ARBITER),
          `https://pool-worker-${i}.example.com`,
          null,
          new BN(LAMPORTS_PER_SOL / 10)
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: this.protocolPda,
          authority: wallet.publicKey,
        })
        .signers([wallet])
        .rpc({ skipPreflight: true });

      this.workers.push({ wallet, agentId, agentPda, inUse: false });
    });

    await Promise.all(registerPromises);
  }

  getWorker(): WorkerInfo {
    const worker = this.workers.find(w => !w.inUse);
    if (!worker) {
      throw new Error("Worker pool exhausted");
    }
    worker.inUse = true;
    return worker;
  }

  releaseWorker(worker: WorkerInfo): void {
    const poolWorker = this.workers.find(
      w => w.agentPda.equals(worker.agentPda)
    );
    if (poolWorker) {
      poolWorker.inUse = false;
    }
  }

  async createFreshWorker(capabilities: number = CAPABILITY_COMPUTE): Promise<WorkerInfo> {
    // Try pool first
    const poolWorker = this.workers.find(w => !w.inUse);
    if (poolWorker) {
      poolWorker.inUse = true;
      return poolWorker;
    }

    // Create new worker
    this.counter++;
    const wallet = Keypair.generate();
    const agentId = makeAgentId(`fresh${this.counter}`, this.runId);
    const agentPda = deriveAgentPda(agentId, this.program.programId);

    await fundWallet(this.provider.connection, wallet, 5 * LAMPORTS_PER_SOL);

    await this.program.methods
      .registerAgent(
        Array.from(agentId),
        new BN(capabilities),
        `https://fresh-worker-${this.counter}.example.com`,
        null,
        new BN(LAMPORTS_PER_SOL / 10)
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: this.protocolPda,
        authority: wallet.publicKey,
      })
      .signers([wallet])
      .rpc({ skipPreflight: true });

    return { wallet, agentId, agentPda };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createTestProof(options: {
  proofSize?: number;
  constraintHash?: Buffer;
  outputCommitment?: Buffer;
  expectedBinding?: Buffer;
} = {}) {
  const proofSize = options.proofSize ?? 388;
  const constraintHash = options.constraintHash ?? Buffer.alloc(HASH_SIZE, 0x01);
  const outputCommitment = options.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x02);
  const expectedBinding = options.expectedBinding ?? Buffer.alloc(HASH_SIZE, 0x03);

  return {
    proofData: Buffer.alloc(proofSize, 0xAA),
    constraintHash: Array.from(constraintHash),
    outputCommitment: Array.from(outputCommitment),
    expectedBinding: Array.from(expectedBinding),
  };
}
