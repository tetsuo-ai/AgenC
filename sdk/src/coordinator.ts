/**
 * High-level coordination API for AgenC
 *
 * Wraps the low-level SDK into a minimal surface that lets developers
 * go from zero to "two agents coordinating privately" in under 20 lines.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { type Idl, Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  SEEDS,
  TaskState,
} from './constants';
import {
  generateProof,
  generateSalt,
  computeHashes,
  verifyProofLocally,
} from './proofs';
import {
  deriveTaskPda,
  deriveClaimPda,
  deriveEscrowPda,
  createTask as rawCreateTask,
  claimTask as rawClaimTask,
  completeTask as rawCompleteTask,
  completeTaskPrivate as rawCompleteTaskPrivate,
  getTask,
} from './tasks';
import type { TaskParams, TaskStatus, PrivateCompletionProof } from './tasks';

type ClusterName = 'devnet' | 'mainnet-beta' | 'localnet';

export interface CoordinatorConfig {
  cluster: ClusterName;
  rpcUrl?: string;
  idl?: Idl;
  programId?: PublicKey;
}

export interface AgentConfig {
  wallet: Keypair;
}

export interface PrivateTaskConfig {
  from: Agent;
  to: Agent;
  instruction: string;
  escrowLamports?: number;
  deadline?: number;
  proof?: 'zk' | 'none';
  output?: bigint[];
  circuitPath?: string;
}

export interface TaskResult {
  taskId: number;
  txSignature: string;
  status: TaskState;
  proofGenerated: boolean;
  proofVerified: boolean;
}

function clusterToRpcUrl(cluster: ClusterName): string {
  switch (cluster) {
    case 'devnet': return DEVNET_RPC;
    case 'mainnet-beta': return MAINNET_RPC;
    case 'localnet': return 'http://localhost:8899';
  }
}

export class Agent {
  readonly wallet: Keypair;
  readonly publicKey: PublicKey;

  constructor(config: AgentConfig) {
    this.wallet = config.wallet;
    this.publicKey = config.wallet.publicKey;
  }
}

export class PrivateTask {
  private coordinator: Coordinator;
  private config: PrivateTaskConfig;
  private taskId: number | null = null;

  constructor(coordinator: Coordinator, config: PrivateTaskConfig) {
    this.coordinator = coordinator;
    this.config = config;
  }

  async execute(): Promise<TaskResult> {
    const connection = this.coordinator.getConnection();
    const program = this.coordinator.getProgram();

    if (!program) {
      throw new Error(
        'Coordinator not initialized with an IDL. ' +
        'Call createCoordinator with an idl option, or use coordinator.init(idl).'
      );
    }

    const escrowLamports = this.config.escrowLamports ?? 100_000;
    const deadline = this.config.deadline ?? Math.floor(Date.now() / 1000) + 3600;

    const useZk = this.config.proof === 'zk';
    const output = this.config.output ?? [1n, 0n, 0n, 0n];

    let constraintHash: Buffer | undefined;
    if (useZk) {
      const hashes = computeHashes(
        // We need a temporary PDA for hash computation; will be replaced after task creation
        PublicKey.default,
        this.config.to.publicKey,
        output,
        0n
      );
      constraintHash = bigintToBuffer(hashes.constraintHash);
    }

    const { taskId, txSignature: createTx } = await rawCreateTask(
      connection,
      program,
      this.config.from.wallet,
      {
        description: this.config.instruction,
        escrowLamports,
        deadline,
        constraintHash,
      }
    );
    this.taskId = taskId;

    await rawClaimTask(connection, program, this.config.to.wallet, taskId);

    let proofGenerated = false;
    let proofVerified = false;

    if (useZk) {
      const salt = generateSalt();
      const taskPda = deriveTaskPda(taskId, program.programId);

      const proofResult = await generateProof({
        taskPda,
        agentPubkey: this.config.to.publicKey,
        output,
        salt,
        circuitPath: this.config.circuitPath,
      });

      proofGenerated = true;

      const proof: PrivateCompletionProof = {
        proofData: proofResult.proof,
        constraintHash: proofResult.constraintHash,
        outputCommitment: proofResult.outputCommitment,
        expectedBinding: proofResult.expectedBinding,
      };

      await rawCompleteTaskPrivate(
        connection,
        program,
        this.config.to.wallet,
        taskId,
        proof,
        program.programId,
      );
      proofVerified = true;
    } else {
      const resultHash = Buffer.alloc(32);
      await rawCompleteTask(
        connection,
        program,
        this.config.to.wallet,
        taskId,
        resultHash,
      );
    }

    return {
      taskId,
      txSignature: createTx,
      status: TaskState.Completed,
      proofGenerated,
      proofVerified,
    };
  }
}

export class Coordinator {
  private connection: Connection;
  private program: Program | null = null;
  private config: CoordinatorConfig;

  constructor(config: CoordinatorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? clusterToRpcUrl(config.cluster);
    this.connection = new Connection(rpcUrl, 'confirmed');

    if (config.idl) {
      const dummyWallet = Keypair.generate();
      const provider = new AnchorProvider(
        this.connection,
        new Wallet(dummyWallet),
        { commitment: 'confirmed' }
      );
      this.program = new Program(
        config.idl,
        provider,
      );
    }
  }

  async init(idl: Idl, signer?: Keypair): Promise<void> {
    const wallet = signer ?? Keypair.generate();
    const provider = new AnchorProvider(
      this.connection,
      new Wallet(wallet),
      { commitment: 'confirmed' }
    );
    this.program = new Program(idl, provider);
  }

  getConnection(): Connection {
    return this.connection;
  }

  getProgram(): Program | null {
    return this.program;
  }

  createPrivateTask(config: Omit<PrivateTaskConfig, 'from' | 'to'> & { from: Agent; to: Agent }): PrivateTask {
    return new PrivateTask(this, config);
  }

  async getTaskStatus(taskId: number): Promise<TaskStatus | null> {
    if (!this.program) {
      throw new Error('Coordinator not initialized with an IDL');
    }
    return getTask(this.connection, this.program, taskId);
  }
}

export function createCoordinator(config: CoordinatorConfig): Coordinator {
  return new Coordinator(config);
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}

function bigintToBuffer(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}
