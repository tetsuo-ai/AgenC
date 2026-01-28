/**
 * Task type definitions, parsing utilities, and configuration types
 * for the Phase 3 Task Executor.
 *
 * @module
 */

import type { PublicKey, TransactionSignature } from '@solana/web3.js';
import { TaskType } from '../events/types.js';
import type { Logger } from '../utils/logger.js';
import type { TaskOperations } from './operations.js';
import type { TaskDiscovery, TaskDiscoveryResult } from './discovery.js';

// Re-export TaskType for consumers importing from task module directly
export { TaskType } from '../events/types.js';

// Re-export TASK_ID_LENGTH from pda.ts
export { TASK_ID_LENGTH } from './pda.js';

// ============================================================================
// On-Chain Task Status Enum (matches state.rs TaskStatus)
// ============================================================================

/**
 * Task status values matching on-chain enum.
 * Stored as u8 on-chain with repr(u8).
 */
export enum OnChainTaskStatus {
  /** Task is open and accepting claims */
  Open = 0,
  /** Task has been claimed and is in progress */
  InProgress = 1,
  /** Task is pending validation */
  PendingValidation = 2,
  /** Task has been completed */
  Completed = 3,
  /** Task has been cancelled */
  Cancelled = 4,
  /** Task is under dispute */
  Disputed = 5,
}

// ============================================================================
// On-Chain Interfaces (parsed, developer-friendly types)
// ============================================================================

/**
 * Parsed on-chain Task account data.
 * Matches the state.rs Task struct with TypeScript-native types.
 * PDA seeds: ["task", creator, task_id]
 */
export interface OnChainTask {
  /** Unique task identifier (32 bytes) */
  taskId: Uint8Array;
  /** Task creator's public key */
  creator: PublicKey;
  /** Required capability bitmask (u64 as bigint) */
  requiredCapabilities: bigint;
  /** Task description or instruction hash (64 bytes) */
  description: Uint8Array;
  /** Constraint hash for private task verification (32 bytes, all zeros = public) */
  constraintHash: Uint8Array;
  /** Reward amount in lamports (u64 as bigint) */
  rewardAmount: bigint;
  /** Maximum workers allowed (u8) */
  maxWorkers: number;
  /** Current worker count (u8) */
  currentWorkers: number;
  /** Current task status */
  status: OnChainTaskStatus;
  /** Task type (Exclusive, Collaborative, Competitive) */
  taskType: TaskType;
  /** Creation timestamp (Unix seconds) */
  createdAt: number;
  /** Deadline timestamp (Unix seconds, 0 = no deadline) */
  deadline: number;
  /** Completion timestamp (Unix seconds, 0 = not completed) */
  completedAt: number;
  /** Escrow account public key */
  escrow: PublicKey;
  /** Result data or pointer (64 bytes) */
  result: Uint8Array;
  /** Number of completions (for collaborative tasks) */
  completions: number;
  /** Required completions */
  requiredCompletions: number;
  /** PDA bump seed */
  bump: number;
}

/**
 * Parsed on-chain TaskClaim account data.
 * Matches the state.rs TaskClaim struct with TypeScript-native types.
 * PDA seeds: ["claim", task_pda, worker_agent_pda]
 */
export interface OnChainTaskClaim {
  /** Task being claimed (PDA) */
  task: PublicKey;
  /** Worker agent (PDA) */
  worker: PublicKey;
  /** Claim timestamp (Unix seconds) */
  claimedAt: number;
  /** Expiration timestamp for claim (Unix seconds) */
  expiresAt: number;
  /** Completion timestamp (Unix seconds, 0 = not completed) */
  completedAt: number;
  /** Proof of work hash (32 bytes) */
  proofHash: Uint8Array;
  /** Result data (64 bytes) */
  resultData: Uint8Array;
  /** Whether the claim has been completed */
  isCompleted: boolean;
  /** Whether the result has been validated */
  isValidated: boolean;
  /** Reward paid amount in lamports (u64 as bigint) */
  rewardPaid: bigint;
  /** PDA bump seed */
  bump: number;
}

