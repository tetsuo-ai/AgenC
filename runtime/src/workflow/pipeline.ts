/**
 * PipelineExecutor — resumable multi-step tool workflows with checkpoint/resume.
 *
 * Pipelines are sequences of tool calls that can be paused (for approval),
 * checkpointed to a MemoryBackend, and resumed after daemon restart.
 *
 * @module
 */

import type { ToolHandler } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ApprovalEngine } from "../gateway/approvals.js";
import type { DelegationDecompositionSignal } from "../gateway/delegation-scope.js";
import type { ProgressTracker } from "../gateway/progress.js";
import type { Logger } from "../utils/logger.js";
import { WorkflowStateError } from "./errors.js";
import { toErrorMessage, SEVEN_DAYS_MS } from "../utils/async.js";
import type { WorkflowGraphEdge } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type PipelineStepErrorPolicy = "retry" | "skip" | "abort";

export interface PipelineStep {
  readonly name: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly requiresApproval?: boolean;
  readonly onError?: PipelineStepErrorPolicy;
  readonly maxRetries?: number;
}

export type PipelinePlannerStepType =
  | "deterministic_tool"
  | "subagent_task"
  | "synthesis";

interface PipelinePlannerStepBase {
  readonly name: string;
  readonly stepType: PipelinePlannerStepType;
  readonly dependsOn?: readonly string[];
}

export interface PipelinePlannerDeterministicStep extends PipelinePlannerStepBase {
  readonly stepType: "deterministic_tool";
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly onError?: PipelineStepErrorPolicy;
  readonly maxRetries?: number;
}

export interface PipelinePlannerSubagentStep extends PipelinePlannerStepBase {
  readonly stepType: "subagent_task";
  readonly objective: string;
  readonly inputContract: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requiredToolCapabilities: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly maxBudgetHint: string;
  readonly canRunParallel: boolean;
}

export interface PipelinePlannerSynthesisStep extends PipelinePlannerStepBase {
  readonly stepType: "synthesis";
  readonly objective?: string;
}

export type PipelinePlannerStep =
  | PipelinePlannerDeterministicStep
  | PipelinePlannerSubagentStep
  | PipelinePlannerSynthesisStep;

export type PipelinePlannerContextHistoryRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

export interface PipelinePlannerContextHistoryEntry {
  readonly role: PipelinePlannerContextHistoryRole;
  readonly content: string;
  readonly toolName?: string;
}

export type PipelinePlannerContextMemorySource =
  | "memory_semantic"
  | "memory_episodic"
  | "memory_working";

export interface PipelinePlannerContextMemoryEntry {
  readonly source: PipelinePlannerContextMemorySource;
  readonly content: string;
}

export interface PipelinePlannerContextToolOutputEntry {
  readonly toolName?: string;
  readonly content: string;
}

export interface PipelinePlannerContext {
  readonly parentRequest: string;
  readonly history: readonly PipelinePlannerContextHistoryEntry[];
  readonly memory: readonly PipelinePlannerContextMemoryEntry[];
  readonly toolOutputs: readonly PipelinePlannerContextToolOutputEntry[];
  /** Optional parent-turn tool allowlist used for child least-privilege scoping. */
  readonly parentAllowedTools?: readonly string[];
}

export interface PipelineContext {
  readonly results: Readonly<Record<string, string>>;
}

export interface Pipeline {
  readonly id: string;
  readonly steps: readonly PipelineStep[];
  /** Optional planner-emitted step graph for DAG orchestration. */
  readonly plannerSteps?: readonly PipelinePlannerStep[];
  /** Optional dependency edges matching plannerSteps. */
  readonly edges?: readonly WorkflowGraphEdge[];
  /** Optional parallelism cap for DAG execution paths. */
  readonly maxParallelism?: number;
  /** Optional planner execution context for subagent curation. */
  readonly plannerContext?: PipelinePlannerContext;
  readonly context: PipelineContext;
  readonly createdAt: number;
}

export type PipelineStatus = "running" | "completed" | "failed" | "halted";

export type PipelineStopReasonHint =
  | "validation_error"
  | "provider_error"
  | "authentication_error"
  | "rate_limited"
  | "timeout"
  | "tool_error"
  | "budget_exceeded"
  | "no_progress"
  | "cancelled";

export interface PipelineResult {
  readonly status: PipelineStatus;
  readonly context: PipelineContext;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly resumeFrom?: number;
  readonly error?: string;
  /** Structured parent-side replan signal for overloaded delegated work. */
  readonly decomposition?: DelegationDecompositionSignal;
  /**
   * Optional stop reason hint for upstream ChatExecutor mapping.
   * Must stay within canonical LLMPipelineStopReason values (excluding completed/tool_calls).
   */
  readonly stopReasonHint?: PipelineStopReasonHint;
}

