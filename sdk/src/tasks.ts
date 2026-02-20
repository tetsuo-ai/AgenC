/**
 * Task Management Helpers for AgenC
 *
 * Create, claim, complete, and cancel tasks on the AgenC protocol.
 * Supports both native SOL and SPL token-denominated tasks.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import anchor, { type Program } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PROGRAM_ID,
  SEEDS,
  TaskState,
  DISCRIMINATOR_SIZE,
  PERCENT_BASE,
  DEFAULT_FEE_PERCENT,
  HASH_SIZE,
  RISC0_SEAL_BORSH_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
  TRUSTED_RISC0_SELECTOR,
  RECOMMENDED_CU_COMPLETE_TASK_PRIVATE,
  RECOMMENDED_CU_COMPLETE_TASK_PRIVATE_TOKEN,
} from './constants';
import { getAccount } from './anchor-utils';
import { getSdkLogger } from './logger';
import { getDependentTaskCount } from './queries';
import { runProofSubmissionPreflight, type ProofSubmissionPreflightResult, type ProofPreconditionResult } from './proof-validation';
import { NullifierCache } from './nullifier-cache';
import { validateRisc0PayloadShape } from './validation';

export { TaskState };

// ============================================================================
// Types
// ============================================================================

export interface TaskParams {
  /** Task ID — 32-byte identifier */
  taskId: Uint8Array | number[];
  /** Required capability bitmask (u64) */
  requiredCapabilities: number | bigint;
  /** Task description or instruction hash — exactly 64 bytes */
  description: Uint8Array | Buffer;
  /** Reward amount in lamports (SOL) or smallest token units */
  rewardAmount: number | bigint;
  /** Maximum workers allowed (u8) */
  maxWorkers: number;
  /** Deadline as Unix timestamp (seconds) */
  deadline: number;
  /** Task type: 0=Exclusive, 1=Collaborative, 2=Competitive */
  taskType: number;
  /** Constraint hash for private task verification (32 bytes). Null for public tasks. */
  constraintHash?: number[] | null;
  /** Minimum reputation score required (u16, default 0) */
  minReputation?: number;
  /** SPL token mint for reward denomination. Null/undefined for SOL tasks. */
  rewardMint?: PublicKey | null;
  /** Creator's token account. Required when rewardMint is set. If omitted, derived as ATA. */
  creatorTokenAccount?: PublicKey;
}

export interface DependentTaskParams extends TaskParams {
  /** Dependency type enum value */
  dependencyType: number;
}

export interface TaskStatus {
  /** Task ID bytes */
  taskId: Uint8Array;
  /** Current state */
  state: TaskState;
  /** Creator public key */
  creator: PublicKey;
  /** Reward amount in lamports or token units */
  rewardAmount: bigint;
  /** Deadline timestamp */
  deadline: number;
  /** Constraint hash (if private) */
  constraintHash: Uint8Array | null;
  /** Number of current workers */
  currentWorkers: number;
  /** Max workers */
  maxWorkers: number;
  /** Completion timestamp (if completed) */
  completedAt: number | null;
  /** SPL token mint (null for SOL tasks) */
  rewardMint: PublicKey | null;
}

export interface PrivateCompletionPayload {
  /** Borsh-encoded router seal bytes (selector + proof = 260 bytes) */
  sealBytes: Buffer | Uint8Array;
  /** Fixed private journal bytes (192 bytes) */
  journal: Buffer | Uint8Array;
  /** RISC0 image ID (32 bytes) */
  imageId: Buffer | Uint8Array;
  /** Binding spend seed (32 bytes) */
  bindingSeed: Buffer | Uint8Array;
  /** Nullifier spend seed (32 bytes) */
  nullifierSeed: Buffer | Uint8Array;
}

export interface CompleteTaskPrivateWithPreflightOptions {
  runProofSubmissionPreflight?: boolean;
  nullifierCache?: NullifierCache;
  proofGeneratedAtMs?: number;
  maxProofAgeMs?: number;
}

/**
 * @deprecated Since v1.6.0. Use {@link CompleteTaskPrivateWithPreflightOptions} and
 * `runProofSubmissionPreflight` instead of `validatePreconditions`.
 */
export interface CompleteTaskPrivateSafeOptions extends CompleteTaskPrivateWithPreflightOptions {
  validatePreconditions?: boolean;
}

export interface TaskLifecycleEvent {
  eventName: string;
  timestamp: number;
  txSignature?: string;
  actor?: PublicKey;
  data?: Record<string, unknown>;
}

