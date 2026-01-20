/**
 * Configuration types for @agenc/runtime
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import type { LLMAdapter, LLMConfig } from './llm';
import type { Tool } from './tools';
import type { MemoryBackend } from './memory';
import type { TaskEvaluator } from './task';
import type { EventHandlers } from './events';

/**
 * Agent capability flags (matches on-chain constants)
 */
export const Capability = {
  COMPUTE: 1n << 0n,
  INFERENCE: 1n << 1n,
  STORAGE: 1n << 2n,
  NETWORK: 1n << 3n,
  SENSOR: 1n << 4n,
  ACTUATOR: 1n << 5n,
  COORDINATOR: 1n << 6n,
  ARBITER: 1n << 7n,
  VALIDATOR: 1n << 8n,
  AGGREGATOR: 1n << 9n,
} as const;

/**
 * Agent status (matches on-chain enum)
 */
export enum AgentStatus {
  Inactive = 0,
  Active = 1,
  Busy = 2,
  Suspended = 3,
}

/**
 * Task type (matches on-chain enum)
 */
export enum TaskType {
  Exclusive = 0,
  Collaborative = 1,
  Competitive = 2,
}

/**
 * Task status (matches on-chain enum)
 */
export enum TaskStatus {
  Open = 0,
  InProgress = 1,
  PendingValidation = 2,
  Completed = 3,
  Cancelled = 4,
  Disputed = 5,
}

/**
 * Operating mode for the runtime
 */
export type OperatingMode = 'autonomous' | 'assisted' | 'human-in-the-loop' | 'supervised' | 'batch';

/**
 * Approval callback for human-in-the-loop mode
 */
export interface Proposal {
  type: 'claim_task' | 'submit_completion' | 'tool_execution' | 'dispute_initiation';
  reasoning: string;
  details: unknown;
}

export type ApprovalCallback = (proposal: Proposal) => Promise<boolean>;

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Complete runtime configuration
 */
export interface AgentRuntimeConfig {
  // === Required ===

  /** Solana RPC connection */
  connection: Connection;

  /** Agent wallet keypair */
  wallet: Keypair;

  /** Anchor program instance */
  program: Program;

  /** Agent capabilities bitmask */
  capabilities: bigint;

  // === Agent Identity ===

  /** Unique 32-byte agent identifier */
  agentId?: Buffer;

  /** Network endpoint for agent communication */
  endpoint?: string;

  /** IPFS/Arweave URI for extended metadata */
  metadataUri?: string;

  /** Initial stake amount in lamports */
  initialStake?: bigint;

  // === LLM Configuration ===

  /** LLM provider configuration or custom adapter */
  llm?: LLMConfig | LLMAdapter;

  // === Task Execution ===

  /** Custom task evaluator */
  taskEvaluator?: TaskEvaluator;

  /** Task types to accept */
  acceptedTaskTypes?: TaskType[];

  /** Maximum reward to accept (lamports) */
  maxTaskReward?: bigint;

  /** Minimum reward to accept (lamports) */
  minTaskReward?: bigint;

  /** Task execution timeout in ms */
  taskTimeout?: number;

  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;

  /** Task polling interval in ms */
  pollIntervalMs?: number;

  // === Operating Mode ===

  /** Operating mode */
  mode?: OperatingMode;

  /** Approval callback for human-in-the-loop mode */
  approvalCallback?: ApprovalCallback;

  // === Memory ===

  /** Memory store backend */
  memoryBackend?: MemoryBackend;

  /** Maximum conversation history tokens */
  maxContextTokens?: number;

  // === Tools ===

  /** Additional custom tools */
  customTools?: Tool[];

  /** Disable built-in tools */
  disableBuiltinTools?: boolean;

  /** Tool sandbox mode */
  sandboxTools?: boolean;

  // === Privacy ===

  /** Circuit path for ZK proofs */
  circuitPath?: string;

  /** Hash helper circuit path */
  hashHelperPath?: string;

  /** Enable Privacy Cash integration */
  enablePrivacyCash?: boolean;

  // === Events ===

  /** Custom event handlers */
  eventHandlers?: Partial<EventHandlers>;

  /** WebSocket RPC URL (if different from HTTP) */
  wsRpcUrl?: string;

  // === Retry Configuration ===

  /** Retry attempts for failed operations */
  retryAttempts?: number;

  /** Base delay for exponential backoff in ms */
  retryBaseDelayMs?: number;

  // === Logging ===

  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  /** Custom logger */
  logger?: Logger;
}

/**
 * Agent on-chain state
 */
export interface AgentState {
  /** Agent PDA address */
  pda: PublicKey;
  /** Agent ID */
  agentId: Buffer;
  /** Authority pubkey */
  authority: PublicKey;
  /** Capability bitmask */
  capabilities: bigint;
  /** Current status */
  status: AgentStatus;
  /** Endpoint URL */
  endpoint: string;
  /** Metadata URI */
  metadataUri: string;
  /** Registration timestamp */
  registeredAt: number;
  /** Last activity timestamp */
  lastActive: number;
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total rewards earned */
  totalEarned: bigint;
  /** Reputation score (0-10000) */
  reputation: number;
  /** Active task count */
  activeTasks: number;
  /** Staked amount */
  stake: bigint;
  /** Is registered on-chain */
  registered: boolean;
  // Rate limiting
  /** Last task creation timestamp */
  lastTaskCreated: number;
  /** Last dispute initiation timestamp */
  lastDisputeInitiated: number;
  /** Tasks created in current 24h window */
  taskCount24h: number;
  /** Disputes initiated in current 24h window */
  disputeCount24h: number;
  /** Rate limit window start */
  rateLimitWindowStart: number;
}

/**
 * Runtime state
 */
export interface RuntimeState {
  /** Is runtime running */
  running: boolean;
  /** Current operating mode */
  mode: OperatingMode;
  /** Active tasks being processed */
  activeTasks: Map<string, unknown>;
  /** Tasks completed this session */
  completedCount: number;
  /** Tasks failed this session */
  failedCount: number;
  /** Runtime start time */
  startedAt: number | null;
}

/**
 * Helper to combine capabilities
 */
export function combineCapabilities(...caps: bigint[]): bigint {
  return caps.reduce((acc, cap) => acc | cap, 0n);
}

/**
 * Helper to check if agent has required capabilities
 */
export function hasCapability(agentCaps: bigint, required: bigint): boolean {
  return (agentCaps & required) === required;
}

/**
 * Generate a unique agent ID
 */
export function generateAgentId(prefix?: string): Buffer {
  const id = Buffer.alloc(32);
  if (prefix) {
    const prefixBuf = Buffer.from(prefix);
    prefixBuf.copy(id, 0, 0, Math.min(prefixBuf.length, 24));
  }
  // Add random bytes for uniqueness
  const randomBytes = Buffer.from(
    Array.from({ length: 8 }, () => Math.floor(Math.random() * 256))
  );
  randomBytes.copy(id, 24);
  return id;
}