export interface PipelineCheckpoint {
  readonly pipelineId: string;
  readonly pipeline: Pipeline;
  readonly stepIndex: number;
  readonly context: PipelineContext;
  readonly status: PipelineStatus;
  readonly updatedAt: number;
}

export interface PipelineExecutorConfig {
  readonly toolHandler: ToolHandler;
  readonly memoryBackend: MemoryBackend;
  readonly approvalEngine?: ApprovalEngine;
  readonly progressTracker?: ProgressTracker;
  readonly logger?: Logger;
  readonly checkpointTtlMs?: number;
}

export interface PipelineExecutionOptions {
  /**
   * Optional per-execution tool handler override.
   * Use this to run pipelines with session-scoped routing (for example desktop-aware handlers).
   */
  readonly toolHandler?: ToolHandler;
  /**
   * Optional execution event hook for observability.
   * Emits deterministic pipeline step start/finish and halt events.
   */
  readonly onEvent?: (event: PipelineExecutionEvent) => void;
}

export type PipelineExecutionEventType =
  | "pipeline_halted"
  | "step_finished"
  | "step_started";

export interface PipelineExecutionEvent {
  readonly type: PipelineExecutionEventType;
  readonly pipelineId: string;
  readonly stepName?: string;
  readonly stepIndex?: number;
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly durationMs?: number;
  readonly result?: string;
  readonly error?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function checkpointKey(id: string): string {
  return `pipeline:${id}`;
}

// ============================================================================
// PipelineExecutor
// ============================================================================

export class PipelineExecutor {
  private readonly toolHandler: ToolHandler;
  private readonly backend: MemoryBackend;
  private readonly approvalEngine?: ApprovalEngine;
  private readonly progressTracker?: ProgressTracker;
  private readonly logger?: Logger;
  private readonly checkpointTtlMs: number;

  /** Active pipeline IDs tracked in memory. */
  private readonly active = new Set<string>();

  constructor(config: PipelineExecutorConfig) {
    this.toolHandler = config.toolHandler;
    this.backend = config.memoryBackend;
    this.approvalEngine = config.approvalEngine;
    this.progressTracker = config.progressTracker;
    this.logger = config.logger;
    this.checkpointTtlMs = config.checkpointTtlMs ?? SEVEN_DAYS_MS;
  }

  /**
   * Execute a pipeline from a given step index.
   * Returns the result including status and resume info if halted.
   */
  async execute(
    pipeline: Pipeline,
    startFrom = 0,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    if (this.active.has(pipeline.id)) {
      return {
        status: "failed",
        context: pipeline.context,
        completedSteps: 0,
        totalSteps: pipeline.steps.length,
        error: `Pipeline "${pipeline.id}" is already running`,
      };
    }

    this.active.add(pipeline.id);
    const executionToolHandler = options?.toolHandler ?? this.toolHandler;
    const mutableResults: Record<string, string> = { ...pipeline.context.results };
    let completedSteps = startFrom;

    try {
      for (let i = startFrom; i < pipeline.steps.length; i++) {
        const step = pipeline.steps[i];

        // Save running checkpoint
        await this.saveCheckpoint({
          pipelineId: pipeline.id,
          pipeline,
          stepIndex: i,
          context: { results: { ...mutableResults } },
          status: "running",
          updatedAt: Date.now(),
        });

        // Approval gate — if step requires approval and engine says no, halt
        if (step.requiresApproval && this.approvalEngine) {
          const rule = this.approvalEngine.requiresApproval(step.tool, step.args);
          if (rule) {
            options?.onEvent?.({
              type: "pipeline_halted",
              pipelineId: pipeline.id,
              stepName: step.name,
              stepIndex: i,
              tool: step.tool,
              args: step.args,
              error: `Approval required for tool "${step.tool}"`,
            });
            await this.saveCheckpoint({
              pipelineId: pipeline.id,
              pipeline,
              stepIndex: i,
              context: { results: { ...mutableResults } },
              status: "halted",
              updatedAt: Date.now(),
            });
            return {
              status: "halted",
              context: { results: { ...mutableResults } },
              completedSteps,
              totalSteps: pipeline.steps.length,
              resumeFrom: i,
            };
          }
        }

        // Execute the tool and handle errors per step policy
        options?.onEvent?.({
          type: "step_started",
          pipelineId: pipeline.id,
          stepName: step.name,
          stepIndex: i,
          tool: step.tool,
          args: step.args,
        });
        const stepStartedAt = Date.now();
        const stepResult = await this.executeStep(step, executionToolHandler);
        options?.onEvent?.({
          type: "step_finished",
          pipelineId: pipeline.id,
          stepName: step.name,
          stepIndex: i,
          tool: step.tool,
          args: step.args,
          durationMs: Date.now() - stepStartedAt,
          ...(stepResult.error
            ? { error: stepResult.error }
            : { result: stepResult.result }),
        });

        if (stepResult.error) {
          const recovery = await this.handleStepError(
            pipeline.id,
            step,
            stepResult.error,
            executionToolHandler,
          );
          if (recovery.terminal) {
            this.active.delete(pipeline.id);
            return {
              status: "failed",
              context: { results: { ...mutableResults } },
              completedSteps,
              totalSteps: pipeline.steps.length,
              error: recovery.error,
            };
          }
          mutableResults[step.name] = recovery.result;
        } else {
          mutableResults[step.name] = stepResult.result;
        }

        completedSteps = i + 1;
        await this.trackProgress(pipeline.id, step.name);
      }

      // All steps completed
      await this.removeCheckpoint(pipeline.id);
      this.active.delete(pipeline.id);
      return {
        status: "completed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps: pipeline.steps.length,
      };
    } catch (err) {
      this.active.delete(pipeline.id);
      return {
        status: "failed",
        context: { results: { ...mutableResults } },
        completedSteps,
        totalSteps: pipeline.steps.length,
        error: toErrorMessage(err),
      };
    }
  }

