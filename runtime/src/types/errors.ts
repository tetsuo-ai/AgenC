/**
 * Error types and utilities for @agenc/runtime
 *
 * Provides custom runtime error classes, complete Anchor error code mapping,
 * and helper functions for error handling in AgenC applications.
 */

import type { PublicKey } from '@solana/web3.js';

// ============================================================================
// Runtime Error Codes
// ============================================================================

/**
 * String error codes for runtime-specific errors.
 * These are distinct from Anchor program errors.
 */
export const RuntimeErrorCodes = {
  /** Agent is not registered in the protocol */
  AGENT_NOT_REGISTERED: 'AGENT_NOT_REGISTERED',
  /** Agent is already registered */
  AGENT_ALREADY_REGISTERED: 'AGENT_ALREADY_REGISTERED',
  /** Input validation failed */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Rate limit exceeded */
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  /** Insufficient stake for operation */
  INSUFFICIENT_STAKE: 'INSUFFICIENT_STAKE',
  /** Agent has active tasks preventing operation */
  ACTIVE_TASKS_ERROR: 'ACTIVE_TASKS_ERROR',
  /** Agent has pending dispute votes */
  PENDING_DISPUTE_VOTES: 'PENDING_DISPUTE_VOTES',
  /** Agent has recent vote activity */
  RECENT_VOTE_ACTIVITY: 'RECENT_VOTE_ACTIVITY',
  /** Task not found by PDA */
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  /** Task is not claimable */
  TASK_NOT_CLAIMABLE: 'TASK_NOT_CLAIMABLE',
  /** Task execution failed locally */
  TASK_EXECUTION_FAILED: 'TASK_EXECUTION_FAILED',
  /** Task result submission failed on-chain */
  TASK_SUBMISSION_FAILED: 'TASK_SUBMISSION_FAILED',
  /** Executor state machine is in an invalid state */
  EXECUTOR_STATE_ERROR: 'EXECUTOR_STATE_ERROR',
  /** Task execution timed out */
  TASK_TIMEOUT: 'TASK_TIMEOUT',
  /** Claim deadline expired or about to expire */
  CLAIM_EXPIRED: 'CLAIM_EXPIRED',
  /** All retry attempts exhausted */
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  /** LLM provider returned an error */
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  /** LLM provider rate limit exceeded */
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  /** Failed to convert LLM response to output */
  LLM_RESPONSE_CONVERSION: 'LLM_RESPONSE_CONVERSION',
  /** LLM tool call failed */
  LLM_TOOL_CALL_ERROR: 'LLM_TOOL_CALL_ERROR',
  /** LLM request timed out */
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  /** Memory backend operation failure */
  MEMORY_BACKEND_ERROR: 'MEMORY_BACKEND_ERROR',
  /** Memory backend connection failure or missing dependency */
  MEMORY_CONNECTION_ERROR: 'MEMORY_CONNECTION_ERROR',
  /** Memory serialization/deserialization failure */
  MEMORY_SERIALIZATION_ERROR: 'MEMORY_SERIALIZATION_ERROR',
  /** ZK proof generation failed */
  PROOF_GENERATION_ERROR: 'PROOF_GENERATION_ERROR',
  /** ZK proof verification failed */
  PROOF_VERIFICATION_ERROR: 'PROOF_VERIFICATION_ERROR',
  /** Proof cache operation failed */
  PROOF_CACHE_ERROR: 'PROOF_CACHE_ERROR',
  /** Dispute not found by PDA */
  DISPUTE_NOT_FOUND: 'DISPUTE_NOT_FOUND',
  /** Dispute vote operation failed */
  DISPUTE_VOTE_ERROR: 'DISPUTE_VOTE_ERROR',
  /** Dispute resolution operation failed */
  DISPUTE_RESOLUTION_ERROR: 'DISPUTE_RESOLUTION_ERROR',
  /** Dispute slash operation failed */
  DISPUTE_SLASH_ERROR: 'DISPUTE_SLASH_ERROR',
} as const;

/** Union type of all runtime error code values */
export type RuntimeErrorCode = (typeof RuntimeErrorCodes)[keyof typeof RuntimeErrorCodes];

// ============================================================================
// Anchor Error Codes (78 codes: 6000-6077)
// ============================================================================

