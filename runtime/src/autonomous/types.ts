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
import type { PolicyEngine } from '../policy/engine.js';
import type { PolicyViolation } from '../policy/types.js';
import type { TrajectoryRecorderSink } from '../eval/types.js';
import type { WorkflowOptimizerRuntimeConfig } from '../workflow/optimizer.js';
import type { BudgetGuardrail } from './verification-budget.js';

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
  /**
   * Optional on-chain task type.
   * Present when the scanner/account parser includes this field.
   */
  taskType?: number;
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
   * Reward mint filter.
   * - `null` = SOL-only tasks
   * - `PublicKey` = one SPL mint
   * - `PublicKey[]` = any of the listed SPL mints
   */
  rewardMint?: PublicKey | PublicKey[] | null;
  /**
   * Accepted reward mints. null means SOL, PublicKey means that mint.
   * Undefined (or omitted) means accept all mints.
   * @deprecated Since v0.1.0. Use {@link TaskFilter.rewardMint} instead.
   * Will be removed in v0.2.0.
   * See: https://github.com/tetsuo-ai/AgenC/issues/983
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
 * Structured reason for verifier decisions.
 */
export interface VerifierReason {
  /** Stable machine-readable code (for routing/escalation). */
  code: string;
  /** Human-readable detail for debugging/review. */
  message: string;
  /** Optional field/path that failed validation. */
  field?: string;
  /** Optional severity bucket from verifier implementation. */
  severity?: 'low' | 'medium' | 'high';
}

/**
 * Supported verifier verdict values.
 */
export type VerifierVerdict = 'pass' | 'fail' | 'needs_revision';

/**
 * Structured verifier output contract.
 */
export interface VerifierVerdictPayload {
  verdict: VerifierVerdict;
  /** Confidence in [0, 1]. */
  confidence: number;
  reasons: VerifierReason[];
  /** Optional metadata propagated to telemetry/journaling. */
  metadata?: Record<string, unknown>;
}

/**
 * Input passed to verifier implementations.
 */
export interface VerifierInput {
  task: Task;
  output: bigint[];
  /** 1-based verification attempt index. */
  attempt: number;
  /** Full prior verdict history for this task run. */
  history: readonly VerifierVerdictPayload[];
}

/**
 * Verifier agent contract (Executor + Critic pattern).
 */
export interface TaskVerifier {
  verify(input: VerifierInput): Promise<VerifierVerdictPayload>;
}

/**
 * Input passed to revision-capable executors.
 */
export interface RevisionInput {
  task: Task;
  previousOutput: bigint[];
  verdict: VerifierVerdictPayload;
  /** 1-based revision attempt index. */
  revisionAttempt: number;
  history: readonly VerifierVerdictPayload[];
}

/**
 * Optional extension for executors that can produce targeted revisions.
 */
export interface RevisionCapableTaskExecutor extends TaskExecutor {
  revise(input: RevisionInput): Promise<bigint[]>;
}

/**
 * Task-type scoped verifier policy override.
 */
export interface VerifierTaskTypePolicy {
  enabled?: boolean;
  minRewardLamports?: bigint;
  minConfidence?: number;
  maxVerificationRetries?: number;
  maxVerificationDurationMs?: number;
  /** Task-class risk multiplier for adaptive scoring (default: 1). */
  riskMultiplier?: number;
  /** Disable verifier lane when risk score is below this threshold (0-1). */
  minRiskScoreToVerify?: number;
  /** Hard spend ceiling for this task class. */
  maxVerificationCostLamports?: bigint;
  /** Optional adaptive override for retry count. */
  adaptiveMaxVerificationRetries?: number;
  /** Optional adaptive override for verification duration budget (ms). */
  adaptiveMaxVerificationDurationMs?: number;
  /** Optional adaptive override for confidence floor. */
  adaptiveMinConfidence?: number;
}

export interface VerifierAdaptiveRiskWeights {
  rewardWeight?: number;
  deadlineWeight?: number;
  claimPressureWeight?: number;
  taskTypeWeight?: number;
  verifierDisagreementWeight?: number;
  rollbackWeight?: number;
}