// ============================================================================
// Raw Interfaces (as received from Anchor account fetch)
// ============================================================================

/**
 * Raw task data from Anchor's program.account.task.fetch().
 * BN fields need conversion to bigint/number, number[] to Uint8Array.
 */
export interface RawOnChainTask {
  taskId: number[] | Uint8Array;
  creator: PublicKey;
  requiredCapabilities: { toString: () => string };
  description: number[] | Uint8Array;
  constraintHash: number[] | Uint8Array;
  rewardAmount: { toString: () => string };
  maxWorkers: number;
  currentWorkers: number;
  status: { open?: object; inProgress?: object; pendingValidation?: object; completed?: object; cancelled?: object; disputed?: object } | number;
  taskType: { exclusive?: object; collaborative?: object; competitive?: object } | number;
  createdAt: { toNumber: () => number };
  deadline: { toNumber: () => number };
  completedAt: { toNumber: () => number };
  escrow: PublicKey;
  result: number[] | Uint8Array;
  completions: number;
  requiredCompletions: number;
  bump: number;
}

/**
 * Raw task claim data from Anchor's program.account.taskClaim.fetch().
 * BN fields need conversion to bigint/number, number[] to Uint8Array.
 */
export interface RawOnChainTaskClaim {
  task: PublicKey;
  worker: PublicKey;
  claimedAt: { toNumber: () => number };
  expiresAt: { toNumber: () => number };
  completedAt: { toNumber: () => number };
  proofHash: number[] | Uint8Array;
  resultData: number[] | Uint8Array;
  isCompleted: boolean;
  isValidated: boolean;
  rewardPaid: { toString: () => string };
  bump: number;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Checks if a value is a BN-like object with toString method (for u64 fields).
 */
function isBNLike(value: unknown): value is { toString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).toString === 'function'
  );
}

/**
 * Checks if a value is a BN-like object with toNumber method (for i64 fields).
 */
function isBNLikeWithToNumber(value: unknown): value is { toNumber: () => number } {
  return (
    isBNLike(value) && typeof (value as Record<string, unknown>).toNumber === 'function'
  );
}

/**
 * Type guard for RawOnChainTask data.
 * Validates all required fields are present with correct types.
 */
export function isRawOnChainTask(data: unknown): data is RawOnChainTask {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Array/Uint8Array fields
  if (!Array.isArray(obj.taskId) && !(obj.taskId instanceof Uint8Array)) return false;
  if (!Array.isArray(obj.description) && !(obj.description instanceof Uint8Array)) return false;
  if (!Array.isArray(obj.constraintHash) && !(obj.constraintHash instanceof Uint8Array)) return false;
  if (!Array.isArray(obj.result) && !(obj.result instanceof Uint8Array)) return false;

  // PublicKey fields
  if (!(obj.creator instanceof Object) || typeof (obj.creator as Record<string, unknown>).toBuffer !== 'function') return false;
  if (!(obj.escrow instanceof Object) || typeof (obj.escrow as Record<string, unknown>).toBuffer !== 'function') return false;

  // BN-like fields (u64)
  if (!isBNLike(obj.requiredCapabilities)) return false;
  if (!isBNLike(obj.rewardAmount)) return false;

  // BN-like fields (i64)
  if (!isBNLikeWithToNumber(obj.createdAt)) return false;
  if (!isBNLikeWithToNumber(obj.deadline)) return false;
  if (!isBNLikeWithToNumber(obj.completedAt)) return false;

  // Number fields (u8)
  if (typeof obj.maxWorkers !== 'number') return false;
  if (typeof obj.currentWorkers !== 'number') return false;
  if (typeof obj.completions !== 'number') return false;
  if (typeof obj.requiredCompletions !== 'number') return false;
  if (typeof obj.bump !== 'number') return false;

  // Status and taskType can be object (Anchor enum) or number
  if (typeof obj.status !== 'object' && typeof obj.status !== 'number') return false;
  if (typeof obj.taskType !== 'object' && typeof obj.taskType !== 'number') return false;

  return true;
}

