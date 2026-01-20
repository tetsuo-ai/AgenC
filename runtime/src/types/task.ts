/**
 * Task type definitions for @agenc/runtime
 */

import { PublicKey } from '@solana/web3.js';
import { TaskStatus, TaskType, AgentState } from './config';

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
  requiredCapabilities: bigint;
  /** Task description (64 bytes) */
  description: Buffer;
  /** Constraint hash for private tasks */
  constraintHash: Buffer | null;
  /** Reward amount in lamports */
  rewardAmount: bigint;
  /** Maximum workers allowed */
  maxWorkers: number;
  /** Current worker count */
  currentWorkers: number;
  /** Task status */
  status: TaskStatus;
  /** Task type */
  taskType: TaskType;
  /** Creation timestamp */
  createdAt: number;
  /** Deadline timestamp (0 = no deadline) */
  deadline: number;
  /** Completion timestamp */
  completedAt: number;
  /** Escrow PDA */
  escrow: PublicKey;
  /** Result data (64 bytes) */
  result: Buffer;
  /** Number of completions */
  completions: number;
  /** Required completions */
  requiredCompletions: number;
}

/**
 * Task claim on-chain representation
 */
export interface TaskClaim {
  /** Claim PDA address */
  address: PublicKey;
  /** Task being claimed */
  task: PublicKey;
  /** Worker agent PDA */
  worker: PublicKey;
  /** Claim timestamp */
  claimedAt: number;
  /** Expiration timestamp */
  expiresAt: number;
  /** Completion timestamp */
  completedAt: number;
  /** Proof hash */
  proofHash: Buffer;
  /** Result data */
  resultData: Buffer;
  /** Is completed */
  isCompleted: boolean;
  /** Is validated */
  isValidated: boolean;
  /** Reward paid */
  rewardPaid: bigint;
}

/**
 * Task execution result
 */
export interface TaskResult {
  /** Output values (for ZK proof) */
  output: bigint[];
  /** Salt for commitment (auto-generated if not provided) */
  salt?: bigint;
  /** Result data (max 64 bytes, for public tasks) */
  resultData?: Buffer;
  /** Execution metadata */
  metadata?: {
    /** Number of LLM iterations */
    iterations?: number;
    /** Total tokens used */
    tokensUsed?: number;
    /** Execution time in ms */
    executionTime?: number;
    /** Tools used */
    toolsUsed?: string[];
    /** Confidence score (0-1) */
    confidence?: number;
  };
}

/**
 * Task handler function signature
 */
export type TaskHandler = (task: OnChainTask, context: TaskExecutionContext) => Promise<TaskResult>;

/**
 * Context provided to task handlers
 */
export interface TaskExecutionContext {
  /** Agent state */
  agent: AgentState;
  /** Claim information */
  claim: TaskClaim;
  /** Runtime logger */
  log: {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
  /** Abort signal for cancellation */
  signal: AbortSignal;
}

/**
 * Task evaluator interface for custom task selection logic
 */
export interface TaskEvaluator {
  /**
   * Evaluate a task and return a score.
   * Higher scores = more desirable tasks.
   * Return null to skip the task entirely.
   */
  evaluate(task: OnChainTask, context: EvaluationContext): Promise<number | null>;
}

/**
 * Context for task evaluation
 */
export interface EvaluationContext {
  /** Current agent state */
  agent: AgentState;
  /** Recently completed tasks */
  recentTasks: TaskHistoryEntry[];
  /** Current timestamp */
  timestamp: number;
  /** Agent's active task count */
  activeTaskCount: number;
  /** Rate limit budget */
  rateLimitBudget: {
    tasksRemaining: number;
    cooldownEnds: number;
  };
}

/**
 * Task history entry for memory
 */
export interface TaskHistoryEntry {
  /** Task ID */
  taskId: Buffer;
  /** Task address */
  taskAddress: PublicKey;
  /** Result */
  result: TaskResult;
  /** Reward received */
  rewardReceived: bigint;
  /** Completion timestamp */
  completedAt: number;
  /** Transaction signature */
  txSignature: string;
}

/**
 * Task filter for discovery
 */
export interface TaskFilter {
  /** Minimum reward amount */
  minReward?: bigint;
  /** Maximum reward amount */
  maxReward?: bigint;
  /** Required task types */
  taskTypes?: TaskType[];
  /** Required capabilities (agent must have these) */
  requiredCapabilities?: bigint;
  /** Maximum deadline (unix timestamp) */
  maxDeadline?: number;
  /** Minimum deadline (unix timestamp) */
  minDeadline?: number;
  /** Only private tasks */
  privateOnly?: boolean;
  /** Only public tasks */
  publicOnly?: boolean;
  /** Custom filter function */
  custom?: (task: OnChainTask) => boolean;
}

/**
 * Task executor state machine states
 */
export enum ExecutorState {
  Idle = 'idle',
  Discovering = 'discovering',
  Evaluating = 'evaluating',
  Claiming = 'claiming',
  Executing = 'executing',
  Proving = 'proving',
  Submitting = 'submitting',
  Error = 'error',
}

/**
 * Built-in task evaluators
 */
export const Evaluators = {
  /**
   * Maximize reward amount
   */
  rewardMaximizer: {
    evaluate: async (task: OnChainTask): Promise<number> => {
      return Number(task.rewardAmount);
    },
  } as TaskEvaluator,

  /**
   * Prefer urgent tasks (close to deadline)
   */
  urgencyEvaluator: {
    evaluate: async (task: OnChainTask, ctx: EvaluationContext): Promise<number | null> => {
      if (task.deadline === 0) return 50; // No deadline = medium priority
      const timeLeft = task.deadline - ctx.timestamp;
      if (timeLeft < 0) return null; // Expired
      // Higher score for less time remaining (max 100 for < 1 hour)
      return Math.max(0, 100 - timeLeft / 3600);
    },
  } as TaskEvaluator,

  /**
   * Balanced evaluator considering reward and urgency
   */
  balanced: {
    evaluate: async (task: OnChainTask, ctx: EvaluationContext): Promise<number | null> => {
      // Reward component (0-70 points)
      const rewardSol = Number(task.rewardAmount) / 1e9;
      const rewardScore = Math.min(70, rewardSol * 10);

      // Urgency component (0-30 points)
      let urgencyScore = 15; // Default for no deadline
      if (task.deadline > 0) {
        const hoursLeft = (task.deadline - ctx.timestamp) / 3600;
        if (hoursLeft < 0) return null; // Expired
        urgencyScore = Math.min(30, Math.max(0, 30 - hoursLeft));
      }

      return rewardScore + urgencyScore;
    },
  } as TaskEvaluator,

  /**
   * Accept all tasks (no filtering)
   */
  acceptAll: {
    evaluate: async (): Promise<number> => 1,
  } as TaskEvaluator,
};