export interface TaskLifecycleSummary {
  taskPda: PublicKey;
  currentState: TaskState;
  creator: PublicKey;
  rewardAmount: bigint;
  rewardMint: PublicKey | null;
  timeline: TaskLifecycleEvent[];
  currentWorkers: number;
  maxWorkers: number;
  createdAt: number;
  deadline: number;
  completedAt: number | null;
  hasActiveDispute: boolean;
  dependsOn: PublicKey | null;
  dependentCount: number;
  durationSeconds: number | null;
  isExpired: boolean;
}

function formatPreflightFailureReasons(result: { failures: Array<{ message: string }> }): string {
  return result.failures.map((failure) => failure.message).join('; ');
}

export class ProofSubmissionPreflightError extends Error {
  readonly result: ProofSubmissionPreflightResult;

  constructor(result: ProofSubmissionPreflightResult) {
    super(`Proof submission preflight failed: ${formatPreflightFailureReasons(result)}`);
    this.name = 'ProofSubmissionPreflightError';
    this.result = result;
  }
}

/**
 * @deprecated Since v1.6.0. Use {@link ProofSubmissionPreflightError} instead.
 */
export class ProofPreconditionError extends ProofSubmissionPreflightError {
  readonly result: ProofPreconditionResult;

  constructor(result: ProofPreconditionResult) {
    super(result);
    this.name = 'ProofPreconditionError';
    this.message = `Proof precondition check failed: ${formatPreflightFailureReasons(result)}`;
    this.result = result;
  }
}

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive task PDA from creator and task ID.
 * Seeds: ["task", creator, task_id]
 */
export function deriveTaskPda(
  creator: PublicKey,
  taskId: Uint8Array | number[],
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const idBytes = taskId instanceof Uint8Array ? taskId : Buffer.from(taskId);
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.TASK, creator.toBuffer(), idBytes],
    programId,
  );
  return pda;
}

/**
 * Derive claim PDA from task and worker agent PDA.
 * Seeds: ["claim", task_pda, worker_agent_pda]
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  workerAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.CLAIM, taskPda.toBuffer(), workerAgentPda.toBuffer()],
    programId,
  );
  return pda;
}

/**
 * Derive escrow PDA from task.
 * Seeds: ["escrow", task_pda]
 */
export function deriveEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId,
  );
  return pda;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function deriveProtocolPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    programId,
  );
  return pda;
}

function deriveAgentPda(agentId: Uint8Array | number[], programId: PublicKey): PublicKey {
  const idBytes = agentId instanceof Uint8Array ? agentId : Buffer.from(agentId);
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, idBytes],
    programId,
  );
  return pda;
}

type TaskTokenAccounts = Record<string, PublicKey | null>;

interface TaskCreationContext {
  taskPda: PublicKey;
  escrowPda: PublicKey;
  protocolPda: PublicKey;
  creatorAgentPda: PublicKey;
  idBytes: Uint8Array;
  mint: PublicKey | null;
  tokenAccounts: TaskTokenAccounts;
}

const BINDING_SPEND_SEED = Buffer.from('binding_spend');
const NULLIFIER_SPEND_SEED = Buffer.from('nullifier_spend');
const ROUTER_SEED = Buffer.from('router');
const VERIFIER_SEED = Buffer.from('verifier');
const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7');
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge');