/**
 * Numeric error codes matching the Anchor program's CoordinationError enum.
 * Codes are organized by category as defined in programs/agenc-coordination/src/errors.rs
 */
export const AnchorErrorCodes = {
  // Agent errors (6000-6007)
  /** Agent is already registered */
  AgentAlreadyRegistered: 6000,
  /** Agent not found */
  AgentNotFound: 6001,
  /** Agent is not active */
  AgentNotActive: 6002,
  /** Agent has insufficient capabilities */
  InsufficientCapabilities: 6003,
  /** Agent has reached maximum active tasks */
  MaxActiveTasksReached: 6004,
  /** Agent has active tasks and cannot be deregistered */
  AgentHasActiveTasks: 6005,
  /** Only the agent authority can perform this action */
  UnauthorizedAgent: 6006,
  /** Agent registration required to create tasks */
  AgentRegistrationRequired: 6007,

  // Task errors (6008-6023)
  /** Task not found */
  TaskNotFound: 6008,
  /** Task is not open for claims */
  TaskNotOpen: 6009,
  /** Task has reached maximum workers */
  TaskFullyClaimed: 6010,
  /** Task has expired */
  TaskExpired: 6011,
  /** Task deadline has not passed */
  TaskNotExpired: 6012,
  /** Task deadline has passed */
  DeadlinePassed: 6013,
  /** Task is not in progress */
  TaskNotInProgress: 6014,
  /** Task is already completed */
  TaskAlreadyCompleted: 6015,
  /** Task cannot be cancelled */
  TaskCannotBeCancelled: 6016,
  /** Only the task creator can perform this action */
  UnauthorizedTaskAction: 6017,
  /** Invalid creator */
  InvalidCreator: 6018,
  /** Invalid task type */
  InvalidTaskType: 6019,
  /** Competitive task already completed by another worker */
  CompetitiveTaskAlreadyWon: 6020,
  /** Task has no workers */
  NoWorkers: 6021,
  /** Proof constraint hash does not match task's stored constraint hash */
  ConstraintHashMismatch: 6022,
  /** Task is not a private task (no constraint hash set) */
  NotPrivateTask: 6023,

  // Claim errors (6024-6032)
  /** Worker has already claimed this task */
  AlreadyClaimed: 6024,
  /** Worker has not claimed this task */
  NotClaimed: 6025,
  /** Claim has already been completed */
  ClaimAlreadyCompleted: 6026,
  /** Claim has not expired yet */
  ClaimNotExpired: 6027,
  /** Invalid proof of work */
  InvalidProof: 6028,
  /** ZK proof verification failed */
  ZkVerificationFailed: 6029,
  /** Invalid proof size - expected 388 bytes for Groth16 */
  InvalidProofSize: 6030,
  /** Invalid proof binding: expected_binding cannot be all zeros */
  InvalidProofBinding: 6031,
  /** Invalid output commitment: output_commitment cannot be all zeros */
  InvalidOutputCommitment: 6032,

  // Dispute errors (6033-6047)
  /** Dispute is not active */
  DisputeNotActive: 6033,
  /** Voting period has ended */
  VotingEnded: 6034,
  /** Voting period has not ended */
  VotingNotEnded: 6035,
  /** Already voted on this dispute */
  AlreadyVoted: 6036,
  /** Not authorized to vote (not an arbiter) */
  NotArbiter: 6037,
  /** Insufficient votes to resolve */
  InsufficientVotes: 6038,
  /** Dispute has already been resolved */
  DisputeAlreadyResolved: 6039,
  /** Only protocol authority or dispute initiator can resolve disputes */
  UnauthorizedResolver: 6040,
  /** Agent has active dispute votes pending resolution */
  ActiveDisputeVotes: 6041,
  /** Agent must wait 24 hours after voting before deregistering */
  RecentVoteActivity: 6042,
  /** Insufficient dispute evidence provided */
  InsufficientEvidence: 6043,
  /** Dispute evidence exceeds maximum allowed length */
  EvidenceTooLong: 6044,
  /** Dispute has not expired */
  DisputeNotExpired: 6045,
  /** Dispute slashing already applied */
  SlashAlreadyApplied: 6046,
  /** Dispute has not been resolved */
  DisputeNotResolved: 6047,

  // State errors (6048-6050)
  /** State version mismatch (concurrent modification) */
  VersionMismatch: 6048,
  /** State key already exists */
  StateKeyExists: 6049,
  /** State not found */
  StateNotFound: 6050,

  // Protocol errors (6051-6061)
  /** Protocol is already initialized */
  ProtocolAlreadyInitialized: 6051,
  /** Protocol is not initialized */
  ProtocolNotInitialized: 6052,
  /** Invalid protocol fee (must be <= 1000 bps) */
  InvalidProtocolFee: 6053,
  /** Invalid dispute threshold */
  InvalidDisputeThreshold: 6054,
  /** Insufficient stake for arbiter registration */
  InsufficientStake: 6055,
  /** Invalid multisig threshold */
  MultisigInvalidThreshold: 6056,
  /** Invalid multisig signer configuration */
  MultisigInvalidSigners: 6057,
  /** Not enough multisig signers */
  MultisigNotEnoughSigners: 6058,
  /** Duplicate multisig signer provided */
  MultisigDuplicateSigner: 6059,
  /** Multisig signer cannot be default pubkey */
  MultisigDefaultSigner: 6060,
  /** Multisig signer account not owned by System Program */
  MultisigSignerNotSystemOwned: 6061,

  // General errors (6062-6068)
  /** Invalid input parameter */
  InvalidInput: 6062,
  /** Arithmetic overflow */
  ArithmeticOverflow: 6063,
  /** Vote count overflow */
  VoteOverflow: 6064,
  /** Insufficient funds */
  InsufficientFunds: 6065,
  /** Account data is corrupted */
  CorruptedData: 6066,
  /** String too long */
  StringTooLong: 6067,
  /** Account owner validation failed: account not owned by this program */
  InvalidAccountOwner: 6068,

  // Rate limiting errors (6069-6071)
  /** Rate limit exceeded: maximum actions per 24h window reached */
  RateLimitExceeded: 6069,
  /** Cooldown period has not elapsed since last action */
  CooldownNotElapsed: 6070,
  /** Insufficient stake to initiate dispute */
  InsufficientStakeForDispute: 6071,

  // Version/upgrade errors (6072-6077)
  /** Protocol version mismatch: account version incompatible with current program */
  VersionMismatchProtocol: 6072,
  /** Account version too old: migration required */
  AccountVersionTooOld: 6073,
  /** Account version too new: program upgrade required */
  AccountVersionTooNew: 6074,
  /** Migration not allowed: invalid source version */
  InvalidMigrationSource: 6075,
  /** Migration not allowed: invalid target version */
  InvalidMigrationTarget: 6076,
  /** Only upgrade authority can perform this action */
  UnauthorizedUpgrade: 6077,
} as const;