/**
 * Type guard for RawOnChainTaskClaim data.
 * Validates all required fields are present with correct types.
 */
export function isRawOnChainTaskClaim(data: unknown): data is RawOnChainTaskClaim {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // PublicKey fields
  if (!(obj.task instanceof Object) || typeof (obj.task as Record<string, unknown>).toBuffer !== 'function') return false;
  if (!(obj.worker instanceof Object) || typeof (obj.worker as Record<string, unknown>).toBuffer !== 'function') return false;

  // BN-like fields (i64)
  if (!isBNLikeWithToNumber(obj.claimedAt)) return false;
  if (!isBNLikeWithToNumber(obj.expiresAt)) return false;
  if (!isBNLikeWithToNumber(obj.completedAt)) return false;

  // BN-like fields (u64)
  if (!isBNLike(obj.rewardPaid)) return false;

  // Array/Uint8Array fields
  if (!Array.isArray(obj.proofHash) && !(obj.proofHash instanceof Uint8Array)) return false;
  if (!Array.isArray(obj.resultData) && !(obj.resultData instanceof Uint8Array)) return false;

  // Boolean fields
  if (typeof obj.isCompleted !== 'boolean') return false;
  if (typeof obj.isValidated !== 'boolean') return false;

  // Number fields (u8)
  if (typeof obj.bump !== 'number') return false;

  return true;
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Converts array-like value to Uint8Array.
 */
function toUint8Array(value: number[] | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

// ============================================================================
// Parse Functions
// ============================================================================

/**
 * Parses the OnChainTaskStatus from Anchor's enum representation.
 * Anchor enums can come as objects like { open: {} } or numbers.
 *
 * @param status - Raw status from Anchor
 * @returns Parsed OnChainTaskStatus
 * @throws Error if status value is invalid
 *
 * @example
 * ```typescript
 * const status = parseTaskStatus(rawTask.status);
 * console.log(taskStatusToString(status)); // "Open"
 * ```
 */
export function parseTaskStatus(
  status: { open?: object; inProgress?: object; pendingValidation?: object; completed?: object; cancelled?: object; disputed?: object } | number
): OnChainTaskStatus {
  if (typeof status === 'number') {
    if (status < OnChainTaskStatus.Open || status > OnChainTaskStatus.Disputed) {
      throw new Error(`Invalid task status value: ${status}`);
    }
    return status;
  }

  if ('open' in status) return OnChainTaskStatus.Open;
  if ('inProgress' in status) return OnChainTaskStatus.InProgress;
  if ('pendingValidation' in status) return OnChainTaskStatus.PendingValidation;
  if ('completed' in status) return OnChainTaskStatus.Completed;
  if ('cancelled' in status) return OnChainTaskStatus.Cancelled;
  if ('disputed' in status) return OnChainTaskStatus.Disputed;

  throw new Error('Invalid task status format');
}

/**
 * Parses the TaskType from Anchor's enum representation.
 * Anchor enums can come as objects like { exclusive: {} } or numbers.
 *
 * @param type - Raw task type from Anchor
 * @returns Parsed TaskType
 * @throws Error if type value is invalid
 *
 * @example
 * ```typescript
 * const type = parseTaskType(rawTask.taskType);
 * console.log(taskTypeToString(type)); // "Exclusive"
 * ```
 */
export function parseTaskType(
  type: { exclusive?: object; collaborative?: object; competitive?: object } | number
): TaskType {
  if (typeof type === 'number') {
    if (type < TaskType.Exclusive || type > TaskType.Competitive) {
      throw new Error(`Invalid task type value: ${type}`);
    }
    return type;
  }

  if ('exclusive' in type) return TaskType.Exclusive;
  if ('collaborative' in type) return TaskType.Collaborative;
  if ('competitive' in type) return TaskType.Competitive;

  throw new Error('Invalid task type format');
}

/**
 * Parses raw Anchor task account data into a typed OnChainTask.
 *
 * @param data - Raw account data from program.account.task.fetch()
 * @returns Parsed OnChainTask with proper TypeScript types
 * @throws Error if data is missing required fields or has invalid values
 *
 * @example
 * ```typescript
 * const rawData = await program.account.task.fetch(taskPda);
 * const task = parseOnChainTask(rawData);
 * console.log(`Task status: ${taskStatusToString(task.status)}`);
 * ```
 */
export function parseOnChainTask(data: unknown): OnChainTask {
  if (!isRawOnChainTask(data)) {
    throw new Error('Invalid task data: missing required fields');
  }

  return {
    taskId: toUint8Array(data.taskId),
    creator: data.creator,
    requiredCapabilities: BigInt(data.requiredCapabilities.toString()),
    description: toUint8Array(data.description),
    constraintHash: toUint8Array(data.constraintHash),
    rewardAmount: BigInt(data.rewardAmount.toString()),
    maxWorkers: data.maxWorkers,
    currentWorkers: data.currentWorkers,
    status: parseTaskStatus(data.status),
    taskType: parseTaskType(data.taskType),
    createdAt: data.createdAt.toNumber(),
    deadline: data.deadline.toNumber(),
    completedAt: data.completedAt.toNumber(),
    escrow: data.escrow,
    result: toUint8Array(data.result),
    completions: data.completions,
    requiredCompletions: data.requiredCompletions,
    bump: data.bump,
  };
}

/**
 * Parses raw Anchor task claim account data into a typed OnChainTaskClaim.
 *
 * @param data - Raw account data from program.account.taskClaim.fetch()
 * @returns Parsed OnChainTaskClaim with proper TypeScript types
 * @throws Error if data is missing required fields or has invalid values
 *
 * @example
 * ```typescript
 * const rawData = await program.account.taskClaim.fetch(claimPda);
 * const claim = parseOnChainTaskClaim(rawData);
 * console.log(`Claim completed: ${claim.isCompleted}`);
 * ```
 */
export function parseOnChainTaskClaim(data: unknown): OnChainTaskClaim {
  if (!isRawOnChainTaskClaim(data)) {
    throw new Error('Invalid task claim data: missing required fields');
  }

  return {
    task: data.task,
    worker: data.worker,
    claimedAt: data.claimedAt.toNumber(),
    expiresAt: data.expiresAt.toNumber(),
    completedAt: data.completedAt.toNumber(),
    proofHash: toUint8Array(data.proofHash),
    resultData: toUint8Array(data.resultData),
    isCompleted: data.isCompleted,
    isValidated: data.isValidated,
    rewardPaid: BigInt(data.rewardPaid.toString()),
    bump: data.bump,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if a task is a private task (has non-zero constraint hash).
 * Private tasks require ZK proof submission via complete_task_private.
 *
 * @param task - Parsed on-chain task
 * @returns True if the task has a non-zero constraint hash
 *
 * @example
 * ```typescript
 * if (isPrivateTask(task)) {
 *   // Generate ZK proof for private completion
 * }
 * ```
 */
export function isPrivateTask(task: OnChainTask): boolean {
  return task.constraintHash.some((byte) => byte !== 0);
}

/**
 * Checks if a task has expired based on its deadline.
 * Tasks with deadline === 0 never expire.
 *
 * @param task - Parsed on-chain task
 * @param now - Current Unix timestamp in seconds (defaults to now)
 * @returns True if the task's deadline has passed
 *
 * @example
 * ```typescript
 * if (isTaskExpired(task)) {
 *   console.log('Task deadline has passed');
 * }
 * ```
 */
export function isTaskExpired(task: OnChainTask, now?: number): boolean {
  if (task.deadline === 0) return false;
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  return currentTime > task.deadline;
}

/**
 * Checks if a task can be claimed by a worker.
 * A task is claimable if it is Open and has capacity for more workers.
 *
 * @param task - Parsed on-chain task
 * @returns True if the task is open and has worker capacity
 *
 * @example
 * ```typescript
 * if (isTaskClaimable(task)) {
 *   await claimTask(task);
 * }
 * ```
 */
export function isTaskClaimable(task: OnChainTask): boolean {
  return (
    task.status === OnChainTaskStatus.Open &&
    task.currentWorkers < task.maxWorkers
  );
}

/**
 * Checks if a task execution result is a private execution result.
 *
 * @param result - Task execution result to check
 * @returns True if the result contains private proof data
 */
export function isPrivateExecutionResult(
  result: TaskExecutionResult | PrivateTaskExecutionResult,
): result is PrivateTaskExecutionResult {
  return 'proof' in result && 'constraintHash' in result;
}

/**
 * Converts an OnChainTaskStatus to a human-readable string.
 *
 * @param status - Task status value
 * @returns Human-readable status name
 *
 * @example
 * ```typescript
 * taskStatusToString(OnChainTaskStatus.Open); // "Open"
 * taskStatusToString(OnChainTaskStatus.Disputed); // "Disputed"
 * ```
 */
export function taskStatusToString(status: OnChainTaskStatus): string {
  switch (status) {
    case OnChainTaskStatus.Open:
      return 'Open';
    case OnChainTaskStatus.InProgress:
      return 'InProgress';
    case OnChainTaskStatus.PendingValidation:
      return 'PendingValidation';
    case OnChainTaskStatus.Completed:
      return 'Completed';
    case OnChainTaskStatus.Cancelled:
      return 'Cancelled';
    case OnChainTaskStatus.Disputed:
      return 'Disputed';
    default:
      return `Unknown (${status})`;
  }
}

/**
 * Converts a TaskType to a human-readable string.
 *
 * @param type - Task type value
 * @returns Human-readable type name
 *
 * @example
 * ```typescript
 * taskTypeToString(TaskType.Exclusive); // "Exclusive"
 * taskTypeToString(TaskType.Competitive); // "Competitive"
 * ```
 */
export function taskTypeToString(type: TaskType): string {
  switch (type) {
    case TaskType.Exclusive:
      return 'Exclusive';
    case TaskType.Collaborative:
      return 'Collaborative';
    case TaskType.Competitive:
      return 'Competitive';
    default:
      return `Unknown (${type})`;
  }
}

// ============================================================================
// Task Handler & Execution Types
// ============================================================================

/**
 * Context provided to a task handler during execution.
 */
export interface TaskExecutionContext {
  /** The parsed on-chain task data */
  task: OnChainTask;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Claim account PDA */
  claimPda: PublicKey;
  /** Agent ID (32 bytes) */
  agentId: Uint8Array;
  /** Agent PDA address */
  agentPda: PublicKey;
  /** Logger instance */
  logger: Logger;
  /** Abort signal for cancellation support */
  signal: AbortSignal;
}

/**
 * Result of a public task execution.
 * Return from handler for non-ZK tasks.
 */
export interface TaskExecutionResult {
  /** Proof hash (32 bytes) for public completion */
  proofHash: Uint8Array;
  /** Result data (up to 64 bytes, optional) */
  resultData?: Uint8Array;
}

/**
 * Extended execution result for private (ZK-proof) tasks.
 * Identified by the presence of the `proof` field.
 */
export interface PrivateTaskExecutionResult {
  /** Generated ZK proof bytes */
  proof: Uint8Array;
  /** Constraint hash (32 bytes) */
  constraintHash: Uint8Array;
  /** Output commitment (32 bytes) */
  outputCommitment: Uint8Array;
  /** Expected binding (32 bytes) */
  expectedBinding: Uint8Array;
}

/**
 * Handler function for processing a claimed task.
 * Returns either a public or private execution result.
 */
export type TaskHandler = (
  context: TaskExecutionContext,
) => Promise<TaskExecutionResult | PrivateTaskExecutionResult>;

// ============================================================================
// Task Discovery Types
// ============================================================================

/**
 * A task discovered during scanning with relevance metadata.
 */
export interface DiscoveredTask {
  /** The on-chain task data */
  task: OnChainTask;
  /** Relevance score (higher = more relevant) */
  relevanceScore: number;
  /** Whether the agent can claim this task */
  canClaim: boolean;
}

/**
 * Filter configuration for task discovery.
 */
export interface TaskFilterConfig {
  /** Only match tasks requiring these capabilities */
  capabilities?: bigint;
  /** Minimum reward amount in lamports */
  minRewardLamports?: bigint;
  /** Maximum reward amount in lamports */
  maxRewardLamports?: bigint;
  /** Only match these task types */
  taskTypes?: TaskType[];
  /** Minimum seconds remaining before deadline (0 = no buffer check) */
  minDeadlineBufferSeconds?: number;
  /** Only match private (ZK-proof) tasks */
  privateOnly?: boolean;
  /** Only match public (non-ZK) tasks */
  publicOnly?: boolean;
  /** Custom filter function applied after all built-in checks */
  customFilter?: (task: DiscoveredTask) => boolean;
}

/**
 * Scoring function for ranking discovered tasks.
 */
export type TaskScorer = (task: DiscoveredTask) => number;

/**
 * Configuration for task discovery.
 */
export interface TaskDiscoveryConfig {
  /** Filter criteria for task matching */
  filter: TaskFilterConfig;
  /** Scoring function for ranking tasks */
  scorer: TaskScorer;
  /** Maximum number of results to return */
  maxResults: number;
}

// ============================================================================
// Task Operations Types
// ============================================================================

/**
 * Configuration for task claim and completion operations.
 */
export interface TaskOperationsConfig {
  /** Whether to automatically claim discovered tasks */
  autoClaimEnabled: boolean;
  /** Whether to automatically complete tasks after execution */
  autoCompleteEnabled: boolean;
  /** Timeout for claim operations (milliseconds) */
  claimTimeoutMs: number;
  /** Timeout for completion operations (milliseconds) */
  completionTimeoutMs: number;
}

/**
 * Result of a task claim operation.
 */
export interface ClaimResult {
  /** Whether the claim succeeded */
  success: boolean;
  /** Task identifier (32 bytes) */
  taskId: Uint8Array;
  /** Claim PDA address */
  claimPda: PublicKey;
  /** Transaction signature if submitted */
  transactionSignature?: TransactionSignature;
  /** Error message if claim failed */
  error?: string;
}

/**
 * Result of a task completion operation.
 */
export interface CompleteResult {
  /** Whether the completion succeeded */
  success: boolean;
  /** Task identifier (32 bytes) */
  taskId: Uint8Array;
  /** Whether this was a private completion */
  isPrivate: boolean;
  /** Transaction signature if submitted */
  transactionSignature?: TransactionSignature;
  /** Error message if completion failed */
  error?: string;
}

// ============================================================================
// Retry Policy Types
// ============================================================================

/**
 * Configuration for retry behavior with exponential backoff.
 *
 * Delay formula: `min(baseDelayMs * 2^attempt, maxDelayMs)`
 * With jitter (AWS full jitter): `random(0, delay)`
 */
export interface RetryPolicy {
  /** Maximum number of attempts (including the initial attempt). Default: 3 */
  maxAttempts: number;
  /** Base delay in milliseconds for exponential backoff. Default: 1000 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 30000 */
  maxDelayMs: number;
  /** Whether to apply full jitter (random(0, delay)). Default: true */
  jitter: boolean;
}

// ============================================================================
// Backpressure Types
// ============================================================================

/**
 * Configuration for queue-based backpressure between TaskDiscovery and TaskExecutor.
 *
 * When the executor's task queue reaches `highWaterMark`, discovery is paused.
 * When the queue drains to `lowWaterMark`, discovery is resumed.
 * The hysteresis gap between the two thresholds prevents rapid pause/resume oscillation.
 */
export interface BackpressureConfig {
  /** Queue length at which discovery is paused. Default: 100 */
  highWaterMark: number;
  /** Queue length at which discovery is resumed. Default: 25 */
  lowWaterMark: number;
  /** Whether to automatically pause discovery when the queue overflows. Default: true */
  pauseDiscovery: boolean;
}

// ============================================================================
// Dead Letter Queue Types
// ============================================================================

/**
 * Pipeline stage at which the task failed.
 */
export type DeadLetterStage = 'claim' | 'execute' | 'submit';

/**
 * An entry in the dead letter queue, capturing full context of a failed task.
 */
export interface DeadLetterEntry {
  /** Task PDA as base58 string */
  taskPda: string;
  /** The on-chain task data at time of failure */
  task: OnChainTask;
  /** Error message describing the failure */
  error: string;
  /** Optional error code for programmatic matching */
  errorCode?: string;
  /** Unix timestamp (ms) when the task was dead-lettered */
  failedAt: number;
  /** Pipeline stage where the failure occurred */
  stage: DeadLetterStage;
  /** Number of attempts made before failure */
  attempts: number;
  /** Whether this entry is eligible for retry */
  retryable: boolean;
  /** Optional metadata for external consumers */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for the dead letter queue.
 */
export interface DeadLetterQueueConfig {
  /** Maximum number of entries to retain. When exceeded, oldest entries are evicted (FIFO). Default: 1000 */
  maxSize: number;
}

// ============================================================================
// Checkpoint Types
// ============================================================================

/**
 * Pipeline stage recorded in a checkpoint.
 */
export type CheckpointStage = 'claimed' | 'executed' | 'submitted';

/**
 * Snapshot of a task's pipeline progress, persisted after each stage transition.
 * Used by the executor to resume from the last successful stage after a crash.
 */
export interface TaskCheckpoint {
  /** Task account PDA (base58 string) */
  taskPda: string;
  /** Last completed pipeline stage */
  stage: CheckpointStage;
  /** Result of the claim stage (present once stage >= 'claimed') */
  claimResult?: ClaimResult;
  /** Result of execution (present once stage >= 'executed') */
  executionResult?: TaskExecutionResult | PrivateTaskExecutionResult;
  /** Unix timestamp (ms) when the checkpoint was first created */
  createdAt: number;
  /** Unix timestamp (ms) when the checkpoint was last updated */
  updatedAt: number;
}

/**
 * Pluggable persistence backend for checkpoints.
 *
 * The executor calls `save()` after each stage transition, `load()` to check
 * for a specific task, `remove()` after successful submission, and
 * `listPending()` on startup to discover incomplete work.
 */
export interface CheckpointStore {
  /** Persist or update a checkpoint. */
  save(checkpoint: TaskCheckpoint): Promise<void>;
  /** Load a checkpoint by task PDA. Returns null if not found. */
  load(taskPda: string): Promise<TaskCheckpoint | null>;
  /** Remove a checkpoint (called after successful submission or staleness cleanup). */
  remove(taskPda: string): Promise<void>;
  /** List all incomplete checkpoints (for crash recovery on startup). */
  listPending(): Promise<TaskCheckpoint[]>;
}

// ============================================================================
// Task Executor Types
// ============================================================================

/**
 * Operating mode for the task executor.
 */
export type OperatingMode = 'autonomous' | 'batch';

/**
 * A batch task item for batch mode execution.
 */
export interface BatchTaskItem {
  /** Task PDA (if already known) */
  taskPda?: PublicKey;
  /** Task creator public key (for deriving PDA) */
  creator?: PublicKey;
  /** Task ID (for deriving PDA along with creator) */
  taskId?: Uint8Array;
}

/**
 * Full configuration for the task executor.
 */
export interface TaskExecutorConfig {
  /** TaskOperations instance for on-chain interactions */
  operations: TaskOperations;
  /** Task handler function for executing claimed tasks */
  handler: TaskHandler;
  /** Operating mode (default: 'autonomous') */
  mode?: OperatingMode;
  /** Maximum concurrent tasks (default: 1) */
  maxConcurrentTasks?: number;
  /** TaskDiscovery instance (required for autonomous mode) */
  discovery?: TaskDiscovery;
  /** Agent ID (32 bytes) */
  agentId: Uint8Array;
  /** Agent PDA address */
  agentPda: PublicKey;
  /** Logger instance */
  logger?: Logger;
  /** Batch tasks (for batch mode) */
  batchTasks?: BatchTaskItem[];
  /** Per-task execution timeout in milliseconds (default: 300_000 = 5 min). Set to 0 to disable. */
  taskTimeoutMs?: number;
  /** Buffer in milliseconds before claim deadline to trigger abort (default: 30_000 = 30s). Set to 0 to disable. */
  claimExpiryBufferMs?: number;
  /** Retry policy for transient failures in claim and submit stages. Handler execution is NOT retried. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Backpressure configuration for controlling discovery rate based on queue depth. */
  backpressure?: Partial<BackpressureConfig>;
  /** Dead letter queue configuration. When provided, failed tasks are captured for inspection and retry. */
  deadLetterQueue?: Partial<DeadLetterQueueConfig>;
  /** Checkpoint store for durable execution. When provided, pipeline progress is persisted and recovered on restart. */
  checkpointStore?: CheckpointStore;
}

/**
 * Current status snapshot of the task executor.
 */
export interface TaskExecutorStatus {
  /** Whether the executor is currently running */
  running: boolean;
  /** Operating mode */
  mode: OperatingMode;
  /** Total tasks discovered */
  tasksDiscovered: number;
  /** Total tasks successfully claimed */
  tasksClaimed: number;
  /** Tasks currently being processed */
  tasksInProgress: number;
  /** Total tasks successfully completed */
  tasksCompleted: number;
  /** Total tasks that failed during execution */
  tasksFailed: number;
  /** Total claim failures */
  claimsFailed: number;
  /** Total submit failures */
  submitsFailed: number;
  /** Total claim retry attempts */
  claimRetries: number;
  /** Total submit retry attempts */
  submitRetries: number;
  /** Timestamp when the executor was started (null if not started) */
  startedAt: number | null;
  /** Milliseconds the executor has been running */
  uptimeMs: number;
  /** Current number of tasks waiting in the queue */
  queueSize: number;
  /** Whether backpressure is currently active (discovery paused due to queue overflow) */
  backpressureActive: boolean;
}

/**
 * Event callbacks for the task executor lifecycle.
 */
export interface TaskExecutorEvents {
  /** Called when a new task is discovered */
  onTaskDiscovered?: (task: TaskDiscoveryResult) => void;
  /** Called when a task is successfully claimed */
  onTaskClaimed?: (claimResult: ClaimResult) => void;
  /** Called when handler execution starts */
  onTaskExecutionStarted?: (context: TaskExecutionContext) => void;
  /** Called when a task is successfully completed (submitted on-chain) */
  onTaskCompleted?: (completeResult: CompleteResult) => void;
  /** Called when a task execution fails */
  onTaskFailed?: (error: Error, taskPda: PublicKey) => void;
  /** Called when a claim attempt fails */
  onClaimFailed?: (error: Error, taskPda: PublicKey) => void;
  /** Called when a submit attempt fails */
  onSubmitFailed?: (error: Error, taskPda: PublicKey) => void;
  /** Called when a task execution times out */
  onTaskTimeout?: (error: Error, taskPda: PublicKey) => void;
  /** Called when a task's claim deadline is about to expire */
  onClaimExpiring?: (error: Error, taskPda: PublicKey) => void;
  /** Called when backpressure is activated (queue reached high-water mark, discovery paused) */
  onBackpressureActivated?: () => void;
  /** Called when backpressure is released (queue drained to low-water mark, discovery resumed) */
  onBackpressureReleased?: () => void;
  /** Called when a failed task is added to the dead letter queue */
  onDeadLettered?: (entry: DeadLetterEntry) => void;
}