  /** Resume a halted or interrupted pipeline from its checkpoint. */
  async resume(
    pipelineId: string,
    options?: PipelineExecutionOptions,
  ): Promise<PipelineResult> {
    const checkpoint = await this.backend.get<PipelineCheckpoint>(
      checkpointKey(pipelineId),
    );
    if (!checkpoint) {
      throw new WorkflowStateError(
        `No checkpoint found for pipeline "${pipelineId}"`,
      );
    }

    // Reconstruct pipeline with saved context
    const pipeline: Pipeline = {
      ...checkpoint.pipeline,
      context: checkpoint.context,
    };

    return this.execute(pipeline, checkpoint.stepIndex, options);
  }

  /** List active pipeline IDs with their checkpoint status. */
  async listActive(): Promise<readonly PipelineCheckpoint[]> {
    const results: PipelineCheckpoint[] = [];
    for (const id of this.active) {
      const checkpoint = await this.backend.get<PipelineCheckpoint>(
        checkpointKey(id),
      );
      if (checkpoint) results.push(checkpoint);
    }
    return results;
  }

  /** Remove a pipeline checkpoint and clear from active set. */
  async remove(pipelineId: string): Promise<void> {
    await this.removeCheckpoint(pipelineId);
    this.active.delete(pipelineId);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Apply the step's error policy. Returns either a terminal failure
   * or a recovered result string (from skip or successful retry).
   */
  private async handleStepError(
    pipelineId: string,
    step: PipelineStep,
    error: string,
    toolHandler: ToolHandler,
  ): Promise<{ terminal: true; error: string } | { terminal: false; result: string }> {
    const policy = step.onError ?? "abort";

    if (policy === "skip") {
      this.logger?.warn(`Pipeline "${pipelineId}" step "${step.name}" failed, skipping: ${error}`);
      return { terminal: false, result: `SKIPPED: ${error}` };
    }

    if (policy === "retry") {
      const maxRetries = step.maxRetries ?? 0;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const retryResult = await this.executeStep(step, toolHandler);
        if (!retryResult.error) {
          return { terminal: false, result: retryResult.result };
        }
        this.logger?.warn(
          `Pipeline "${pipelineId}" step "${step.name}" retry ${attempt}/${maxRetries} failed`,
        );
      }
    }

    // abort (default) or exhausted retries
    await this.removeCheckpoint(pipelineId);
    return { terminal: true, error };
  }

  private async executeStep(
    step: PipelineStep,
    toolHandler: ToolHandler,
  ): Promise<{ result: string; error?: string }> {
    try {
      const result = await toolHandler(step.tool, step.args);
      return { result };
    } catch (err) {
      return { result: "", error: toErrorMessage(err) };
    }
  }

  private async saveCheckpoint(checkpoint: PipelineCheckpoint): Promise<void> {
    await this.backend.set(
      checkpointKey(checkpoint.pipelineId),
      checkpoint,
      this.checkpointTtlMs,
    );
  }

  private async removeCheckpoint(pipelineId: string): Promise<void> {
    await this.backend.delete(checkpointKey(pipelineId));
  }

  private async trackProgress(
    pipelineId: string,
    stepName: string,
  ): Promise<void> {
    if (!this.progressTracker) return;
    try {
      await this.progressTracker.append({
        sessionId: pipelineId,
        type: "task_completed",
        summary: `Pipeline step "${stepName}" completed`,
      });
    } catch {
      // Progress tracking failure is non-blocking
    }
  }
}