function toFixedBytes(value: Uint8Array | Buffer, expectedLen: number, label: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length !== expectedLen) {
    throw new Error(`${label} must be exactly ${expectedLen} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function normalizeTaskId(taskId: Uint8Array | number[]): Uint8Array {
  return taskId instanceof Uint8Array ? taskId : Uint8Array.from(taskId);
}

function buildTaskTokenAccounts(
  mint: PublicKey | null,
  creator: PublicKey,
  escrowPda: PublicKey,
  creatorTokenAccount?: PublicKey,
): TaskTokenAccounts {
  if (!mint) {
    return {
      rewardMint: null,
      creatorTokenAccount: null,
      tokenEscrowAta: null,
      tokenProgram: null,
      associatedTokenProgram: null,
    };
  }

  const resolvedCreatorTokenAccount = creatorTokenAccount
    ?? getAssociatedTokenAddressSync(mint, creator);
  const tokenEscrowAta = getAssociatedTokenAddressSync(mint, escrowPda, true);

  return {
    rewardMint: mint,
    creatorTokenAccount: resolvedCreatorTokenAccount,
    tokenEscrowAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };
}

function buildTaskCreationContext(
  programId: PublicKey,
  creator: Keypair,
  creatorAgentId: Uint8Array | number[],
  params: TaskParams,
): TaskCreationContext {
  const idBytes = normalizeTaskId(params.taskId);
  const taskPda = deriveTaskPda(creator.publicKey, idBytes, programId);
  const escrowPda = deriveEscrowPda(taskPda, programId);
  const protocolPda = deriveProtocolPda(programId);
  const creatorAgentPda = deriveAgentPda(creatorAgentId, programId);
  const mint = params.rewardMint ?? null;
  const tokenAccounts = buildTaskTokenAccounts(
    mint,
    creator.publicKey,
    escrowPda,
    params.creatorTokenAccount,
  );

  return {
    taskPda,
    escrowPda,
    protocolPda,
    creatorAgentPda,
    idBytes,
    mint,
    tokenAccounts,
  };
}

async function submitTaskCreationTransaction(
  connection: Connection,
  operation: 'createTask' | 'createDependentTask',
  send: () => Promise<string>,
): Promise<string> {
  try {
    const tx = await send();
    await connection.confirmTransaction(tx, 'confirmed');
    return tx;
  } catch (error) {
    getSdkLogger().error(operation + ' failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ============================================================================
// Task Functions
// ============================================================================

/**
 * Create a new task.
 *
 * For SPL token tasks, the caller must ensure the creator's token account
 * exists and has sufficient balance. The escrow ATA is created by the
 * on-chain instruction via CPI.
 */
export async function createTask(
  connection: Connection,
  program: Program,
  creator: Keypair,
  creatorAgentId: Uint8Array | number[],
  params: TaskParams,
): Promise<{ taskPda: PublicKey; txSignature: string }> {
  const context = buildTaskCreationContext(
    program.programId,
    creator,
    creatorAgentId,
    params,
  );

  const tx = await submitTaskCreationTransaction(
    connection,
    'createTask',
    () =>
      program.methods
        .createTask(
          Array.from(context.idBytes),
          new anchor.BN(params.requiredCapabilities.toString()),
          Buffer.from(params.description),
          new anchor.BN(params.rewardAmount.toString()),
          params.maxWorkers,
          new anchor.BN(params.deadline),
          params.taskType,
          params.constraintHash ?? null,
          params.minReputation ?? 0,
          context.mint,
        )
        .accountsPartial({
          task: context.taskPda,
          escrow: context.escrowPda,
          protocolConfig: context.protocolPda,
          creatorAgent: context.creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          ...context.tokenAccounts,
        })
        .signers([creator])
        .rpc(),
  );

  return { taskPda: context.taskPda, txSignature: tx };
}

/**
 * Create a dependent task with an explicit parent task reference.
 */
export async function createDependentTask(
  connection: Connection,
  program: Program,
  creator: Keypair,
  creatorAgentId: Uint8Array | number[],
  parentTaskPda: PublicKey,
  params: DependentTaskParams,
): Promise<{ taskPda: PublicKey; txSignature: string }> {
  const context = buildTaskCreationContext(
    program.programId,
    creator,
    creatorAgentId,
    params,
  );

  const tx = await submitTaskCreationTransaction(
    connection,
    'createDependentTask',
    () =>
      program.methods
        .createDependentTask(
          Array.from(context.idBytes),
          new anchor.BN(params.requiredCapabilities.toString()),
          Buffer.from(params.description),
          new anchor.BN(params.rewardAmount.toString()),
          params.maxWorkers,
          new anchor.BN(params.deadline),
          params.taskType,
          params.constraintHash ?? null,
          params.dependencyType,
          params.minReputation ?? 0,
          context.mint,
        )
        .accountsPartial({
          task: context.taskPda,
          escrow: context.escrowPda,
          parentTask: parentTaskPda,
          protocolConfig: context.protocolPda,
          creatorAgent: context.creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          ...context.tokenAccounts,
        })
        .signers([creator])
        .rpc(),
  );

  return { taskPda: context.taskPda, txSignature: tx };
}

/**
 * Claim a task as a worker agent.
 */
export async function claimTask(
  connection: Connection,
  program: Program,
  worker: Keypair,
  workerAgentId: Uint8Array | number[],
  taskPda: PublicKey,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const workerAgentPda = deriveAgentPda(workerAgentId, programId);
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .claimTask()
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      protocolConfig: protocolPda,
      worker: workerAgentPda,
      authority: worker.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([worker])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

/**
 * Expire a claim after its deadline.
 */
export async function expireClaim(
  connection: Connection,
  program: Program,
  caller: Keypair,
  taskPda: PublicKey,
  workerAgentId: Uint8Array | number[],
  rentRecipient: PublicKey = caller.publicKey,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const workerAgentPda = deriveAgentPda(workerAgentId, programId);
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, programId);
  const escrowPda = deriveEscrowPda(taskPda, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .expireClaim()
    .accountsPartial({
      caller: caller.publicKey,
      task: taskPda,
      escrow: escrowPda,
      claim: claimPda,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      rentRecipient,
      systemProgram: SystemProgram.programId,
    })
    .signers([caller])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

/**
 * Complete a task (public completion with proof hash).
 *
 * Fetches the task and protocol config on-chain to determine accounts.
 * For SPL token tasks, the caller must ensure the worker's token account exists.
 */
export async function completeTask(
  connection: Connection,
  program: Program,
  worker: Keypair,
  workerAgentId: Uint8Array | number[],
  taskPda: PublicKey,
  proofHash: Uint8Array | number[],
  resultData?: Uint8Array | number[] | null,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const workerAgentPda = deriveAgentPda(workerAgentId, programId);
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, programId);
  const escrowPda = deriveEscrowPda(taskPda, programId);
  const protocolPda = deriveProtocolPda(programId);

  // Fetch task to get creator and reward_mint
  const task = await getAccount(program, 'task').fetch(taskPda) as {
    creator: PublicKey;
    rewardMint: PublicKey | null;
  };

  // Fetch protocol config to get treasury
  const protocolConfig = await getAccount(program, 'protocolConfig').fetch(protocolPda) as {
    treasury: PublicKey;
  };

  const mint = task.rewardMint;

  // Build token-specific accounts
  let tokenAccounts: Record<string, PublicKey | null>;
  if (mint) {
    tokenAccounts = {
      tokenEscrowAta: getAssociatedTokenAddressSync(mint, escrowPda, true),
      workerTokenAccount: getAssociatedTokenAddressSync(mint, worker.publicKey),
      treasuryTokenAccount: getAssociatedTokenAddressSync(mint, protocolConfig.treasury),
      rewardMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  } else {
    tokenAccounts = {
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }

  const proofHashArr = Array.from(proofHash);
  const resultDataBuf = resultData ? Buffer.from(resultData) : null;

  const tx = await program.methods
    .completeTask(proofHashArr, resultDataBuf)
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      escrow: escrowPda,
      creator: task.creator,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      treasury: protocolConfig.treasury,
      authority: worker.publicKey,
      systemProgram: SystemProgram.programId,
      ...tokenAccounts,
    })
    .signers([worker])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

/**
 * Complete a task privately with a ZK proof.
 *
 * Fetches the task and protocol config on-chain to determine accounts.
 * The task_id u64 argument is derived from the first 8 bytes of the task's taskId field.
 */
export async function completeTaskPrivate(
  connection: Connection,
  program: Program,
  worker: Keypair,
  workerAgentId: Uint8Array | number[],
  taskPda: PublicKey,
  proof: PrivateCompletionPayload,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const workerAgentPda = deriveAgentPda(workerAgentId, programId);
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, programId);
  const escrowPda = deriveEscrowPda(taskPda, programId);
  const protocolPda = deriveProtocolPda(programId);
  const sealBytes = toFixedBytes(proof.sealBytes, RISC0_SEAL_BORSH_LEN, 'sealBytes');
  const journal = toFixedBytes(proof.journal, RISC0_JOURNAL_LEN, 'journal');
  const imageId = toFixedBytes(proof.imageId, RISC0_IMAGE_ID_LEN, 'imageId');
  const bindingSeed = toFixedBytes(proof.bindingSeed, HASH_SIZE, 'bindingSeed');
  const nullifierSeed = toFixedBytes(proof.nullifierSeed, HASH_SIZE, 'nullifierSeed');

  // Defense-in-depth: validate payload shape (sizes + trusted selector)
  validateRisc0PayloadShape({ sealBytes, journal, imageId, bindingSeed, nullifierSeed });

  const [bindingSpend] = PublicKey.findProgramAddressSync(
    [BINDING_SPEND_SEED, bindingSeed],
    programId,
  );
  const [nullifierSpend] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SPEND_SEED, nullifierSeed],
    programId,
  );
  const [router] = PublicKey.findProgramAddressSync(
    [ROUTER_SEED],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  );
  const [verifierEntry] = PublicKey.findProgramAddressSync(
    [VERIFIER_SEED, Buffer.from(TRUSTED_RISC0_SELECTOR)],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  );

  // Fetch task to get creator, taskId, and reward_mint
  const task = await getAccount(program, 'task').fetch(taskPda) as {
    creator: PublicKey;
    taskId: number[] | Uint8Array;
    rewardMint: PublicKey | null;
  };

  // Extract task_id as u64 (first 8 bytes LE)
  const taskIdBuf = Buffer.from(task.taskId);
  const taskIdU64 = new anchor.BN(taskIdBuf.subarray(0, 8), 'le');

  // Fetch protocol config to get treasury
  const protocolConfig = await getAccount(program, 'protocolConfig').fetch(protocolPda) as {
    treasury: PublicKey;
  };

  const mint = task.rewardMint;

  // Build token-specific accounts
  let tokenAccounts: Record<string, PublicKey | null>;
  if (mint) {
    tokenAccounts = {
      tokenEscrowAta: getAssociatedTokenAddressSync(mint, escrowPda, true),
      workerTokenAccount: getAssociatedTokenAddressSync(mint, worker.publicKey),
      treasuryTokenAccount: getAssociatedTokenAddressSync(mint, protocolConfig.treasury),
      rewardMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  } else {
    tokenAccounts = {
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }

  const cuLimit = mint
    ? RECOMMENDED_CU_COMPLETE_TASK_PRIVATE_TOKEN
    : RECOMMENDED_CU_COMPLETE_TASK_PRIVATE;

  const tx = await program.methods
    .completeTaskPrivate(taskIdU64, {
      sealBytes: Array.from(sealBytes),
      journal: Array.from(journal),
      imageId: Array.from(imageId),
      bindingSeed: Array.from(bindingSeed),
      nullifierSeed: Array.from(nullifierSeed),
    })
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      escrow: escrowPda,
      creator: task.creator,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      bindingSpend,
      nullifierSpend,
      treasury: protocolConfig.treasury,
      authority: worker.publicKey,
      routerProgram: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
      router,
      verifierEntry,
      verifierProgram: TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      ...tokenAccounts,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ])
    .signers([worker])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

/**
 * Complete a task privately with optional best-effort client-side preflight checks
 * and local nullifier cache tracking.
 *
 * The preflight checks are not a cryptographic proof verifier and do not guarantee
 * transaction success.
 */
export async function completeTaskPrivateWithPreflight(
  connection: Connection,
  program: Program,
  worker: Keypair,
  workerAgentId: Uint8Array | number[],
  taskPda: PublicKey,
  proof: PrivateCompletionPayload,
  options: CompleteTaskPrivateWithPreflightOptions = {},
): Promise<{ txSignature: string; preflightResult?: ProofSubmissionPreflightResult }> {
  if (options.nullifierCache?.isUsed(proof.nullifierSeed)) {
    throw new Error('Nullifier already submitted in this session');
  }

  // SECURITY FIX: Mark nullifier as used BEFORE submission to prevent concurrent
  // duplicate submissions. On failure, remove it to allow retry.
  options.nullifierCache?.markUsed(proof.nullifierSeed);

  const shouldRunPreflight = options.runProofSubmissionPreflight ?? true;
  let preflightResult: ProofSubmissionPreflightResult | undefined;

  try {
    if (shouldRunPreflight) {
      const workerAgentPda = deriveAgentPda(workerAgentId, program.programId);
      preflightResult = await runProofSubmissionPreflight(connection, program, {
        taskPda,
        workerAgentPda,
        authorityPubkey: worker.publicKey,
        proof,
        proofGeneratedAtMs: options.proofGeneratedAtMs,
        maxProofAgeMs: options.maxProofAgeMs,
      });

      if (!preflightResult.valid) {
        throw new ProofSubmissionPreflightError(preflightResult);
      }
    }

    const result = await completeTaskPrivate(
      connection,
      program,
      worker,
      workerAgentId,
      taskPda,
      proof,
    );

    return {
      ...result,
      preflightResult,
    };
  } catch (err) {
    // Rollback: allow retry with same nullifier after failure
    options.nullifierCache?.remove(proof.nullifierSeed);
    throw err;
  }
}

/**
 * @deprecated Since v1.6.0. Use {@link completeTaskPrivateWithPreflight}.
 */
export async function completeTaskPrivateSafe(
  connection: Connection,
  program: Program,
  worker: Keypair,
  workerAgentId: Uint8Array | number[],
  taskPda: PublicKey,
  proof: PrivateCompletionPayload,
  options: CompleteTaskPrivateSafeOptions = {},
): Promise<{ txSignature: string; validationResult?: ProofPreconditionResult }> {
  const runProofSubmissionPreflightOption = options.runProofSubmissionPreflight
    ?? options.validatePreconditions;

  try {
    const result = await completeTaskPrivateWithPreflight(
      connection,
      program,
      worker,
      workerAgentId,
      taskPda,
      proof,
      {
        runProofSubmissionPreflight: runProofSubmissionPreflightOption,
        nullifierCache: options.nullifierCache,
        proofGeneratedAtMs: options.proofGeneratedAtMs,
        maxProofAgeMs: options.maxProofAgeMs,
      },
    );

    return {
      txSignature: result.txSignature,
      validationResult: result.preflightResult,
    };
  } catch (error) {
    if (error instanceof ProofSubmissionPreflightError) {
      throw new ProofPreconditionError(error.result);
    }
    throw error;
  }
}

/**
 * Cancel a task and refund the escrow to the creator.
 *
 * For tasks with active workers, pass workerPairs to close their claim accounts.
 * The on-chain instruction uses remaining_accounts for worker claim/agent pairs.
 */
export async function cancelTask(
  connection: Connection,
  program: Program,
  creator: Keypair,
  taskPda: PublicKey,
  workerPairs?: Array<{ claimPda: PublicKey; workerAgentPda: PublicKey }>,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const escrowPda = deriveEscrowPda(taskPda, programId);
  const protocolPda = deriveProtocolPda(programId);

  // Fetch task to get reward_mint
  const task = await getAccount(program, 'task').fetch(taskPda) as {
    rewardMint: PublicKey | null;
  };

  const mint = task.rewardMint;

  // Build token-specific accounts
  let tokenAccounts: Record<string, PublicKey | null>;
  if (mint) {
    tokenAccounts = {
      tokenEscrowAta: getAssociatedTokenAddressSync(mint, escrowPda, true),
      creatorTokenAccount: getAssociatedTokenAddressSync(mint, creator.publicKey),
      rewardMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  } else {
    tokenAccounts = {
      tokenEscrowAta: null,
      creatorTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    };
  }

  // Build remaining accounts for worker claim pairs
  const remainingAccounts = (workerPairs ?? []).flatMap((pair) => [
    { pubkey: pair.claimPda, isSigner: false, isWritable: true },
    { pubkey: pair.workerAgentPda, isSigner: false, isWritable: true },
  ]);

  const builder = program.methods
    .cancelTask()
    .accountsPartial({
      task: taskPda,
      escrow: escrowPda,
      creator: creator.publicKey,
      protocolConfig: protocolPda,
      systemProgram: SystemProgram.programId,
      ...tokenAccounts,
    })
    .signers([creator]);

  if (remainingAccounts.length > 0) {
    builder.remainingAccounts(remainingAccounts);
  }

  const tx = await builder.rpc();

  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get task status by PDA.
 */
export async function getTask(
  program: Program,
  taskPda: PublicKey,
): Promise<TaskStatus | null> {
  try {
    const task = await getAccount(program, 'task').fetch(taskPda);

    interface TaskAccountData {
      taskId?: number[] | Uint8Array;
      status?: { [key: string]: Record<string, never> } | number;
      creator?: PublicKey;
      rewardAmount?: { toString: () => string };
      deadline?: { toNumber: () => number };
      constraintHash?: number[] | Uint8Array | null;
      currentWorkers?: number;
      maxWorkers?: number;
      completedAt?: { toNumber: () => number } | null;
      rewardMint?: PublicKey | null;
    }

    const data = task as TaskAccountData;

    if (data.creator === undefined || data.status === undefined) {
      getSdkLogger().warn('Task account data missing required fields');
      return null;
    }

    // Parse Anchor enum status (e.g. { open: {} } → 0)
    const state = parseTaskState(data.status);

    // Parse constraint hash — check if all zeros (means no constraint)
    let constraintHash: Uint8Array | null = null;
    if (data.constraintHash) {
      const bytes = new Uint8Array(data.constraintHash);
      if (bytes.some((b) => b !== 0)) {
        constraintHash = bytes;
      }
    }

    return {
      taskId: data.taskId ? new Uint8Array(data.taskId) : new Uint8Array(32),
      state,
      creator: data.creator,
      rewardAmount: BigInt(data.rewardAmount?.toString() ?? '0'),
      deadline: data.deadline?.toNumber() ?? 0,
      constraintHash,
      currentWorkers: data.currentWorkers ?? 0,
      maxWorkers: data.maxWorkers ?? 1,
      completedAt: data.completedAt?.toNumber() ?? null,
      rewardMint: data.rewardMint ?? null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Account does not exist') ||
        errorMessage.includes('could not find account')) {
      return null;
    }
    getSdkLogger().warn(`getTask encountered unexpected error: ${errorMessage}`);
    return null;
  }
}

/**
 * Get all tasks created by an address.
 */
export async function getTasksByCreator(
  program: Program,
  creator: PublicKey,
): Promise<TaskStatus[]> {
  const tasks = await getAccount(program, 'task').all([
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE + 32, // After discriminator + task_id
        bytes: creator.toBase58(),
      },
    },
  ]);

  interface TaskAccountData {
    taskId?: number[] | Uint8Array;
    status?: { [key: string]: Record<string, never> } | number;
    creator?: PublicKey;
    rewardAmount?: { toString: () => string };
    deadline?: { toNumber: () => number };
    constraintHash?: number[] | Uint8Array | null;
    currentWorkers?: number;
    maxWorkers?: number;
    completedAt?: { toNumber: () => number } | null;
    rewardMint?: PublicKey | null;
  }

  const result: TaskStatus[] = [];

  for (let idx = 0; idx < tasks.length; idx++) {
    const t = tasks[idx];
    const data = t.account as TaskAccountData;

    if (data.creator === undefined || data.status === undefined) {
      getSdkLogger().warn(`Task at index ${idx} missing required fields, skipping`);
      continue;
    }

    const state = parseTaskState(data.status);

    let constraintHash: Uint8Array | null = null;
    if (data.constraintHash) {
      const bytes = new Uint8Array(data.constraintHash);
      if (bytes.some((b) => b !== 0)) {
        constraintHash = bytes;
      }
    }

    result.push({
      taskId: data.taskId ? new Uint8Array(data.taskId) : new Uint8Array(32),
      state,
      creator: data.creator,
      rewardAmount: BigInt(data.rewardAmount?.toString() ?? '0'),
      deadline: data.deadline?.toNumber() ?? 0,
      constraintHash,
      currentWorkers: data.currentWorkers ?? 0,
      maxWorkers: data.maxWorkers ?? 1,
      completedAt: data.completedAt?.toNumber() ?? null,
      rewardMint: data.rewardMint ?? null,
    });
  }

  return result;
}

/**
 * Build a timeline summary for a task from task/claim/dispute accounts.
 *
 * @example
 * ```typescript
 * const summary = await getTaskLifecycleSummary(program, taskPda);
 * if (summary?.currentState === TaskState.Completed) {
 *   console.log(`Task completed in ${summary.durationSeconds}s`);
 * }
 * ```
 */
export async function getTaskLifecycleSummary(
  program: Program,
  taskPda: PublicKey,
): Promise<TaskLifecycleSummary | null> {
  const task = await getTask(program, taskPda);
  if (!task) {
    return null;
  }

  const rawTask = await getAccount(program, 'task').fetch(taskPda) as {
    creator: PublicKey;
    createdAt?: { toNumber: () => number };
    created_at?: { toNumber: () => number };
    dependsOn?: PublicKey | null;
    depends_on?: PublicKey | null;
    completedAt?: { toNumber: () => number } | null;
    completed_at?: { toNumber: () => number } | null;
  };

  const createdAt = rawTask.createdAt?.toNumber() ?? rawTask.created_at?.toNumber() ?? 0;
  const dependsOn = rawTask.dependsOn ?? rawTask.depends_on ?? null;
  const completedAt = rawTask.completedAt?.toNumber()
    ?? rawTask.completed_at?.toNumber()
    ?? task.completedAt;

  const timeline: TaskLifecycleEvent[] = [
    {
      eventName: 'taskCreated',
      timestamp: createdAt,
      actor: task.creator,
    },
  ];

  const claims = await getAccount(program, 'taskClaim').all([
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE, // discriminator + task pubkey at offset 8
        bytes: taskPda.toBase58(),
      },
    },
  ]);

  for (const claim of claims) {
    const claimAccount = claim.account as {
      worker?: PublicKey;
      claimedAt?: { toNumber: () => number };
      claimed_at?: { toNumber: () => number };
      completedAt?: { toNumber: () => number };
      completed_at?: { toNumber: () => number };
    };

    const claimedAt = claimAccount.claimedAt?.toNumber() ?? claimAccount.claimed_at?.toNumber() ?? 0;
    if (claimedAt > 0) {
      timeline.push({
        eventName: 'taskClaimed',
        timestamp: claimedAt,
        actor: claimAccount.worker,
        data: { claimPda: claim.publicKey.toBase58() },
      });
    }

    const claimCompletedAt = claimAccount.completedAt?.toNumber() ?? claimAccount.completed_at?.toNumber() ?? 0;
    if (claimCompletedAt > 0) {
      timeline.push({
        eventName: 'taskClaimCompleted',
        timestamp: claimCompletedAt,
        actor: claimAccount.worker,
        data: { claimPda: claim.publicKey.toBase58() },
      });
    }
  }

  if (task.state === TaskState.Completed && completedAt && completedAt > 0) {
    timeline.push({
      eventName: 'taskCompleted',
      timestamp: completedAt,
    });
  }

  if (task.state === TaskState.Cancelled) {
    timeline.push({
      eventName: 'taskCancelled',
      timestamp: completedAt && completedAt > 0 ? completedAt : createdAt,
      actor: rawTask.creator,
    });
  }

  const disputes = await getAccount(program, 'dispute').all([
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE + 32, // discriminator + dispute_id
        bytes: taskPda.toBase58(),
      },
    },
  ]);

  const parseDisputeStatus = (status: unknown): number => {
    if (typeof status === 'number') return status;
    if (!status || typeof status !== 'object') return 0;
    const key = Object.keys(status as Record<string, unknown>)[0];
    const map: Record<string, number> = {
      active: 0,
      resolved: 1,
      expired: 2,
      cancelled: 3,
    };
    return map[key] ?? 0;
  };

  let hasActiveDispute = false;
  for (const dispute of disputes) {
    const d = dispute.account as {
      initiator?: PublicKey;
      createdAt?: { toNumber: () => number };
      created_at?: { toNumber: () => number };
      resolvedAt?: { toNumber: () => number };
      resolved_at?: { toNumber: () => number };
      status?: unknown;
    };

    const created = d.createdAt?.toNumber() ?? d.created_at?.toNumber() ?? 0;
    const resolved = d.resolvedAt?.toNumber() ?? d.resolved_at?.toNumber() ?? 0;
    const status = parseDisputeStatus(d.status);

    if (status === 0) {
      hasActiveDispute = true;
    }

    if (created > 0) {
      timeline.push({
        eventName: 'disputeInitiated',
        timestamp: created,
        actor: d.initiator,
        data: { disputePda: dispute.publicKey.toBase58() },
      });
    }

    if (resolved > 0 && status === 1) {
      timeline.push({
        eventName: 'disputeResolved',
        timestamp: resolved,
        data: { disputePda: dispute.publicKey.toBase58() },
      });
    }
  }

  timeline.sort((a, b) => a.timestamp - b.timestamp);

  const providerConnection = (program.provider as { connection?: Connection }).connection;
  if (!providerConnection) {
    throw new Error('Program provider does not expose a connection');
  }

  const dependentCount = await getDependentTaskCount(
    providerConnection,
    program.programId,
    taskPda,
  );

  const now = Math.floor(Date.now() / 1000);
  const isExpired = task.deadline > 0
    && now > task.deadline
    && task.state !== TaskState.Completed
    && task.state !== TaskState.Cancelled;

  const durationSeconds = completedAt && createdAt > 0
    ? completedAt - createdAt
    : null;

  return {
    taskPda,
    currentState: task.state,
    creator: task.creator,
    rewardAmount: task.rewardAmount,
    rewardMint: task.rewardMint,
    timeline,
    currentWorkers: task.currentWorkers,
    maxWorkers: task.maxWorkers,
    createdAt,
    deadline: task.deadline,
    completedAt,
    hasActiveDispute,
    dependsOn,
    dependentCount,
    durationSeconds,
    isExpired,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse Anchor enum status to TaskState number.
 * Anchor returns enums as objects like { open: {} }, { inProgress: {} }, etc.
 */
function parseTaskState(status: { [key: string]: Record<string, never> } | number): TaskState {
  if (typeof status === 'number') return status as TaskState;

  const key = Object.keys(status)[0];
  const stateMap: Record<string, TaskState> = {
    open: TaskState.Open,
    inProgress: TaskState.InProgress,
    pendingValidation: TaskState.PendingValidation,
    completed: TaskState.Completed,
    cancelled: TaskState.Cancelled,
    disputed: TaskState.Disputed,
  };
  return stateMap[key] ?? TaskState.Open;
}

/**
 * Format task state as human-readable string
 */
export function formatTaskState(state: TaskState): string {
  const states: Record<TaskState, string> = {
    [TaskState.Open]: 'Open',
    [TaskState.InProgress]: 'In Progress',
    [TaskState.PendingValidation]: 'Pending Validation',
    [TaskState.Completed]: 'Completed',
    [TaskState.Cancelled]: 'Cancelled',
    [TaskState.Disputed]: 'Disputed',
  };
  return states[state] ?? 'Unknown';
}

/**
 * Calculate escrow fee (protocol fee percentage)
 * @param escrowLamports - Escrow amount in lamports (must be non-negative)
 * @param feePercentage - Fee percentage (must be between 0 and PERCENT_BASE)
 * @returns Fee amount in lamports
 */
export function calculateEscrowFee(
  escrowLamports: number,
  feePercentage: number = DEFAULT_FEE_PERCENT
): number {
  if (escrowLamports < 0 || !Number.isFinite(escrowLamports)) {
    throw new Error('Invalid escrow amount: must be a non-negative finite number');
  }
  if (feePercentage < 0 || feePercentage > PERCENT_BASE || !Number.isFinite(feePercentage)) {
    throw new Error(`Invalid fee percentage: must be between 0 and ${PERCENT_BASE}`);
  }

  const maxSafeMultiplier = Math.floor(Number.MAX_SAFE_INTEGER / PERCENT_BASE);
  if (escrowLamports > maxSafeMultiplier) {
    throw new Error('Escrow amount too large: would cause arithmetic overflow');
  }

  return Math.floor((escrowLamports * feePercentage) / PERCENT_BASE);
}
