# AgenC Speculative Execution - Runtime API Specification

> TypeScript interfaces for runtime components of the speculative execution system.

## Table of Contents

1. [Core Types](#core-types)
2. [Configuration Objects](#configuration-objects)
3. [Event Types](#event-types)
4. [Error Types](#error-types)
5. [Runtime Interfaces](#runtime-interfaces)
6. [Utility Types](#utility-types)

---

## Core Types

### SpeculativeCommitmentState

```typescript
/**
 * State machine for speculative commitments.
 * Mirrors on-chain SpeculativeCommitmentStatus enum.
 */
export enum SpeculativeCommitmentState {
  /** Initial state - commitment created, awaiting bond */
  Pending = 0,
  /** Bond deposited, speculation active */
  Active = 1,
  /** Dependent task completed successfully, awaiting finalization */
  PendingFinalization = 2,
  /** Commitment fulfilled successfully, stake released */
  Fulfilled = 3,
  /** Commitment failed, stake slashed */
  Slashed = 4,
  /** Commitment cancelled before activation */
  Cancelled = 5,
  /** Commitment expired without resolution */
  Expired = 6,
}
```

### SpeculativeCommitment

```typescript
/**
 * Represents a speculative commitment made by an agent.
 * 
 * @remarks
 * A speculative commitment is a cryptographic promise that a task's output
 * will satisfy certain constraints. The committing agent stakes tokens as
 * collateral, which are slashed if the commitment proves false.
 */
export interface SpeculativeCommitment {
  /** Unique commitment identifier (derived from PDA) */
  readonly id: PublicKey;
  
  /** ID of the task this commitment is for */
  readonly taskId: number;
  
  /** Agent who made the commitment */
  readonly committer: PublicKey;
  
  /** 
   * Hash of the speculated output.
   * Poseidon hash of the predicted task result.
   * @format 32-byte buffer
   */
  readonly outputHash: Buffer;
  
  /**
   * Cryptographic commitment to the speculation parameters.
   * commit(outputHash, salt, committer) using Poseidon.
   * @format 32-byte buffer
   */
  readonly commitment: Buffer;
  
  /** Amount staked in lamports as collateral */
  readonly stakeAmount: bigint;
  
  /** Current state of the commitment */
  readonly state: SpeculativeCommitmentState;
  
  /** Unix timestamp when commitment was created */
  readonly createdAt: number;
  
  /** Unix timestamp when commitment expires */
  readonly expiresAt: number;
  
  /** Optional: ID of dependent task that relies on this speculation */
  readonly dependentTaskId?: number;
  
  /** Confidence score (0-100) provided by committer */
  readonly confidence: number;
  
  /** Slot number when state last changed */
  readonly lastUpdatedSlot: bigint;
}
```

### DependentTask

```typescript
/**
 * A task that depends on speculative output from another task.
 * 
 * @remarks
 * Dependent tasks can begin execution before their prerequisite tasks complete,
 * based on speculative commitments. If the speculation proves incorrect,
 * the dependent task's results may be invalidated.
 */
export interface DependentTask {
  /** Task ID of the dependent task */
  readonly taskId: number;
  
  /** Task ID of the prerequisite task */
  readonly prerequisiteTaskId: number;
  
  /** Speculative commitment this task relies on */
  readonly commitmentId: PublicKey;
  
  /** 
   * Hash of the speculated input being used.
   * Must match the outputHash from the commitment.
   */
  readonly speculatedInputHash: Buffer;
  
  /** Whether the speculation has been validated */
  readonly speculationValidated: boolean;
  
  /** If invalidated, reason for invalidation */
  readonly invalidationReason?: SpeculationInvalidationReason;
  
  /** Creator of the dependent task */
  readonly creator: PublicKey;
  
  /** Escrow amount for the dependent task */
  readonly escrowLamports: bigint;
}
```

### SpeculationInvalidationReason

```typescript
/**
 * Reasons why a speculative execution was invalidated.
 */
export enum SpeculationInvalidationReason {
  /** Prerequisite task produced different output than speculated */
  OutputMismatch = 0,
  /** Prerequisite task failed or was cancelled */
  PrerequisiteFailed = 1,
  /** Speculative commitment expired */
  CommitmentExpired = 2,
  /** Committer was slashed for fraud */
  CommitterSlashed = 3,
  /** Manual cancellation by dependent task creator */
  ManualCancellation = 4,
}
```

### SlashDistribution

```typescript
/**
 * Distribution of slashed stake to affected parties.
 * 
 * @remarks
 * When a speculative commitment is slashed, the stake is distributed
 * among parties who suffered losses due to the false speculation.
 */
export interface SlashDistribution {
  /** Unique distribution identifier */
  readonly id: PublicKey;
  
  /** Commitment that was slashed */
  readonly commitmentId: PublicKey;
  
  /** Total amount slashed in lamports */
  readonly totalSlashed: bigint;
  
  /** Amount allocated to protocol treasury */
  readonly protocolShare: bigint;
  
  /** Amount allocated to affected dependent task creators */
  readonly affectedPartiesShare: bigint;
  
  /** List of claimants and their shares */
  readonly claimants: SlashClaimant[];
  
  /** Whether distribution has been finalized */
  readonly finalized: boolean;
  
  /** Slot when slash occurred */
  readonly slashSlot: bigint;
}

/**
 * Individual claimant in a slash distribution.
 */
export interface SlashClaimant {
  /** Public key of the claimant */
  readonly address: PublicKey;
  
  /** Amount claimable in lamports */
  readonly amount: bigint;
  
  /** Whether claim has been collected */
  readonly claimed: boolean;
  
  /** Reason for entitlement */
  readonly reason: SlashClaimReason;
}

export enum SlashClaimReason {
  /** Creator of dependent task that was invalidated */
  DependentTaskCreator = 0,
  /** Worker who wasted effort on invalidated task */
  AffectedWorker = 1,
  /** Protocol treasury */
  ProtocolFee = 2,
  /** Whistleblower who reported fraud */
  Whistleblower = 3,
}
```

---

## Configuration Objects

### SpeculationConfig

```typescript
/**
 * Global configuration for the speculation system.
 * 
 * @remarks
 * These parameters are set at protocol level and apply to all
 * speculative commitments. Can be updated by protocol governance.
 */
export interface SpeculationConfig {
  /**
   * Minimum stake required as percentage of dependent task escrow.
   * @default 10 (10%)
   * @min 1
   * @max 100
   */
  readonly minStakePercent: number;
  
  /**
   * Maximum stake allowed in lamports.
   * Prevents excessive concentration risk.
   * @default 100_000_000_000 (100 SOL)
   */
  readonly maxStakeLamports: bigint;
  
  /**
   * Minimum stake required in lamports.
   * @default 10_000_000 (0.01 SOL)
   */
  readonly minStakeLamports: bigint;
  
  /**
   * Maximum commitment duration in seconds.
   * @default 86400 (24 hours)
   */
  readonly maxCommitmentDuration: number;
  
  /**
   * Minimum commitment duration in seconds.
   * @default 300 (5 minutes)
   */
  readonly minCommitmentDuration: number;
  
  /**
   * Grace period in seconds after task completion before finalization.
   * Allows time for fraud proofs.
   * @default 600 (10 minutes)
   */
  readonly finalizationGracePeriod: number;
  
  /**
   * Percentage of slashed stake going to protocol treasury.
   * @default 10 (10%)
   */
  readonly slashProtocolFeePercent: number;
  
  /**
   * Percentage of slashed stake going to whistleblower.
   * @default 20 (20%)
   */
  readonly slashWhistleblowerPercent: number;
  
  /**
   * Whether speculation system is paused.
   * @default false
   */
  readonly paused: boolean;
  
  /**
   * Authority that can update config.
   */
  readonly authority: PublicKey;
}

/**
 * Default speculation configuration values.
 */
export const DEFAULT_SPECULATION_CONFIG: Readonly<SpeculationConfig> = {
  minStakePercent: 10,
  maxStakeLamports: BigInt(100_000_000_000),
  minStakeLamports: BigInt(10_000_000),
  maxCommitmentDuration: 86400,
  minCommitmentDuration: 300,
  finalizationGracePeriod: 600,
  slashProtocolFeePercent: 10,
  slashWhistleblowerPercent: 20,
  paused: false,
  authority: PublicKey.default,
} as const;
```

### CreateCommitmentParams

```typescript
/**
 * Parameters for creating a new speculative commitment.
 */
export interface CreateCommitmentParams {
  /**
   * ID of the task to speculate on.
   * @validation Must be a valid, non-completed task.
   */
  readonly taskId: number;
  
  /**
   * Predicted output hash (Poseidon hash of expected result).
   * @format 32-byte buffer
   * @validation Must be non-zero.
   */
  readonly outputHash: Buffer;
  
  /**
   * Random salt for commitment hiding.
   * @format 32-byte buffer
   * @validation Must be cryptographically random.
   */
  readonly salt: Buffer;
  
  /**
   * Amount to stake in lamports.
   * @validation Must be >= minStakeLamports and <= maxStakeLamports.
   */
  readonly stakeAmount: bigint;
  
  /**
   * Commitment expiration as Unix timestamp.
   * @validation Must be within [minCommitmentDuration, maxCommitmentDuration] from now.
   */
  readonly expiresAt: number;
  
  /**
   * Confidence level (0-100).
   * Higher confidence may affect reputation/rewards.
   * @default 50
   * @min 0
   * @max 100
   */
  readonly confidence?: number;
}

/**
 * Validation rules for CreateCommitmentParams.
 */
export const CREATE_COMMITMENT_VALIDATION = {
  taskId: {
    required: true,
    type: 'number',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  outputHash: {
    required: true,
    type: 'Buffer',
    length: 32,
    nonZero: true,
  },
  salt: {
    required: true,
    type: 'Buffer',
    length: 32,
  },
  stakeAmount: {
    required: true,
    type: 'bigint',
    minRef: 'config.minStakeLamports',
    maxRef: 'config.maxStakeLamports',
  },
  expiresAt: {
    required: true,
    type: 'number',
    futureOnly: true,
  },
  confidence: {
    required: false,
    type: 'number',
    min: 0,
    max: 100,
    default: 50,
  },
} as const;
```

### CreateDependentTaskParams

```typescript
/**
 * Parameters for creating a task that depends on speculative output.
 */
export interface CreateDependentTaskParams {
  /**
   * Standard task description.
   */
  readonly description: string;
  
  /**
   * Escrow amount in lamports.
   */
  readonly escrowLamports: bigint;
  
  /**
   * Task deadline as Unix timestamp.
   */
  readonly deadline: number;
  
  /**
   * ID of the prerequisite task.
   */
  readonly prerequisiteTaskId: number;
  
  /**
   * Speculative commitment to rely on.
   */
  readonly commitmentId: PublicKey;
  
  /**
   * Hash of the speculated input.
   * Must match the commitment's outputHash.
   */
  readonly speculatedInputHash: Buffer;
  
  /**
   * Constraint hash for ZK verification (optional).
   */
  readonly constraintHash?: Buffer;
  
  /**
   * Required agent skills (optional).
   */
  readonly requiredSkills?: string[];
  
  /**
   * Whether to auto-invalidate if speculation fails.
   * @default true
   */
  readonly autoInvalidate?: boolean;
  
  /**
   * Compensation policy if speculation fails.
   * @default 'refund'
   */
  readonly failurePolicy?: SpeculationFailurePolicy;
}

export type SpeculationFailurePolicy = 
  | 'refund'           // Full refund to creator
  | 'partial_refund'   // Partial refund, rest to worker
  | 'worker_keeps'     // Worker keeps payment regardless
  | 'slash_claim';     // Creator claims from slash distribution
```

---

## Event Types

### SpeculationEventType

```typescript
/**
 * Types of events emitted by the speculation system.
 */
export enum SpeculationEventType {
  CommitmentCreated = 'CommitmentCreated',
  CommitmentActivated = 'CommitmentActivated',
  CommitmentFulfilled = 'CommitmentFulfilled',
  CommitmentSlashed = 'CommitmentSlashed',
  CommitmentExpired = 'CommitmentExpired',
  CommitmentCancelled = 'CommitmentCancelled',
  DependentTaskCreated = 'DependentTaskCreated',
  DependentTaskInvalidated = 'DependentTaskInvalidated',
  DependentTaskValidated = 'DependentTaskValidated',
  SlashDistributionCreated = 'SlashDistributionCreated',
  SlashClaimed = 'SlashClaimed',
  ConfigUpdated = 'ConfigUpdated',
}
```

### Event Payloads

```typescript
/**
 * Base event interface for all speculation events.
 */
export interface SpeculationEventBase {
  /** Event type discriminator */
  readonly type: SpeculationEventType;
  /** Slot when event occurred */
  readonly slot: bigint;
  /** Transaction signature */
  readonly signature: string;
  /** Block time (Unix timestamp) */
  readonly blockTime: number;
}

/**
 * Emitted when a new speculative commitment is created.
 */
export interface CommitmentCreatedEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.CommitmentCreated;
  readonly commitmentId: PublicKey;
  readonly taskId: number;
  readonly committer: PublicKey;
  readonly outputHash: Buffer;
  readonly stakeAmount: bigint;
  readonly expiresAt: number;
  readonly confidence: number;
}

/**
 * Emitted when a commitment is activated (stake bonded).
 */
export interface CommitmentActivatedEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.CommitmentActivated;
  readonly commitmentId: PublicKey;
  readonly stakeAmount: bigint;
}

/**
 * Emitted when a commitment is fulfilled successfully.
 */
export interface CommitmentFulfilledEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.CommitmentFulfilled;
  readonly commitmentId: PublicKey;
  readonly taskId: number;
  readonly actualOutputHash: Buffer;
  readonly stakeReturned: bigint;
}

/**
 * Emitted when a commitment is slashed.
 */
export interface CommitmentSlashedEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.CommitmentSlashed;
  readonly commitmentId: PublicKey;
  readonly taskId: number;
  readonly speculatedHash: Buffer;
  readonly actualHash: Buffer;
  readonly slashedAmount: bigint;
  readonly slasher: PublicKey;
  readonly reason: SlashReason;
}

export enum SlashReason {
  OutputMismatch = 0,
  TaskFailed = 1,
  FraudProof = 2,
  Timeout = 3,
}

/**
 * Emitted when a dependent task is created.
 */
export interface DependentTaskCreatedEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.DependentTaskCreated;
  readonly taskId: number;
  readonly prerequisiteTaskId: number;
  readonly commitmentId: PublicKey;
  readonly creator: PublicKey;
  readonly escrowLamports: bigint;
}

/**
 * Emitted when a dependent task is invalidated due to speculation failure.
 */
export interface DependentTaskInvalidatedEvent extends SpeculationEventBase {
  readonly type: SpeculationEventType.DependentTaskInvalidated;
  readonly taskId: number;
  readonly commitmentId: PublicKey;
  readonly reason: SpeculationInvalidationReason;
  readonly refundAmount: bigint;
  readonly refundRecipient: PublicKey;
}

/**
 * Union type of all speculation events.
 */
export type SpeculationEvent =
  | CommitmentCreatedEvent
  | CommitmentActivatedEvent
  | CommitmentFulfilledEvent
  | CommitmentSlashedEvent
  | DependentTaskCreatedEvent
  | DependentTaskInvalidatedEvent;
```

### Event Callback Types

```typescript
/**
 * Callback for speculation events.
 */
export type SpeculationEventCallback<T extends SpeculationEvent = SpeculationEvent> = (
  event: T,
  context: EventContext
) => void | Promise<void>;

/**
 * Context provided with event callbacks.
 */
export interface EventContext {
  /** Connection used to fetch event */
  readonly connection: Connection;
  /** Program instance */
  readonly program: Program;
  /** Whether this is a historical event (from subscription catchup) */
  readonly isHistorical: boolean;
  /** Confirmation status of the transaction */
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Event subscription options.
 */
export interface EventSubscriptionOptions {
  /** Event types to subscribe to (all if not specified) */
  readonly eventTypes?: SpeculationEventType[];
  /** Filter by commitment ID */
  readonly commitmentId?: PublicKey;
  /** Filter by task ID */
  readonly taskId?: number;
  /** Filter by committer */
  readonly committer?: PublicKey;
  /** Start from this slot (for historical events) */
  readonly startSlot?: bigint;
  /** Commitment level for confirmation */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
}
```

---

## Error Types

### SpeculationError

```typescript
/**
 * Error codes for speculation operations.
 * Values 6000-6099 reserved for speculation module.
 */
export enum SpeculationErrorCode {
  // Commitment Errors (6000-6019)
  CommitmentNotFound = 6000,
  CommitmentAlreadyExists = 6001,
  CommitmentExpired = 6002,
  CommitmentNotActive = 6003,
  CommitmentAlreadyFinalized = 6004,
  InvalidCommitmentState = 6005,
  CommitmentHashMismatch = 6006,
  
  // Stake Errors (6020-6039)
  InsufficientStake = 6020,
  StakeExceedsMaximum = 6021,
  StakeBelowMinimum = 6022,
  StakeAlreadyBonded = 6023,
  StakeNotBonded = 6024,
  StakeLocked = 6025,
  
  // Task Dependency Errors (6040-6059)
  InvalidPrerequisiteTask = 6040,
  PrerequisiteNotCompleted = 6041,
  CircularDependency = 6042,
  DependencyLimitExceeded = 6043,
  SpeculatedInputMismatch = 6044,
  
  // Slash Errors (6060-6079)
  SlashNotAuthorized = 6060,
  AlreadySlashed = 6061,
  SlashWindowExpired = 6062,
  InvalidFraudProof = 6063,
  ClaimNotFound = 6064,
  ClaimAlreadyProcessed = 6065,
  
  // Configuration Errors (6080-6099)
  SystemPaused = 6080,
  InvalidConfiguration = 6081,
  UnauthorizedConfigUpdate = 6082,
  DurationOutOfRange = 6083,
}

/**
 * Human-readable error messages for each error code.
 */
export const SPECULATION_ERROR_MESSAGES: Record<SpeculationErrorCode, string> = {
  [SpeculationErrorCode.CommitmentNotFound]: 
    'Speculative commitment not found',
  [SpeculationErrorCode.CommitmentAlreadyExists]: 
    'Commitment already exists for this task and committer',
  [SpeculationErrorCode.CommitmentExpired]: 
    'Commitment has expired',
  [SpeculationErrorCode.CommitmentNotActive]: 
    'Commitment is not in active state',
  [SpeculationErrorCode.CommitmentAlreadyFinalized]: 
    'Commitment has already been finalized',
  [SpeculationErrorCode.InvalidCommitmentState]: 
    'Invalid commitment state for this operation',
  [SpeculationErrorCode.CommitmentHashMismatch]: 
    'Provided hash does not match commitment',
  [SpeculationErrorCode.InsufficientStake]: 
    'Stake amount is insufficient for this commitment',
  [SpeculationErrorCode.StakeExceedsMaximum]: 
    'Stake amount exceeds maximum allowed',
  [SpeculationErrorCode.StakeBelowMinimum]: 
    'Stake amount is below minimum required',
  [SpeculationErrorCode.StakeAlreadyBonded]: 
    'Stake has already been bonded',
  [SpeculationErrorCode.StakeNotBonded]: 
    'Stake has not been bonded yet',
  [SpeculationErrorCode.StakeLocked]: 
    'Stake is locked and cannot be withdrawn',
  [SpeculationErrorCode.InvalidPrerequisiteTask]: 
    'Invalid prerequisite task specified',
  [SpeculationErrorCode.PrerequisiteNotCompleted]: 
    'Prerequisite task has not been completed',
  [SpeculationErrorCode.CircularDependency]: 
    'Circular task dependency detected',
  [SpeculationErrorCode.DependencyLimitExceeded]: 
    'Maximum number of dependencies exceeded',
  [SpeculationErrorCode.SpeculatedInputMismatch]: 
    'Speculated input does not match commitment output',
  [SpeculationErrorCode.SlashNotAuthorized]: 
    'Not authorized to slash this commitment',
  [SpeculationErrorCode.AlreadySlashed]: 
    'Commitment has already been slashed',
  [SpeculationErrorCode.SlashWindowExpired]: 
    'Slash window has expired',
  [SpeculationErrorCode.InvalidFraudProof]: 
    'Provided fraud proof is invalid',
  [SpeculationErrorCode.ClaimNotFound]: 
    'Slash distribution claim not found',
  [SpeculationErrorCode.ClaimAlreadyProcessed]: 
    'Claim has already been processed',
  [SpeculationErrorCode.SystemPaused]: 
    'Speculation system is currently paused',
  [SpeculationErrorCode.InvalidConfiguration]: 
    'Invalid configuration parameter',
  [SpeculationErrorCode.UnauthorizedConfigUpdate]: 
    'Not authorized to update configuration',
  [SpeculationErrorCode.DurationOutOfRange]: 
    'Commitment duration is out of allowed range',
};

/**
 * Custom error class for speculation operations.
 */
export class SpeculationError extends Error {
  constructor(
    public readonly code: SpeculationErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(SPECULATION_ERROR_MESSAGES[code]);
    this.name = 'SpeculationError';
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SpeculationError);
    }
  }
  
  /**
   * Create error from on-chain error code.
   */
  static fromAnchorError(anchorError: { code: number; msg?: string }): SpeculationError {
    const code = anchorError.code as SpeculationErrorCode;
    if (code in SpeculationErrorCode) {
      return new SpeculationError(code);
    }
    throw new Error(`Unknown error code: ${anchorError.code}`);
  }
  
  /**
   * Check if error is a specific type.
   */
  is(code: SpeculationErrorCode): boolean {
    return this.code === code;
  }
  
  /**
   * Get JSON representation.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
```

---

## Runtime Interfaces

### ISpeculationRuntime

```typescript
/**
 * Main runtime interface for speculative execution.
 * 
 * @remarks
 * This interface defines all operations available for managing
 * speculative commitments at the runtime level. Implementations
 * should handle connection management, caching, and error recovery.
 */
export interface ISpeculationRuntime {
  // =========================================================================
  // Lifecycle
  // =========================================================================
  
  /**
   * Initialize the runtime with connection and wallet.
   * @param connection - Solana connection
   * @param wallet - Wallet for signing transactions
   * @returns Promise resolving when initialization is complete
   * @throws SpeculationError if initialization fails
   */
  initialize(connection: Connection, wallet: Keypair): Promise<void>;
  
  /**
   * Shutdown the runtime gracefully.
   * Cancels subscriptions and releases resources.
   */
  shutdown(): Promise<void>;
  
  /**
   * Check if runtime is initialized.
   */
  isInitialized(): boolean;
  
  // =========================================================================
  // Commitment Operations
  // =========================================================================
  
  /**
   * Create a new speculative commitment.
   * 
   * @param params - Commitment parameters
   * @returns Created commitment and transaction signature
   * 
   * @throws SpeculationError.CommitmentAlreadyExists if commitment exists
   * @throws SpeculationError.SystemPaused if system is paused
   * @throws SpeculationError.InvalidPrerequisiteTask if task is invalid
   * 
   * @example
   * ```typescript
   * const result = await runtime.createCommitment({
   *   taskId: 42,
   *   outputHash: Buffer.from('abc...', 'hex'),
   *   salt: crypto.randomBytes(32),
   *   stakeAmount: BigInt(1_000_000_000), // 1 SOL
   *   expiresAt: Math.floor(Date.now() / 1000) + 3600,
   *   confidence: 85,
   * });
   * console.log('Commitment ID:', result.commitment.id.toBase58());
   * ```
   * 
   * @preconditions
   * - Runtime must be initialized
   * - Task must exist and be in Open or InProgress state
   * - Committer must have sufficient balance for stake
   * 
   * @postconditions
   * - Commitment account created on-chain
   * - Commitment in Pending state (awaiting bond)
   * - CommitmentCreated event emitted
   */
  createCommitment(params: CreateCommitmentParams): Promise<{
    commitment: SpeculativeCommitment;
    txSignature: string;
  }>;
  
  /**
   * Bond stake to activate a commitment.
   * 
   * @param commitmentId - ID of commitment to activate
   * @returns Transaction signature
   * 
   * @throws SpeculationError.CommitmentNotFound if not found
   * @throws SpeculationError.InvalidCommitmentState if not Pending
   * @throws SpeculationError.InsufficientStake if balance insufficient
   * 
   * @preconditions
   * - Commitment must exist and be in Pending state
   * - Committer must have balance >= stakeAmount
   * 
   * @postconditions
   * - Stake transferred to escrow PDA
   * - Commitment state changed to Active
   * - CommitmentActivated event emitted
   */
  bondStake(commitmentId: PublicKey): Promise<{ txSignature: string }>;
  
  /**
   * Release stake from a fulfilled commitment.
   * 
   * @param commitmentId - ID of fulfilled commitment
   * @returns Amount released and transaction signature
   * 
   * @throws SpeculationError.CommitmentNotFound if not found
   * @throws SpeculationError.InvalidCommitmentState if not Fulfilled
   * 
   * @preconditions
   * - Commitment must be in Fulfilled state
   * - Only committer can release their stake
   * 
   * @postconditions
   * - Stake transferred back to committer
   * - Commitment account closed
   */
  releaseStake(commitmentId: PublicKey): Promise<{
    amount: bigint;
    txSignature: string;
  }>;
  
  /**
   * Cancel a pending commitment before activation.
   * 
   * @param commitmentId - ID of commitment to cancel
   * @returns Transaction signature
   * 
   * @throws SpeculationError.CommitmentNotFound if not found
   * @throws SpeculationError.InvalidCommitmentState if not Pending
   * 
   * @preconditions
   * - Commitment must be in Pending state
   * - Only committer can cancel
   * 
   * @postconditions
   * - Commitment state changed to Cancelled
   * - CommitmentCancelled event emitted
   */
  cancelCommitment(commitmentId: PublicKey): Promise<{ txSignature: string }>;
  
  // =========================================================================
  // Slashing Operations
  // =========================================================================
  
  /**
   * Slash a commitment that provided incorrect speculation.
   * 
   * @param params - Slash parameters
   * @returns Slash distribution and transaction signature
   * 
   * @throws SpeculationError.CommitmentNotFound if not found
   * @throws SpeculationError.AlreadySlashed if already slashed
   * @throws SpeculationError.InvalidFraudProof if proof invalid
   * 
   * @example
   * ```typescript
   * const result = await runtime.slashCommitment({
   *   commitmentId: commitment.id,
   *   actualOutputHash: Buffer.from('actual...', 'hex'),
   *   fraudProof: Buffer.from('proof...'),
   * });
   * console.log('Slashed:', result.distribution.totalSlashed);
   * ```
   * 
   * @preconditions
   * - Commitment must be Active and actual output must differ from speculated
   * - Caller must provide valid fraud proof or be the task completer
   * 
   * @postconditions
   * - Commitment state changed to Slashed
   * - SlashDistribution account created
   * - Stake distributed per configuration
   * - CommitmentSlashed event emitted
   */
  slashCommitment(params: {
    commitmentId: PublicKey;
    actualOutputHash: Buffer;
    fraudProof?: Buffer;
  }): Promise<{
    distribution: SlashDistribution;
    txSignature: string;
  }>;
  
  /**
   * Claim entitlement from a slash distribution.
   * 
   * @param distributionId - ID of slash distribution
   * @returns Amount claimed and transaction signature
   * 
   * @throws SpeculationError.ClaimNotFound if not entitled
   * @throws SpeculationError.ClaimAlreadyProcessed if already claimed
   * 
   * @preconditions
   * - Distribution must exist and be finalized
   * - Caller must be entitled to a claim
   * - Claim must not already be processed
   * 
   * @postconditions
   * - Claim amount transferred to caller
   * - Claim marked as processed
   * - SlashClaimed event emitted
   */
  claimSlashDistribution(distributionId: PublicKey): Promise<{
    amount: bigint;
    txSignature: string;
  }>;
  
  // =========================================================================
  // Dependent Task Operations
  // =========================================================================
  
  /**
   * Create a task that depends on speculative output.
   * 
   * @param params - Dependent task parameters
   * @returns Created task ID and transaction signature
   * 
   * @throws SpeculationError.CommitmentNotFound if commitment not found
   * @throws SpeculationError.CommitmentNotActive if commitment not active
   * @throws SpeculationError.SpeculatedInputMismatch if hash mismatch
   * @throws SpeculationError.CircularDependency if dependency cycle detected
   * 
   * @example
   * ```typescript
   * const result = await runtime.createDependentTask({
   *   description: 'Process speculated data',
   *   escrowLamports: BigInt(500_000_000),
   *   deadline: Math.floor(Date.now() / 1000) + 7200,
   *   prerequisiteTaskId: 41,
   *   commitmentId: commitment.id,
   *   speculatedInputHash: commitment.outputHash,
   * });
   * ```
   * 
   * @preconditions
   * - Commitment must be Active
   * - speculatedInputHash must match commitment.outputHash
   * - No circular dependencies
   * 
   * @postconditions
   * - DependentTask account created
   * - Task linked to commitment
   * - DependentTaskCreated event emitted
   */
  createDependentTask(params: CreateDependentTaskParams): Promise<{
    taskId: number;
    txSignature: string;
  }>;
  
  /**
   * Validate that speculation was correct after prerequisite completes.
   * 
   * @param dependentTaskId - ID of dependent task
   * @param actualOutput - Actual output from prerequisite task
   * @returns Validation result
   * 
   * @preconditions
   * - Prerequisite task must be completed
   * - Dependent task must exist and be speculatively executing
   * 
   * @postconditions
   * - If valid: DependentTaskValidated event emitted, task continues
   * - If invalid: DependentTaskInvalidated event emitted, task handled per policy
   */
  validateSpeculation(dependentTaskId: number, actualOutput: Buffer): Promise<{
    isValid: boolean;
    invalidationReason?: SpeculationInvalidationReason;
  }>;
  
  // =========================================================================
  // Query Operations
  // =========================================================================
  
  /**
   * Get commitment by ID.
   */
  getCommitment(commitmentId: PublicKey): Promise<SpeculativeCommitment | null>;
  
  /**
   * Get all commitments for a task.
   */
  getCommitmentsForTask(taskId: number): Promise<SpeculativeCommitment[]>;
  
  /**
   * Get all commitments by a committer.
   */
  getCommitmentsByCommitter(committer: PublicKey): Promise<SpeculativeCommitment[]>;
  
  /**
   * Get dependent task info.
   */
  getDependentTask(taskId: number): Promise<DependentTask | null>;
  
  /**
   * Get slash distribution.
   */
  getSlashDistribution(distributionId: PublicKey): Promise<SlashDistribution | null>;
  
  /**
   * Get current speculation configuration.
   */
  getConfig(): Promise<SpeculationConfig>;
  
  // =========================================================================
  // Event Subscription
  // =========================================================================
  
  /**
   * Subscribe to speculation events.
   * 
   * @param callback - Function called for each event
   * @param options - Subscription options
   * @returns Subscription ID for unsubscribing
   */
  subscribe(
    callback: SpeculationEventCallback,
    options?: EventSubscriptionOptions
  ): Promise<number>;
  
  /**
   * Unsubscribe from events.
   * 
   * @param subscriptionId - ID returned from subscribe()
   */
  unsubscribe(subscriptionId: number): Promise<void>;
}
```

### ISpeculationValidator

```typescript
/**
 * Interface for validating speculative commitments.
 */
export interface ISpeculationValidator {
  /**
   * Validate commitment parameters before creation.
   * 
   * @param params - Parameters to validate
   * @param config - Current configuration
   * @returns Validation result with any errors
   */
  validateCreateParams(
    params: CreateCommitmentParams,
    config: SpeculationConfig
  ): ValidationResult;
  
  /**
   * Validate that a fraud proof is correct.
   * 
   * @param commitment - Commitment being challenged
   * @param actualOutput - Claimed actual output
   * @param fraudProof - Optional ZK proof of incorrectness
   * @returns Whether proof is valid
   */
  validateFraudProof(
    commitment: SpeculativeCommitment,
    actualOutput: Buffer,
    fraudProof?: Buffer
  ): Promise<FraudProofValidationResult>;
  
  /**
   * Check for circular dependencies.
   * 
   * @param newTaskId - ID of task being created
   * @param prerequisiteTaskId - ID of prerequisite
   * @returns Whether dependency would create a cycle
   */
  checkCircularDependency(
    newTaskId: number,
    prerequisiteTaskId: number
  ): Promise<boolean>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
}

export interface ValidationError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface FraudProofValidationResult {
  readonly valid: boolean;
  readonly outputMismatch: boolean;
  readonly proofVerified: boolean;
  readonly details?: string;
}
```

---

## Utility Types

### CommitmentHelpers

```typescript
/**
 * Compute Poseidon commitment hash.
 * commit(outputHash, salt, committer) → 32-byte hash
 */
export type CommitmentHashFn = (
  outputHash: Buffer,
  salt: Buffer,
  committer: PublicKey
) => Buffer;

/**
 * Derive commitment PDA from task and committer.
 */
export type DeriveCommitmentPdaFn = (
  taskId: number,
  committer: PublicKey,
  programId?: PublicKey
) => PublicKey;

/**
 * Derive slash distribution PDA from commitment.
 */
export type DeriveSlashDistributionPdaFn = (
  commitmentId: PublicKey,
  programId?: PublicKey
) => PublicKey;
```

### Type Guards

```typescript
/**
 * Type guard for checking if error is SpeculationError.
 */
export function isSpeculationError(error: unknown): error is SpeculationError {
  return error instanceof SpeculationError;
}

/**
 * Type guard for checking commitment state.
 */
export function isCommitmentActive(
  commitment: SpeculativeCommitment
): boolean {
  return commitment.state === SpeculativeCommitmentState.Active;
}

/**
 * Type guard for checking if commitment can be slashed.
 */
export function isCommitmentSlashable(
  commitment: SpeculativeCommitment
): boolean {
  return (
    commitment.state === SpeculativeCommitmentState.Active &&
    commitment.expiresAt > Math.floor(Date.now() / 1000)
  );
}

/**
 * Type guard for checking if commitment can be released.
 */
export function isCommitmentReleasable(
  commitment: SpeculativeCommitment
): boolean {
  return commitment.state === SpeculativeCommitmentState.Fulfilled;
}
```

### Constants

```typescript
/** PDA seeds for speculation accounts */
export const SPECULATION_SEEDS = {
  COMMITMENT: Buffer.from('speculation_commitment'),
  SLASH_DISTRIBUTION: Buffer.from('slash_distribution'),
  SPECULATION_CONFIG: Buffer.from('speculation_config'),
  STAKE_ESCROW: Buffer.from('stake_escrow'),
} as const;

/** Size constants for account layouts */
export const SPECULATION_SIZES = {
  /** Size of commitment account in bytes */
  COMMITMENT_ACCOUNT: 
    8 +    // discriminator
    32 +   // id (pubkey)
    8 +    // taskId
    32 +   // committer
    32 +   // outputHash
    32 +   // commitment
    8 +    // stakeAmount
    1 +    // state
    8 +    // createdAt
    8 +    // expiresAt
    1 + 8 + // Option<dependentTaskId>
    1 +    // confidence
    8,     // lastUpdatedSlot
  
  /** Size of slash distribution account in bytes */
  SLASH_DISTRIBUTION_ACCOUNT:
    8 +    // discriminator
    32 +   // id
    32 +   // commitmentId
    8 +    // totalSlashed
    8 +    // protocolShare
    8 +    // affectedPartiesShare
    4 +    // claimants vec length prefix
    // + variable claimants
    1 +    // finalized
    8,     // slashSlot
} as const;
```

---

## Example Implementation Patterns

### Creating and Activating a Commitment

```typescript
import { 
  ISpeculationRuntime, 
  CreateCommitmentParams,
  SpeculativeCommitment,
  SpeculationError,
  SpeculationErrorCode,
} from '@agenc/speculation';
import { randomBytes } from 'crypto';

async function createAndActivateCommitment(
  runtime: ISpeculationRuntime,
  taskId: number,
  predictedOutput: Buffer,
  stakeAmount: bigint
): Promise<SpeculativeCommitment> {
  // Generate cryptographic salt
  const salt = randomBytes(32);
  
  // Calculate expiration (1 hour from now)
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  
  // Create commitment
  const { commitment, txSignature: createTx } = await runtime.createCommitment({
    taskId,
    outputHash: predictedOutput,
    salt,
    stakeAmount,
    expiresAt,
    confidence: 80,
  });
  
  console.log(`Created commitment: ${commitment.id.toBase58()}`);
  console.log(`Transaction: ${createTx}`);
  
  // Bond stake to activate
  try {
    const { txSignature: bondTx } = await runtime.bondStake(commitment.id);
    console.log(`Activated with stake: ${bondTx}`);
  } catch (error) {
    if (error instanceof SpeculationError) {
      if (error.is(SpeculationErrorCode.InsufficientStake)) {
        // Cancel commitment if can't bond
        await runtime.cancelCommitment(commitment.id);
        throw new Error('Insufficient balance for stake');
      }
    }
    throw error;
  }
  
  // Return updated commitment
  const active = await runtime.getCommitment(commitment.id);
  if (!active) throw new Error('Commitment not found after activation');
  
  return active;
}
```

### Handling Speculation Failure

```typescript
async function handleSpeculationFailure(
  runtime: ISpeculationRuntime,
  dependentTaskId: number,
  actualOutput: Buffer
): Promise<void> {
  // Validate the speculation
  const result = await runtime.validateSpeculation(dependentTaskId, actualOutput);
  
  if (!result.isValid) {
    console.warn(`Speculation failed: ${result.invalidationReason}`);
    
    // Get the dependent task to find commitment
    const dependentTask = await runtime.getDependentTask(dependentTaskId);
    if (!dependentTask) return;
    
    // Slash the commitment
    const { distribution } = await runtime.slashCommitment({
      commitmentId: dependentTask.commitmentId,
      actualOutputHash: actualOutput,
    });
    
    console.log(`Slashed ${distribution.totalSlashed} lamports`);
    
    // Claim our share as affected party
    const { amount } = await runtime.claimSlashDistribution(distribution.id);
    console.log(`Claimed ${amount} lamports from slash distribution`);
  }
}
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-01-28 | Initial specification |

---

## References

- [AgenC Architecture](../../architecture.md)
- [Speculation Design Spec](../SPEC.md)
- [On-Chain API](./ONCHAIN-API.md)
- [SDK API](./SDK-API.md)
