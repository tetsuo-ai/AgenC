/**
 * Types for the Autonomous Agent system
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import { AgentRuntimeConfig } from '../types/config.js';
import type { ProofEngine } from '../proof/engine.js';
import type { MemoryBackend } from '../memory/types.js';
import type { MetricsProvider } from '../task/types.js';
import type { DependencyType } from '../task/dependency-graph.js';
import type { ProofPipelineConfig } from '../task/proof-pipeline.js';

/**
 * On-chain task data
 */
export interface Task {
  /** Task PDA */
  pda: PublicKey;
  /** Task ID (32 bytes) */
  taskId: Uint8Array;
  /** Creator's public key */
  creator: PublicKey;
  /** Required capabilities bitmask */
  requiredCapabilities: bigint;
  /** Reward amount in lamports */
  reward: bigint;
  /** Task description (64 bytes) */
  description: Uint8Array;
  /** Constraint hash for private tasks (32 bytes, all zeros for public) */
  constraintHash: Uint8Array;
  /** Deadline timestamp (0 = no deadline) */
  deadline: number;
  /** Maximum workers allowed */
  maxWorkers: number;
  /** Current number of claims */
  currentClaims: number;
  /** Task status */
  status: TaskStatus;
  /** SPL token mint for reward denomination (null = SOL) */
  rewardMint: PublicKey | null;
}

export enum TaskStatus {
  Open = 0,
  InProgress = 1,
  Completed = 2,
  Cancelled = 3,
  Disputed = 4,
}

/**
 * Filter for which tasks an agent should consider
 */
export interface TaskFilter {
  /** Only consider tasks matching these capabilities */
  capabilities?: bigint;
  /** Minimum reward in lamports */
  minReward?: bigint;
  /** Maximum reward in lamports (avoid honeypots) */
  maxReward?: bigint;
  /** Only accept tasks from these creators */
  trustedCreators?: PublicKey[];
  /** Reject tasks from these creators */
  blockedCreators?: PublicKey[];
  /** Only private tasks (non-zero constraint hash) */
  privateOnly?: boolean;
  /** Only public tasks (zero constraint hash) */
  publicOnly?: boolean;
  /**
   * Accepted reward mints. null means SOL, PublicKey means that mint.
   * Undefined (or omitted) means accept all mints.
   */
  acceptedMints?: (PublicKey | null)[];
  /** Custom filter function */
  custom?: (task: Task) => boolean;
}

/**
 * Strategy for deciding which tasks to claim
 */
export interface ClaimStrategy {
  /**
   * Decide whether to claim a task
   * @param task - The task to consider
   * @param pendingTasks - Number of tasks currently being worked on
   * @returns true to claim, false to skip
   */
  shouldClaim(task: Task, pendingTasks: number): boolean;

  /**
   * Priority for claiming (higher = claim first)
   * Used when multiple tasks are available
   */
  priority(task: Task): number;
}

/**
 * Interface for task executors
 */
export interface TaskExecutor {
  /**
   * Execute a task and return the output
   *
   * The output is an array of 4 field elements (bigint) that will be
   * used to generate the ZK proof. For public tasks, this is hashed
   * on-chain. For private tasks, only the commitment is revealed.
   *
   * @param task - The task to execute
   * @returns Array of 4 bigints representing the output
   */
  execute(task: Task): Promise<bigint[]>;

  /**
   * Optional: Validate that this executor can handle a task
   */
  canExecute?(task: Task): boolean;
}

/**
 * Alias for TaskExecutor used in autonomous agent context
 */
export type AutonomousTaskExecutor = TaskExecutor;

/**
 * Discovery mode for finding tasks
 */
export type DiscoveryMode = 'polling' | 'events' | 'hybrid';

/**
 * Configuration for speculative execution.
 *
 * When enabled, the agent uses a SpeculativeExecutor to overlap
 * proof generation with task execution, reducing pipeline latency.
 * Dependencies between tasks can be registered via
 * `agent.registerDependency()` for full speculative child execution.
 */
export interface SpeculationConfig {
  /** Enable speculative execution. @default false */
  enabled?: boolean;
  /** Maximum speculative tasks per parent. @default 5 */
  maxSpeculativeTasksPerParent?: number;
  /** Maximum speculation depth (chain length). @default 1, max: 5 */
  maxSpeculationDepth?: number;
  /** Dependency types eligible for speculation. @default [Data, Order] */
  speculatableDependencyTypes?: DependencyType[];
  /** Abort speculative tasks if parent proof fails. @default true */
  abortOnParentFailure?: boolean;
  /** Proof pipeline configuration overrides. */
  proofPipelineConfig?: Partial<ProofPipelineConfig>;
  /** Called when speculative execution starts for a dependent task. */
  onSpeculativeStarted?: (taskPda: PublicKey, parentPda: PublicKey) => void;
  /** Called when a speculative task's proof is confirmed on-chain. */
  onSpeculativeConfirmed?: (taskPda: PublicKey) => void;
  /** Called when a speculative task is aborted (e.g., parent failed). */
  onSpeculativeAborted?: (taskPda: PublicKey, reason: string) => void;
}

