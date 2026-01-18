/**
 * Task Management Helpers for AgenC
 *
 * Create, claim, and complete tasks on the AgenC protocol
 */

import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { Program, BN } from '@coral-xyz/anchor';
import { PROGRAM_ID, SEEDS, TaskState, U64_SIZE, DISCRIMINATOR_SIZE, PERCENT_BASE, DEFAULT_FEE_PERCENT } from './constants';

export { TaskState };

/**
 * Helper type for dynamic account access on Anchor programs.
 * Anchor's generic Program type doesn't know about specific account types,
 * so we use this to access accounts dynamically.
 */
type AccountFetcher = {
  fetch: (key: PublicKey) => Promise<unknown>;
  all: (filters?: Array<{ memcmp: { offset: number; bytes: string } }>) => Promise<Array<{ account: unknown; publicKey: PublicKey }>>;
};

function getAccount(program: Program, name: string): AccountFetcher {
  const accounts = program.account as Record<string, AccountFetcher | undefined>;
  const account = accounts[name];
  if (!account) {
    throw new Error(
      `Account "${name}" not found in program. ` +
      `Available accounts: ${Object.keys(accounts).join(', ') || 'none'}`
    );
  }
  return account;
}

export interface TaskParams {
  /** Task description/title */
  description: string;
  /** Escrow amount in lamports */
  escrowLamports: number;
  /** Deadline as Unix timestamp */
  deadline: number;
  /**
   * Constraint hash for private task verification.
   * For private tasks, this is the Poseidon hash of the expected output.
   * Workers must prove they know an output that hashes to this value.
   * CRITICAL: Must be set for private tasks, verified on-chain during completion.
   */
  constraintHash?: Buffer;
  /** Required skills (optional) */
  requiredSkills?: string[];
  /** Maximum number of claims allowed */
  maxClaims?: number;
}

export interface TaskStatus {
  /** Task ID */
  taskId: number;
  /** Current state */
  state: TaskState;
  /** Creator public key */
  creator: PublicKey;
  /** Escrow amount */
  escrowLamports: number;
  /** Deadline timestamp */
  deadline: number;
  /** Constraint hash (if private) */
  constraintHash: Buffer | null;
  /** Claimed by agent (if claimed) */
  claimedBy: PublicKey | null;
  /** Completion timestamp (if completed) */
  completedAt: number | null;
}

/**
 * Derive task PDA from task ID
 */
export function deriveTaskPda(taskId: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  const taskIdBuffer = Buffer.alloc(U64_SIZE);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));

  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.TASK, taskIdBuffer],
    programId
  );
  return pda;
}

/**
 * Derive claim PDA from task and agent
 */
export function deriveClaimPda(
  taskPda: PublicKey,
  agent: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.CLAIM, taskPda.toBuffer(), agent.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Derive escrow PDA from task
 */
export function deriveEscrowPda(
  taskPda: PublicKey,
  programId: PublicKey = PROGRAM_ID
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Create a new task
 */
export async function createTask(
  connection: Connection,
  program: Program,
  creator: Keypair,
  params: TaskParams
): Promise<{ taskId: number; txSignature: string }> {
  // Get next task ID from protocol state
  const [protocolPda] = PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    program.programId
  );

  const protocolState = await getAccount(program, 'protocolState').fetch(protocolPda) as { nextTaskId?: BN };
  const taskId = protocolState.nextTaskId?.toNumber() || 0;

  const taskPda = deriveTaskPda(taskId, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);

  const tx = await program.methods
    .createTask({
      description: params.description,
      escrowLamports: new BN(params.escrowLamports),
      deadline: new BN(params.deadline),
      constraintHash: params.constraintHash ? Array.from(params.constraintHash) : null,
      requiredSkills: params.requiredSkills || [],
      maxClaims: params.maxClaims || 1,
    })
    .accounts({
      creator: creator.publicKey,
      task: taskPda,
      escrow: escrowPda,
      protocolState: protocolPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator])
    .rpc();

  return { taskId, txSignature: tx };
}

/**
 * Claim a task as an agent
 */
export async function claimTask(
  connection: Connection,
  program: Program,
  agent: Keypair,
  taskId: number
): Promise<{ txSignature: string }> {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, agent.publicKey, program.programId);

  const [agentPda] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, agent.publicKey.toBuffer()],
    program.programId
  );

  const tx = await program.methods
    .claimTask(taskId)
    .accounts({
      agent: agent.publicKey,
      agentAccount: agentPda,
      task: taskPda,
      taskClaim: claimPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([agent])
    .rpc();

  return { txSignature: tx };
}

/**
 * Complete a task (standard, non-private)
 */
export async function completeTask(
  connection: Connection,
  program: Program,
  worker: Keypair,
  taskId: number,
  resultHash: Buffer
): Promise<{ txSignature: string }> {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);

  const task = await getAccount(program, 'task').fetch(taskPda) as { creator: PublicKey };

  const tx = await program.methods
    .completeTask({
      resultHash: Array.from(resultHash),
    })
    .accounts({
      worker: worker.publicKey,
      task: taskPda,
      taskClaim: claimPda,
      escrow: escrowPda,
      creator: task.creator,
      systemProgram: SystemProgram.programId,
    })
    .signers([worker])
    .rpc();

  return { txSignature: tx };
}