/** Union type of all Anchor error code values */
export type AnchorErrorCode = (typeof AnchorErrorCodes)[keyof typeof AnchorErrorCodes];

/** Union type of all Anchor error names */
export type AnchorErrorName = keyof typeof AnchorErrorCodes;

// ============================================================================
// Error Messages Mapping
// ============================================================================

/** Human-readable messages for each Anchor error code */
const AnchorErrorMessages: Record<AnchorErrorCode, string> = {
  6000: 'Agent is already registered',
  6001: 'Agent not found',
  6002: 'Agent is not active',
  6003: 'Agent has insufficient capabilities',
  6004: 'Agent has reached maximum active tasks',
  6005: 'Agent has active tasks and cannot be deregistered',
  6006: 'Only the agent authority can perform this action',
  6007: 'Agent registration required to create tasks',
  6008: 'Task not found',
  6009: 'Task is not open for claims',
  6010: 'Task has reached maximum workers',
  6011: 'Task has expired',
  6012: 'Task deadline has not passed',
  6013: 'Task deadline has passed',
  6014: 'Task is not in progress',
  6015: 'Task is already completed',
  6016: 'Task cannot be cancelled',
  6017: 'Only the task creator can perform this action',
  6018: 'Invalid creator',
  6019: 'Invalid task type',
  6020: 'Competitive task already completed by another worker',
  6021: 'Task has no workers',
  6022: "Proof constraint hash does not match task's stored constraint hash",
  6023: 'Task is not a private task (no constraint hash set)',
  6024: 'Worker has already claimed this task',
  6025: 'Worker has not claimed this task',
  6026: 'Claim has already been completed',
  6027: 'Claim has not expired yet',
  6028: 'Invalid proof of work',
  6029: 'ZK proof verification failed',
  6030: 'Invalid proof size - expected 388 bytes for Groth16',
  6031: 'Invalid proof binding: expected_binding cannot be all zeros',
  6032: 'Invalid output commitment: output_commitment cannot be all zeros',
  6033: 'Dispute is not active',
  6034: 'Voting period has ended',
  6035: 'Voting period has not ended',
  6036: 'Already voted on this dispute',
  6037: 'Not authorized to vote (not an arbiter)',
  6038: 'Insufficient votes to resolve',
  6039: 'Dispute has already been resolved',
  6040: 'Only protocol authority or dispute initiator can resolve disputes',
  6041: 'Agent has active dispute votes pending resolution',
  6042: 'Agent must wait 24 hours after voting before deregistering',
  6043: 'Insufficient dispute evidence provided',
  6044: 'Dispute evidence exceeds maximum allowed length',
  6045: 'Dispute has not expired',
  6046: 'Dispute slashing already applied',
  6047: 'Dispute has not been resolved',
  6048: 'State version mismatch (concurrent modification)',
  6049: 'State key already exists',
  6050: 'State not found',
  6051: 'Protocol is already initialized',
  6052: 'Protocol is not initialized',
  6053: 'Invalid protocol fee (must be <= 1000 bps)',
  6054: 'Invalid dispute threshold',
  6055: 'Insufficient stake for arbiter registration',
  6056: 'Invalid multisig threshold',
  6057: 'Invalid multisig signer configuration',
  6058: 'Not enough multisig signers',
  6059: 'Duplicate multisig signer provided',
  6060: 'Multisig signer cannot be default pubkey',
  6061: 'Multisig signer account not owned by System Program',
  6062: 'Invalid input parameter',
  6063: 'Arithmetic overflow',
  6064: 'Vote count overflow',
  6065: 'Insufficient funds',
  6066: 'Account data is corrupted',
  6067: 'String too long',
  6068: 'Account owner validation failed: account not owned by this program',
  6069: 'Rate limit exceeded: maximum actions per 24h window reached',
  6070: 'Cooldown period has not elapsed since last action',
  6071: 'Insufficient stake to initiate dispute',
  6072: 'Protocol version mismatch: account version incompatible with current program',
  6073: 'Account version too old: migration required',
  6074: 'Account version too new: program upgrade required',
  6075: 'Migration not allowed: invalid source version',
  6076: 'Migration not allowed: invalid target version',
  6077: 'Only upgrade authority can perform this action',
};