export interface VerifierAdaptiveRiskConfig {
  /** Feature flag for adaptive risk-based verification budgeting. */
  enabled?: boolean;
  /** Disable verifier lane below this risk score. */
  minRiskScoreToVerify?: number;
  /** Threshold between low and medium tiers. */
  mediumRiskThreshold?: number;
  /** Threshold between medium and high tiers. */
  highRiskThreshold?: number;
  /** Optional risk feature weights override. */
  weights?: VerifierAdaptiveRiskWeights;
  /** Retry ceilings by risk tier. */
  maxVerificationRetriesByRisk?: Partial<Record<'low' | 'medium' | 'high', number>>;
  /** Duration ceilings by risk tier in ms. */
  maxVerificationDurationMsByRisk?: Partial<Record<'low' | 'medium' | 'high', number>>;
  /** Confidence floors by risk tier. */
  minConfidenceByRisk?: Partial<Record<'low' | 'medium' | 'high', number>>;
  /** Scheduler route by risk tier. */
  routeByRisk?: Partial<
    Record<'low' | 'medium' | 'high', 'single_pass' | 'retry_execute' | 'revision_first'>
  >;
  /** Escalate after this many disagreements per risk tier. */
  maxDisagreementsByRisk?: Partial<Record<'low' | 'medium' | 'high', number>>;
  /** Hard ceilings for retries, duration, and spend. */
  hardMaxVerificationRetries?: number;
  hardMaxVerificationDurationMs?: number;
  hardMaxVerificationCostLamports?: bigint;
  /** Guardrail bounds for adaptive budget changes. */
  budgetGuardrail?: Partial<BudgetGuardrail>;
  /** Maximum number of budget adjustment audit entries kept in memory. */
  auditTrailMaxEntries?: number;
  /** Initial verification budget in lamports before adjustments. */
  initialBudgetLamports?: bigint;
}

export interface MultiCandidateArbitrationWeights {
  /** Agreement with peers; higher is better. */
  consistency?: number;
  /** Diversity contribution measured during generation. */
  diversity?: number;
  /** Optional confidence signal supplied by callers. */
  confidence?: number;
  /** Small preference for earlier attempts. */
  recency?: number;
}

export interface MultiCandidateEscalationPolicy {
  /** Escalate when pairwise disagreement count meets/exceeds this limit. */
  maxPairwiseDisagreements?: number;
  /** Escalate when disagreement ratio meets/exceeds this limit (0-1). */
  maxDisagreementRate?: number;
}

export interface MultiCandidatePolicyBudget {
  /** Hard cap on generated candidates. */
  maxCandidates?: number;
  /** Hard cap on aggregate candidate generation spend. */
  maxExecutionCostLamports?: bigint;
  /** Hard cap on aggregate token units consumed during generation. */
  maxTokenBudget?: number;
}

export interface MultiCandidateConfig {
  /** Feature flag for bounded multi-candidate execution. */
  enabled?: boolean;
  /** Deterministic seed used by arbitration tie-break. */
  seed?: number;
  /** Candidate generation target before arbitration. */
  maxCandidates?: number;
  /** Hard cap on generation attempts (includes discarded low-diversity outputs). */
  maxGenerationAttempts?: number;
  /** Minimum novelty score [0,1] required after the first accepted candidate. */
  minDiversityScore?: number;
  /** Arbitration scoring weights. */
  arbitrationWeights?: MultiCandidateArbitrationWeights;
  /** Escalation policy for disagreement-heavy runs. */
  escalation?: MultiCandidateEscalationPolicy;
  /** Hard policy ceilings for candidate generation budgets. */
  policyBudget?: MultiCandidatePolicyBudget;
}

/**
 * Policy controls for determining when verifier gating applies.
 */
export interface VerifierPolicyConfig {
  /** Global opt-in switch (default: false). */
  enabled?: boolean;
  /** Value-tier trigger; tasks below this reward skip verifier lane. */
  minRewardLamports?: bigint;
  /**
   * Per-task-type policy. Key is on-chain numeric task type.
   * Uses task.taskType when available.
   */
  taskTypePolicies?: Record<number, VerifierTaskTypePolicy>;
  /** Optional custom gate hook for app-specific policy. */
  taskSelector?: (task: Task) => boolean;
  /** Optional adaptive risk policy for dynamic verifier budgets. */
  adaptiveRisk?: VerifierAdaptiveRiskConfig;
}

/**
 * Escalation metadata for verifier-gated failures.
 */
export interface VerifierEscalationMetadata {
  reason:
    | 'verifier_failed'
    | 'verifier_timeout'
    | 'verifier_error'
    | 'revision_unavailable'
    | 'verifier_disagreement'
    | 'verifier_budget_exhausted';
  attempts: number;
  revisions: number;
  durationMs: number;
  lastVerdict: VerifierVerdictPayload | null;
  details?: Record<string, unknown>;
}

