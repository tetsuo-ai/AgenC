/**
 * Speculation Adapter - Bridges autonomous and task module type systems.
 *
 * These functions convert between the autonomous module's `Task` type and
 * the task module's `OnChainTask` type, enabling SpeculativeExecutor to
 * work with the AutonomousAgent's task discovery pipeline.
 *
 * Internal module — not exported from public API.
 *
 * @module
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import type { Task, TaskExecutor as AutonomousTaskExecutor } from './types.js';
import { TaskStatus } from './types.js';
import type {
  OnChainTask,
  TaskHandler,
  TaskExecutionResult,
  TaskExecutionContext,
} from '../task/types.js';
import { OnChainTaskStatus } from '../task/types.js';
import { TaskType } from '../events/types.js';
import { bigintsToProofHash } from '../utils/encoding.js';

// Re-export for backward compat (tests import from here)
export { bigintsToProofHash as packBigintsToProofHash } from '../utils/encoding.js';

// ============================================================================
// Task Type Converters
// ============================================================================

/**
 * Maps autonomous TaskStatus to OnChainTaskStatus.
 */
function mapTaskStatus(status: TaskStatus): OnChainTaskStatus {
  switch (status) {
    case TaskStatus.Open:
      return OnChainTaskStatus.Open;
    case TaskStatus.InProgress:
      return OnChainTaskStatus.InProgress;
    case TaskStatus.Completed:
      return OnChainTaskStatus.Completed;
    case TaskStatus.Cancelled:
      return OnChainTaskStatus.Cancelled;
    case TaskStatus.Disputed:
      return OnChainTaskStatus.Disputed;
    default:
      return OnChainTaskStatus.Open;
  }
}

/**
 * Maps OnChainTaskStatus to autonomous TaskStatus.
 */
function mapOnChainTaskStatus(status: OnChainTaskStatus): TaskStatus {
  switch (status) {
    case OnChainTaskStatus.Open:
      return TaskStatus.Open;
    case OnChainTaskStatus.InProgress:
      return TaskStatus.InProgress;
    case OnChainTaskStatus.Completed:
      return TaskStatus.Completed;
    case OnChainTaskStatus.Cancelled:
      return TaskStatus.Cancelled;
    case OnChainTaskStatus.Disputed:
      return TaskStatus.Disputed;
    case OnChainTaskStatus.PendingValidation:
      return TaskStatus.InProgress;
    default:
      return TaskStatus.Open;
  }
}

/**
 * Convert an autonomous Task to an OnChainTask for the task module.
 *
 * Fields not available in the autonomous Task type are filled with
 * sensible defaults (taskType=Exclusive, escrow=SystemProgram, etc.).
 *
 * @param task - Autonomous module Task
 * @returns OnChainTask compatible with SpeculativeExecutor
 */
export function autonomousTaskToOnChainTask(task: Task): OnChainTask {
  return {
    taskId: task.taskId,
    creator: task.creator,
    requiredCapabilities: task.requiredCapabilities,
    description: task.description,
    constraintHash: task.constraintHash,
    rewardAmount: task.reward,
    maxWorkers: task.maxWorkers,
    currentWorkers: task.currentClaims,
    status: mapTaskStatus(task.status),
    taskType: TaskType.Exclusive,
    createdAt: 0,
    deadline: task.deadline,
    completedAt: 0,
    escrow: SystemProgram.programId,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 0,
  };
}

/**
 * Convert an OnChainTask back to an autonomous Task.
 *
 * Used in callbacks so the autonomous module receives its expected type.
 *
 * @param task - Task module OnChainTask
 * @param pda - Task PDA address
 * @returns Autonomous module Task
 */
export function onChainTaskToAutonomousTask(task: OnChainTask, pda: PublicKey): Task {
  return {
    pda,
    taskId: task.taskId,
    creator: task.creator,
    requiredCapabilities: task.requiredCapabilities,
    reward: task.rewardAmount,
    description: task.description,
    constraintHash: task.constraintHash,
    deadline: task.deadline,
    maxWorkers: task.maxWorkers,
    currentClaims: task.currentWorkers,
    status: mapOnChainTaskStatus(task.status),
  };
}

/**
 * Wrap an autonomous TaskExecutor as a task-module TaskHandler.
 *
 * The adapter:
 * 1. Converts the TaskExecutionContext.task (OnChainTask) to autonomous Task
 * 2. Calls executor.execute(task) to get bigint[] output
 * 3. Packs the output into a 32-byte LE proofHash
 * 4. Returns a TaskExecutionResult
 *
 * @param executor - Autonomous module TaskExecutor
 * @returns TaskHandler compatible with SpeculativeExecutor
 */
export function executorToTaskHandler(executor: AutonomousTaskExecutor): TaskHandler {
  return async (context: TaskExecutionContext): Promise<TaskExecutionResult> => {
    // Convert OnChainTask → autonomous Task for the executor
    const task = onChainTaskToAutonomousTask(context.task, context.taskPda);

    // Execute via the autonomous executor
    const output = await executor.execute(task);

    // Pack bigints into proofHash
    const proofHash = bigintsToProofHash(output);

    return { proofHash };
  };
}