/**
 * Configuration for AutonomousAgent
 */
export interface AutonomousAgentConfig extends AgentRuntimeConfig {
  /**
   * Task executor implementation
   * Required - defines how tasks are actually executed
   */
  executor: TaskExecutor;

  /**
   * Filter for which tasks to consider
   * @default All tasks matching agent capabilities
   */
  taskFilter?: TaskFilter;

  /**
   * Strategy for claiming tasks
   * @default Claim any matching task
   */
  claimStrategy?: ClaimStrategy;

  /**
   * How often to scan for new tasks (ms)
   * Only used when discoveryMode is 'polling' or 'hybrid'
   * @default 5000
   */
  scanIntervalMs?: number;

  /**
   * Maximum concurrent tasks
   * @default 1
   */
  maxConcurrentTasks?: number;

  /**
   * Whether to generate proofs for private tasks
   * @default true
   */
  generateProofs?: boolean;

  /**
   * Path to circuit files (for proof generation)
   * @default './circuits-circom/task_completion'
   */
  circuitPath?: string;

  /**
   * Optional ProofEngine for cached, stats-tracked proof generation.
   * When provided, completeTaskPrivate() delegates to this engine
   * instead of calling SDK generateProof() directly.
   */
  proofEngine?: ProofEngine;

  /**
   * Optional memory backend for conversation persistence and lifecycle journaling
   */
  memory?: MemoryBackend;

  /**
   * TTL for memory entries in ms (default: 86_400_000 = 24h)
   */
  memoryTtlMs?: number;

  /**
   * Task discovery mode
   * - 'polling': Periodically scan for all open tasks
   * - 'events': Subscribe to TaskCreated events for real-time discovery
   * - 'hybrid': Use both polling and events (most reliable)
   * @default 'hybrid'
   */
  discoveryMode?: DiscoveryMode;

  /**
   * Maximum retries for on-chain operations (claim, complete)
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries (ms), with exponential backoff
   * @default 1000
   */
  retryDelayMs?: number;

  // Callbacks
  onTaskDiscovered?: (task: Task) => void;
  onTaskClaimed?: (task: Task, txSignature: string) => void;
  onTaskExecuted?: (task: Task, output: bigint[]) => void;
  onTaskCompleted?: (task: Task, txSignature: string) => void;
  onTaskFailed?: (task: Task, error: Error) => void;
  onEarnings?: (amount: bigint, task: Task) => void;
  onProofGenerated?: (task: Task, proofSizeBytes: number, durationMs: number) => void;

  /**
   * Speculative execution configuration.
   * When enabled, overlaps proof generation with task execution.
   * @default undefined (disabled)
   */
  speculation?: SpeculationConfig;

  /**
   * Optional metrics provider for telemetry instrumentation.
   * Passed through to internal components (LLMTaskExecutor, etc.).
   */
  metrics?: MetricsProvider;
}

/**
 * Stats for an autonomous agent
 */
export interface AutonomousAgentStats {
  /** Total tasks discovered */
  tasksDiscovered: number;
  /** Total tasks claimed */
  tasksClaimed: number;
  /** Total tasks completed successfully */
  tasksCompleted: number;
  /** Total tasks failed */
  tasksFailed: number;
  /** Total earnings in lamports (across all mints) */
  totalEarnings: bigint;
  /** Earnings broken down by mint (key = mint base58, "SOL" for native) */
  earningsByMint: Record<string, bigint>;
  /** Currently active tasks */
  activeTasks: number;
  /** Average task completion time (ms) */
  avgCompletionTimeMs: number;
  /** Uptime in ms */
  uptimeMs: number;

  // Speculative execution metrics (only present when speculation is enabled)
  /** Total speculative executions started */
  speculativeExecutionsStarted?: number;
  /** Speculative executions that were confirmed */
  speculativeExecutionsConfirmed?: number;
  /** Speculative executions that were aborted */
  speculativeExecutionsAborted?: number;
  /** Total time saved by speculation (estimated, in ms) */
  estimatedTimeSavedMs?: number;
}

/**
 * Default claim strategy - claim one task at a time, prioritize by reward
 */
export const DefaultClaimStrategy: ClaimStrategy = {
  shouldClaim: (_task: Task, pendingTasks: number) => pendingTasks === 0,
  priority: (task: Task) => Number(task.reward),
};
