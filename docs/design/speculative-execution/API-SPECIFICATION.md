# Speculative Execution API Specification

> **Version:** 1.0.0  
> **Status:** Draft  
> **Last Updated:** 2026-01-28  
> **Epic:** [#285](https://github.com/tetsuo-ai/AgenC/issues/285)

## Table of Contents

- [1. Core Interfaces](#1-core-interfaces)
- [2. Class APIs](#2-class-apis)
- [3. Events](#3-events)
- [4. Configuration Schema](#4-configuration-schema)
- [5. Error Types](#5-error-types)
- [6. Constants](#6-constants)

---

## 1. Core Interfaces

### 1.1 Task Dependency Interfaces

```typescript
/**
 * Unique identifier for a task in the system.
 * Typically a Solana public key string or UUID.
 */
export type TaskId = string;

/**
 * Unique identifier for an agent.
 * Corresponds to the agent's Solana wallet address.
 */
export type AgentId = string;

/**
 * Unix timestamp in milliseconds.
 */
export type TimestampMs = number;

/**
 * Amount in lamports (1 SOL = 1_000_000_000 lamports).
 */
export type Lamports = bigint;

/**
 * Represents a task node in the dependency graph.
 * Contains all metadata needed for speculative execution decisions.
 */
export interface TaskNode {
  /** Unique identifier for this task */
  readonly id: TaskId;
  
  /** Agent that claimed this task */
  readonly agentId: AgentId;
  
  /** Parent task this depends on (null for root tasks) */
  readonly dependsOn: TaskId | null;
  
  /** Current execution status */
  status: TaskStatus;
  
  /** When the task claim expires (ms since epoch) */
  readonly claimExpiry: TimestampMs;
  
  /** When this task was created/claimed */
  readonly createdAt: TimestampMs;
  
  /** Estimated compute time in milliseconds */
  readonly estimatedComputeMs: number;
  
  /** Actual compute time once completed */
  computeTimeMs?: number;
  
  /** Task payload/input data hash */
  readonly inputHash: string;
  
  /** Task output data hash (set after completion) */
  outputHash?: string;
  
  /** Current speculation depth (0 = confirmed ancestor chain) */
  speculationDepth: number;
  
  /** Metadata for tracking and debugging */
  metadata: TaskNodeMetadata;
}

/**
 * Additional metadata attached to task nodes.
 */
export interface TaskNodeMetadata {
  /** Human-readable task name/description */
  name?: string;
  
  /** Task type/category for analytics */
  taskType?: string;
  
  /** Priority level (higher = more urgent) */
  priority: number;
  
  /** Number of retry attempts */
  retryCount: number;
  
  /** Maximum allowed retries */
  maxRetries: number;
  
  /** Custom labels for filtering/grouping */
  labels: Record<string, string>;
  
  /** Trace ID for distributed tracing */
  traceId?: string;
  
  /** Span ID for distributed tracing */
  spanId?: string;
}

/**
 * Possible states for a task in the speculative execution system.
 */
export enum TaskStatus {
  /** Task is waiting for dependencies */
  PENDING = 'PENDING',
  
  /** Task is ready to execute (dependencies met or speculating) */
  READY = 'READY',
  
  /** Task is currently being executed */
  EXECUTING = 'EXECUTING',
  
  /** Task execution completed, generating proof */
  PROVING = 'PROVING',
  
  /** Proof generated, waiting for ancestor confirmation */
  AWAITING_ANCESTORS = 'AWAITING_ANCESTORS',
  
  /** Proof submitted, waiting for on-chain confirmation */
  CONFIRMING = 'CONFIRMING',
  
  /** Task fully confirmed on-chain */
  CONFIRMED = 'CONFIRMED',
  
  /** Task was rolled back due to ancestor failure */
  ROLLED_BACK = 'ROLLED_BACK',
  
  /** Task failed during execution */
  FAILED = 'FAILED',
  
  /** Task was cancelled */
  CANCELLED = 'CANCELLED',
  
  /** Task claim expired before completion */
  EXPIRED = 'EXPIRED',
}

/**
 * Represents a directed edge in the dependency graph.
 */
export interface DependencyEdge {
  /** Source task (parent/dependency) */
  readonly from: TaskId;
  
  /** Target task (child/dependent) */
  readonly to: TaskId;
  
  /** When this edge was created */
  readonly createdAt: TimestampMs;
  
  /** Edge type for multi-dependency scenarios */
  readonly edgeType: DependencyEdgeType;
  
  /** Weight for scheduling priority (optional) */
  weight?: number;
}

/**
 * Types of dependency relationships.
 */
export enum DependencyEdgeType {
  /** Standard data dependency (output -> input) */
  DATA = 'DATA',
  
  /** Ordering constraint only (no data flow) */
  ORDER = 'ORDER',
  
  /** Resource dependency (shared resource lock) */
  RESOURCE = 'RESOURCE',
}
```

### 1.2 Speculative Commitment Interfaces

```typescript
/**
 * Unique identifier for a speculative commitment.
 */
export type CommitmentId = string;

/**
 * Represents a speculative commitment made by an agent.
 * This is the core data structure for tracking speculative execution.
 */
export interface SpeculativeCommitment {
  /** Unique commitment identifier */
  readonly id: CommitmentId;
  
  /** Task this commitment is for */
  readonly taskId: TaskId;
  
  /** Agent making the commitment */
  readonly agentId: AgentId;
  
  /** Amount of stake bonded for this commitment */
  readonly bondedStake: Lamports;
  
  /** Speculation depth (distance from last confirmed ancestor) */
  readonly depth: number;
  
  /** Current status of the commitment */
  status: CommitmentStatus;
  
  /** Hash of the speculative output */
  readonly outputHash: string;
  
  /** Hash of the input state (for verification) */
  readonly inputStateHash: string;
  
  /** When the commitment was created */
  readonly createdAt: TimestampMs;
  
  /** When the commitment expires if not confirmed */
  readonly expiresAt: TimestampMs;
  
  /** Parent commitment ID (null for depth-1 speculation) */
  readonly parentCommitmentId: CommitmentId | null;
  
  /** Child commitment IDs (dependents) */
  childCommitmentIds: CommitmentId[];
  
  /** Proof status for this commitment */
  proofStatus: ProofStatus;
  
  /** On-chain transaction signature (if submitted) */
  onChainTxSignature?: string;
  
  /** Slot when confirmed on-chain */
  confirmedAtSlot?: number;
}

/**
 * Status of a speculative commitment.
 */
export enum CommitmentStatus {
  /** Commitment is active and valid */
  ACTIVE = 'ACTIVE',
  
  /** Commitment has been confirmed on-chain */
  CONFIRMED = 'CONFIRMED',
  
  /** Commitment was rolled back */
  ROLLED_BACK = 'ROLLED_BACK',
  
  /** Commitment expired without confirmation */
  EXPIRED = 'EXPIRED',
  
  /** Commitment was invalidated (parent failed) */
  INVALIDATED = 'INVALIDATED',
  
  /** Agent was slashed for invalid commitment */
  SLASHED = 'SLASHED',
}

/**
 * Status of proof generation and submission.
 */
export interface ProofStatus {
  /** Current state of proof generation */
  state: ProofState;
  
  /** Private payload (when generated) */
  privatePayload?: {
    sealBytes: Uint8Array;
    journal: Uint8Array;
    imageId: Uint8Array;
    bindingSeed: Uint8Array;
    nullifierSeed: Uint8Array;
  };
  
  /** Proof generation job ID */
  jobId?: string;
  
  /** When proof generation started */
  startedAt?: TimestampMs;
  
  /** When proof generation completed */
  completedAt?: TimestampMs;
  
  /** Error message if proof generation failed */
  error?: string;
  
  /** Number of proof generation attempts */
  attempts: number;
  
  /** Whether proof is deferred (waiting for ancestors) */
  isDeferred: boolean;
}

/**
 * States for proof generation.
 */
export enum ProofState {
  /** Proof not yet started */
  NOT_STARTED = 'NOT_STARTED',
  
  /** Proof generation queued */
  QUEUED = 'QUEUED',
  
  /** Proof currently being generated */
  GENERATING = 'GENERATING',
  
  /** Proof generated, awaiting submission */
  GENERATED = 'GENERATED',
  
  /** Proof submitted to chain */
  SUBMITTED = 'SUBMITTED',
  
  /** Proof verified on-chain */
  VERIFIED = 'VERIFIED',
  
  /** Proof generation failed */
  FAILED = 'FAILED',
}
```

### 1.3 Proof Deferral Interfaces

```typescript
/**
 * Represents a proof generation job in the deferral queue.
 */
export interface ProofGenerationJob {
  /** Unique job identifier */
  readonly id: string;
  
  /** Task this proof is for */
  readonly taskId: TaskId;
  
  /** Commitment this proof validates */
  readonly commitmentId: CommitmentId;
  
  /** Job priority (higher = processed first) */
  priority: number;
  
  /** Current job status */
  status: ProofJobStatus;
  
  /** When the job was created */
  readonly createdAt: TimestampMs;
  
  /** When the job started processing */
  startedAt?: TimestampMs;
  
  /** When the job completed */
  completedAt?: TimestampMs;
  
  /** Worker ID processing this job */
  workerId?: string;
  
  /** Inputs required for proof generation */
  readonly inputs: ProofInputs;
  
  /** Generated proof output */
  output?: ProofOutput;
  
  /** Error details if failed */
  error?: ProofJobError;
  
  /** Number of retry attempts */
  retryCount: number;
  
  /** Ancestor commitments that must be confirmed first */
  readonly requiredAncestors: CommitmentId[];
  
  /** Whether all ancestors are confirmed */
  ancestorsConfirmed: boolean;
}

/**
 * Inputs required for proof generation.
 */
export interface ProofInputs {
  /** Input state hash */
  inputStateHash: string;
  
  /** Output state hash */
  outputStateHash: string;
  
  /** Execution trace (compressed) */
  executionTrace: Uint8Array;
  
  /** Public inputs (journal fields) */
  publicInputs: bigint[];
  
  /** Private witness data */
  witnessData: Uint8Array;
}

/**
 * Output from proof generation.
 */
export interface ProofOutput {
  /** The generated proof */
  proof: Uint8Array;
  
  /** Public inputs verified by the proof */
  publicInputs: bigint[];
  
  /** Proof type/system used */
  proofType: ProofType;
  
  /** Verification key hash */
  vkHash: string;
  
  /** Proof generation duration in ms */
  generationTimeMs: number;
  
  /** Proof size in bytes */
  proofSizeBytes: number;
}

/**
 * Supported proof systems.
 */
export enum ProofType {
  GROTH16 = 'GROTH16',
  PLONK = 'PLONK',
  STARK = 'STARK',
  MOCK = 'MOCK',
}

/**
 * Status of a proof generation job.
 */
export enum ProofJobStatus {
  /** Job is queued, waiting for processing */
  QUEUED = 'QUEUED',
  
  /** Job is waiting for ancestor proofs */
  WAITING_ANCESTORS = 'WAITING_ANCESTORS',
  
  /** Job is currently being processed */
  PROCESSING = 'PROCESSING',
  
  /** Job completed successfully */
  COMPLETED = 'COMPLETED',
  
  /** Job failed */
  FAILED = 'FAILED',
  
  /** Job was cancelled */
  CANCELLED = 'CANCELLED',
  
  /** Job timed out */
  TIMED_OUT = 'TIMED_OUT',
}

/**
 * Error details for failed proof jobs.
 */
export interface ProofJobError {
  /** Error code */
  code: ProofErrorCode;
  
  /** Human-readable error message */
  message: string;
  
  /** Stack trace (if available) */
  stack?: string;
  
  /** Whether this error is retryable */
  retryable: boolean;
  
  /** Suggested retry delay in ms */
  retryDelayMs?: number;
}

/**
 * Error codes for proof generation failures.
 */
export enum ProofErrorCode {
  /** Invalid inputs provided */
  INVALID_INPUTS = 'INVALID_INPUTS',
  
  /** Witness generation failed */
  WITNESS_GENERATION_FAILED = 'WITNESS_GENERATION_FAILED',
  
  /** Proof generation timed out */
  TIMEOUT = 'TIMEOUT',
  
  /** Out of memory during proof generation */
  OUT_OF_MEMORY = 'OUT_OF_MEMORY',
  
  /** Proof constraint violation */
  CONSTRAINT_VIOLATION = 'CONSTRAINT_VIOLATION',
  
  /** Worker crashed during generation */
  WORKER_CRASH = 'WORKER_CRASH',
  
  /** Unknown/internal error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  
  /** Ancestors not yet confirmed */
  ANCESTORS_PENDING = 'ANCESTORS_PENDING',
  
  /** Ancestor proof was invalidated */
  ANCESTOR_INVALIDATED = 'ANCESTOR_INVALIDATED',
}

/**
 * Status of deferred proofs waiting for ancestors.
 */
export interface DeferredProofStatus {
  /** The proof job being deferred */
  readonly jobId: string;
  
  /** Commitment this proof is for */
  readonly commitmentId: CommitmentId;
  
  /** Ancestor commitments being waited on */
  readonly pendingAncestors: AncestorStatus[];
  
  /** When deferral started */
  readonly deferredAt: TimestampMs;
  
  /** Estimated time until all ancestors confirmed */
  estimatedWaitMs?: number;
  
  /** Whether any ancestor has failed */
  hasFailedAncestor: boolean;
  
  /** Current position in deferral queue */
  queuePosition: number;
}

/**
 * Status of a single ancestor in the chain.
 */
export interface AncestorStatus {
  /** Ancestor commitment ID */
  readonly commitmentId: CommitmentId;
  
  /** Ancestor task ID */
  readonly taskId: TaskId;
  
  /** Depth of this ancestor (relative to current) */
  readonly depth: number;
  
  /** Current status */
  status: CommitmentStatus;
  
  /** Proof status */
  proofState: ProofState;
  
  /** Estimated time to confirmation */
  estimatedConfirmationMs?: number;
}
```

### 1.4 Rollback Interfaces

```typescript
/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  /** Unique identifier for this rollback operation */
  readonly rollbackId: string;
  
  /** Root cause commitment that triggered the rollback */
  readonly triggerCommitmentId: CommitmentId;
  
  /** Reason for the rollback */
  readonly reason: RollbackReason;
  
  /** Tasks that were rolled back */
  readonly rolledBackTasks: RolledBackTask[];
  
  /** Commitments that were invalidated */
  readonly invalidatedCommitments: CommitmentId[];
  
  /** Total stake that was released */
  readonly totalReleasedStake: Lamports;
  
  /** Total stake that was slashed (if any) */
  readonly totalSlashedStake: Lamports;
  
  /** Duration of the rollback operation in ms */
  readonly durationMs: number;
  
  /** When the rollback started */
  readonly startedAt: TimestampMs;
  
  /** When the rollback completed */
  readonly completedAt: TimestampMs;
  
  /** Whether any errors occurred during rollback */
  readonly hadErrors: boolean;
  
  /** Error details if any */
  errors?: RollbackError[];
  
  /** Metrics about the rollback */
  metrics: RollbackMetrics;
}

/**
 * Reasons for triggering a rollback.
 */
export enum RollbackReason {
  /** Ancestor proof verification failed */
  ANCESTOR_PROOF_FAILED = 'ANCESTOR_PROOF_FAILED',
  
  /** Ancestor task execution failed */
  ANCESTOR_EXECUTION_FAILED = 'ANCESTOR_EXECUTION_FAILED',
  
  /** Ancestor commitment expired */
  ANCESTOR_EXPIRED = 'ANCESTOR_EXPIRED',
  
  /** Ancestor was slashed for invalid output */
  ANCESTOR_SLASHED = 'ANCESTOR_SLASHED',
  
  /** Manual rollback requested */
  MANUAL_REQUEST = 'MANUAL_REQUEST',
  
  /** System detected inconsistency */
  CONSISTENCY_CHECK_FAILED = 'CONSISTENCY_CHECK_FAILED',
  
  /** Claim expired before proof submission */
  CLAIM_EXPIRED = 'CLAIM_EXPIRED',
  
  /** Configuration change required rollback */
  CONFIG_CHANGE = 'CONFIG_CHANGE',
  
  /** Emergency shutdown initiated */
  EMERGENCY_SHUTDOWN = 'EMERGENCY_SHUTDOWN',
}

/**
 * Information about a single rolled back task.
 */
export interface RolledBackTask {
  /** Task that was rolled back */
  readonly taskId: TaskId;
  
  /** Associated commitment ID */
  readonly commitmentId: CommitmentId;
  
  /** Agent who owned this task */
  readonly agentId: AgentId;
  
  /** Depth at which this task was speculating */
  readonly speculationDepth: number;
  
  /** Previous status before rollback */
  readonly previousStatus: TaskStatus;
  
  /** Stake that was bonded */
  readonly bondedStake: Lamports;
  
  /** Stake that was released (not slashed) */
  readonly releasedStake: Lamports;
  
  /** Stake that was slashed (if any) */
  readonly slashedStake: Lamports;
  
  /** Compute time wasted on this task */
  readonly wastedComputeMs: number;
  
  /** State snapshot that was restored (if any) */
  readonly restoredSnapshotId?: string;
  
  /** Order in which this task was rolled back */
  readonly rollbackOrder: number;
  
  /** Whether rollback was successful for this task */
  readonly success: boolean;
  
  /** Error if rollback failed for this task */
  error?: string;
}

/**
 * Metrics collected during rollback.
 */
export interface RollbackMetrics {
  /** Total number of tasks rolled back */
  totalTasksRolledBack: number;
  
  /** Maximum depth of rollback chain */
  maxRollbackDepth: number;
  
  /** Total compute time wasted */
  totalWastedComputeMs: number;
  
  /** Number of state snapshots restored */
  snapshotsRestored: number;
  
  /** Number of proof jobs cancelled */
  proofJobsCancelled: number;
  
  /** Time spent in each rollback phase */
  phaseTimings: Record<RollbackPhase, number>;
  
  /** Number of agents affected */
  affectedAgents: number;
  
  /** Rollback cascade depth (how many levels) */
  cascadeDepth: number;
}

/**
 * Phases of the rollback operation.
 */
export enum RollbackPhase {
  /** Identifying affected tasks */
  IDENTIFICATION = 'IDENTIFICATION',
  
  /** Topological sort for rollback order */
  ORDERING = 'ORDERING',
  
  /** Cancelling in-flight operations */
  CANCELLATION = 'CANCELLATION',
  
  /** Restoring state snapshots */
  STATE_RESTORATION = 'STATE_RESTORATION',
  
  /** Releasing/slashing stakes */
  STAKE_SETTLEMENT = 'STAKE_SETTLEMENT',
  
  /** Cleaning up resources */
  CLEANUP = 'CLEANUP',
  
  /** Emitting events and notifications */
  NOTIFICATION = 'NOTIFICATION',
}
```

### 1.5 Speculation Decision Interfaces

```typescript
/**
 * Decision made by the scheduler about whether to speculate.
 */
export interface SpeculationDecision {
  /** Task being considered for speculation */
  readonly taskId: TaskId;
  
  /** Whether to proceed with speculation */
  readonly shouldSpeculate: boolean;
  
  /** Reasons for the decision */
  readonly reasons: DecisionReason[];
  
  /** Calculated speculation depth if proceeding */
  readonly depth?: number;
  
  /** Required stake if proceeding */
  readonly requiredStake?: Lamports;
  
  /** Risk assessment score (0-100) */
  readonly riskScore: number;
  
  /** Expected value calculation */
  readonly expectedValue?: ExpectedValueCalculation;
  
  /** Constraints that were evaluated */
  readonly evaluatedConstraints: ConstraintEvaluation[];
  
  /** Timestamp of decision */
  readonly decidedAt: TimestampMs;
  
  /** Time to live for this decision (ms) */
  readonly ttlMs: number;
  
  /** ID of this decision for tracking */
  readonly decisionId: string;
}

/**
 * Reasons that influenced the speculation decision.
 */
export interface DecisionReason {
  /** Type of reason */
  type: DecisionReasonType;
  
  /** Weight of this reason in decision (-100 to 100) */
  weight: number;
  
  /** Human-readable description */
  description: string;
  
  /** Relevant threshold or value */
  value?: number;
  
  /** Threshold that was compared against */
  threshold?: number;
}

/**
 * Types of reasons for speculation decisions.
 */
export enum DecisionReasonType {
  /** Depth exceeds maximum allowed */
  DEPTH_EXCEEDED = 'DEPTH_EXCEEDED',
  
  /** Insufficient stake available */
  INSUFFICIENT_STAKE = 'INSUFFICIENT_STAKE',
  
  /** Claim expiry too close */
  CLAIM_EXPIRY_RISK = 'CLAIM_EXPIRY_RISK',
  
  /** Parent commitment not found */
  PARENT_NOT_FOUND = 'PARENT_NOT_FOUND',
  
  /** Parent commitment in bad state */
  PARENT_INVALID_STATE = 'PARENT_INVALID_STATE',
  
  /** Resource limits reached */
  RESOURCE_LIMIT = 'RESOURCE_LIMIT',
  
  /** Historical success rate too low */
  LOW_SUCCESS_RATE = 'LOW_SUCCESS_RATE',
  
  /** Expected value too low */
  LOW_EXPECTED_VALUE = 'LOW_EXPECTED_VALUE',
  
  /** Feature flag disabled */
  FEATURE_DISABLED = 'FEATURE_DISABLED',
  
  /** Agent in cooldown period */
  AGENT_COOLDOWN = 'AGENT_COOLDOWN',
  
  /** Parallel branch limit reached */
  BRANCH_LIMIT = 'BRANCH_LIMIT',
  
  /** All checks passed */
  ALL_CHECKS_PASSED = 'ALL_CHECKS_PASSED',
  
  /** High confidence in parent */
  HIGH_PARENT_CONFIDENCE = 'HIGH_PARENT_CONFIDENCE',
  
  /** Fast expected confirmation */
  FAST_CONFIRMATION = 'FAST_CONFIRMATION',
}

/**
 * Expected value calculation for speculation.
 */
export interface ExpectedValueCalculation {
  /** Probability of successful confirmation */
  successProbability: number;
  
  /** Value gained on success (in compute time saved) */
  successValue: number;
  
  /** Probability of rollback */
  rollbackProbability: number;
  
  /** Cost of rollback (wasted compute + potential slash) */
  rollbackCost: number;
  
  /** Net expected value */
  expectedValue: number;
  
  /** Factors used in calculation */
  factors: ExpectedValueFactors;
}

/**
 * Factors used in expected value calculation.
 */
export interface ExpectedValueFactors {
  /** Historical confirmation rate for this depth */
  historicalConfirmationRate: number;
  
  /** Average confirmation time at this depth */
  avgConfirmationTimeMs: number;
  
  /** Parent's current confirmation likelihood */
  parentConfidenceScore: number;
  
  /** Network congestion factor (0-1) */
  networkCongestionFactor: number;
  
  /** Agent's historical success rate */
  agentSuccessRate: number;
  
  /** Task type historical success rate */
  taskTypeSuccessRate: number;
}

/**
 * Result of evaluating a single constraint.
 */
export interface ConstraintEvaluation {
  /** Name of the constraint */
  constraint: string;
  
  /** Whether the constraint passed */
  passed: boolean;
  
  /** Current value */
  currentValue: number | string | boolean;
  
  /** Required value or threshold */
  requiredValue: number | string | boolean;
  
  /** Whether this constraint is blocking */
  isBlocking: boolean;
}
```

### 1.6 Configuration Interfaces

```typescript
/**
 * Complete configuration for the speculative execution system.
 */
export interface SpeculationConfig {
  /** Whether speculation is enabled */
  enabled: boolean;
  
  /** Operating mode */
  mode: SpeculationMode;
  
  /** Core speculation settings */
  core: SpeculationCoreConfig;
  
  /** Stake management settings */
  stake: StakeConfig;
  
  /** Proof generation settings */
  proof: ProofConfig;
  
  /** Resource limits */
  limits: ResourceLimitsConfig;
  
  /** Feature flags */
  features: FeatureFlagsConfig;
  
  /** Scheduler settings */
  scheduler: SchedulerConfig;
  
  /** Rollback settings */
  rollback: RollbackConfig;
}

/**
 * Operating modes for speculation.
 */
export enum SpeculationMode {
  /** Low risk, shallow depth */
  CONSERVATIVE = 'conservative',
  
  /** Balanced risk/reward */
  BALANCED = 'balanced',
  
  /** High throughput, accept risk */
  AGGRESSIVE = 'aggressive',
  
  /** User-defined settings */
  CUSTOM = 'custom',
}

/**
 * Core speculation settings.
 */
export interface SpeculationCoreConfig {
  /** Maximum speculation chain depth */
  maxDepth: number;
  
  /** Maximum parallel speculation branches */
  maxParallelBranches: number;
  
  /** Timeout for confirmation (ms) */
  confirmationTimeoutMs: number;
  
  /** Minimum buffer before claim expiry (ms) */
  claimBufferMs: number;
  
  /** Minimum confidence score to speculate (0-100) */
  minConfidenceScore: number;
  
  /** Whether to allow cross-agent speculation */
  allowCrossAgentSpeculation: boolean;
}

/**
 * Stake management configuration.
 */
export interface StakeConfig {
  /** Minimum stake to speculate */
  minStake: Lamports;
  
  /** Maximum total stake per agent */
  maxStake: Lamports;
  
  /** Base stake required per speculation */
  baseBond: Lamports;
  
  /** Stake multiplier per depth level */
  depthMultiplier: number;
  
  /** Percentage of stake slashed on failure */
  slashPercentage: number;
  
  /** Portion of slash to protocol (rest to affected) */
  protocolSlashShare: number;
  
  /** Cooldown after slash (ms) */
  cooldownPeriodMs: number;
}

/**
 * Proof generation configuration.
 */
export interface ProofConfig {
  /** Proof system to use */
  generator: ProofType;
  
  /** Number of worker threads */
  workerThreads: number;
  
  /** Maximum queue size */
  queueSize: number;
  
  /** Proof generation timeout (ms) */
  timeoutMs: number;
  
  /** Batch size for proof generation */
  batchSize: number;
  
  /** Maximum retries on failure */
  maxRetries: number;
  
  /** Retry delay base (ms) */
  retryDelayMs: number;
  
  /** Retry delay multiplier (exponential backoff) */
  retryMultiplier: number;
  
  /** Whether to generate proofs optimistically */
  optimisticGeneration: boolean;
}

/**
 * Resource limits configuration.
 */
export interface ResourceLimitsConfig {
  /** Maximum memory for speculation state (MB) */
  maxMemoryMb: number;
  
  /** Maximum pending operations */
  maxPendingOperations: number;
  
  /** Maximum state snapshots */
  maxStateSnapshots: number;
  
  /** Garbage collection interval (ms) */
  gcIntervalMs: number;
  
  /** Maximum commitment age before expiry (ms) */
  maxCommitmentAgeMs: number;
  
  /** Maximum rollback cascade size */
  maxRollbackCascadeSize: number;
}

/**
 * Feature flags configuration.
 */
export interface FeatureFlagsConfig {
  /** Enable parallel speculation branches */
  enableParallelSpeculation: boolean;
  
  /** Enable cross-agent speculation */
  enableCrossAgentSpeculation: boolean;
  
  /** Enable optimistic proof generation */
  enableOptimisticProofs: boolean;
  
  /** Enable stake delegation */
  enableStakeDelegation: boolean;
  
  /** Enable on-chain commitments (vs runtime-only) */
  enableOnChainCommitments: boolean;
  
  /** Rollout percentage (0-100) */
  rolloutPercentage: number;
  
  /** Enable detailed metrics */
  enableDetailedMetrics: boolean;
}

/**
 * Scheduler configuration.
 */
export interface SchedulerConfig {
  /** How often to run scheduling loop (ms) */
  schedulingIntervalMs: number;
  
  /** Maximum tasks to process per cycle */
  maxTasksPerCycle: number;
  
  /** Priority weight for depth (lower depth = higher priority) */
  depthPriorityWeight: number;
  
  /** Priority weight for claim expiry urgency */
  expiryPriorityWeight: number;
  
  /** Priority weight for task type priority */
  taskPriorityWeight: number;
  
  /** Whether to use expected value for decisions */
  useExpectedValueDecisions: boolean;
  
  /** Minimum expected value to speculate */
  minExpectedValue: number;
}

/**
 * Rollback configuration.
 */
export interface RollbackConfig {
  /** Rollback policy to use */
  policy: RollbackPolicy;
  
  /** Maximum concurrent rollbacks */
  maxConcurrentRollbacks: number;
  
  /** Rollback operation timeout (ms) */
  rollbackTimeoutMs: number;
  
  /** Whether to preserve state snapshots after rollback */
  preserveSnapshotsAfterRollback: boolean;
  
  /** Grace period before forcing rollback (ms) */
  gracePeriodMs: number;
  
  /** Whether to notify affected agents */
  notifyAffectedAgents: boolean;
}

/**
 * Rollback policies.
 */
export enum RollbackPolicy {
  /** Roll back all dependents */
  CASCADE = 'cascade',
  
  /** Only roll back directly affected */
  SELECTIVE = 'selective',
  
  /** Roll back to last checkpoint */
  CHECKPOINT = 'checkpoint',
}
```

### 1.7 Event Interfaces

```typescript
/**
 * Base interface for all speculation events.
 */
export interface SpeculationEvent<T extends SpeculationEventType = SpeculationEventType> {
  /** Event type */
  readonly type: T;
  
  /** Unique event ID */
  readonly eventId: string;
  
  /** When the event occurred */
  readonly timestamp: TimestampMs;
  
  /** Source component that emitted the event */
  readonly source: EventSource;
  
  /** Correlation ID for tracing */
  readonly correlationId?: string;
  
  /** Event payload (type-specific) */
  readonly payload: SpeculationEventPayloads[T];
}

/**
 * All speculation event types.
 */
export enum SpeculationEventType {
  // Task events
  TASK_ADDED = 'task.added',
  TASK_READY = 'task.ready',
  TASK_STARTED = 'task.started',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  
  // Commitment events
  COMMITMENT_CREATED = 'commitment.created',
  COMMITMENT_CONFIRMED = 'commitment.confirmed',
  COMMITMENT_EXPIRED = 'commitment.expired',
  COMMITMENT_INVALIDATED = 'commitment.invalidated',
  
  // Proof events
  PROOF_JOB_QUEUED = 'proof.job.queued',
  PROOF_JOB_STARTED = 'proof.job.started',
  PROOF_JOB_COMPLETED = 'proof.job.completed',
  PROOF_JOB_FAILED = 'proof.job.failed',
  PROOF_JOB_DEFERRED = 'proof.job.deferred',
  PROOF_SUBMITTED = 'proof.submitted',
  PROOF_VERIFIED = 'proof.verified',
  
  // Rollback events
  ROLLBACK_STARTED = 'rollback.started',
  ROLLBACK_TASK_REVERTED = 'rollback.task.reverted',
  ROLLBACK_COMPLETED = 'rollback.completed',
  ROLLBACK_FAILED = 'rollback.failed',
  
  // Stake events
  STAKE_BONDED = 'stake.bonded',
  STAKE_RELEASED = 'stake.released',
  STAKE_SLASHED = 'stake.slashed',
  
  // Decision events
  SPECULATION_DECISION = 'speculation.decision',
  
  // System events
  DEPTH_LIMIT_REACHED = 'system.depth.limit',
  RESOURCE_LIMIT_REACHED = 'system.resource.limit',
  CONFIG_CHANGED = 'system.config.changed',
  SYSTEM_PAUSED = 'system.paused',
  SYSTEM_RESUMED = 'system.resumed',
}

/**
 * Event source components.
 */
export enum EventSource {
  DEPENDENCY_GRAPH = 'DependencyGraph',
  COMMITMENT_LEDGER = 'CommitmentLedger',
  PROOF_DEFERRAL_MANAGER = 'ProofDeferralManager',
  ROLLBACK_CONTROLLER = 'RollbackController',
  SPECULATIVE_TASK_SCHEDULER = 'SpeculativeTaskScheduler',
  STAKE_MANAGER = 'StakeManager',
  SYSTEM = 'System',
}

/**
 * Map of event types to their payload interfaces.
 */
export interface SpeculationEventPayloads {
  // Task events
  [SpeculationEventType.TASK_ADDED]: TaskAddedPayload;
  [SpeculationEventType.TASK_READY]: TaskReadyPayload;
  [SpeculationEventType.TASK_STARTED]: TaskStartedPayload;
  [SpeculationEventType.TASK_COMPLETED]: TaskCompletedPayload;
  [SpeculationEventType.TASK_FAILED]: TaskFailedPayload;
  
  // Commitment events
  [SpeculationEventType.COMMITMENT_CREATED]: CommitmentCreatedPayload;
  [SpeculationEventType.COMMITMENT_CONFIRMED]: CommitmentConfirmedPayload;
  [SpeculationEventType.COMMITMENT_EXPIRED]: CommitmentExpiredPayload;
  [SpeculationEventType.COMMITMENT_INVALIDATED]: CommitmentInvalidatedPayload;
  
  // Proof events
  [SpeculationEventType.PROOF_JOB_QUEUED]: ProofJobQueuedPayload;
  [SpeculationEventType.PROOF_JOB_STARTED]: ProofJobStartedPayload;
  [SpeculationEventType.PROOF_JOB_COMPLETED]: ProofJobCompletedPayload;
  [SpeculationEventType.PROOF_JOB_FAILED]: ProofJobFailedPayload;
  [SpeculationEventType.PROOF_JOB_DEFERRED]: ProofJobDeferredPayload;
  [SpeculationEventType.PROOF_SUBMITTED]: ProofSubmittedPayload;
  [SpeculationEventType.PROOF_VERIFIED]: ProofVerifiedPayload;
  
  // Rollback events
  [SpeculationEventType.ROLLBACK_STARTED]: RollbackStartedPayload;
  [SpeculationEventType.ROLLBACK_TASK_REVERTED]: RollbackTaskRevertedPayload;
  [SpeculationEventType.ROLLBACK_COMPLETED]: RollbackCompletedPayload;
  [SpeculationEventType.ROLLBACK_FAILED]: RollbackFailedPayload;
  
  // Stake events
  [SpeculationEventType.STAKE_BONDED]: StakeBondedPayload;
  [SpeculationEventType.STAKE_RELEASED]: StakeReleasedPayload;
  [SpeculationEventType.STAKE_SLASHED]: StakeSlashedPayload;
  
  // Decision events
  [SpeculationEventType.SPECULATION_DECISION]: SpeculationDecisionPayload;
  
  // System events
  [SpeculationEventType.DEPTH_LIMIT_REACHED]: DepthLimitReachedPayload;
  [SpeculationEventType.RESOURCE_LIMIT_REACHED]: ResourceLimitReachedPayload;
  [SpeculationEventType.CONFIG_CHANGED]: ConfigChangedPayload;
  [SpeculationEventType.SYSTEM_PAUSED]: SystemPausedPayload;
  [SpeculationEventType.SYSTEM_RESUMED]: SystemResumedPayload;
}

// Task Event Payloads
export interface TaskAddedPayload {
  task: TaskNode;
  parentTaskId?: TaskId;
}

export interface TaskReadyPayload {
  taskId: TaskId;
  isSpeculative: boolean;
  speculationDepth: number;
}

export interface TaskStartedPayload {
  taskId: TaskId;
  agentId: AgentId;
  isSpeculative: boolean;
  speculationDepth: number;
}

export interface TaskCompletedPayload {
  taskId: TaskId;
  outputHash: string;
  computeTimeMs: number;
  isSpeculative: boolean;
}

export interface TaskFailedPayload {
  taskId: TaskId;
  error: string;
  isRetryable: boolean;
  isSpeculative: boolean;
}

// Commitment Event Payloads
export interface CommitmentCreatedPayload {
  commitment: SpeculativeCommitment;
}

export interface CommitmentConfirmedPayload {
  commitmentId: CommitmentId;
  taskId: TaskId;
  confirmedAtSlot: number;
  txSignature: string;
}

export interface CommitmentExpiredPayload {
  commitmentId: CommitmentId;
  taskId: TaskId;
  expiredAt: TimestampMs;
  bondedStake: Lamports;
}

export interface CommitmentInvalidatedPayload {
  commitmentId: CommitmentId;
  taskId: TaskId;
  reason: RollbackReason;
  triggerCommitmentId: CommitmentId;
}

// Proof Event Payloads
export interface ProofJobQueuedPayload {
  job: ProofGenerationJob;
  queuePosition: number;
  estimatedStartMs: number;
}

export interface ProofJobStartedPayload {
  jobId: string;
  taskId: TaskId;
  workerId: string;
}

export interface ProofJobCompletedPayload {
  jobId: string;
  taskId: TaskId;
  generationTimeMs: number;
  proofSizeBytes: number;
}

export interface ProofJobFailedPayload {
  jobId: string;
  taskId: TaskId;
  error: ProofJobError;
  willRetry: boolean;
}

export interface ProofJobDeferredPayload {
  jobId: string;
  taskId: TaskId;
  pendingAncestors: CommitmentId[];
  estimatedWaitMs: number;
}

export interface ProofSubmittedPayload {
  jobId: string;
  taskId: TaskId;
  txSignature: string;
  slot: number;
}

export interface ProofVerifiedPayload {
  jobId: string;
  taskId: TaskId;
  commitmentId: CommitmentId;
  verifiedAtSlot: number;
}

// Rollback Event Payloads
export interface RollbackStartedPayload {
  rollbackId: string;
  triggerCommitmentId: CommitmentId;
  reason: RollbackReason;
  estimatedTaskCount: number;
}

export interface RollbackTaskRevertedPayload {
  rollbackId: string;
  task: RolledBackTask;
}

export interface RollbackCompletedPayload {
  result: RollbackResult;
}

export interface RollbackFailedPayload {
  rollbackId: string;
  error: string;
  partialResult?: Partial<RollbackResult>;
}

// Stake Event Payloads
export interface StakeBondedPayload {
  agentId: AgentId;
  commitmentId: CommitmentId;
  amount: Lamports;
  totalBonded: Lamports;
}

export interface StakeReleasedPayload {
  agentId: AgentId;
  commitmentId: CommitmentId;
  amount: Lamports;
  reason: 'confirmed' | 'rollback' | 'expiry';
}

export interface StakeSlashedPayload {
  agentId: AgentId;
  commitmentId: CommitmentId;
  slashedAmount: Lamports;
  reason: RollbackReason;
  protocolShare: Lamports;
  affectedAgentsShare: Lamports;
}

// Decision Event Payloads
export interface SpeculationDecisionPayload {
  decision: SpeculationDecision;
}

// System Event Payloads
export interface DepthLimitReachedPayload {
  taskId: TaskId;
  currentDepth: number;
  maxDepth: number;
}

export interface ResourceLimitReachedPayload {
  resourceType: 'memory' | 'operations' | 'snapshots' | 'branches';
  currentValue: number;
  limitValue: number;
}

export interface ConfigChangedPayload {
  changedKeys: string[];
  previousValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  changedBy: string;
}

export interface SystemPausedPayload {
  reason: string;
  pendingCommitments: number;
  pausedBy: string;
}

export interface SystemResumedPayload {
  pauseDurationMs: number;
  resumedBy: string;
}
```

---

## 2. Class APIs

### 2.1 DependencyGraph

Manages the directed acyclic graph (DAG) of task dependencies.

```typescript
/**
 * Manages task dependencies as a directed acyclic graph.
 * Thread-safe for concurrent reads, serialized writes.
 * 
 * @example
 * ```typescript
 * const graph = new DependencyGraph(config);
 * 
 * // Add a root task
 * graph.addTask(rootTask);
 * 
 * // Add dependent task
 * graph.addTask(childTask, rootTask.id);
 * 
 * // Get all tasks ready for execution
 * const ready = graph.getReadyTasks();
 * ```
 */
export class DependencyGraph extends EventEmitter {
  /**
   * Creates a new DependencyGraph instance.
   * 
   * @param config - Configuration options
   * @throws {ConfigurationError} If config is invalid
   */
  constructor(config: DependencyGraphConfig);

  /**
   * Adds a task to the dependency graph.
   * 
   * @param task - The task to add
   * @param dependsOn - Optional parent task ID
   * @returns The added task node
   * @throws {DuplicateTaskError} If task ID already exists
   * @throws {InvalidDependencyError} If parent doesn't exist
   * @throws {CycleDetectedError} If adding would create a cycle
   * 
   * @emits task.added
   * 
   * @example
   * ```typescript
   * const task = graph.addTask({
   *   id: 'task-123',
   *   agentId: 'agent-abc',
   *   status: TaskStatus.PENDING,
   *   claimExpiry: Date.now() + 300000,
   *   // ...
   * }, 'parent-task-id');
   * ```
   */
  addTask(task: TaskNode, dependsOn?: TaskId): TaskNode;

  /**
   * Removes a task from the graph.
   * 
   * @param taskId - ID of the task to remove
   * @param cascade - If true, also remove all dependents
   * @returns Array of removed task IDs
   * @throws {TaskNotFoundError} If task doesn't exist
   * @throws {HasDependentsError} If cascade=false and task has dependents
   * 
   * @example
   * ```typescript
   * const removed = graph.removeTask('task-123', true);
   * console.log(`Removed ${removed.length} tasks`);
   * ```
   */
  removeTask(taskId: TaskId, cascade?: boolean): TaskId[];

  /**
   * Retrieves a task by ID.
   * 
   * @param taskId - The task ID to look up
   * @returns The task node or undefined if not found
   */
  getTask(taskId: TaskId): TaskNode | undefined;

  /**
   * Gets all tasks that are ready for execution.
   * A task is ready if all its dependencies are in CONFIRMED status,
   * or if speculation is enabled and dependencies are speculatively complete.
   * 
   * @param includeSpeculative - Include speculatively ready tasks
   * @returns Array of ready task nodes
   */
  getReadyTasks(includeSpeculative?: boolean): TaskNode[];

  /**
   * Gets all descendants of a task (children, grandchildren, etc.).
   * 
   * @param taskId - The task ID to start from
   * @returns Array of descendant task IDs in topological order
   * @throws {TaskNotFoundError} If task doesn't exist
   */
  getDescendants(taskId: TaskId): TaskId[];

  /**
   * Gets all ancestors of a task (parents, grandparents, etc.).
   * 
   * @param taskId - The task ID to start from
   * @returns Array of ancestor task IDs, nearest first
   * @throws {TaskNotFoundError} If task doesn't exist
   */
  getAncestors(taskId: TaskId): TaskId[];

  /**
   * Gets direct children of a task.
   * 
   * @param taskId - The parent task ID
   * @returns Array of child task IDs
   */
  getChildren(taskId: TaskId): TaskId[];

  /**
   * Gets the parent task ID.
   * 
   * @param taskId - The child task ID
   * @returns Parent task ID or null if root task
   */
  getParent(taskId: TaskId): TaskId | null;

  /**
   * Calculates the speculation depth for a task.
   * Depth is the number of unconfirmed ancestors.
   * 
   * @param taskId - The task ID
   * @returns Speculation depth (0 = all ancestors confirmed)
   * @throws {TaskNotFoundError} If task doesn't exist
   */
  getSpeculationDepth(taskId: TaskId): number;

  /**
   * Updates the status of a task.
   * 
   * @param taskId - The task to update
   * @param status - New status
   * @param metadata - Optional additional updates
   * @throws {TaskNotFoundError} If task doesn't exist
   * @throws {InvalidStateTransitionError} If transition is not allowed
   * 
   * @emits task.ready (if transition makes task ready)
   * @emits task.completed (if transition is to CONFIRMED)
   */
  updateTaskStatus(
    taskId: TaskId,
    status: TaskStatus,
    metadata?: Partial<TaskNodeMetadata>
  ): void;

  /**
   * Returns tasks in topological order (dependencies before dependents).
   * 
   * @param taskIds - Optional subset of tasks to sort
   * @returns Topologically sorted task IDs
   */
  topologicalSort(taskIds?: TaskId[]): TaskId[];

  /**
   * Returns tasks in reverse topological order (dependents before dependencies).
   * Useful for rollback operations.
   * 
   * @param taskIds - Optional subset of tasks to sort
   * @returns Reverse topologically sorted task IDs
   */
  reverseTopologicalSort(taskIds?: TaskId[]): TaskId[];

  /**
   * Finds all root tasks (tasks with no dependencies).
   * 
   * @returns Array of root task IDs
   */
  getRootTasks(): TaskId[];

  /**
   * Finds all leaf tasks (tasks with no dependents).
   * 
   * @returns Array of leaf task IDs
   */
  getLeafTasks(): TaskId[];

  /**
   * Gets statistics about the graph.
   * 
   * @returns Graph statistics
   */
  getStats(): DependencyGraphStats;

  /**
   * Validates the graph for consistency.
   * 
   * @returns Validation result with any issues found
   */
  validate(): GraphValidationResult;

  /**
   * Clears all tasks from the graph.
   * 
   * @param force - If true, clear even if tasks are in-progress
   * @throws {OperationInProgressError} If force=false and tasks are executing
   */
  clear(force?: boolean): void;

  /**
   * Exports the graph to a serializable format.
   * 
   * @returns Serialized graph data
   */
  export(): SerializedDependencyGraph;

  /**
   * Imports a previously exported graph.
   * 
   * @param data - Serialized graph data
   * @throws {ImportError} If data is invalid
   */
  import(data: SerializedDependencyGraph): void;
}

/**
 * Configuration for DependencyGraph.
 */
export interface DependencyGraphConfig {
  /** Maximum number of tasks in the graph */
  maxTasks: number;
  
  /** Maximum depth of the graph */
  maxDepth: number;
  
  /** Whether to allow multiple parents (DAG vs tree) */
  allowMultipleParents: boolean;
  
  /** Whether to validate on every mutation */
  validateOnMutation: boolean;
}

/**
 * Statistics about the dependency graph.
 */
export interface DependencyGraphStats {
  totalTasks: number;
  tasksByStatus: Record<TaskStatus, number>;
  totalEdges: number;
  maxDepth: number;
  avgDepth: number;
  rootTaskCount: number;
  leafTaskCount: number;
  speculativeTaskCount: number;
}

/**
 * Result of graph validation.
 */
export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

/**
 * A validation issue found in the graph.
 */
export interface GraphValidationIssue {
  type: 'cycle' | 'orphan' | 'invalid_status' | 'missing_parent';
  taskIds: TaskId[];
  message: string;
}

/**
 * Serialized dependency graph for export/import.
 */
export interface SerializedDependencyGraph {
  version: string;
  exportedAt: TimestampMs;
  tasks: TaskNode[];
  edges: DependencyEdge[];
}
```

### 2.2 CommitmentLedger

Tracks speculative commitments and their lifecycle.

```typescript
/**
 * Manages the lifecycle of speculative commitments.
 * Provides the source of truth for commitment state and stake tracking.
 * 
 * @example
 * ```typescript
 * const ledger = new CommitmentLedger(config);
 * 
 * // Create a commitment
 * const commitment = await ledger.createCommitment({
 *   taskId: 'task-123',
 *   agentId: 'agent-abc',
 *   outputHash: '0x...',
 *   bondedStake: 1000000n,
 * });
 * 
 * // Later, confirm it
 * await ledger.confirmCommitment(commitment.id, txSignature, slot);
 * ```
 */
export class CommitmentLedger extends EventEmitter {
  /**
   * Creates a new CommitmentLedger instance.
   * 
   * @param config - Configuration options
   * @param dependencyGraph - DependencyGraph instance for depth calculation
   * @throws {ConfigurationError} If config is invalid
   */
  constructor(config: CommitmentLedgerConfig, dependencyGraph: DependencyGraph);

  /**
   * Creates a new speculative commitment.
   * 
   * @param params - Commitment creation parameters
   * @returns The created commitment
   * @throws {InsufficientStakeError} If agent lacks required stake
   * @throws {DepthExceededError} If speculation depth exceeds limit
   * @throws {DuplicateCommitmentError} If commitment for task exists
   * @throws {ParentNotFoundError} If parent commitment doesn't exist
   * @throws {ParentInvalidStateError} If parent is not in valid state
   * 
   * @emits commitment.created
   * @emits stake.bonded
   */
  createCommitment(params: CreateCommitmentParams): Promise<SpeculativeCommitment>;

  /**
   * Retrieves a commitment by ID.
   * 
   * @param commitmentId - The commitment ID
   * @returns The commitment or undefined
   */
  getCommitment(commitmentId: CommitmentId): SpeculativeCommitment | undefined;

  /**
   * Retrieves a commitment by task ID.
   * 
   * @param taskId - The task ID
   * @returns The commitment or undefined
   */
  getCommitmentByTaskId(taskId: TaskId): SpeculativeCommitment | undefined;

  /**
   * Gets all commitments for an agent.
   * 
   * @param agentId - The agent ID
   * @param status - Optional status filter
   * @returns Array of commitments
   */
  getCommitmentsByAgent(
    agentId: AgentId,
    status?: CommitmentStatus
  ): SpeculativeCommitment[];

  /**
   * Gets all child commitments of a parent.
   * 
   * @param parentCommitmentId - The parent commitment ID
   * @returns Array of child commitments
   */
  getChildCommitments(parentCommitmentId: CommitmentId): SpeculativeCommitment[];

  /**
   * Confirms a commitment after on-chain verification.
   * 
   * @param commitmentId - The commitment to confirm
   * @param txSignature - On-chain transaction signature
   * @param slot - Slot when confirmed
   * @throws {CommitmentNotFoundError} If commitment doesn't exist
   * @throws {InvalidStateError} If commitment not in confirmable state
   * 
   * @emits commitment.confirmed
   * @emits stake.released
   */
  confirmCommitment(
    commitmentId: CommitmentId,
    txSignature: string,
    slot: number
  ): Promise<void>;

  /**
   * Invalidates a commitment and triggers rollback.
   * 
   * @param commitmentId - The commitment to invalidate
   * @param reason - Reason for invalidation
   * @returns Array of invalidated commitment IDs (includes descendants)
   * @throws {CommitmentNotFoundError} If commitment doesn't exist
   * 
   * @emits commitment.invalidated (for each affected commitment)
   */
  invalidateCommitment(
    commitmentId: CommitmentId,
    reason: RollbackReason
  ): Promise<CommitmentId[]>;

  /**
   * Marks a commitment as expired.
   * 
   * @param commitmentId - The commitment to expire
   * @throws {CommitmentNotFoundError} If commitment doesn't exist
   * 
   * @emits commitment.expired
   * @emits stake.released
   */
  expireCommitment(commitmentId: CommitmentId): Promise<void>;

  /**
   * Slashes stake for an invalid commitment.
   * 
   * @param commitmentId - The commitment to slash
   * @param reason - Reason for slashing
   * @returns Slash result with amounts
   * @throws {CommitmentNotFoundError} If commitment doesn't exist
   * @throws {AlreadySlashedError} If already slashed
   * 
   * @emits stake.slashed
   */
  slashCommitment(
    commitmentId: CommitmentId,
    reason: RollbackReason
  ): Promise<SlashResult>;

  /**
   * Gets the total bonded stake for an agent.
   * 
   * @param agentId - The agent ID
   * @returns Total bonded stake in lamports
   */
  getBondedStake(agentId: AgentId): Lamports;

  /**
   * Gets the available stake (max - bonded) for an agent.
   * 
   * @param agentId - The agent ID
   * @returns Available stake in lamports
   */
  getAvailableStake(agentId: AgentId): Lamports;

  /**
   * Calculates required stake for a given depth.
   * Uses formula: baseBond × (2 ^ depth)
   * 
   * @param depth - Speculation depth
   * @returns Required stake in lamports
   */
  calculateRequiredStake(depth: number): Lamports;

  /**
   * Checks if an agent is in cooldown after slash.
   * 
   * @param agentId - The agent ID
   * @returns Cooldown status
   */
  isAgentInCooldown(agentId: AgentId): AgentCooldownStatus;

  /**
   * Gets all active (non-confirmed/invalidated) commitments.
   * 
   * @returns Array of active commitments
   */
  getActiveCommitments(): SpeculativeCommitment[];

  /**
   * Gets commitments that are expiring soon.
   * 
   * @param withinMs - Time window in milliseconds
   * @returns Array of expiring commitments
   */
  getExpiringCommitments(withinMs: number): SpeculativeCommitment[];

  /**
   * Runs garbage collection on expired/old commitments.
   * 
   * @returns Number of commitments cleaned up
   */
  gc(): Promise<number>;

  /**
   * Gets ledger statistics.
   * 
   * @returns Ledger statistics
   */
  getStats(): CommitmentLedgerStats;
}

/**
 * Parameters for creating a commitment.
 */
export interface CreateCommitmentParams {
  taskId: TaskId;
  agentId: AgentId;
  outputHash: string;
  inputStateHash: string;
  bondedStake?: Lamports; // If not provided, calculates from depth
}

/**
 * Configuration for CommitmentLedger.
 */
export interface CommitmentLedgerConfig {
  /** Stake configuration */
  stake: StakeConfig;
  
  /** Default commitment TTL (ms) */
  commitmentTtlMs: number;
  
  /** Maximum commitments per agent */
  maxCommitmentsPerAgent: number;
  
  /** GC interval (ms) */
  gcIntervalMs: number;
  
  /** How long to keep confirmed commitments */
  retainConfirmedMs: number;
}

/**
 * Result of a slash operation.
 */
export interface SlashResult {
  commitmentId: CommitmentId;
  agentId: AgentId;
  totalSlashed: Lamports;
  protocolShare: Lamports;
  affectedAgentsShare: Lamports;
  affectedAgents: Array<{
    agentId: AgentId;
    share: Lamports;
    wastedComputeMs: number;
  }>;
}

/**
 * Agent cooldown status.
 */
export interface AgentCooldownStatus {
  inCooldown: boolean;
  cooldownEndsAt?: TimestampMs;
  remainingMs?: number;
  reason?: RollbackReason;
}

/**
 * Commitment ledger statistics.
 */
export interface CommitmentLedgerStats {
  totalCommitments: number;
  activeCommitments: number;
  confirmedCommitments: number;
  invalidatedCommitments: number;
  totalBondedStake: Lamports;
  totalSlashedStake: Lamports;
  avgDepth: number;
  maxDepth: number;
  commitmentsByStatus: Record<CommitmentStatus, number>;
}
```

### 2.3 ProofDeferralManager

Manages proof generation jobs and deferral queue.

```typescript
/**
 * Manages proof generation jobs with deferral for ancestor dependencies.
 * Ensures proofs are only submitted when all ancestors are confirmed.
 * 
 * @example
 * ```typescript
 * const manager = new ProofDeferralManager(config);
 * 
 * // Queue a proof job
 * const job = await manager.queueProofJob({
 *   taskId: 'task-123',
 *   commitmentId: 'commitment-456',
 *   inputs: { ... },
 * });
 * 
 * // Check deferred status
 * const status = manager.getDeferredStatus(job.id);
 * ```
 */
export class ProofDeferralManager extends EventEmitter {
  /**
   * Creates a new ProofDeferralManager instance.
   * 
   * @param config - Configuration options
   * @param commitmentLedger - CommitmentLedger for ancestor tracking
   * @throws {ConfigurationError} If config is invalid
   */
  constructor(config: ProofDeferralConfig, commitmentLedger: CommitmentLedger);

  /**
   * Queues a proof generation job.
   * Job will be deferred if ancestors are not yet confirmed.
   * 
   * @param params - Job parameters
   * @returns The created job
   * @throws {DuplicateJobError} If job for task already exists
   * @throws {QueueFullError} If queue is at capacity
   * 
   * @emits proof.job.queued
   * @emits proof.job.deferred (if ancestors pending)
   */
  queueProofJob(params: QueueProofJobParams): Promise<ProofGenerationJob>;

  /**
   * Gets a proof job by ID.
   * 
   * @param jobId - The job ID
   * @returns The job or undefined
   */
  getJob(jobId: string): ProofGenerationJob | undefined;

  /**
   * Gets a proof job by task ID.
   * 
   * @param taskId - The task ID
   * @returns The job or undefined
   */
  getJobByTaskId(taskId: TaskId): ProofGenerationJob | undefined;

  /**
   * Gets the deferral status of a job.
   * 
   * @param jobId - The job ID
   * @returns Deferral status or undefined if not deferred
   */
  getDeferredStatus(jobId: string): DeferredProofStatus | undefined;

  /**
   * Notifies the manager that an ancestor was confirmed.
   * May trigger deferred jobs to proceed.
   * 
   * @param commitmentId - The confirmed commitment
   * @returns Jobs that are now ready to proceed
   * 
   * @emits proof.job.started (for each unblocked job)
   */
  onAncestorConfirmed(commitmentId: CommitmentId): Promise<ProofGenerationJob[]>;

  /**
   * Notifies the manager that an ancestor failed.
   * Cancels all dependent jobs.
   * 
   * @param commitmentId - The failed commitment
   * @param reason - Reason for failure
   * @returns Jobs that were cancelled
   * 
   * @emits proof.job.failed (for each cancelled job)
   */
  onAncestorFailed(
    commitmentId: CommitmentId,
    reason: RollbackReason
  ): Promise<ProofGenerationJob[]>;

  /**
   * Cancels a proof job.
   * 
   * @param jobId - The job to cancel
   * @param reason - Reason for cancellation
   * @throws {JobNotFoundError} If job doesn't exist
   * @throws {JobNotCancellableError} If job is already completed
   * 
   * @emits proof.job.failed
   */
  cancelJob(jobId: string, reason: string): Promise<void>;

  /**
   * Retries a failed job.
   * 
   * @param jobId - The job to retry
   * @returns The updated job
   * @throws {JobNotFoundError} If job doesn't exist
   * @throws {MaxRetriesExceededError} If retry limit reached
   * @throws {JobNotRetryableError} If job is not in failed state
   */
  retryJob(jobId: string): Promise<ProofGenerationJob>;

  /**
   * Gets all jobs in a given status.
   * 
   * @param status - Status filter
   * @returns Array of matching jobs
   */
  getJobsByStatus(status: ProofJobStatus): ProofGenerationJob[];

  /**
   * Gets the current queue depth.
   * 
   * @returns Number of jobs in queue
   */
  getQueueDepth(): number;

  /**
   * Gets the number of deferred jobs.
   * 
   * @returns Number of deferred jobs
   */
  getDeferredCount(): number;

  /**
   * Gets statistics about proof generation.
   * 
   * @returns Proof manager statistics
   */
  getStats(): ProofDeferralStats;

  /**
   * Starts the proof generation worker pool.
   */
  start(): Promise<void>;

  /**
   * Stops the worker pool gracefully.
   * 
   * @param timeoutMs - Max time to wait for in-progress jobs
   */
  stop(timeoutMs?: number): Promise<void>;

  /**
   * Pauses accepting new jobs (in-progress jobs continue).
   */
  pause(): void;

  /**
   * Resumes accepting new jobs.
   */
  resume(): void;
}

/**
 * Parameters for queuing a proof job.
 */
export interface QueueProofJobParams {
  taskId: TaskId;
  commitmentId: CommitmentId;
  inputs: ProofInputs;
  priority?: number;
}

/**
 * Configuration for ProofDeferralManager.
 */
export interface ProofDeferralConfig {
  /** Proof generation settings */
  proof: ProofConfig;
  
  /** Maximum queue size */
  maxQueueSize: number;
  
  /** Maximum deferred jobs */
  maxDeferredJobs: number;
  
  /** How often to check deferred jobs (ms) */
  deferralCheckIntervalMs: number;
  
  /** Timeout for waiting on ancestors (ms) */
  ancestorWaitTimeoutMs: number;
}

/**
 * Statistics for proof deferral.
 */
export interface ProofDeferralStats {
  totalJobsQueued: number;
  totalJobsCompleted: number;
  totalJobsFailed: number;
  totalJobsDeferred: number;
  currentQueueDepth: number;
  currentDeferredCount: number;
  avgGenerationTimeMs: number;
  avgWaitTimeMs: number;
  successRate: number;
  workerUtilization: number;
  jobsByStatus: Record<ProofJobStatus, number>;
}
```

### 2.4 RollbackController

Orchestrates rollback operations when speculation fails.

```typescript
/**
 * Orchestrates rollback of speculative execution chains.
 * Ensures rollback happens in correct order (leaves first).
 * 
 * @example
 * ```typescript
 * const controller = new RollbackController(config, dependencyGraph, commitmentLedger);
 * 
 * // Trigger rollback when ancestor fails
 * const result = await controller.rollback(failedCommitmentId, RollbackReason.ANCESTOR_PROOF_FAILED);
 * 
 * console.log(`Rolled back ${result.rolledBackTasks.length} tasks`);
 * ```
 */
export class RollbackController extends EventEmitter {
  /**
   * Creates a new RollbackController instance.
   * 
   * @param config - Configuration options
   * @param dependencyGraph - DependencyGraph for traversal
   * @param commitmentLedger - CommitmentLedger for commitment updates
   * @param proofDeferralManager - ProofDeferralManager for job cancellation
   */
  constructor(
    config: RollbackControllerConfig,
    dependencyGraph: DependencyGraph,
    commitmentLedger: CommitmentLedger,
    proofDeferralManager: ProofDeferralManager
  );

  /**
   * Initiates a rollback from a failed commitment.
   * Rolls back all dependent speculative work in reverse topological order.
   * 
   * @param triggerCommitmentId - The commitment that failed
   * @param reason - Why the rollback is happening
   * @returns Complete rollback result
   * @throws {RollbackInProgressError} If rollback already in progress for this chain
   * @throws {CommitmentNotFoundError} If trigger commitment doesn't exist
   * 
   * @emits rollback.started
   * @emits rollback.task.reverted (for each task)
   * @emits rollback.completed
   */
  rollback(
    triggerCommitmentId: CommitmentId,
    reason: RollbackReason
  ): Promise<RollbackResult>;

  /**
   * Performs a dry-run of rollback without making changes.
   * Useful for impact analysis.
   * 
   * @param triggerCommitmentId - The commitment that would fail
   * @returns Simulated rollback result
   */
  simulateRollback(triggerCommitmentId: CommitmentId): Promise<RollbackSimulation>;

  /**
   * Checks if a rollback is currently in progress.
   * 
   * @param commitmentId - Optional commitment to check
   * @returns Whether rollback is in progress
   */
  isRollbackInProgress(commitmentId?: CommitmentId): boolean;

  /**
   * Gets the status of an ongoing rollback.
   * 
   * @param rollbackId - The rollback operation ID
   * @returns Current rollback status or undefined
   */
  getRollbackStatus(rollbackId: string): RollbackStatus | undefined;

  /**
   * Cancels an in-progress rollback (if possible).
   * Only works in early stages before state changes.
   * 
   * @param rollbackId - The rollback to cancel
   * @throws {RollbackNotCancellableError} If rollback has progressed too far
   */
  cancelRollback(rollbackId: string): Promise<void>;

  /**
   * Gets history of completed rollbacks.
   * 
   * @param limit - Maximum results to return
   * @param offset - Offset for pagination
   * @returns Array of rollback results
   */
  getRollbackHistory(limit?: number, offset?: number): RollbackResult[];

  /**
   * Gets statistics about rollbacks.
   * 
   * @returns Rollback statistics
   */
  getStats(): RollbackControllerStats;
}

/**
 * Configuration for RollbackController.
 */
export interface RollbackControllerConfig {
  /** Rollback policy */
  policy: RollbackPolicy;
  
  /** Maximum concurrent rollbacks */
  maxConcurrentRollbacks: number;
  
  /** Timeout for rollback operations (ms) */
  rollbackTimeoutMs: number;
  
  /** Whether to preserve state snapshots */
  preserveSnapshots: boolean;
  
  /** Grace period before forcing (ms) */
  gracePeriodMs: number;
  
  /** Whether to notify affected agents */
  notifyAgents: boolean;
  
  /** Maximum rollback cascade size */
  maxCascadeSize: number;
  
  /** How long to retain rollback history */
  historyRetentionMs: number;
}

/**
 * Simulated rollback result (without actual changes).
 */
export interface RollbackSimulation {
  triggerCommitmentId: CommitmentId;
  affectedTasks: TaskId[];
  affectedCommitments: CommitmentId[];
  estimatedDurationMs: number;
  totalStakeAtRisk: Lamports;
  totalComputeAtRisk: number;
  maxCascadeDepth: number;
  affectedAgents: AgentId[];
}

/**
 * Status of an in-progress rollback.
 */
export interface RollbackStatus {
  rollbackId: string;
  phase: RollbackPhase;
  progress: number; // 0-100
  tasksRolledBack: number;
  totalTasksToRollback: number;
  startedAt: TimestampMs;
  estimatedCompletionMs: number;
  currentTask?: TaskId;
  errors: RollbackError[];
}

/**
 * Statistics about rollbacks.
 */
export interface RollbackControllerStats {
  totalRollbacks: number;
  successfulRollbacks: number;
  failedRollbacks: number;
  totalTasksRolledBack: number;
  totalStakeSlashed: Lamports;
  totalComputeWasted: number;
  avgRollbackDurationMs: number;
  avgCascadeDepth: number;
  rollbacksByReason: Record<RollbackReason, number>;
  activeRollbacks: number;
}
```

### 2.5 SpeculativeTaskScheduler

High-level orchestrator for speculative task execution.

```typescript
/**
 * High-level orchestrator for speculative task execution.
 * Coordinates all components and makes speculation decisions.
 * 
 * @example
 * ```typescript
 * const scheduler = new SpeculativeTaskScheduler(config);
 * 
 * // Start the scheduler
 * await scheduler.start();
 * 
 * // Submit a task for scheduling
 * const decision = await scheduler.scheduleTask(task, 'parent-task-id');
 * 
 * if (decision.shouldSpeculate) {
 *   console.log(`Speculating at depth ${decision.depth}`);
 * }
 * ```
 */
export class SpeculativeTaskScheduler extends EventEmitter {
  /**
   * Creates a new SpeculativeTaskScheduler instance.
   * 
   * @param config - Complete speculation configuration
   */
  constructor(config: SpeculationConfig);

  /**
   * Starts the scheduler and all sub-components.
   * 
   * @throws {AlreadyStartedError} If already running
   */
  start(): Promise<void>;

  /**
   * Stops the scheduler gracefully.
   * Waits for in-progress operations to complete.
   * 
   * @param timeoutMs - Maximum time to wait
   */
  stop(timeoutMs?: number): Promise<void>;

  /**
   * Pauses scheduling (in-progress work continues).
   * 
   * @param reason - Reason for pausing
   * 
   * @emits system.paused
   */
  pause(reason: string): void;

  /**
   * Resumes scheduling after pause.
   * 
   * @emits system.resumed
   */
  resume(): void;

  /**
   * Schedules a task for execution, deciding whether to speculate.
   * 
   * @param task - The task to schedule
   * @param dependsOn - Optional parent task ID
   * @returns Speculation decision
   * @throws {SchedulerNotRunningError} If scheduler is stopped
   * @throws {TaskValidationError} If task is invalid
   * 
   * @emits speculation.decision
   * @emits task.added
   * @emits commitment.created (if speculating)
   */
  scheduleTask(task: TaskNode, dependsOn?: TaskId): Promise<SpeculationDecision>;

  /**
   * Manually triggers evaluation of speculation decision.
   * 
   * @param taskId - Task to evaluate
   * @returns Updated speculation decision
   */
  evaluateSpeculation(taskId: TaskId): Promise<SpeculationDecision>;

  /**
   * Reports task completion.
   * 
   * @param taskId - Completed task
   * @param output - Task output
   * @throws {TaskNotFoundError} If task doesn't exist
   * 
   * @emits task.completed
   * @emits proof.job.queued
   */
  reportCompletion(taskId: TaskId, output: TaskOutput): Promise<void>;

  /**
   * Reports task failure.
   * 
   * @param taskId - Failed task
   * @param error - Error details
   * @throws {TaskNotFoundError} If task doesn't exist
   * 
   * @emits task.failed
   * @emits rollback.started (if speculative)
   */
  reportFailure(taskId: TaskId, error: Error): Promise<void>;

  /**
   * Reports on-chain confirmation of a task's proof.
   * 
   * @param taskId - Confirmed task
   * @param txSignature - Transaction signature
   * @param slot - Confirmation slot
   * 
   * @emits commitment.confirmed
   * @emits proof.verified
   */
  reportConfirmation(
    taskId: TaskId,
    txSignature: string,
    slot: number
  ): Promise<void>;

  /**
   * Gets the next batch of tasks ready for execution.
   * 
   * @param maxTasks - Maximum tasks to return
   * @param includeSpeculative - Include speculatively ready tasks
   * @returns Array of ready tasks
   */
  getReadyTasks(maxTasks?: number, includeSpeculative?: boolean): TaskNode[];

  /**
   * Gets the current state of a task.
   * 
   * @param taskId - Task to query
   * @returns Task state or undefined
   */
  getTaskState(taskId: TaskId): TaskState | undefined;

  /**
   * Gets the full speculation chain for a task.
   * 
   * @param taskId - Task to query
   * @returns Speculation chain details
   */
  getSpeculationChain(taskId: TaskId): SpeculationChain;

  /**
   * Updates configuration at runtime.
   * 
   * @param config - Partial config to update
   * @throws {InvalidConfigError} If config is invalid
   * 
   * @emits system.config.changed
   */
  updateConfig(config: Partial<SpeculationConfig>): void;

  /**
   * Gets the current configuration.
   * 
   * @returns Current config
   */
  getConfig(): SpeculationConfig;

  /**
   * Gets comprehensive statistics.
   * 
   * @returns Scheduler statistics
   */
  getStats(): SchedulerStats;

  /**
   * Gets health status of all components.
   * 
   * @returns Health check result
   */
  healthCheck(): HealthCheckResult;

  // Component accessors
  readonly dependencyGraph: DependencyGraph;
  readonly commitmentLedger: CommitmentLedger;
  readonly proofDeferralManager: ProofDeferralManager;
  readonly rollbackController: RollbackController;
}

/**
 * Task output after completion.
 */
export interface TaskOutput {
  outputHash: string;
  executionTrace: Uint8Array;
  computeTimeMs: number;
  gasUsed?: bigint;
  logs?: string[];
}

/**
 * Complete task state.
 */
export interface TaskState {
  task: TaskNode;
  commitment?: SpeculativeCommitment;
  proofJob?: ProofGenerationJob;
  speculationDecision?: SpeculationDecision;
  rollbackResult?: RollbackResult;
}

/**
 * Speculation chain details.
 */
export interface SpeculationChain {
  taskId: TaskId;
  depth: number;
  ancestors: Array<{
    taskId: TaskId;
    commitmentId: CommitmentId;
    status: CommitmentStatus;
    proofState: ProofState;
  }>;
  descendants: Array<{
    taskId: TaskId;
    commitmentId: CommitmentId;
    status: CommitmentStatus;
  }>;
  totalStakeBonded: Lamports;
  estimatedConfirmationMs: number;
}

/**
 * Comprehensive scheduler statistics.
 */
export interface SchedulerStats {
  uptime: number;
  tasksScheduled: number;
  tasksCompleted: number;
  tasksFailed: number;
  speculativeExecutions: number;
  confirmations: number;
  rollbacks: number;
  avgSpeculationDepth: number;
  maxSpeculationDepth: number;
  avgConfirmationTimeMs: number;
  throughputTasksPerSecond: number;
  latencyReduction: number; // Percentage improvement from speculation
  graph: DependencyGraphStats;
  ledger: CommitmentLedgerStats;
  proofs: ProofDeferralStats;
  rollbackController: RollbackControllerStats;
}

/**
 * Health check result.
 */
export interface HealthCheckResult {
  healthy: boolean;
  components: Record<string, ComponentHealth>;
  issues: string[];
  lastCheck: TimestampMs;
}

/**
 * Health of a single component.
 */
export interface ComponentHealth {
  name: string;
  healthy: boolean;
  status: 'running' | 'paused' | 'stopped' | 'error';
  lastActivity: TimestampMs;
  errorCount: number;
  latencyMs?: number;
}
```

---

## 3. Events

### 3.1 Event Emitter Pattern

All components extend `EventEmitter` and emit typed events:

```typescript
import { EventEmitter } from 'events';

/**
 * Type-safe event emitter for speculation events.
 */
export interface TypedEventEmitter<Events extends Record<string, unknown>> {
  on<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): this;
  once<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): this;
  off<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): this;
  emit<E extends keyof Events>(event: E, payload: Events[E]): boolean;
}

/**
 * Map of event names to payload types.
 */
export interface SpeculationEvents {
  // Task events
  'task.added': TaskAddedPayload;
  'task.ready': TaskReadyPayload;
  'task.started': TaskStartedPayload;
  'task.completed': TaskCompletedPayload;
  'task.failed': TaskFailedPayload;
  
  // Commitment events
  'commitment.created': CommitmentCreatedPayload;
  'commitment.confirmed': CommitmentConfirmedPayload;
  'commitment.expired': CommitmentExpiredPayload;
  'commitment.invalidated': CommitmentInvalidatedPayload;
  
  // Proof events
  'proof.job.queued': ProofJobQueuedPayload;
  'proof.job.started': ProofJobStartedPayload;
  'proof.job.completed': ProofJobCompletedPayload;
  'proof.job.failed': ProofJobFailedPayload;
  'proof.job.deferred': ProofJobDeferredPayload;
  'proof.submitted': ProofSubmittedPayload;
  'proof.verified': ProofVerifiedPayload;
  
  // Rollback events
  'rollback.started': RollbackStartedPayload;
  'rollback.task.reverted': RollbackTaskRevertedPayload;
  'rollback.completed': RollbackCompletedPayload;
  'rollback.failed': RollbackFailedPayload;
  
  // Stake events
  'stake.bonded': StakeBondedPayload;
  'stake.released': StakeReleasedPayload;
  'stake.slashed': StakeSlashedPayload;
  
  // Decision events
  'speculation.decision': SpeculationDecisionPayload;
  
  // System events
  'system.depth.limit': DepthLimitReachedPayload;
  'system.resource.limit': ResourceLimitReachedPayload;
  'system.config.changed': ConfigChangedPayload;
  'system.paused': SystemPausedPayload;
  'system.resumed': SystemResumedPayload;
}
```

### 3.2 Event Handler Examples

```typescript
// Task completion handler
scheduler.on('task.completed', (payload: TaskCompletedPayload) => {
  console.log(`Task ${payload.taskId} completed in ${payload.computeTimeMs}ms`);
  
  if (payload.isSpeculative) {
    metrics.speculativeCompletions.inc();
  }
  
  // Update dashboards
  dashboard.updateTaskStatus(payload.taskId, 'completed');
});

// Rollback handler with alerting
scheduler.on('rollback.started', (payload: RollbackStartedPayload) => {
  console.warn(`Rollback initiated for commitment ${payload.triggerCommitmentId}`);
  console.warn(`Reason: ${payload.reason}`);
  console.warn(`Estimated ${payload.estimatedTaskCount} tasks affected`);
  
  // Alert if large rollback
  if (payload.estimatedTaskCount > 10) {
    alerting.send({
      severity: 'warning',
      message: `Large rollback: ${payload.estimatedTaskCount} tasks`,
      metadata: payload,
    });
  }
});

// Stake slashing handler
scheduler.on('stake.slashed', (payload: StakeSlashedPayload) => {
  console.error(`Agent ${payload.agentId} slashed ${payload.slashedAmount} lamports`);
  
  // Record for analytics
  analytics.recordSlash({
    agentId: payload.agentId,
    amount: payload.slashedAmount,
    reason: payload.reason,
    timestamp: Date.now(),
  });
  
  // Notify affected agents
  for (const { agentId, share } of payload.affectedAgentsShare) {
    notifications.send(agentId, {
      type: 'slash_compensation',
      amount: share,
      fromAgent: payload.agentId,
    });
  }
});

// Proof deferral monitoring
scheduler.on('proof.job.deferred', (payload: ProofJobDeferredPayload) => {
  console.log(`Proof for task ${payload.taskId} deferred`);
  console.log(`Waiting on ${payload.pendingAncestors.length} ancestors`);
  console.log(`Estimated wait: ${payload.estimatedWaitMs}ms`);
  
  metrics.deferredProofs.inc();
  metrics.deferralWaitTime.observe(payload.estimatedWaitMs);
});

// Configuration change handler
scheduler.on('system.config.changed', (payload: ConfigChangedPayload) => {
  console.log(`Configuration changed by ${payload.changedBy}`);
  
  for (const key of payload.changedKeys) {
    console.log(`  ${key}: ${payload.previousValues[key]} -> ${payload.newValues[key]}`);
  }
  
  // Audit log
  audit.log({
    action: 'config_change',
    changedBy: payload.changedBy,
    changes: payload.changedKeys,
    timestamp: Date.now(),
  });
});

// Comprehensive event logger
function setupEventLogging(scheduler: SpeculativeTaskScheduler) {
  const events: (keyof SpeculationEvents)[] = [
    'task.added',
    'task.ready',
    'task.started',
    'task.completed',
    'task.failed',
    'commitment.created',
    'commitment.confirmed',
    'commitment.expired',
    'commitment.invalidated',
    'proof.job.queued',
    'proof.job.started',
    'proof.job.completed',
    'proof.job.failed',
    'proof.job.deferred',
    'proof.submitted',
    'proof.verified',
    'rollback.started',
    'rollback.task.reverted',
    'rollback.completed',
    'rollback.failed',
    'stake.bonded',
    'stake.released',
    'stake.slashed',
    'speculation.decision',
    'system.depth.limit',
    'system.resource.limit',
    'system.config.changed',
    'system.paused',
    'system.resumed',
  ];
  
  for (const event of events) {
    scheduler.on(event, (payload) => {
      logger.debug({
        event,
        payload,
        timestamp: Date.now(),
      });
    });
  }
}
```

---

## 4. Configuration Schema

### 4.1 JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://agenc.ai/schemas/speculation-config.json",
  "title": "SpeculationConfig",
  "description": "Configuration schema for the Speculative Execution system",
  "type": "object",
  "required": ["enabled", "mode", "core", "stake", "proof", "limits", "features"],
  "properties": {
    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "Master switch for speculative execution"
    },
    "mode": {
      "type": "string",
      "enum": ["conservative", "balanced", "aggressive", "custom"],
      "default": "conservative",
      "description": "Operating mode preset"
    },
    "core": {
      "type": "object",
      "description": "Core speculation settings",
      "required": ["maxDepth", "maxParallelBranches", "confirmationTimeoutMs"],
      "properties": {
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20,
          "default": 5,
          "description": "Maximum speculation chain depth"
        },
        "maxParallelBranches": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16,
          "default": 4,
          "description": "Maximum concurrent speculation branches"
        },
        "confirmationTimeoutMs": {
          "type": "integer",
          "minimum": 5000,
          "maximum": 300000,
          "default": 30000,
          "description": "Timeout for confirmation (milliseconds)"
        },
        "claimBufferMs": {
          "type": "integer",
          "minimum": 10000,
          "maximum": 600000,
          "default": 60000,
          "description": "Minimum buffer before claim expiry (milliseconds)"
        },
        "minConfidenceScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100,
          "default": 70,
          "description": "Minimum confidence score to speculate (0-100)"
        },
        "allowCrossAgentSpeculation": {
          "type": "boolean",
          "default": false,
          "description": "Whether to allow speculation on other agents' tasks"
        }
      }
    },
    "stake": {
      "type": "object",
      "description": "Stake management settings",
      "required": ["minStake", "maxStake", "baseBond", "slashPercentage"],
      "properties": {
        "minStake": {
          "type": "string",
          "pattern": "^[0-9]+$",
          "default": "1000000",
          "description": "Minimum stake to speculate (lamports as string for bigint)"
        },
        "maxStake": {
          "type": "string",
          "pattern": "^[0-9]+$",
          "default": "1000000000",
          "description": "Maximum total stake per agent (lamports)"
        },
        "baseBond": {
          "type": "string",
          "pattern": "^[0-9]+$",
          "default": "100000",
          "description": "Base stake per speculation (lamports)"
        },
        "depthMultiplier": {
          "type": "number",
          "minimum": 1.0,
          "maximum": 10.0,
          "default": 2.0,
          "description": "Stake multiplier per depth level (exponential)"
        },
        "slashPercentage": {
          "type": "number",
          "minimum": 0.01,
          "maximum": 0.5,
          "default": 0.1,
          "description": "Percentage of stake slashed on failure (0-1)"
        },
        "protocolSlashShare": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 1.0,
          "default": 0.5,
          "description": "Portion of slash to protocol treasury (0-1)"
        },
        "cooldownPeriodMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3600000,
          "default": 60000,
          "description": "Cooldown after slash (milliseconds)"
        }
      }
    },
    "proof": {
      "type": "object",
      "description": "Proof generation settings",
      "required": ["generator", "workerThreads", "queueSize", "timeoutMs"],
      "properties": {
        "generator": {
          "type": "string",
          "enum": ["groth16", "plonk", "stark", "mock"],
          "default": "groth16",
          "description": "Proof system to use"
        },
        "workerThreads": {
          "type": "integer",
          "minimum": 1,
          "maximum": 32,
          "default": 4,
          "description": "Number of proof generation worker threads"
        },
        "queueSize": {
          "type": "integer",
          "minimum": 100,
          "maximum": 10000,
          "default": 1000,
          "description": "Maximum proof generation queue size"
        },
        "timeoutMs": {
          "type": "integer",
          "minimum": 10000,
          "maximum": 600000,
          "default": 60000,
          "description": "Proof generation timeout (milliseconds)"
        },
        "batchSize": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 10,
          "description": "Number of proofs to batch together"
        },
        "maxRetries": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10,
          "default": 3,
          "description": "Maximum retry attempts on failure"
        },
        "retryDelayMs": {
          "type": "integer",
          "minimum": 100,
          "maximum": 60000,
          "default": 1000,
          "description": "Base retry delay (milliseconds)"
        },
        "retryMultiplier": {
          "type": "number",
          "minimum": 1.0,
          "maximum": 5.0,
          "default": 2.0,
          "description": "Retry delay multiplier for exponential backoff"
        },
        "optimisticGeneration": {
          "type": "boolean",
          "default": true,
          "description": "Generate proofs before ancestor confirmation"
        }
      }
    },
    "limits": {
      "type": "object",
      "description": "Resource limits",
      "required": ["maxMemoryMb", "maxPendingOperations"],
      "properties": {
        "maxMemoryMb": {
          "type": "integer",
          "minimum": 512,
          "maximum": 65536,
          "default": 4096,
          "description": "Maximum memory for speculation state (MB)"
        },
        "maxPendingOperations": {
          "type": "integer",
          "minimum": 100,
          "maximum": 1000000,
          "default": 10000,
          "description": "Maximum pending speculative operations"
        },
        "maxStateSnapshots": {
          "type": "integer",
          "minimum": 10,
          "maximum": 10000,
          "default": 100,
          "description": "Maximum concurrent state snapshots"
        },
        "gcIntervalMs": {
          "type": "integer",
          "minimum": 5000,
          "maximum": 300000,
          "default": 30000,
          "description": "Garbage collection interval (milliseconds)"
        },
        "maxCommitmentAgeMs": {
          "type": "integer",
          "minimum": 60000,
          "maximum": 86400000,
          "default": 3600000,
          "description": "Maximum commitment age before expiry (milliseconds)"
        },
        "maxRollbackCascadeSize": {
          "type": "integer",
          "minimum": 10,
          "maximum": 10000,
          "default": 1000,
          "description": "Maximum tasks in a single rollback cascade"
        }
      }
    },
    "features": {
      "type": "object",
      "description": "Feature flags",
      "properties": {
        "enableParallelSpeculation": {
          "type": "boolean",
          "default": true,
          "description": "Allow multiple speculation branches"
        },
        "enableCrossAgentSpeculation": {
          "type": "boolean",
          "default": false,
          "description": "Allow speculation on other agents' speculative state"
        },
        "enableOptimisticProofs": {
          "type": "boolean",
          "default": true,
          "description": "Generate proofs before confirmation"
        },
        "enableStakeDelegation": {
          "type": "boolean",
          "default": false,
          "description": "Allow stake delegation for speculation"
        },
        "enableOnChainCommitments": {
          "type": "boolean",
          "default": false,
          "description": "Record commitments on-chain (vs runtime-only)"
        },
        "rolloutPercentage": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 100.0,
          "default": 100.0,
          "description": "Percentage of operations using speculation"
        },
        "enableDetailedMetrics": {
          "type": "boolean",
          "default": false,
          "description": "Enable detailed performance metrics"
        }
      }
    },
    "scheduler": {
      "type": "object",
      "description": "Scheduler settings",
      "properties": {
        "schedulingIntervalMs": {
          "type": "integer",
          "minimum": 10,
          "maximum": 10000,
          "default": 100,
          "description": "Scheduling loop interval (milliseconds)"
        },
        "maxTasksPerCycle": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "default": 50,
          "description": "Maximum tasks to process per scheduling cycle"
        },
        "depthPriorityWeight": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 10.0,
          "default": 1.0,
          "description": "Priority weight for speculation depth"
        },
        "expiryPriorityWeight": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 10.0,
          "default": 2.0,
          "description": "Priority weight for claim expiry urgency"
        },
        "taskPriorityWeight": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 10.0,
          "default": 1.0,
          "description": "Priority weight for task-level priority"
        },
        "useExpectedValueDecisions": {
          "type": "boolean",
          "default": true,
          "description": "Use expected value calculation for decisions"
        },
        "minExpectedValue": {
          "type": "number",
          "minimum": -1000.0,
          "maximum": 1000.0,
          "default": 0.0,
          "description": "Minimum expected value to speculate"
        }
      }
    },
    "rollback": {
      "type": "object",
      "description": "Rollback settings",
      "properties": {
        "policy": {
          "type": "string",
          "enum": ["cascade", "selective", "checkpoint"],
          "default": "cascade",
          "description": "Rollback policy"
        },
        "maxConcurrentRollbacks": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "default": 3,
          "description": "Maximum concurrent rollback operations"
        },
        "rollbackTimeoutMs": {
          "type": "integer",
          "minimum": 10000,
          "maximum": 600000,
          "default": 120000,
          "description": "Rollback operation timeout (milliseconds)"
        },
        "preserveSnapshotsAfterRollback": {
          "type": "boolean",
          "default": false,
          "description": "Keep state snapshots after rollback for debugging"
        },
        "gracePeriodMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 60000,
          "default": 5000,
          "description": "Grace period before forcing rollback (milliseconds)"
        },
        "notifyAffectedAgents": {
          "type": "boolean",
          "default": true,
          "description": "Send notifications to affected agents"
        }
      }
    }
  }
}
```

### 4.2 Configuration Defaults by Mode

| Setting | Conservative | Balanced | Aggressive |
|---------|-------------|----------|------------|
| `core.maxDepth` | 3 | 5 | 10 |
| `core.maxParallelBranches` | 2 | 4 | 8 |
| `core.confirmationTimeoutMs` | 60000 | 30000 | 15000 |
| `core.minConfidenceScore` | 80 | 70 | 50 |
| `stake.slashPercentage` | 0.15 | 0.10 | 0.05 |
| `limits.maxPendingOperations` | 5000 | 10000 | 50000 |
| `rollback.policy` | cascade | cascade | selective |

---

## 5. Error Types

### 5.1 Error Hierarchy

```typescript
/**
 * Base error class for all speculation-related errors.
 */
