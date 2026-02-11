/**
 * DAGOrchestrator — Top-level workflow API.
 *
 * Validates workflow definitions, submits tasks on-chain via DAGSubmitter,
 * and monitors completion via DAGMonitor.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type {
  DAGOrchestratorConfig,
  WorkflowDefinition,
  WorkflowState,
  WorkflowStats,
  WorkflowCallbacks,
} from './types.js';
import {
  WorkflowStatus,
  WorkflowNodeStatus,
  OnChainDependencyType,
} from './types.js';
import { WorkflowStateError } from './errors.js';
import { validateWorkflow } from './validation.js';
import { DAGSubmitter } from './submitter.js';
import { DAGMonitor } from './monitor.js';

/**
 * Orchestrates multi-step task workflows on the AgenC protocol.
 *
 * Usage:
 * ```typescript
 * const orch = new DAGOrchestrator({ program, agentId });
 * orch.validate(definition);            // throws on invalid
 * const state = await orch.submit(definition);
 * const final = await orch.waitForCompletion(definition.id);
 * await orch.shutdown();
 * ```
 */
export class DAGOrchestrator {
  private readonly submitter: DAGSubmitter;
  private readonly monitor: DAGMonitor;
  private readonly logger: Logger;
  private readonly callbacks: WorkflowCallbacks;
  private readonly cancelOnParentFailure: boolean;
  private readonly workflows = new Map<string, WorkflowState>();

  constructor(config: DAGOrchestratorConfig) {
    this.logger = config.logger ?? silentLogger;
    this.callbacks = config.callbacks ?? {};
    this.cancelOnParentFailure = config.cancelOnParentFailure ?? true;

    this.submitter = new DAGSubmitter({
      program: config.program,
      agentId: config.agentId,
      logger: this.logger,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
    });

    this.monitor = new DAGMonitor({
      program: config.program,
      logger: this.logger,
      pollIntervalMs: config.pollIntervalMs,
    });
  }

  /**
   * Validate a workflow definition without submitting.
   *
   * @throws WorkflowValidationError on any violation
   */
  validate(definition: WorkflowDefinition): void {
    validateWorkflow(definition);
  }

  /**
   * Submit a workflow: validate, create on-chain tasks, start monitoring.
   *
   * @param definition - The workflow definition
   * @returns Workflow state (status will be Running after successful submission)
   * @throws WorkflowValidationError if definition is invalid
   * @throws WorkflowSubmissionError if on-chain task creation fails
   * @throws WorkflowStateError if a workflow with the same ID already exists
   */
  async submit(definition: WorkflowDefinition): Promise<WorkflowState> {
    if (this.workflows.has(definition.id)) {
      throw new WorkflowStateError(
        `Workflow "${definition.id}" already exists. Use a unique ID.`
      );
    }

    // Validate
    validateWorkflow(definition);

    // Build initial state
    const state = this.buildInitialState(definition);
    this.workflows.set(definition.id, state);

    state.status = WorkflowStatus.Running;
    state.startedAt = Date.now();

    // Submit all tasks on-chain
    try {
      await this.submitter.submitAll(state, this.cancelOnParentFailure);
    } catch (err) {
      // On submission failure, mark workflow as failed but keep it tracked
      // (some nodes may have been created successfully)
      state.status = WorkflowStatus.Failed;
      state.completedAt = Date.now();
      this.callbacks.onWorkflowFailed?.(state);
      throw err;
    }

    // Fire onNodeCreated callbacks for all successfully created nodes
    for (const node of state.nodes.values()) {
      if (node.status === WorkflowNodeStatus.Created) {
        this.callbacks.onNodeCreated?.(node);
      }
    }

    // Start monitoring for completions
    this.monitor.startMonitoring(state, this.callbacks, this.cancelOnParentFailure);

    return state;
  }

  /**
   * Get the current state of a workflow.
   *
   * @param workflowId - Workflow identifier
   * @returns Workflow state, or null if not found
   */
  getState(workflowId: string): WorkflowState | null {
    return this.workflows.get(workflowId) ?? null;
  }

  /**
   * Get summary statistics for a workflow.
   *
   * @param workflowId - Workflow identifier
   * @returns Stats, or null if workflow not found
   */
  getStats(workflowId: string): WorkflowStats | null {
    const state = this.workflows.get(workflowId);
    if (!state) return null;

    const nodes = Array.from(state.nodes.values());
    const now = Date.now();
    const startedAt = state.startedAt ?? now;

    return {
      totalNodes: nodes.length,
      pending: nodes.filter((n) => n.status === WorkflowNodeStatus.Pending || n.status === WorkflowNodeStatus.Creating).length,
      created: nodes.filter((n) => n.status === WorkflowNodeStatus.Created).length,
      completed: nodes.filter((n) => n.status === WorkflowNodeStatus.Completed).length,
      failed: nodes.filter((n) => n.status === WorkflowNodeStatus.Failed).length,
      cancelled: nodes.filter((n) => n.status === WorkflowNodeStatus.Cancelled).length,
      elapsedMs: (state.completedAt ?? now) - startedAt,
      totalReward: nodes.reduce((sum, n) => sum + n.template.rewardAmount, 0n),
    };
  }

  /**
   * Wait for a workflow to reach terminal state.
   *
   * @param workflowId - Workflow identifier
   * @param timeoutMs - Optional timeout in ms
   * @returns Final workflow state
   * @throws WorkflowStateError if workflow not found or on timeout
   */
  async waitForCompletion(workflowId: string, timeoutMs?: number): Promise<WorkflowState> {
    const state = this.workflows.get(workflowId);
    if (!state) {
      throw new WorkflowStateError(`Workflow "${workflowId}" not found`);
    }

    // Already terminal?
    if (this.monitor.isTerminal(state)) {
      return state;
    }

    return this.monitor.waitForTerminal(workflowId, timeoutMs);
  }

  /**
   * Stop all monitoring and clean up resources.
   */
  async shutdown(): Promise<void> {
    await this.monitor.shutdown();
    this.logger.info('DAGOrchestrator shut down');
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private buildInitialState(definition: WorkflowDefinition): WorkflowState {
    // Build edge map (child -> parent edge) for assigning parentName/dependencyType
    const edgeByChild = new Map<string, { from: string; dependencyType: OnChainDependencyType }>();
    for (const edge of definition.edges) {
      edgeByChild.set(edge.to, { from: edge.from, dependencyType: edge.dependencyType });
    }

    const nodes = new Map<string, import('./types.js').WorkflowNode>();

    for (const template of definition.tasks) {
      const parentEdge = edgeByChild.get(template.name);
      nodes.set(template.name, {
        name: template.name,
        template,
        taskId: null,
        taskPda: null,
        parentName: parentEdge?.from ?? null,
        parentPda: null,
        dependencyType: parentEdge?.dependencyType ?? OnChainDependencyType.None,
        status: WorkflowNodeStatus.Pending,
        transactionSignature: null,
        error: null,
        createdAt: null,
        completedAt: null,
      });
    }

    return {
      id: definition.id,
      definition,
      status: WorkflowStatus.Pending,
      nodes,
      startedAt: null,
      completedAt: null,
    };
  }
}