/**
 * Runtime verifier lane configuration.
 */
export interface VerifierLaneConfig {
  verifier: TaskVerifier;
  /** Policy gate for when verifier lane is active. */
  policy?: VerifierPolicyConfig;
  /** Minimum confidence required for pass verdict (default: 0.7). */
  minConfidence?: number;
  /** Maximum number of revision attempts after initial output (default: 1). */
  maxVerificationRetries?: number;
  /** Upper bound for verifier lane processing time in ms (default: 30_000). */
  maxVerificationDurationMs?: number;
  /** Optional delay between verification attempts (default: 0). */
  revisionDelayMs?: number;
  /**
   * When true, verifier exceptions are treated as terminal escalation.
   * When false (default), they are converted to fail verdicts and retried.
   */
  failOnVerifierError?: boolean;
  /**
   * When true, non-revision-capable executors may re-run execute() on
   * needs_revision verdicts. Default false for deterministic behavior.
   */
  reexecuteOnNeedsRevision?: boolean;
}

/**
 * Result summary for a verifier-gated execution.
 */
export interface VerifierExecutionResult {
  output: bigint[];
  attempts: number;
  revisions: number;
  durationMs: number;
  passed: boolean;
  escalated: boolean;
  history: VerifierVerdictPayload[];
  lastVerdict: VerifierVerdictPayload | null;
  adaptiveRisk?: {
    score: number;
    tier: 'low' | 'medium' | 'high';
    contributions: Array<{
      feature: string;
      value: number;
      weight: number;
      contribution: number;
    }>;
    budget: {
      maxVerificationRetries: number;
      maxVerificationDurationMs: number;
      minConfidence: number;
      maxAllowedSpendLamports: string;
    };
  };
}

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
  onEarnings?: (amount: bigint, task: Task, mint?: PublicKey | null) => void;
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

  /**
   * Optional verifier lane (Executor + Critic quality gate).
   * When configured and policy matches a task, completion submission is gated
   * on verifier pass.
   */
  verifier?: VerifierLaneConfig;

  /**
   * Optional callback fired after each verifier verdict.
   */
  onVerifierVerdict?: (task: Task, verdict: VerifierVerdictPayload) => void;

  /**
   * Optional callback fired when verifier lane escalates a task failure.
   */
  onTaskEscalated?: (task: Task, metadata: VerifierEscalationMetadata) => void;

  /**
   * Optional policy/safety engine for runtime action enforcement.
   */
  policyEngine?: PolicyEngine;

  /**
   * Optional callback fired on policy violations.
   */
  onPolicyViolation?: (violation: PolicyViolation) => void;

  /**
   * Optional trajectory recorder for deterministic replay/evaluation.
   * When omitted, no trace events are recorded.
   */
  trajectoryRecorder?: TrajectoryRecorderSink;

  /**
   * Optional workflow optimizer runtime controls (feature-flagged).
   * When disabled or omitted, workflow optimization stays inactive.
   */
  workflowOptimizer?: WorkflowOptimizerRuntimeConfig;

  /**
   * Optional bounded multi-candidate generation + arbitration controls.
   * When disabled or omitted, execution remains single-candidate.
   */
  multiCandidate?: MultiCandidateConfig;
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

  // Verifier lane metrics (only present when verifier lane is enabled)
  /** Total verifier decisions recorded. */
  verifierChecks?: number;
  /** Verifier pass verdict count. */
  verifierPasses?: number;
  /** Verifier fail verdict count. */
  verifierFailures?: number;
  /** Verifier needs_revision verdict count. */
  verifierNeedsRevision?: number;
  /** Count of first-pass disagreements (non-pass on first verifier attempt). */
  verifierDisagreements?: number;
  /** Number of revision attempts executed. */
  verifierRevisions?: number;
  /** Number of tasks escalated by verifier lane. */
  verifierEscalations?: number;
  /** Aggregate verifier-induced latency in ms. */
  verifierAddedLatencyMs?: number;
  /** Verifier pass ratio (passes / checks). */
  verifierPassRate?: number;
  /** Verifier disagreement ratio (first-check non-pass / checks). */
  verifierDisagreementRate?: number;
}

/**
 * Default claim strategy - claim one task at a time, prioritize by reward
 */
export const DefaultClaimStrategy: ClaimStrategy = {
  shouldClaim: (_task: Task, pendingTasks: number) => pendingTasks === 0,
  priority: (task: Task) => Number(task.reward),
};