export class SpeculationError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  
  /** HTTP status code equivalent */
  readonly statusCode: number;
  
  /** Whether this error is retryable */
  readonly retryable: boolean;
  
  /** Additional context */
  readonly context: Record<string, unknown>;
  
  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    retryable: boolean = false,
    context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SpeculationError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.context = context;
  }
}

// ============================================
// Configuration Errors
// ============================================

/**
 * Invalid configuration provided.
 */
export class ConfigurationError extends SpeculationError {
  readonly invalidFields: string[];
  
  constructor(message: string, invalidFields: string[]) {
    super(message, 'CONFIGURATION_ERROR', 400, false, { invalidFields });
    this.name = 'ConfigurationError';
    this.invalidFields = invalidFields;
  }
}

/**
 * Configuration value out of allowed range.
 */
export class ConfigurationRangeError extends ConfigurationError {
  readonly field: string;
  readonly value: unknown;
  readonly min?: number;
  readonly max?: number;
  
  constructor(field: string, value: unknown, min?: number, max?: number) {
    super(
      `Configuration value for '${field}' is out of range: ${value} (allowed: ${min}-${max})`,
      [field]
    );
    this.name = 'ConfigurationRangeError';
    this.field = field;
    this.value = value;
    this.min = min;
    this.max = max;
  }
}

