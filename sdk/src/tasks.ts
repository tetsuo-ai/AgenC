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
import { PROGRAM_ID, SEEDS, TaskState } from './constants';

export { TaskState };

export interface TaskParams {
  /** Task description/title */
  description: string;
  /** Escrow amount in lamports */
  escrowLamports: number;
  /** Deadline as Unix timestamp */
  deadline: number;
  /** Constraint hash for private verification */
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
  const taskIdBuffer = Buffer.alloc(8);
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

  const protocolState = await program.account.protocolState.fetch(protocolPda);
  const taskId = (protocolState as any).nextTaskId?.toNumber() || 0;

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

  const task = await program.account.task.fetch(taskPda);

  const tx = await program.methods
    .completeTask({
      resultHash: Array.from(resultHash),
    })
    .accounts({
      worker: worker.publicKey,
      task: taskPda,
      taskClaim: claimPda,
      escrow: escrowPda,
      creator: (task as any).creator,
      systemProgram: SystemProgram.programId,
    })
    .signers([worker])
    .rpc();

  return { txSignature: tx };
}

/**
 * Complete a task privately with ZK proof
 */
export async function completeTaskPrivate(
  connection: Connection,
  program: Program,
  worker: Keypair,
  taskId: number,
  zkProof: Buffer,
  publicWitness: Buffer,
  verifierProgramId: PublicKey
): Promise<{ txSignature: string }> {
  const taskPda = deriveTaskPda(taskId, program.programId);
  const claimPda = deriveClaimPda(taskPda, worker.publicKey, program.programId);

  const tx = await program.methods
    .completeTaskPrivate(taskId, {
      zkProof: Array.from(zkProof),
      publicWitness: Array.from(publicWitness),
    })
    .accounts({
      worker: worker.publicKey,
      task: taskPda,
      taskClaim: claimPda,
      zkVerifier: verifierProgramId,
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
    const task = await program.account.task.fetch(taskPda);
    const taskData = task as any;

    return {
      taskId,
      state: taskData.state as TaskState,
      creator: taskData.creator,
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
  const tasks = await program.account.task.all([
    {
      memcmp: {
        offset: 8, // After discriminator
        bytes: creator.toBase58(),
      },
    },
  ]);

  return tasks.map((t, idx) => {
    const data = t.account as any;
    return {
      taskId: idx, // This is simplified; actual ID would need proper extraction
      state: data.state as TaskState,
      creator: data.creator,
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
 */
export function calculateEscrowFee(
  escrowLamports: number,
  feePercentage: number = 1
): number {
  return Math.floor((escrowLamports * feePercentage) / 100);
}
