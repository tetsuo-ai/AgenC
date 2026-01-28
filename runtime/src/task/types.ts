/**
 * Task type definitions, parsing utilities, and configuration types
 * for the Phase 3 Task Executor.
 *
 * @module
 */

import type { PublicKey, TransactionSignature } from '@solana/web3.js';
import { TaskType } from '../events/types.js';

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
 * Checks if a TaskExecutionResult is a private execution result.
 *
 * @param result - Task execution result to check
 * @returns True if the result contains private proof data
 */
export function isPrivateExecutionResult(
  result: TaskExecutionResult
): result is PrivateTaskExecutionResult {
  return 'proof' in result || 'proofHash' in result;
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
  /** Task identifier (32 bytes) */
  taskId: Uint8Array;
  /** Task account PDA */
  taskPda: PublicKey;
  /** Claim account PDA */
  claimPda: PublicKey;
  /** Whether this is a private (ZK-proof) task */
  isPrivate: boolean;
  /** Task deadline (Unix seconds, 0 = no deadline) */
  deadline: number;
}

/**
 * Result of a task execution.
 */
export interface TaskExecutionResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** Transaction signature if submitted on-chain */
  transactionSignature: TransactionSignature | null;
  /** Error message if execution failed */
  error?: string;
  /** Compute units consumed (if available) */
  gasUsed?: number;
}

/**
 * Extended execution result for private (ZK-proof) tasks.
 */
export interface PrivateTaskExecutionResult extends TaskExecutionResult {
  /** Generated ZK proof */
  proof?: Uint8Array;
  /** Proof hash (32 bytes) */
  proofHash?: Uint8Array;
}

/**
 * Handler function for processing a task.
 */
export type TaskHandler = (task: OnChainTask) => Promise<void>;

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
  minReward?: bigint;
  /** Maximum deadline (Unix seconds) */
  maxDeadline?: number;
  /** Only match these task types */
  taskTypes?: TaskType[];
  /** Exclude private (ZK-proof) tasks */
  excludePrivate?: boolean;
  /** Exclude tasks that are already claimed */
  excludeClaimed?: boolean;
}

/**
 * Scoring function for ranking discovered tasks.
 */
export type TaskScorer = (task: OnChainTask, agentCapabilities: bigint) => number;

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
// Task Executor Types
// ============================================================================

/**
 * Full configuration for the task executor.
 */
export interface TaskExecutorConfig {
  /** Discovery configuration */
  discovery: TaskDiscoveryConfig;
  /** Operations configuration */
  operations: TaskOperationsConfig;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
}

/**
 * Current status of the task executor.
 */
export enum TaskExecutorStatus {
  Idle = 'idle',
  Discovering = 'discovering',
  Claiming = 'claiming',
  Executing = 'executing',
  Completing = 'completing',
  Error = 'error',
}

/**
 * Event callbacks for the task executor lifecycle.
 */
export interface TaskExecutorEvents {
  /** Called when a new task is discovered */
  onTaskDiscovered?: (task: DiscoveredTask) => void;
  /** Called when a task is successfully claimed */
  onTaskClaimed?: (claimResult: ClaimResult) => void;
  /** Called when a task is successfully completed */
  onTaskCompleted?: (completeResult: CompleteResult) => void;
  /** Called when a task execution fails */
  onTaskFailed?: (error: Error, taskId: Uint8Array) => void;
}

/**
 * Mode for discovering tasks.
 */
export enum DiscoveryMode {
  /** Poll for tasks at regular intervals */
  Poll = 'poll',
  /** Subscribe to task creation events */
  Subscribe = 'subscribe',
  /** Combine polling and subscriptions */
  Hybrid = 'hybrid',
}

/**
 * Operating mode for the task executor.
 */
export enum OperatingMode {
  /** All operations require explicit calls */
  Manual = 'manual',
  /** Tasks are discovered automatically, but claim/complete require confirmation */
  SemiAutomatic = 'semi-automatic',
  /** Full automation: discover, claim, execute, complete */
  Automatic = 'automatic',
}