// ============================================
// Task Errors
// ============================================

/**
 * Task not found in the system.
 */
export class TaskNotFoundError extends SpeculationError {
  readonly taskId: TaskId;
  
  constructor(taskId: TaskId) {
    super(`Task not found: ${taskId}`, 'TASK_NOT_FOUND', 404, false, { taskId });
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/**
 * Task already exists with the given ID.
 */
export class DuplicateTaskError extends SpeculationError {
  readonly taskId: TaskId;
  
  constructor(taskId: TaskId) {
    super(`Task already exists: ${taskId}`, 'DUPLICATE_TASK', 409, false, { taskId });
    this.name = 'DuplicateTaskError';
    this.taskId = taskId;
  }
}

/**
 * Task validation failed.
 */
export class TaskValidationError extends SpeculationError {
  readonly taskId: TaskId;
  readonly validationErrors: string[];
  
  constructor(taskId: TaskId, validationErrors: string[]) {
    super(
      `Task validation failed: ${validationErrors.join(', ')}`,
      'TASK_VALIDATION_FAILED',
      400,
      false,
      { taskId, validationErrors }
    );
    this.name = 'TaskValidationError';
    this.taskId = taskId;
    this.validationErrors = validationErrors;
  }
}

/**
 * Invalid state transition for a task.
 */
export class InvalidStateTransitionError extends SpeculationError {
  readonly taskId: TaskId;
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
  
  constructor(taskId: TaskId, fromStatus: TaskStatus, toStatus: TaskStatus) {
    super(
      `Invalid state transition for task ${taskId}: ${fromStatus} -> ${toStatus}`,
      'INVALID_STATE_TRANSITION',
      400,
      false,
      { taskId, fromStatus, toStatus }
    );
    this.name = 'InvalidStateTransitionError';
    this.taskId = taskId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

// ============================================
// Dependency Errors
// ============================================

/**
 * Invalid dependency relationship.
 */
export class InvalidDependencyError extends SpeculationError {
  readonly taskId: TaskId;
  readonly dependsOn: TaskId;
  readonly reason: string;
  
  constructor(taskId: TaskId, dependsOn: TaskId, reason: string) {
    super(
      `Invalid dependency: ${taskId} cannot depend on ${dependsOn} - ${reason}`,
      'INVALID_DEPENDENCY',
      400,
      false,
      { taskId, dependsOn, reason }
    );
    this.name = 'InvalidDependencyError';
    this.taskId = taskId;
    this.dependsOn = dependsOn;
    this.reason = reason;
  }
}

/**
 * Cycle detected in dependency graph.
 */
export class CycleDetectedError extends SpeculationError {
  readonly cycle: TaskId[];
  
  constructor(cycle: TaskId[]) {
    super(
      `Cycle detected in dependency graph: ${cycle.join(' -> ')}`,
      'CYCLE_DETECTED',
      400,
      false,
      { cycle }
    );
    this.name = 'CycleDetectedError';
    this.cycle = cycle;
  }
}

/**
 * Task has dependents and cannot be removed.
 */
export class HasDependentsError extends SpeculationError {
  readonly taskId: TaskId;
  readonly dependentIds: TaskId[];
  
  constructor(taskId: TaskId, dependentIds: TaskId[]) {
    super(
      `Task ${taskId} has ${dependentIds.length} dependents and cannot be removed`,
      'HAS_DEPENDENTS',
      400,
      false,
      { taskId, dependentIds }
    );
    this.name = 'HasDependentsError';
    this.taskId = taskId;
    this.dependentIds = dependentIds;
  }
}

// ============================================
// Commitment Errors
// ============================================

/**
 * Commitment not found.
 */
export class CommitmentNotFoundError extends SpeculationError {
  readonly commitmentId: CommitmentId;
  
  constructor(commitmentId: CommitmentId) {
    super(
      `Commitment not found: ${commitmentId}`,
      'COMMITMENT_NOT_FOUND',
      404,
      false,
      { commitmentId }
    );
    this.name = 'CommitmentNotFoundError';
    this.commitmentId = commitmentId;
  }
}

/**
 * Duplicate commitment for a task.
 */
export class DuplicateCommitmentError extends SpeculationError {
  readonly taskId: TaskId;
  readonly existingCommitmentId: CommitmentId;
  
  constructor(taskId: TaskId, existingCommitmentId: CommitmentId) {
    super(
      `Commitment already exists for task ${taskId}: ${existingCommitmentId}`,
      'DUPLICATE_COMMITMENT',
      409,
      false,
      { taskId, existingCommitmentId }
    );
    this.name = 'DuplicateCommitmentError';
    this.taskId = taskId;
    this.existingCommitmentId = existingCommitmentId;
  }
}

/**
 * Commitment is in an invalid state for the operation.
 */
export class InvalidCommitmentStateError extends SpeculationError {
  readonly commitmentId: CommitmentId;
  readonly currentStatus: CommitmentStatus;
  readonly operation: string;
  
  constructor(commitmentId: CommitmentId, currentStatus: CommitmentStatus, operation: string) {
    super(
      `Cannot ${operation} commitment ${commitmentId} in state ${currentStatus}`,
      'INVALID_COMMITMENT_STATE',
      400,
      false,
      { commitmentId, currentStatus, operation }
    );
    this.name = 'InvalidCommitmentStateError';
    this.commitmentId = commitmentId;
    this.currentStatus = currentStatus;
    this.operation = operation;
  }
}

/**
 * Parent commitment not found or invalid.
 */
export class ParentCommitmentError extends SpeculationError {
  readonly taskId: TaskId;
  readonly parentTaskId: TaskId;
  readonly reason: string;
  
  constructor(taskId: TaskId, parentTaskId: TaskId, reason: string) {
    super(
      `Invalid parent commitment for task ${taskId}: ${reason}`,
      'PARENT_COMMITMENT_ERROR',
      400,
      false,
      { taskId, parentTaskId, reason }
    );
    this.name = 'ParentCommitmentError';
    this.taskId = taskId;
    this.parentTaskId = parentTaskId;
    this.reason = reason;
  }
}

/**
 * Commitment has already been slashed.
 */
export class AlreadySlashedError extends SpeculationError {
  readonly commitmentId: CommitmentId;
  
  constructor(commitmentId: CommitmentId) {
    super(
      `Commitment ${commitmentId} has already been slashed`,
      'ALREADY_SLASHED',
      400,
      false,
      { commitmentId }
    );
    this.name = 'AlreadySlashedError';
    this.commitmentId = commitmentId;
  }
}

// ============================================
// Stake Errors
// ============================================

/**
 * Insufficient stake for the operation.
 */
export class InsufficientStakeError extends SpeculationError {
  readonly agentId: AgentId;
  readonly required: Lamports;
  readonly available: Lamports;
  
  constructor(agentId: AgentId, required: Lamports, available: Lamports) {
    super(
      `Insufficient stake for agent ${agentId}: required ${required}, available ${available}`,
      'INSUFFICIENT_STAKE',
      400,
      false,
      { agentId, required: required.toString(), available: available.toString() }
    );
    this.name = 'InsufficientStakeError';
    this.agentId = agentId;
    this.required = required;
    this.available = available;
  }
}

/**
 * Agent is in cooldown period after slash.
 */
export class AgentCooldownError extends SpeculationError {
  readonly agentId: AgentId;
  readonly cooldownEndsAt: TimestampMs;
  readonly remainingMs: number;
  
  constructor(agentId: AgentId, cooldownEndsAt: TimestampMs) {
    const remainingMs = Math.max(0, cooldownEndsAt - Date.now());
    super(
      `Agent ${agentId} is in cooldown until ${new Date(cooldownEndsAt).toISOString()}`,
      'AGENT_COOLDOWN',
      429,
      true,
      { agentId, cooldownEndsAt, remainingMs }
    );
    this.name = 'AgentCooldownError';
    this.agentId = agentId;
    this.cooldownEndsAt = cooldownEndsAt;
    this.remainingMs = remainingMs;
  }
}

// ============================================
// Depth Errors
// ============================================

/**
 * Speculation depth exceeded maximum.
 */
export class DepthExceededError extends SpeculationError {
  readonly taskId: TaskId;
  readonly currentDepth: number;
  readonly maxDepth: number;
  
  constructor(taskId: TaskId, currentDepth: number, maxDepth: number) {
    super(
      `Speculation depth exceeded for task ${taskId}: ${currentDepth} > ${maxDepth}`,
      'DEPTH_EXCEEDED',
      400,
      false,
      { taskId, currentDepth, maxDepth }
    );
    this.name = 'DepthExceededError';
    this.taskId = taskId;
    this.currentDepth = currentDepth;
    this.maxDepth = maxDepth;
  }
}

// ============================================
// Proof Errors
// ============================================

/**
 * Proof generation job not found.
 */
export class JobNotFoundError extends SpeculationError {
  readonly jobId: string;
  
  constructor(jobId: string) {
    super(`Proof job not found: ${jobId}`, 'JOB_NOT_FOUND', 404, false, { jobId });
    this.name = 'JobNotFoundError';
    this.jobId = jobId;
  }
}

/**
 * Duplicate proof job for a task.
 */
export class DuplicateJobError extends SpeculationError {
  readonly taskId: TaskId;
  readonly existingJobId: string;
  
  constructor(taskId: TaskId, existingJobId: string) {
    super(
      `Proof job already exists for task ${taskId}: ${existingJobId}`,
      'DUPLICATE_JOB',
      409,
      false,
      { taskId, existingJobId }
    );
    this.name = 'DuplicateJobError';
    this.taskId = taskId;
    this.existingJobId = existingJobId;
  }
}

/**
 * Proof queue is full.
 */
export class QueueFullError extends SpeculationError {
  readonly queueSize: number;
  readonly maxSize: number;
  
  constructor(queueSize: number, maxSize: number) {
    super(
      `Proof queue is full: ${queueSize}/${maxSize}`,
      'QUEUE_FULL',
      503,
      true,
      { queueSize, maxSize }
    );
    this.name = 'QueueFullError';
    this.queueSize = queueSize;
    this.maxSize = maxSize;
  }
}

/**
 * Proof generation failed.
 */
export class ProofGenerationError extends SpeculationError {
  readonly jobId: string;
  readonly taskId: TaskId;
  readonly errorCode: ProofErrorCode;
  
  constructor(jobId: string, taskId: TaskId, errorCode: ProofErrorCode, message: string) {
    const retryable = [
      ProofErrorCode.TIMEOUT,
      ProofErrorCode.WORKER_CRASH,
      ProofErrorCode.ANCESTORS_PENDING,
    ].includes(errorCode);
    
    super(
      `Proof generation failed for job ${jobId}: ${message}`,
      'PROOF_GENERATION_FAILED',
      500,
      retryable,
      { jobId, taskId, errorCode }
    );
    this.name = 'ProofGenerationError';
    this.jobId = jobId;
    this.taskId = taskId;
    this.errorCode = errorCode;
  }
}

/**
 * Maximum retries exceeded for proof job.
 */
export class MaxRetriesExceededError extends SpeculationError {
  readonly jobId: string;
  readonly attempts: number;
  readonly maxRetries: number;
  
  constructor(jobId: string, attempts: number, maxRetries: number) {
    super(
      `Max retries exceeded for job ${jobId}: ${attempts}/${maxRetries}`,
      'MAX_RETRIES_EXCEEDED',
      400,
      false,
      { jobId, attempts, maxRetries }
    );
    this.name = 'MaxRetriesExceededError';
    this.jobId = jobId;
    this.attempts = attempts;
    this.maxRetries = maxRetries;
  }
}

/**
 * Job is not in a state that allows cancellation.
 */
export class JobNotCancellableError extends SpeculationError {
  readonly jobId: string;
  readonly currentStatus: ProofJobStatus;
  
  constructor(jobId: string, currentStatus: ProofJobStatus) {
    super(
      `Job ${jobId} cannot be cancelled in state ${currentStatus}`,
      'JOB_NOT_CANCELLABLE',
      400,
      false,
      { jobId, currentStatus }
    );
    this.name = 'JobNotCancellableError';
    this.jobId = jobId;
    this.currentStatus = currentStatus;
  }
}

/**
 * Job is not in a state that allows retry.
 */
export class JobNotRetryableError extends SpeculationError {
  readonly jobId: string;
  readonly currentStatus: ProofJobStatus;
  
  constructor(jobId: string, currentStatus: ProofJobStatus) {
    super(
      `Job ${jobId} cannot be retried in state ${currentStatus}`,
      'JOB_NOT_RETRYABLE',
      400,
      false,
      { jobId, currentStatus }
    );
    this.name = 'JobNotRetryableError';
    this.jobId = jobId;
    this.currentStatus = currentStatus;
  }
}

// ============================================
// Rollback Errors
// ============================================

/**
 * Base class for rollback-related errors.
 */
export class RollbackError extends SpeculationError {
  readonly rollbackId?: string;
  
  constructor(
    message: string,
    code: string,
    rollbackId?: string,
    context: Record<string, unknown> = {}
  ) {
    super(message, code, 500, false, { ...context, rollbackId });
    this.name = 'RollbackError';
    this.rollbackId = rollbackId;
  }
}

/**
 * Rollback is already in progress.
 */
export class RollbackInProgressError extends RollbackError {
  readonly existingRollbackId: string;
  
  constructor(commitmentId: CommitmentId, existingRollbackId: string) {
    super(
      `Rollback already in progress for commitment chain including ${commitmentId}`,
      'ROLLBACK_IN_PROGRESS',
      existingRollbackId,
      { commitmentId }
    );
    this.name = 'RollbackInProgressError';
    this.existingRollbackId = existingRollbackId;
  }
}

/**
 * Rollback cascade size exceeded limit.
 */
export class RollbackCascadeTooLargeError extends RollbackError {
  readonly affectedTasks: number;
  readonly maxCascadeSize: number;
  
  constructor(rollbackId: string, affectedTasks: number, maxCascadeSize: number) {
    super(
      `Rollback cascade too large: ${affectedTasks} tasks (max: ${maxCascadeSize})`,
      'ROLLBACK_CASCADE_TOO_LARGE',
      rollbackId,
      { affectedTasks, maxCascadeSize }
    );
    this.name = 'RollbackCascadeTooLargeError';
    this.affectedTasks = affectedTasks;
    this.maxCascadeSize = maxCascadeSize;
  }
}

/**
 * Rollback timed out.
 */
export class RollbackTimeoutError extends RollbackError {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly tasksRolledBack: number;
  readonly tasksRemaining: number;
  
  constructor(
    rollbackId: string,
    elapsedMs: number,
    timeoutMs: number,
    tasksRolledBack: number,
    tasksRemaining: number
  ) {
    super(
      `Rollback ${rollbackId} timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms)`,
      'ROLLBACK_TIMEOUT',
      rollbackId,
      { elapsedMs, timeoutMs, tasksRolledBack, tasksRemaining }
    );
    this.name = 'RollbackTimeoutError';
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
    this.tasksRolledBack = tasksRolledBack;
    this.tasksRemaining = tasksRemaining;
  }
}

/**
 * Rollback cannot be cancelled in current state.
 */
export class RollbackNotCancellableError extends RollbackError {
  readonly currentPhase: RollbackPhase;
  
  constructor(rollbackId: string, currentPhase: RollbackPhase) {
    super(
      `Rollback ${rollbackId} cannot be cancelled in phase ${currentPhase}`,
      'ROLLBACK_NOT_CANCELLABLE',
      rollbackId,
      { currentPhase }
    );
    this.name = 'RollbackNotCancellableError';
    this.currentPhase = currentPhase;
  }
}

// ============================================
// System Errors
// ============================================

/**
 * Scheduler is not running.
 */
export class SchedulerNotRunningError extends SpeculationError {
  constructor() {
    super('Scheduler is not running', 'SCHEDULER_NOT_RUNNING', 503, true);
    this.name = 'SchedulerNotRunningError';
  }
}

/**
 * Scheduler is already started.
 */
export class AlreadyStartedError extends SpeculationError {
  constructor() {
    super('Scheduler is already started', 'ALREADY_STARTED', 400, false);
    this.name = 'AlreadyStartedError';
  }
}

/**
 * Operation is still in progress.
 */
export class OperationInProgressError extends SpeculationError {
  readonly operationType: string;
  readonly count: number;
  
  constructor(operationType: string, count: number) {
    super(
      `${count} ${operationType} operations still in progress`,
      'OPERATION_IN_PROGRESS',
      400,
      true,
      { operationType, count }
    );
    this.name = 'OperationInProgressError';
    this.operationType = operationType;
    this.count = count;
  }
}

/**
 * Resource limit reached.
 */
export class ResourceLimitError extends SpeculationError {
  readonly resourceType: string;
  readonly currentValue: number;
  readonly limitValue: number;
  
  constructor(resourceType: string, currentValue: number, limitValue: number) {
    super(
      `Resource limit reached for ${resourceType}: ${currentValue}/${limitValue}`,
      'RESOURCE_LIMIT_REACHED',
      503,
      true,
      { resourceType, currentValue, limitValue }
    );
    this.name = 'ResourceLimitError';
    this.resourceType = resourceType;
    this.currentValue = currentValue;
    this.limitValue = limitValue;
  }
}

// ============================================
// Import/Export Errors
// ============================================

/**
 * Import failed due to invalid data.
 */
export class ImportError extends SpeculationError {
  readonly importErrors: string[];
  
  constructor(importErrors: string[]) {
    super(
      `Import failed: ${importErrors.join('; ')}`,
      'IMPORT_ERROR',
      400,
      false,
      { importErrors }
    );
    this.name = 'ImportError';
    this.importErrors = importErrors;
  }
}
```

### 5.2 Error Code Reference

| Code | Name | HTTP | Retryable | Description |
|------|------|------|-----------|-------------|
| `CONFIGURATION_ERROR` | ConfigurationError | 400 | No | Invalid configuration |
| `TASK_NOT_FOUND` | TaskNotFoundError | 404 | No | Task doesn't exist |
| `DUPLICATE_TASK` | DuplicateTaskError | 409 | No | Task ID already exists |
| `TASK_VALIDATION_FAILED` | TaskValidationError | 400 | No | Task failed validation |
| `INVALID_STATE_TRANSITION` | InvalidStateTransitionError | 400 | No | Invalid status change |
| `INVALID_DEPENDENCY` | InvalidDependencyError | 400 | No | Bad dependency |
| `CYCLE_DETECTED` | CycleDetectedError | 400 | No | Graph cycle |
| `HAS_DEPENDENTS` | HasDependentsError | 400 | No | Can't remove task with deps |
| `COMMITMENT_NOT_FOUND` | CommitmentNotFoundError | 404 | No | Commitment doesn't exist |
| `DUPLICATE_COMMITMENT` | DuplicateCommitmentError | 409 | No | Commitment already exists |
| `INVALID_COMMITMENT_STATE` | InvalidCommitmentStateError | 400 | No | Wrong commitment state |
| `PARENT_COMMITMENT_ERROR` | ParentCommitmentError | 400 | No | Invalid parent |
| `ALREADY_SLASHED` | AlreadySlashedError | 400 | No | Already slashed |
| `INSUFFICIENT_STAKE` | InsufficientStakeError | 400 | No | Not enough stake |
| `AGENT_COOLDOWN` | AgentCooldownError | 429 | Yes | Agent in cooldown |
| `DEPTH_EXCEEDED` | DepthExceededError | 400 | No | Too deep |
| `JOB_NOT_FOUND` | JobNotFoundError | 404 | No | Proof job not found |
| `DUPLICATE_JOB` | DuplicateJobError | 409 | No | Job exists |
| `QUEUE_FULL` | QueueFullError | 503 | Yes | Queue at capacity |
| `PROOF_GENERATION_FAILED` | ProofGenerationError | 500 | Varies | Proof failed |
| `MAX_RETRIES_EXCEEDED` | MaxRetriesExceededError | 400 | No | Too many retries |
| `JOB_NOT_CANCELLABLE` | JobNotCancellableError | 400 | No | Can't cancel job |
| `JOB_NOT_RETRYABLE` | JobNotRetryableError | 400 | No | Can't retry job |
| `ROLLBACK_IN_PROGRESS` | RollbackInProgressError | 500 | No | Rollback ongoing |
| `ROLLBACK_CASCADE_TOO_LARGE` | RollbackCascadeTooLargeError | 500 | No | Too many affected |
| `ROLLBACK_TIMEOUT` | RollbackTimeoutError | 500 | No | Rollback timed out |
| `ROLLBACK_NOT_CANCELLABLE` | RollbackNotCancellableError | 400 | No | Can't cancel rollback |
| `SCHEDULER_NOT_RUNNING` | SchedulerNotRunningError | 503 | Yes | Scheduler stopped |
| `ALREADY_STARTED` | AlreadyStartedError | 400 | No | Already running |
| `OPERATION_IN_PROGRESS` | OperationInProgressError | 400 | Yes | Work ongoing |
| `RESOURCE_LIMIT_REACHED` | ResourceLimitError | 503 | Yes | Limit hit |
| `IMPORT_ERROR` | ImportError | 400 | No | Import failed |

---

## 6. Constants

### 6.1 Default Values

```typescript
/**
 * Default values for speculation configuration.
 */
export const SPECULATION_DEFAULTS = {
  // Core defaults
  ENABLED: false,
  MODE: SpeculationMode.CONSERVATIVE,
  MAX_DEPTH: 5,
  MAX_PARALLEL_BRANCHES: 4,
  CONFIRMATION_TIMEOUT_MS: 30_000,
  CLAIM_BUFFER_MS: 60_000,
  MIN_CONFIDENCE_SCORE: 70,
  
  // Stake defaults (in lamports)
  MIN_STAKE: 1_000_000n, // 0.001 SOL
  MAX_STAKE: 1_000_000_000n, // 1 SOL
  BASE_BOND: 100_000n, // 0.0001 SOL
  DEPTH_MULTIPLIER: 2.0,
  SLASH_PERCENTAGE: 0.1, // 10%
  PROTOCOL_SLASH_SHARE: 0.5, // 50%
  COOLDOWN_PERIOD_MS: 60_000,
  
  // Proof defaults
  PROOF_GENERATOR: ProofType.GROTH16,
  WORKER_THREADS: 4,
  PROOF_QUEUE_SIZE: 1_000,
  PROOF_TIMEOUT_MS: 60_000,
  PROOF_BATCH_SIZE: 10,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1_000,
  RETRY_MULTIPLIER: 2.0,
  
  // Resource limits
  MAX_MEMORY_MB: 4_096,
  MAX_PENDING_OPERATIONS: 10_000,
  MAX_STATE_SNAPSHOTS: 100,
  GC_INTERVAL_MS: 30_000,
  MAX_COMMITMENT_AGE_MS: 3_600_000,
  MAX_ROLLBACK_CASCADE_SIZE: 1_000,
  
  // Scheduler defaults
  SCHEDULING_INTERVAL_MS: 100,
  MAX_TASKS_PER_CYCLE: 50,
  MIN_EXPECTED_VALUE: 0.0,
  
  // Rollback defaults
  ROLLBACK_POLICY: RollbackPolicy.CASCADE,
  MAX_CONCURRENT_ROLLBACKS: 3,
  ROLLBACK_TIMEOUT_MS: 120_000,
  GRACE_PERIOD_MS: 5_000,
} as const;

/**
 * Lamports per SOL for stake calculations.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Minimum valid task ID length.
 */
export const MIN_TASK_ID_LENGTH = 8;

/**
 * Maximum valid task ID length.
 */
export const MAX_TASK_ID_LENGTH = 128;

/**
 * Version of the serialization format.
 */
export const SERIALIZATION_VERSION = '1.0.0';
```

### 6.2 Timing Constants

```typescript
/**
 * Timing-related constants.
 */
export const TIMING = {
  /** Minimum confirmation timeout */
  MIN_CONFIRMATION_TIMEOUT_MS: 5_000,
  
  /** Maximum confirmation timeout */
  MAX_CONFIRMATION_TIMEOUT_MS: 300_000,
  
  /** Minimum GC interval */
  MIN_GC_INTERVAL_MS: 5_000,
  
  /** Maximum GC interval */
  MAX_GC_INTERVAL_MS: 300_000,
  
  /** Minimum proof timeout */
  MIN_PROOF_TIMEOUT_MS: 10_000,
  
  /** Maximum proof timeout */
  MAX_PROOF_TIMEOUT_MS: 600_000,
  
  /** Minimum scheduling interval */
  MIN_SCHEDULING_INTERVAL_MS: 10,
  
  /** Maximum scheduling interval */
  MAX_SCHEDULING_INTERVAL_MS: 10_000,
  
  /** Minimum rollback timeout */
  MIN_ROLLBACK_TIMEOUT_MS: 10_000,
  
  /** Maximum rollback timeout */
  MAX_ROLLBACK_TIMEOUT_MS: 600_000,
  
  /** Minimum cooldown period */
  MIN_COOLDOWN_MS: 0,
  
  /** Maximum cooldown period (1 hour) */
  MAX_COOLDOWN_MS: 3_600_000,
  
  /** Minimum claim buffer */
  MIN_CLAIM_BUFFER_MS: 10_000,
  
  /** Maximum claim buffer (10 minutes) */
  MAX_CLAIM_BUFFER_MS: 600_000,
  
  /** Deferral check interval */
  DEFAULT_DEFERRAL_CHECK_INTERVAL_MS: 1_000,
  
  /** Ancestor wait timeout (5 minutes) */
  DEFAULT_ANCESTOR_WAIT_TIMEOUT_MS: 300_000,
} as const;
```

### 6.3 Size Limits

```typescript
/**
 * Size and count limits.
 */
export const LIMITS = {
  /** Minimum max depth */
  MIN_MAX_DEPTH: 1,
  
  /** Maximum max depth */
  MAX_MAX_DEPTH: 20,
  
  /** Minimum parallel branches */
  MIN_PARALLEL_BRANCHES: 1,
  
  /** Maximum parallel branches */
  MAX_PARALLEL_BRANCHES: 16,
  
  /** Minimum worker threads */
  MIN_WORKER_THREADS: 1,
  
  /** Maximum worker threads */
  MAX_WORKER_THREADS: 32,
  
  /** Minimum queue size */
  MIN_QUEUE_SIZE: 100,
  
  /** Maximum queue size */
  MAX_QUEUE_SIZE: 100_000,
  
  /** Minimum batch size */
  MIN_BATCH_SIZE: 1,
  
  /** Maximum batch size */
  MAX_BATCH_SIZE: 100,
  
  /** Minimum memory limit (512 MB) */
  MIN_MEMORY_MB: 512,
  
  /** Maximum memory limit (64 GB) */
  MAX_MEMORY_MB: 65_536,
  
  /** Minimum pending operations */
  MIN_PENDING_OPERATIONS: 100,
  
  /** Maximum pending operations */
  MAX_PENDING_OPERATIONS: 1_000_000,
  
  /** Minimum state snapshots */
  MIN_STATE_SNAPSHOTS: 10,
  
  /** Maximum state snapshots */
  MAX_STATE_SNAPSHOTS: 10_000,
  
  /** Minimum rollback cascade size */
  MIN_ROLLBACK_CASCADE_SIZE: 10,
  
  /** Maximum rollback cascade size */
  MAX_ROLLBACK_CASCADE_SIZE: 100_000,
  
  /** Maximum tasks per scheduling cycle */
  MAX_TASKS_PER_CYCLE: 1_000,
  
  /** Maximum concurrent rollbacks */
  MAX_CONCURRENT_ROLLBACKS: 10,
  
  /** Maximum retries for proof generation */
  MAX_PROOF_RETRIES: 10,
  
  /** Maximum label key length */
  MAX_LABEL_KEY_LENGTH: 64,
  
  /** Maximum label value length */
  MAX_LABEL_VALUE_LENGTH: 256,
  
  /** Maximum labels per task */
  MAX_LABELS_PER_TASK: 32,
  
  /** Maximum error message length */
  MAX_ERROR_MESSAGE_LENGTH: 4096,
} as const;
```

### 6.4 Stake Constants

```typescript
/**
 * Stake-related constants.
 */
export const STAKE = {
  /** Minimum slash percentage */
  MIN_SLASH_PERCENTAGE: 0.01, // 1%
  
  /** Maximum slash percentage */
  MAX_SLASH_PERCENTAGE: 0.5, // 50%
  
  /** Minimum depth multiplier */
  MIN_DEPTH_MULTIPLIER: 1.0,
  
  /** Maximum depth multiplier */
  MAX_DEPTH_MULTIPLIER: 10.0,
  
  /** Minimum protocol slash share */
  MIN_PROTOCOL_SLASH_SHARE: 0.0,
  
  /** Maximum protocol slash share */
  MAX_PROTOCOL_SLASH_SHARE: 1.0,
  
  /** Minimum stake (1 lamport) */
  ABSOLUTE_MIN_STAKE: 1n,
  
  /** Maximum single bond (10 SOL) */
  MAX_SINGLE_BOND: 10_000_000_000n,
} as const;
```

### 6.5 Metric Names

```typescript
/**
 * Standard metric names for observability.
 */
export const METRICS = {
  // Counters
  TASKS_SCHEDULED: 'speculation.tasks.scheduled',
  TASKS_COMPLETED: 'speculation.tasks.completed',
  TASKS_FAILED: 'speculation.tasks.failed',
  TASKS_ROLLED_BACK: 'speculation.tasks.rolled_back',
  
  COMMITMENTS_CREATED: 'speculation.commitments.created',
  COMMITMENTS_CONFIRMED: 'speculation.commitments.confirmed',
  COMMITMENTS_INVALIDATED: 'speculation.commitments.invalidated',
  COMMITMENTS_EXPIRED: 'speculation.commitments.expired',
  
  PROOFS_QUEUED: 'speculation.proofs.queued',
  PROOFS_COMPLETED: 'speculation.proofs.completed',
  PROOFS_FAILED: 'speculation.proofs.failed',
  PROOFS_DEFERRED: 'speculation.proofs.deferred',
  
  ROLLBACKS_STARTED: 'speculation.rollbacks.started',
  ROLLBACKS_COMPLETED: 'speculation.rollbacks.completed',
  ROLLBACKS_FAILED: 'speculation.rollbacks.failed',
  
  STAKE_BONDED: 'speculation.stake.bonded',
  STAKE_RELEASED: 'speculation.stake.released',
  STAKE_SLASHED: 'speculation.stake.slashed',
  
  // Gauges
  ACTIVE_COMMITMENTS: 'speculation.commitments.active',
  QUEUE_DEPTH: 'speculation.proofs.queue_depth',
  DEFERRED_COUNT: 'speculation.proofs.deferred_count',
  ACTIVE_ROLLBACKS: 'speculation.rollbacks.active',
  SPECULATION_DEPTH: 'speculation.depth.current',
  PARALLEL_BRANCHES: 'speculation.branches.active',
  MEMORY_USED_MB: 'speculation.resources.memory_mb',
  PENDING_OPERATIONS: 'speculation.resources.pending_ops',
  
  // Histograms
  CONFIRMATION_TIME: 'speculation.timing.confirmation_ms',
  PROOF_GENERATION_TIME: 'speculation.timing.proof_generation_ms',
  ROLLBACK_DURATION: 'speculation.timing.rollback_ms',
  DEFERRAL_WAIT_TIME: 'speculation.timing.deferral_wait_ms',
  SCHEDULING_LATENCY: 'speculation.timing.scheduling_ms',
  
  // Labels
  LABEL_TASK_TYPE: 'task_type',
  LABEL_AGENT_ID: 'agent_id',
  LABEL_DEPTH: 'depth',
  LABEL_REASON: 'reason',
  LABEL_STATUS: 'status',
  LABEL_PROOF_TYPE: 'proof_type',
} as const;
```

### 6.6 Valid State Transitions

```typescript
/**
 * Valid state transitions for tasks.
 */
export const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.PENDING]: [
    TaskStatus.READY,
    TaskStatus.CANCELLED,
    TaskStatus.EXPIRED,
  ],
  [TaskStatus.READY]: [
    TaskStatus.EXECUTING,
    TaskStatus.CANCELLED,
    TaskStatus.EXPIRED,
  ],
  [TaskStatus.EXECUTING]: [
    TaskStatus.PROVING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.PROVING]: [
    TaskStatus.AWAITING_ANCESTORS,
    TaskStatus.CONFIRMING,
    TaskStatus.FAILED,
    TaskStatus.ROLLED_BACK,
  ],
  [TaskStatus.AWAITING_ANCESTORS]: [
    TaskStatus.CONFIRMING,
    TaskStatus.ROLLED_BACK,
    TaskStatus.FAILED,
  ],
  [TaskStatus.CONFIRMING]: [
    TaskStatus.CONFIRMED,
    TaskStatus.FAILED,
    TaskStatus.ROLLED_BACK,
  ],
  [TaskStatus.CONFIRMED]: [], // Terminal state
  [TaskStatus.ROLLED_BACK]: [], // Terminal state
  [TaskStatus.FAILED]: [], // Terminal state (unless retry)
  [TaskStatus.CANCELLED]: [], // Terminal state
  [TaskStatus.EXPIRED]: [], // Terminal state
};

/**
 * Valid state transitions for commitments.
 */
export const VALID_COMMITMENT_TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
  [CommitmentStatus.ACTIVE]: [
    CommitmentStatus.CONFIRMED,
    CommitmentStatus.ROLLED_BACK,
    CommitmentStatus.EXPIRED,
    CommitmentStatus.INVALIDATED,
    CommitmentStatus.SLASHED,
  ],
  [CommitmentStatus.CONFIRMED]: [], // Terminal state
  [CommitmentStatus.ROLLED_BACK]: [], // Terminal state
  [CommitmentStatus.EXPIRED]: [], // Terminal state
  [CommitmentStatus.INVALIDATED]: [
    CommitmentStatus.SLASHED, // Can be slashed after invalidation
  ],
  [CommitmentStatus.SLASHED]: [], // Terminal state
};

/**
 * Valid state transitions for proof jobs.
 */
export const VALID_PROOF_JOB_TRANSITIONS: Record<ProofJobStatus, ProofJobStatus[]> = {
  [ProofJobStatus.QUEUED]: [
    ProofJobStatus.WAITING_ANCESTORS,
    ProofJobStatus.PROCESSING,
    ProofJobStatus.CANCELLED,
  ],
  [ProofJobStatus.WAITING_ANCESTORS]: [
    ProofJobStatus.PROCESSING,
    ProofJobStatus.FAILED,
    ProofJobStatus.CANCELLED,
  ],
  [ProofJobStatus.PROCESSING]: [
    ProofJobStatus.COMPLETED,
    ProofJobStatus.FAILED,
    ProofJobStatus.TIMED_OUT,
  ],
  [ProofJobStatus.COMPLETED]: [], // Terminal state
  [ProofJobStatus.FAILED]: [
    ProofJobStatus.QUEUED, // Can retry
  ],
  [ProofJobStatus.CANCELLED]: [], // Terminal state
  [ProofJobStatus.TIMED_OUT]: [
    ProofJobStatus.QUEUED, // Can retry
  ],
};
```

---

## Appendix A: Usage Examples

### A.1 Basic Speculation Flow

```typescript
import {
  SpeculativeTaskScheduler,
  TaskNode,
  TaskStatus,
  SpeculationConfig,
} from '@agenc/speculation';

// Create configuration
const config: SpeculationConfig = {
  enabled: true,
  mode: 'balanced',
  core: {
    maxDepth: 5,
    maxParallelBranches: 4,
    confirmationTimeoutMs: 30000,
    claimBufferMs: 60000,
    minConfidenceScore: 70,
    allowCrossAgentSpeculation: false,
  },
  stake: {
    minStake: 1000000n,
    maxStake: 1000000000n,
    baseBond: 100000n,
    depthMultiplier: 2.0,
    slashPercentage: 0.1,
    protocolSlashShare: 0.5,
    cooldownPeriodMs: 60000,
  },
  // ... rest of config
};

// Initialize scheduler
const scheduler = new SpeculativeTaskScheduler(config);
await scheduler.start();

// Create root task
const rootTask: TaskNode = {
  id: 'task-root',
  agentId: 'agent-001',
  dependsOn: null,
  status: TaskStatus.PENDING,
  claimExpiry: Date.now() + 300000,
  createdAt: Date.now(),
  estimatedComputeMs: 5000,
  speculationDepth: 0,
  inputHash: '0x1234...',
  metadata: {
    priority: 1,
    retryCount: 0,
    maxRetries: 3,
    labels: {},
  },
};

// Schedule root task
const rootDecision = await scheduler.scheduleTask(rootTask);
console.log('Root task scheduled, speculating:', rootDecision.shouldSpeculate);

// Create child task that depends on root
const childTask: TaskNode = {
  id: 'task-child',
  agentId: 'agent-001',
  dependsOn: 'task-root',
  status: TaskStatus.PENDING,
  claimExpiry: Date.now() + 300000,
  createdAt: Date.now(),
  estimatedComputeMs: 3000,
  speculationDepth: 1, // Will be calculated
  inputHash: '0x5678...',
  metadata: {
    priority: 1,
    retryCount: 0,
    maxRetries: 3,
    labels: {},
  },
};

// Schedule child task (may speculate on root)
const childDecision = await scheduler.scheduleTask(childTask, 'task-root');
console.log('Child task decision:', {
  speculate: childDecision.shouldSpeculate,
  depth: childDecision.depth,
  stake: childDecision.requiredStake,
  reasons: childDecision.reasons,
});

// Report root task completion
await scheduler.reportCompletion('task-root', {
  outputHash: '0xabcd...',
  executionTrace: new Uint8Array([...]),
  computeTimeMs: 4500,
});

// Report on-chain confirmation
await scheduler.reportConfirmation(
  'task-root',
  'tx-signature-123',
  12345678
);

// Graceful shutdown
await scheduler.stop(30000);
```

### A.2 Handling Rollbacks

```typescript
// Set up rollback event handlers
scheduler.on('rollback.started', (payload) => {
  console.warn('Rollback started:', {
    trigger: payload.triggerCommitmentId,
    reason: payload.reason,
    estimatedTasks: payload.estimatedTaskCount,
  });
  
  // Notify monitoring
  alerting.warn('Speculation rollback initiated', payload);
});

scheduler.on('rollback.task.reverted', (payload) => {
  console.log('Task reverted:', {
    taskId: payload.task.taskId,
    depth: payload.task.speculationDepth,
    wastedCompute: payload.task.wastedComputeMs,
  });
});

scheduler.on('rollback.completed', (payload) => {
  const result = payload.result;
  console.log('Rollback completed:', {
    duration: result.durationMs,
    tasksRolledBack: result.rolledBackTasks.length,
    stakeReleased: result.totalReleasedStake,
    stakeSlashed: result.totalSlashedStake,
  });
  
  // Record metrics
  metrics.rollbackDuration.observe(result.durationMs);
  metrics.tasksRolledBack.inc(result.rolledBackTasks.length);
});

// Manually trigger rollback for testing/emergency
const simulation = await scheduler.rollbackController.simulateRollback(
  'commitment-to-fail'
);
console.log('Rollback simulation:', {
  affectedTasks: simulation.affectedTasks.length,
  stakeAtRisk: simulation.totalStakeAtRisk,
  computeAtRisk: simulation.totalComputeAtRisk,
});

if (simulation.affectedTasks.length < 10) {
  // Safe to proceed
  const result = await scheduler.rollbackController.rollback(
    'commitment-to-fail',
    RollbackReason.MANUAL_REQUEST
  );
}
```

### A.3 Monitoring and Observability

```typescript
// Health check endpoint
app.get('/health', async (req, res) => {
  const health = scheduler.healthCheck();
  
  res.status(health.healthy ? 200 : 503).json({
    status: health.healthy ? 'healthy' : 'unhealthy',
    components: health.components,
    issues: health.issues,
    lastCheck: new Date(health.lastCheck).toISOString(),
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  const stats = scheduler.getStats();
  
  // Prometheus format
  const lines = [
    `# HELP speculation_tasks_scheduled Total tasks scheduled`,
    `# TYPE speculation_tasks_scheduled counter`,
    `speculation_tasks_scheduled ${stats.tasksScheduled}`,
    
    `# HELP speculation_active_commitments Current active commitments`,
    `# TYPE speculation_active_commitments gauge`,
    `speculation_active_commitments ${stats.ledger.activeCommitments}`,
    
    `# HELP speculation_avg_depth Average speculation depth`,
    `# TYPE speculation_avg_depth gauge`,
    `speculation_avg_depth ${stats.avgSpeculationDepth}`,
    
    // ... more metrics
  ];
  
  res.set('Content-Type', 'text/plain');
  res.send(lines.join('\n'));
});

// Periodic stats logging
setInterval(() => {
  const stats = scheduler.getStats();
  
  logger.info('Speculation stats', {
    uptime: stats.uptime,
    throughput: stats.throughputTasksPerSecond,
    latencyReduction: `${(stats.latencyReduction * 100).toFixed(1)}%`,
    avgDepth: stats.avgSpeculationDepth.toFixed(2),
    activeCommitments: stats.ledger.activeCommitments,
    queueDepth: stats.proofs.currentQueueDepth,
    rollbacks: stats.rollbacks,
  });
}, 60000);
```

---

## Appendix B: Migration Guide

### B.1 From Synchronous to Speculative Execution

```typescript
// Before: Synchronous execution
async function executeTaskSync(task: Task): Promise<Result> {
  // Wait for parent to complete
  if (task.dependsOn) {
    await waitForConfirmation(task.dependsOn);
  }
  
  // Execute
  const result = await execute(task);
  
  // Generate and submit proof
  const proof = await generateProof(result);
  await submitProof(proof);
  
  return result;
}

// After: Speculative execution
async function executeTaskSpeculative(task: TaskNode): Promise<void> {
  // Schedule through speculation system
  const decision = await scheduler.scheduleTask(task, task.dependsOn);
  
  if (decision.shouldSpeculate) {
    logger.info(`Speculating on ${task.id} at depth ${decision.depth}`);
    
    // Execute immediately (speculative)
    const result = await execute(task);
    
    // Report completion (proof will be deferred if needed)
    await scheduler.reportCompletion(task.id, {
      outputHash: result.hash,
      executionTrace: result.trace,
      computeTimeMs: result.duration,
    });
    
    // Handle potential rollback
    scheduler.once('rollback.task.reverted', (payload) => {
      if (payload.task.taskId === task.id) {
        logger.warn(`Task ${task.id} was rolled back`);
        // Handle rollback (e.g., revert side effects)
      }
    });
  } else {
    logger.info(`Not speculating on ${task.id}:`, decision.reasons);
    // Fall back to synchronous execution
    await executeTaskSync(task);
  }
}
```

---

*This specification is generated from AgenC Speculative Execution design documents. For implementation details, see the source code and related documentation.*