export interface PrivateCompletionProof {
  proofData: Buffer;
  constraintHash: Buffer;
  outputCommitment: Buffer;
  expectedBinding: Buffer;
}

/**
 * Complete a task privately with ZK proof
 */
export async function completeTaskPrivate(
  connection: Connection,
  program: Program,
  worker: Keypair,
  taskId: number,
  proof: PrivateCompletionProof,
  verifierProgramId: PublicKey
): Promise<{ txSignature: string }> {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);
  const escrowPda = deriveEscrowPda(taskPda, program.programId);

  const [workerAgentPda] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, worker.publicKey.toBuffer()],
    program.programId
  );

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [SEEDS.PROTOCOL],
    program.programId
  );

  const protocolState = await getAccount(program, 'protocolConfig').fetch(protocolPda) as { treasury: PublicKey };

  const tx = await program.methods
    .completeTaskPrivate(new BN(taskId), {
      proofData: Array.from(proof.proofData),
      constraintHash: Array.from(proof.constraintHash),
      outputCommitment: Array.from(proof.outputCommitment),
      expectedBinding: Array.from(proof.expectedBinding),
    })
    .accounts({
      task: taskPda,
      claim: claimPda,
      escrow: escrowPda,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      treasury: protocolState.treasury,
      zkVerifier: verifierProgramId,
      authority: worker.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([worker])
    .rpc();

  return { txSignature: tx };
}

/**
 * Get task status
 */
export async function getTask(
  connection: Connection,
  program: Program,
  taskId: number
): Promise<TaskStatus | null> {
  const taskPda = deriveTaskPda(taskId, program.programId);

  try {
    const task = await getAccount(program, 'task').fetch(taskPda);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskData = task as any;

    return {
      taskId,
      state: taskData.state as TaskState,
      creator: taskData.creator as PublicKey,
      escrowLamports: taskData.escrowLamports?.toNumber() || 0,
      deadline: taskData.deadline?.toNumber() || 0,
      constraintHash: taskData.constraintHash
        ? Buffer.from(taskData.constraintHash)
        : null,
      claimedBy: taskData.claimedBy || null,
      completedAt: taskData.completedAt?.toNumber() || null,
    };
  } catch {
    return null;
  }
}

/**
 * Get all tasks created by an address
 */
export async function getTasksByCreator(
  connection: Connection,
  program: Program,
  creator: PublicKey
): Promise<TaskStatus[]> {
  const tasks = await getAccount(program, 'task').all([
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE, // After discriminator
        bytes: creator.toBase58(),
      },
    },
  ]);

  return tasks.map((t: { account: unknown; publicKey: PublicKey }, idx: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = t.account as any;
    return {
      taskId: idx, // This is simplified; actual ID would need proper extraction
      state: data.state as TaskState,
      creator: data.creator as PublicKey,
      escrowLamports: data.escrowLamports?.toNumber() || 0,
      deadline: data.deadline?.toNumber() || 0,
      constraintHash: data.constraintHash ? Buffer.from(data.constraintHash) : null,
      claimedBy: data.claimedBy || null,
      completedAt: data.completedAt?.toNumber() || null,
    };
  });
}

/**
 * Format task state as human-readable string
 */
export function formatTaskState(state: TaskState): string {
  const states: Record<TaskState, string> = {
    [TaskState.Open]: 'Open',
    [TaskState.Claimed]: 'Claimed',
    [TaskState.Completed]: 'Completed',
    [TaskState.Disputed]: 'Disputed',
    [TaskState.Cancelled]: 'Cancelled',
  };
  return states[state] || 'Unknown';
}

/**
 * Calculate escrow fee (protocol fee percentage)
 * @param escrowLamports - Escrow amount in lamports (must be non-negative)
 * @param feePercentage - Fee percentage (must be between 0 and PERCENT_BASE)
 * @returns Fee amount in lamports
 * @throws Error if inputs would cause overflow or are invalid
 */
export function calculateEscrowFee(
  escrowLamports: number,
  feePercentage: number = DEFAULT_FEE_PERCENT
): number {
  // Security: Validate inputs to prevent unexpected behavior
  if (escrowLamports < 0 || !Number.isFinite(escrowLamports)) {
    throw new Error('Invalid escrow amount: must be a non-negative finite number');
  }
  if (feePercentage < 0 || feePercentage > PERCENT_BASE || !Number.isFinite(feePercentage)) {
    throw new Error(`Invalid fee percentage: must be between 0 and ${PERCENT_BASE}`);
  }

  // Security: Check for potential overflow before multiplication
  // JavaScript's Number.MAX_SAFE_INTEGER is 2^53 - 1
  const maxSafeMultiplier = Math.floor(Number.MAX_SAFE_INTEGER / PERCENT_BASE);
  if (escrowLamports > maxSafeMultiplier) {
    throw new Error('Escrow amount too large: would cause arithmetic overflow');
  }

  return Math.floor((escrowLamports * feePercentage) / PERCENT_BASE);
}
