/**
 * Workflow DAG Orchestrator — Type Definitions
 *
 * Types for defining, submitting, and monitoring multi-step task workflows
 * on the AgenC protocol. The on-chain topology is a tree (each task has at
 * most one parent via `depends_on: Option<Pubkey>`).
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";

// ============================================================================
// On-Chain Dependency Type
// ============================================================================

/**
 * Matches the on-chain Rust `DependencyType` enum values exactly.
 *
 * Separate from `DependencyGraph.DependencyType` in the speculative executor
 * (which uses different ordinals).
 */
export enum OnChainDependencyType {
  None = 0,
  Data = 1,
  Ordering = 2,
  Proof = 3,
}

// ============================================================================
// Workflow Definition (User Input — Immutable)
// ============================================================================

/**
 * User-defined task blueprint (before on-chain submission).
 */
export interface TaskTemplate {
  /** Local reference key (NOT on-chain task_id — that's generated at submission time) */
  name: string;
  /** Bitmask of required agent capabilities */
  requiredCapabilities: bigint;
  /** Task description or instruction hash (64 bytes) */
  description: Uint8Array;
  /** SOL reward for completion in lamports (can be 0 for dependents) */
  rewardAmount: bigint;
  /** Maximum number of agents that can work on this task */
  maxWorkers: number;
  /** Unix timestamp deadline (0 = no deadline) */
  deadline: number;
  /** 0=Exclusive, 1=Collaborative, 2=Competitive */
  taskType: number;
  /** For private tasks: hash of expected output (32 bytes). Null = public task. */
  constraintHash?: Uint8Array;
  /** Minimum reputation score (0-10000). Default 0. */
  minReputation?: number;
  /** SPL token mint for reward denomination (null/undefined = SOL) */
  rewardMint?: PublicKey | null;
}

/**
 * Directed edge from parent task to child task.
 */
export interface WorkflowEdge {
  /** Parent task name (must reference a TaskTemplate.name) */
  from: string;
  /** Child task name (must reference a TaskTemplate.name) */
  to: string;
  /** On-chain dependency type (1=Data, 2=Ordering, 3=Proof) */
  dependencyType: OnChainDependencyType;
}

/**
 * Immutable workflow definition provided by the user.
 */
export interface WorkflowDefinition {
  /** User-supplied workflow identifier */
  id: string;
  /** Default reward mint for nodes that omit `task.rewardMint` (null/undefined = SOL) */
  defaultRewardMint?: PublicKey | null;
  /** Task blueprints */
  tasks: ReadonlyArray<TaskTemplate>;
  /** Dependency edges between tasks */
  edges: ReadonlyArray<WorkflowEdge>;
}

/**
 * Optional workflow-level configuration.
 */
export interface WorkflowConfig {
  /** Default reward mint for nodes without explicit rewardMint (null/undefined = SOL) */
  defaultRewardMint?: PublicKey | null;
}

// ============================================================================
// Runtime State
// ============================================================================

/** Status of an individual workflow node. */
export enum WorkflowNodeStatus {
  Pending = "pending",
  Creating = "creating",
  Created = "created",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

/**
 * Runtime state for a single task within the workflow.
 */
export interface WorkflowNode {
  /** Local reference name (matches TaskTemplate.name) */
  name: string;
  /** The original template */
  template: TaskTemplate;
  /** Generated 32-byte on-chain task ID (null before submission) */
  taskId: Uint8Array | null;
  /** Derived task PDA (null before submission) */
  taskPda: PublicKey | null;
  /** Parent task name (null for root nodes) */
  parentName: string | null;
  /** Parent task PDA (null for root nodes, set after parent submission) */
  parentPda: PublicKey | null;
  /** Dependency type (None for roots, Data/Ordering/Proof for dependents) */
  dependencyType: OnChainDependencyType;
  /** Current status */
  status: WorkflowNodeStatus;
  /** Transaction signature from on-chain creation */
  transactionSignature: string | null;
  /** Error if status is Failed */
  error: Error | null;
  /** Timestamp when node was created on-chain */
  createdAt: number | null;
  /** Timestamp when node was completed */
  completedAt: number | null;
}

/** Overall workflow status. */
export enum WorkflowStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  PartiallyCompleted = "partially_completed",
}

/**
 * Full runtime state of a workflow.
 */
export interface WorkflowState {
  /** Workflow identifier (from WorkflowDefinition.id) */
  id: string;
  /** The original definition */
  definition: WorkflowDefinition;
  /** Overall status */
  status: WorkflowStatus;
  /** Node states keyed by task name */
  nodes: Map<string, WorkflowNode>;
  /** When submission started */
  startedAt: number | null;
  /** When workflow reached terminal state */
  completedAt: number | null;
}

/**
 * Summary statistics for a workflow.
 */
export interface WorkflowStats {
  totalNodes: number;
  pending: number;
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
  elapsedMs: number;
  /** Sum of all node reward amounts */
  totalReward: bigint;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Callbacks for workflow lifecycle events.
 */
export interface WorkflowCallbacks {
  onNodeCreated?: (node: WorkflowNode) => void;
  onNodeCompleted?: (node: WorkflowNode) => void;
  onNodeFailed?: (node: WorkflowNode, error: Error) => void;
  onNodeCancelled?: (node: WorkflowNode, reason: string) => void;
  onWorkflowCompleted?: (state: WorkflowState) => void;
  onWorkflowFailed?: (state: WorkflowState) => void;
}

/**
 * Configuration for DAGOrchestrator.
 */
export interface DAGOrchestratorConfig {
  /** Anchor program instance (with wallet for signing) */
  program: Program<AgencCoordination>;
  /** 32-byte agent ID of the creator */
  agentId: Uint8Array;
  /** Logger instance */
  logger?: Logger;
  /** Lifecycle callbacks */
  callbacks?: WorkflowCallbacks;
  /** Cancel descendant tasks when a parent fails (default: true) */
  cancelOnParentFailure?: boolean;
  /** Polling interval for task completion checks in ms (default: 10_000) */
  pollIntervalMs?: number;
  /** Max retries for on-chain task creation (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
}