// ============================================================================
// Base Runtime Error Class
// ============================================================================

/**
 * Base class for all runtime errors.
 *
 * @example
 * ```typescript
 * try {
 *   await runtime.registerAgent(config);
 * } catch (err) {
 *   if (err instanceof RuntimeError) {
 *     console.log(`Runtime error: ${err.code} - ${err.message}`);
 *   }
 * }
 * ```
 */
export class RuntimeError extends Error {
  /** The error code identifying this error type */
  public readonly code: RuntimeErrorCode;

  constructor(message: string, code: RuntimeErrorCode) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    // Maintain proper stack trace in V8 environments.
    // Using this.constructor ensures subclass constructors are hidden from the
    // stack, making the redundant captureStackTrace calls in subclasses unnecessary.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ============================================================================
// Specific Runtime Error Classes
// ============================================================================

/**
 * Error thrown when an agent is not registered in the protocol.
 *
 * @example
 * ```typescript
 * if (!agent.isRegistered) {
 *   throw new AgentNotRegisteredError();
 * }
 * ```
 */
export class AgentNotRegisteredError extends RuntimeError {
  constructor() {
    super('Agent is not registered in the protocol', RuntimeErrorCodes.AGENT_NOT_REGISTERED);
    this.name = 'AgentNotRegisteredError';
  }
}

/**
 * Error thrown when attempting to register an agent that already exists.
 *
 * @example
 * ```typescript
 * const existing = await getAgent(agentId);
 * if (existing) {
 *   throw new AgentAlreadyRegisteredError(agentId);
 * }
 * ```
 */
export class AgentAlreadyRegisteredError extends RuntimeError {
  /** The ID of the agent that is already registered */
  public readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent "${agentId}" is already registered`, RuntimeErrorCodes.AGENT_ALREADY_REGISTERED);
    this.name = 'AgentAlreadyRegisteredError';
    this.agentId = agentId;
  }
}

/**
 * Error thrown when input validation fails.
 *
 * @example
 * ```typescript
 * if (!isValidEndpoint(endpoint)) {
 *   throw new ValidationError('Invalid endpoint URL format');
 * }
 * ```
 */
export class ValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.VALIDATION_ERROR);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when a rate limit is exceeded.
 *
 * @example
 * ```typescript
 * if (taskCount >= maxTasksPer24h) {
 *   throw new RateLimitError('task_creation', cooldownEnd);
 * }
 * ```
 */
export class RateLimitError extends RuntimeError {
  /** The type of rate limit that was exceeded */
  public readonly limitType: string;
  /** When the cooldown period ends */
  public readonly cooldownEnds: Date;

  constructor(limitType: string, cooldownEnds: Date) {
    super(
      `Rate limit exceeded for "${limitType}". Cooldown ends at ${cooldownEnds.toISOString()}`,
      RuntimeErrorCodes.RATE_LIMIT_ERROR
    );
    this.name = 'RateLimitError';
    this.limitType = limitType;
    this.cooldownEnds = cooldownEnds;
  }
}

/**
 * Error thrown when an agent has insufficient stake for an operation.
 *
 * @example
 * ```typescript
 * if (currentStake < requiredStake) {
 *   throw new InsufficientStakeError(requiredStake, currentStake);
 * }
 * ```
 */
export class InsufficientStakeError extends RuntimeError {
  /** The required stake amount in lamports */
  public readonly required: bigint;
  /** The available stake amount in lamports */
  public readonly available: bigint;

  constructor(required: bigint, available: bigint) {
    super(
      `Insufficient stake: required ${required} lamports, available ${available} lamports`,
      RuntimeErrorCodes.INSUFFICIENT_STAKE
    );
    this.name = 'InsufficientStakeError';
    this.required = required;
    this.available = available;
  }
}

/**
 * Error thrown when an agent has active tasks preventing an operation.
 *
 * @example
 * ```typescript
 * if (agent.activeTasks > 0) {
 *   throw new ActiveTasksError(agent.activeTasks);
 * }
 * ```
 */
export class ActiveTasksError extends RuntimeError {
  /** The number of active tasks */
  public readonly activeTaskCount: number;

  constructor(activeTaskCount: number) {
    super(
      `Agent has ${activeTaskCount} active ${activeTaskCount === 1 ? 'task' : 'tasks'} and cannot perform this operation`,
      RuntimeErrorCodes.ACTIVE_TASKS_ERROR
    );
    this.name = 'ActiveTasksError';
    this.activeTaskCount = activeTaskCount;
  }
}

/**
 * Error thrown when an agent has pending dispute votes.
 *
 * @example
 * ```typescript
 * if (pendingVotes > 0) {
 *   throw new PendingDisputeVotesError(pendingVotes);
 * }
 * ```
 */
export class PendingDisputeVotesError extends RuntimeError {
  /** The number of pending dispute votes */
  public readonly voteCount: number;

  constructor(voteCount: number) {
    super(
      `Agent has ${voteCount} pending dispute ${voteCount === 1 ? 'vote' : 'votes'} that must be resolved first`,
      RuntimeErrorCodes.PENDING_DISPUTE_VOTES
    );
    this.name = 'PendingDisputeVotesError';
    this.voteCount = voteCount;
  }
}

/**
 * Error thrown when an agent has recent vote activity.
 *
 * @example
 * ```typescript
 * const waitPeriod = 24 * 60 * 60 * 1000; // 24 hours
 * if (Date.now() - lastVote.getTime() < waitPeriod) {
 *   throw new RecentVoteActivityError(lastVote);
 * }
 * ```
 */
export class RecentVoteActivityError extends RuntimeError {
  /** The timestamp of the last vote */
  public readonly lastVoteTimestamp: Date;

  constructor(lastVoteTimestamp: Date) {
    super(
      `Agent must wait 24 hours after voting before performing this operation. Last vote: ${lastVoteTimestamp.toISOString()}`,
      RuntimeErrorCodes.RECENT_VOTE_ACTIVITY
    );
    this.name = 'RecentVoteActivityError';
    this.lastVoteTimestamp = lastVoteTimestamp;
  }
}

/**
 * Error thrown when a task cannot be found by its PDA.
 *
 * @example
 * ```typescript
 * throw new TaskNotFoundError(taskPda, 'Task account not found on chain');
 * ```
 */
export class TaskNotFoundError extends RuntimeError {
  /** The PDA of the task that was not found */
  public readonly taskPda: PublicKey;

  constructor(taskPda: PublicKey, message?: string) {
    super(message || 'Task not found', RuntimeErrorCodes.TASK_NOT_FOUND);
    this.name = 'TaskNotFoundError';
    this.taskPda = taskPda;
  }
}

/**
 * Error thrown when a task cannot be claimed by the executor.
 *
 * @example
 * ```typescript
 * throw new TaskNotClaimableError(taskPda, 'Task already has maximum workers');
 * ```
 */
export class TaskNotClaimableError extends RuntimeError {
  /** The PDA of the task that could not be claimed */
  public readonly taskPda: PublicKey;
  /** The reason the task is not claimable */
  public readonly reason: string;

  constructor(taskPda: PublicKey, reason: string) {
    super(`Task not claimable: ${reason}`, RuntimeErrorCodes.TASK_NOT_CLAIMABLE);
    this.name = 'TaskNotClaimableError';
    this.taskPda = taskPda;
    this.reason = reason;
  }
}

/**
 * Error thrown when task execution fails locally.
 *
 * @example
 * ```typescript
 * throw new TaskExecutionError(taskPda, 'Circuit generation failed');
 * ```
 */
export class TaskExecutionError extends RuntimeError {
  /** The PDA of the task that failed execution */
  public readonly taskPda: PublicKey;
  /** The cause of the execution failure */
  public readonly cause: string;

  constructor(taskPda: PublicKey, cause: string) {
    super(`Task execution failed: ${cause}`, RuntimeErrorCodes.TASK_EXECUTION_FAILED);
    this.name = 'TaskExecutionError';
    this.taskPda = taskPda;
    this.cause = cause;
  }
}

/**
 * Error thrown when task result submission fails on-chain.
 *
 * @example
 * ```typescript
 * throw new TaskSubmissionError(taskPda, 'Proof verification failed on-chain');
 * ```
 */
export class TaskSubmissionError extends RuntimeError {
  /** The PDA of the task whose submission failed */
  public readonly taskPda: PublicKey;
  /** The cause of the submission failure */
  public readonly cause: string;

  constructor(taskPda: PublicKey, cause: string) {
    super(`Task submission failed: ${cause}`, RuntimeErrorCodes.TASK_SUBMISSION_FAILED);
    this.name = 'TaskSubmissionError';
    this.taskPda = taskPda;
    this.cause = cause;
  }
}

/**
 * Error thrown when the executor state machine is in an invalid state.
 *
 * @example
 * ```typescript
 * throw new ExecutorStateError('Cannot execute task: executor not initialized');
 * ```
 */
export class ExecutorStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.EXECUTOR_STATE_ERROR);
    this.name = 'ExecutorStateError';
  }
}

/**
 * Error thrown when a task handler exceeds its execution timeout.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onTaskTimeout: (error, taskPda) => {
 *     console.log(`Task ${taskPda.toBase58()} timed out after ${error.timeoutMs}ms`);
 *   },
 * });
 * ```
 */
export class TaskTimeoutError extends RuntimeError {
  /** The timeout duration in milliseconds that was exceeded */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Task execution timed out after ${timeoutMs}ms`,
      RuntimeErrorCodes.TASK_TIMEOUT,
    );
    this.name = 'TaskTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a task's on-chain claim deadline expires or is about to expire.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onClaimExpiring: (error, taskPda) => {
 *     console.log(`Claim for ${taskPda.toBase58()} expiring: ${error.message}`);
 *   },
 * });
 * ```
 */
export class ClaimExpiredError extends RuntimeError {
  /** The claim expiry timestamp (Unix seconds) */
  public readonly expiresAt: number;
  /** The buffer in milliseconds that was configured */
  public readonly bufferMs: number;

