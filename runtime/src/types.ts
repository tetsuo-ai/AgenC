/**
 * Type definitions for @agenc/runtime
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';

/**
 * Agent configuration options
 */
export interface AgentConfig {
  /** Solana RPC connection */
  connection: Connection;
  /** Agent wallet keypair */
  wallet: Keypair;
  /** Anchor program instance */
  program: Program;
  /** Agent's capability bitmask */
  capabilities: number;
  /** Agent's unique ID (32 bytes) */
  agentId: Buffer;
  /** Endpoint URL for agent (for discovery) */
  endpoint?: string;
  /** Initial stake amount in lamports */
  stake?: number;
  /** Path to ZK circuits directory */
  circuitPath?: string;
  /** Path to hash helper circuit */
  hashHelperPath?: string;
}

/**
 * Agent runtime options
 */
export interface RuntimeOptions {
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum concurrent tasks (default: 1) */
  maxConcurrentTasks?: number;
  /** Auto-claim matching tasks (default: false) */
  autoClaim?: boolean;
  /** Filter function for task selection */
  taskFilter?: (task: OnChainTask) => boolean;
  /** Retry attempts for failed operations (default: 3) */
  retryAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelayMs?: number;
}

/**
 * On-chain task representation
 */
export interface OnChainTask {
  /** Task PDA address */
  address: PublicKey;
  /** Task unique identifier */
  taskId: Buffer;
  /** Task creator */
  creator: PublicKey;
  /** Required capabilities bitmask */
  requiredCapabilities: number;
  /** Task description */
  description: string;
  /** Reward amount in lamports */
  rewardLamports: number;
  /** Maximum workers allowed */
  maxWorkers: number;
  /** Current worker count */
  currentWorkers: number;
  /** Deadline timestamp (0 = no deadline) */
  deadline: number;
  /** Task type (exclusive, collaborative, competitive) */
  taskType: TaskType;
  /** Constraint hash for private tasks (null for public) */
  constraintHash: Buffer | null;
  /** Task status */
  status: TaskStatus;
}

/**
 * Task types
 */
export enum TaskType {
  Exclusive = 0,
  Collaborative = 1,
  Competitive = 2,
}

/**
 * Task status
 */
export enum TaskStatus {
  Open = 0,
  InProgress = 1,
  Completed = 2,
  Cancelled = 3,
  Disputed = 4,
}

/**
 * Task execution result from handler
 */
export interface TaskResult {
  /** Output values (4 field elements for private tasks) */
  output: bigint[];
  /** Salt for proof generation (auto-generated if not provided) */
  salt?: bigint;
  /** Optional result data (max 128 bytes, for public tasks) */
  resultData?: Buffer;
}

/**
 * Task handler function signature
 */
export type TaskHandler = (task: OnChainTask) => Promise<TaskResult>;

/**
 * Event types emitted by the runtime
 */
export type RuntimeEvent =
  | { type: 'started'; agentId: Buffer }
  | { type: 'stopped'; agentId: Buffer }
  | { type: 'taskFound'; task: OnChainTask }
  | { type: 'taskClaimed'; task: OnChainTask; claimPda: PublicKey }
  | { type: 'taskCompleted'; task: OnChainTask; txSignature: string }
  | { type: 'taskFailed'; task: OnChainTask; error: Error }
  | { type: 'error'; error: Error };

/**
 * Event listener callback
 */
export type EventListener = (event: RuntimeEvent) => void;

/**
 * Agent state
 */
export interface AgentState {
  /** Agent PDA address */
  pda: PublicKey;
  /** Is agent registered on-chain */
  registered: boolean;
  /** Is runtime running */
  running: boolean;
  /** Current active tasks */
  activeTasks: Map<string, OnChainTask>;
  /** Tasks completed this session */
  completedCount: number;
  /** Tasks failed this session */
  failedCount: number;
}

/**
 * Capability flags (matches on-chain constants)
 */
export const Capabilities = {
  COMPUTE: 1 << 0,
  STORAGE: 1 << 1,
  INFERENCE: 1 << 2,
  NETWORK: 1 << 3,
  COORDINATOR: 1 << 4,
  ARBITER: 1 << 7,
} as const;