  constructor(expiresAt: number, bufferMs: number) {
    super(
      `Claim deadline expiring: expires_at=${expiresAt}, buffer=${bufferMs}ms`,
      RuntimeErrorCodes.CLAIM_EXPIRED,
    );
    this.name = 'ClaimExpiredError';
    this.expiresAt = expiresAt;
    this.bufferMs = bufferMs;
  }
}

/**
 * Error thrown when all retry attempts have been exhausted for a pipeline stage.
 *
 * @example
 * ```typescript
 * executor.on({
 *   onTaskFailed: (error, taskPda) => {
 *     if (error instanceof RetryExhaustedError) {
 *       console.log(`Retries exhausted for ${error.stage} after ${error.attempts} attempts`);
 *     }
 *   },
 * });
 * ```
 */
export class RetryExhaustedError extends RuntimeError {
  /** The pipeline stage that exhausted retries */
  public readonly stage: string;
  /** The number of attempts made */
  public readonly attempts: number;
  /** The last error that caused the final retry to fail */
  public readonly lastError: Error;

  constructor(stage: string, attempts: number, lastError: Error) {
    super(
      `Retry exhausted for ${stage} after ${attempts} attempts: ${lastError.message}`,
      RuntimeErrorCodes.RETRY_EXHAUSTED,
    );
    this.name = 'RetryExhaustedError';
    this.stage = stage;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// ============================================================================
// Parsed Anchor Error Type
// ============================================================================

/**
 * Structured representation of a parsed Anchor error.
 */
export interface ParsedAnchorError {
  /** The numeric error code */
  code: AnchorErrorCode;
  /** The error name (e.g., 'AgentNotFound') */
  name: AnchorErrorName;
  /** Human-readable error message */
  message: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Reverse lookup map from code to name */
const codeToNameMap: Map<number, AnchorErrorName> = new Map(
  (Object.entries(AnchorErrorCodes) as [AnchorErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ])
);

/**
 * Check if an error matches a specific Anchor error code.
 *
 * Handles multiple error formats:
 * - Direct error code property
 * - Nested errorCode object
 * - Transaction logs containing error code
 * - Error message containing error code
 *
 * @example
 * ```typescript
 * try {
 *   await program.methods.claimTask().rpc();
 * } catch (err) {
 *   if (isAnchorError(err, AnchorErrorCodes.AlreadyClaimed)) {
 *     console.log('Task already claimed by this worker');
 *   } else if (isAnchorError(err, AnchorErrorCodes.TaskNotOpen)) {
 *     console.log('Task is not open for claims');
 *   }
 * }
 * ```
 *
 * @param error - The error to check
 * @param code - The Anchor error code to match
 * @returns True if the error matches the specified code
 */
export function isAnchorError(error: unknown, code: AnchorErrorCode): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check direct code property
  if ('code' in err && err.code === code) {
    return true;
  }

  // Check Anchor SDK errorCode format: { errorCode: { code: string, number: number } }
  if ('errorCode' in err && typeof err.errorCode === 'object' && err.errorCode !== null) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ('number' in errorCode && errorCode.number === code) {
      return true;
    }
  }

  // Check for error.error format (nested error object)
  if ('error' in err && typeof err.error === 'object' && err.error !== null) {
    const innerError = err.error as Record<string, unknown>;
    if ('errorCode' in innerError && typeof innerError.errorCode === 'object') {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ('number' in errorCode && errorCode.number === code) {
        return true;
      }
    }
  }

  // Check transaction logs for error code pattern
  if ('logs' in err && Array.isArray(err.logs)) {
    const errorPattern = new RegExp(`Error Code: \\w+\\. Error Number: ${code}\\.`);
    for (const log of err.logs) {
      if (typeof log === 'string' && errorPattern.test(log)) {
        return true;
      }
    }
  }

  // Check error message for error code
  if ('message' in err && typeof err.message === 'string') {
    // Match patterns like "custom program error: 0x1770" (hex) or "Error Number: 6000"
    const hexCode = `0x${code.toString(16)}`;
    if (
      err.message.includes(`custom program error: ${hexCode}`) ||
      err.message.includes(`Error Number: ${code}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parse an error into a structured Anchor error format.
 *
 * @example
 * ```typescript
 * try {
 *   await program.methods.registerAgent().rpc();
 * } catch (err) {
 *   const parsed = parseAnchorError(err);
 *   if (parsed) {
 *     console.log(`Error ${parsed.code}: ${parsed.name} - ${parsed.message}`);
 *   }
 * }
 * ```
 *
 * @param error - The error to parse
 * @returns Parsed error object if it's an Anchor error, null otherwise
 */
export function parseAnchorError(error: unknown): ParsedAnchorError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const err = error as Record<string, unknown>;
  let code: number | undefined;
  let name: AnchorErrorName | undefined;

  // Try to extract code from various formats

  // Format 1: Direct code property
  if ('code' in err && typeof err.code === 'number') {
    code = err.code;
  }

  // Format 2: Anchor SDK errorCode format
  if ('errorCode' in err && typeof err.errorCode === 'object' && err.errorCode !== null) {
    const errorCode = err.errorCode as Record<string, unknown>;
    if ('number' in errorCode && typeof errorCode.number === 'number') {
      code = errorCode.number;
    }
    if ('code' in errorCode && typeof errorCode.code === 'string') {
      name = errorCode.code as AnchorErrorName;
    }
  }

  // Format 3: Nested error.error format
  if (!code && 'error' in err && typeof err.error === 'object' && err.error !== null) {
    const innerError = err.error as Record<string, unknown>;
    if ('errorCode' in innerError && typeof innerError.errorCode === 'object') {
      const errorCode = innerError.errorCode as Record<string, unknown>;
      if ('number' in errorCode && typeof errorCode.number === 'number') {
        code = errorCode.number;
      }
      if ('code' in errorCode && typeof errorCode.code === 'string') {
        name = errorCode.code as AnchorErrorName;
      }
    }
  }

  // Format 4: Extract from logs
  if (!code && 'logs' in err && Array.isArray(err.logs)) {
    const errorPattern = /Error Code: (\w+)\. Error Number: (\d+)\./;
    for (const log of err.logs) {
      if (typeof log === 'string') {
        const match = log.match(errorPattern);
        if (match) {
          name = match[1] as AnchorErrorName;
          code = parseInt(match[2], 10);
          break;
        }
      }
    }
  }

  // Format 5: Extract from error message
  if (!code && 'message' in err && typeof err.message === 'string') {
    // Match hex pattern: "custom program error: 0x1770"
    const hexMatch = err.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      code = parseInt(hexMatch[1], 16);
    }

    // Match decimal pattern: "Error Number: 6000"
    if (!code) {
      const decMatch = err.message.match(/Error Number: (\d+)/);
      if (decMatch) {
        code = parseInt(decMatch[1], 10);
      }
    }
  }

  // Validate code is in our known range
  if (code === undefined || code < 6000 || code > 6077) {
    return null;
  }

  // Look up name if not already found
  if (!name) {
    name = codeToNameMap.get(code);
  }

  // Final validation
  if (!name || !(name in AnchorErrorCodes)) {
    return null;
  }

  return {
    code: code as AnchorErrorCode,
    name,
    message: AnchorErrorMessages[code as AnchorErrorCode],
  };
}

/**
 * Get the error name for a given Anchor error code.
 *
 * @example
 * ```typescript
 * const name = getAnchorErrorName(6000);
 * console.log(name); // 'AgentAlreadyRegistered'
 * ```
 *
 * @param code - The error code to look up
 * @returns The error name, or undefined if not found
 */
export function getAnchorErrorName(code: number): AnchorErrorName | undefined {
  return codeToNameMap.get(code);
}

/**
 * Get the error message for a given Anchor error code.
 *
 * @example
 * ```typescript
 * const message = getAnchorErrorMessage(6000);
 * console.log(message); // 'Agent is already registered'
 * ```
 *
 * @param code - The error code to look up
 * @returns The error message, or undefined if not found
 */
export function getAnchorErrorMessage(code: AnchorErrorCode): string {
  return AnchorErrorMessages[code];
}

/**
 * Type guard to check if an error is a RuntimeError.
 *
 * @example
 * ```typescript
 * try {
 *   await runtime.doSomething();
 * } catch (err) {
 *   if (isRuntimeError(err)) {
 *     console.log(`Runtime error code: ${err.code}`);
 *   }
 * }
 * ```
 *
 * @param error - The error to check
 * @returns True if the error is a RuntimeError instance
 */
export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}
