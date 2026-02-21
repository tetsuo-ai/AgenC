/**
 * DAGMonitor — Event and poll-driven workflow completion tracking.
 *
 * Subscribes to `taskCompleted` and `taskCancelled` events with client-side
 * filtering, plus periodic polling for missed events. Detects terminal
 * workflow states and fires lifecycle callbacks.
 *
 * @module
 */

import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
} from "../events/index.js";
import type { WorkflowCallbacks, WorkflowState } from "./types.js";
import { WorkflowNodeStatus, WorkflowStatus } from "./types.js";
import { WorkflowStateError } from "./errors.js";

/** Default polling interval in ms */
const DEFAULT_POLL_INTERVAL_MS = 10_000;

interface MonitoredWorkflow {
  state: WorkflowState;
  callbacks: WorkflowCallbacks;
  cancelOnParentFailure: boolean;
  /** Set of task PDA base58 strings we're tracking */
  knownPdas: Set<string>;
  /** Map from task PDA base58 → node name for fast lookup */
  pdaToName: Map<string, string>;
  /** Map from taskId hex → node name (for event matching) */
  taskIdToName: Map<string, string>;
  /** Resolve function for waitForTerminal */
  resolveTerminal?: (state: WorkflowState) => void;
  /** Reject function for waitForTerminal timeout */
  rejectTerminal?: (error: Error) => void;
  /** Timeout handle for waitForTerminal */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface DAGMonitorConfig {
  program: Program<AgencCoordination>;
  logger?: Logger;
  pollIntervalMs?: number;
}

/**
 * Monitors workflow task completion via events and polling.
 */
export class DAGMonitor {
  private readonly program: Program<AgencCoordination>;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly workflows = new Map<string, MonitoredWorkflow>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private completedListenerId: number | null = null;
  private cancelledListenerId: number | null = null;
  private started = false;

  constructor(config: DAGMonitorConfig) {
    this.program = config.program;
    this.logger = config.logger ?? silentLogger;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Start monitoring a workflow for task completions.
   */
  startMonitoring(
    state: WorkflowState,
    callbacks: WorkflowCallbacks,
    cancelOnParentFailure: boolean,
  ): void {
    const knownPdas = new Set<string>();
    const pdaToName = new Map<string, string>();
    const taskIdToName = new Map<string, string>();

    for (const [name, node] of state.nodes) {
      if (node.taskPda) {
        const pdaStr = node.taskPda.toBase58();
        knownPdas.add(pdaStr);
        pdaToName.set(pdaStr, name);
      }
      if (node.taskId) {
        const idHex = Buffer.from(node.taskId).toString("hex");
        taskIdToName.set(idHex, name);
      }
    }

    this.workflows.set(state.id, {
      state,
      callbacks,
      cancelOnParentFailure,
      knownPdas,
      pdaToName,
      taskIdToName,
    });

    // Start global event listeners if not already running
    if (!this.started) {
      this.startEventListeners();
      this.startPolling();
      this.started = true;
    }
  }

  /**
   * Stop monitoring a specific workflow.
   */
  stopMonitoring(workflowId: string): void {
    const wf = this.workflows.get(workflowId);
    if (wf) {
      if (wf.timeoutHandle) {
        clearTimeout(wf.timeoutHandle);
      }
      this.workflows.delete(workflowId);
    }

    // If no more workflows, clean up global listeners
    if (this.workflows.size === 0) {
      this.stopAll();
    }
  }

  /**
   * Wait for a workflow to reach terminal state.
   *
   * @param workflowId - Workflow identifier
   * @param timeoutMs - Optional timeout in ms
   * @returns Resolved workflow state
   * @throws WorkflowStateError on timeout or if workflow not found
   */
  waitForTerminal(
    workflowId: string,
    timeoutMs?: number,
  ): Promise<WorkflowState> {
    const wf = this.workflows.get(workflowId);
    if (!wf) {
      throw new WorkflowStateError(`Workflow "${workflowId}" not found`);
    }

    // Already terminal?
    if (this.isTerminal(wf.state)) {
      return Promise.resolve(wf.state);
    }

    return new Promise((resolve, reject) => {
      wf.resolveTerminal = resolve;
      wf.rejectTerminal = reject;

      if (timeoutMs !== undefined && timeoutMs > 0) {
        wf.timeoutHandle = setTimeout(() => {
          wf.resolveTerminal = undefined;
          wf.rejectTerminal = undefined;
          reject(
            new WorkflowStateError(
              `Workflow "${workflowId}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  /**
   * Check if a workflow has reached a terminal state.
   */
  isTerminal(state: WorkflowState): boolean {
    return (
      state.status === WorkflowStatus.Completed ||
      state.status === WorkflowStatus.Failed ||
      state.status === WorkflowStatus.PartiallyCompleted
    );
  }

  /**
   * Stop all monitoring (event listeners + polling).
   */
  async shutdown(): Promise<void> {
    this.stopAll();
    // Clean up all workflow promises
    for (const wf of this.workflows.values()) {
      if (wf.timeoutHandle) {
        clearTimeout(wf.timeoutHandle);
      }
    }
    this.workflows.clear();
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================

  private startEventListeners(): void {
    // Subscribe to taskCompleted (unfiltered — we filter client-side)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.completedListenerId = (this.program as Program<any>).addEventListener(
      "taskCompleted" as any,
      (rawEvent: any, _slot: number, _signature: string) => {
        try {
          const event = parseTaskCompletedEvent(rawEvent);
          const idHex = Buffer.from(event.taskId).toString("hex");

          // Check all monitored workflows
          for (const wf of this.workflows.values()) {
            const nodeName = wf.taskIdToName.get(idHex);
            if (nodeName) {
              this.handleNodeCompleted(wf, nodeName);
            }
          }
        } catch (err) {
          this.logger.error(`Failed to parse taskCompleted event: ${err}`);
        }
      },
    );

    // Subscribe to taskCancelled (unfiltered)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cancelledListenerId = (this.program as Program<any>).addEventListener(
      "taskCancelled" as any,
      (rawEvent: any, _slot: number, _signature: string) => {
        try {
          const event = parseTaskCancelledEvent(rawEvent);
          const idHex = Buffer.from(event.taskId).toString("hex");

          for (const wf of this.workflows.values()) {
            const nodeName = wf.taskIdToName.get(idHex);
            if (nodeName) {
              this.handleNodeFailed(
                wf,
                nodeName,
                new Error("Task cancelled on-chain"),
              );
            }
          }
        } catch (err) {
          this.logger.error(`Failed to parse taskCancelled event: ${err}`);
        }
      },
    );

    this.logger.debug("Event listeners started for workflow monitoring");
  }

  // ===========================================================================
  // Polling Fallback
  // ===========================================================================

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.pollAllWorkflows();
    }, this.pollIntervalMs);
  }

  private async pollAllWorkflows(): Promise<void> {
    for (const wf of this.workflows.values()) {
      await this.pollWorkflow(wf);
    }
  }

  private async pollWorkflow(wf: MonitoredWorkflow): Promise<void> {
    for (const [name, node] of wf.state.nodes) {
      if (node.status !== WorkflowNodeStatus.Created || !node.taskPda) {
        continue;
      }

      try {
        const taskAccount = await this.program.account.task.fetch(node.taskPda);
        const status = taskAccount.status as Record<string, unknown>;

        // Anchor represents enums as { completed: {} } etc.
        if ("completed" in status) {
          this.handleNodeCompleted(wf, name);
        } else if ("cancelled" in status || "disputed" in status) {
          this.handleNodeFailed(
            wf,
            name,
            new Error(`Task status: ${Object.keys(status)[0]}`),
          );
        }
      } catch (err) {
        // Account not found or RPC error — log but don't fail
        this.logger.debug(`Poll fetch failed for node "${name}": ${err}`);
      }
    }
  }

  // ===========================================================================
  // State Transitions
  // ===========================================================================

  private handleNodeCompleted(wf: MonitoredWorkflow, nodeName: string): void {
    const node = wf.state.nodes.get(nodeName);
    if (!node || node.status === WorkflowNodeStatus.Completed) return;

    node.status = WorkflowNodeStatus.Completed;
    node.completedAt = Date.now();
    this.logger.info(`Workflow "${wf.state.id}" node "${nodeName}" completed`);

    wf.callbacks.onNodeCompleted?.(node);

    this.checkTerminalState(wf);
  }

  private handleNodeFailed(
    wf: MonitoredWorkflow,
    nodeName: string,
    error: Error,
  ): void {
    const node = wf.state.nodes.get(nodeName);
    if (
      !node ||
      node.status === WorkflowNodeStatus.Failed ||
      node.status === WorkflowNodeStatus.Cancelled
    )
      return;

    node.status = WorkflowNodeStatus.Failed;
    node.error = error;
    this.logger.warn(
      `Workflow "${wf.state.id}" node "${nodeName}" failed: ${error.message}`,
    );

    wf.callbacks.onNodeFailed?.(node, error);

    if (wf.cancelOnParentFailure) {
      this.cascadeCancelDescendants(wf, nodeName);
    }

    this.checkTerminalState(wf);
  }

  private cascadeCancelDescendants(
    wf: MonitoredWorkflow,
    failedName: string,
  ): void {
    // Build parent->children adjacency
    const children = new Map<string, string[]>();
    for (const edge of wf.state.definition.edges) {
      if (!children.has(edge.from)) {
        children.set(edge.from, []);
      }
      children.get(edge.from)!.push(edge.to);
    }

    const queue = [failedName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const kids = children.get(current);
      if (!kids) continue;
      for (const kid of kids) {
        const kidNode = wf.state.nodes.get(kid)!;
        if (
          kidNode.status === WorkflowNodeStatus.Created ||
          kidNode.status === WorkflowNodeStatus.Pending ||
          kidNode.status === WorkflowNodeStatus.Creating
        ) {
          const reason = `Parent node "${failedName}" failed`;
          kidNode.status = WorkflowNodeStatus.Cancelled;
          kidNode.error = new Error(reason);
          wf.callbacks.onNodeCancelled?.(kidNode, reason);
          this.logger.info(
            `Cancelled descendant "${kid}" in workflow "${wf.state.id}"`,
          );
        }
        queue.push(kid);
      }
    }
  }

  private checkTerminalState(wf: MonitoredWorkflow): void {
    const nodes = Array.from(wf.state.nodes.values());
    const allCompleted = nodes.every(
      (n) => n.status === WorkflowNodeStatus.Completed,
    );
    const anyFailed = nodes.some((n) => n.status === WorkflowNodeStatus.Failed);
    const anyCancelled = nodes.some(
      (n) => n.status === WorkflowNodeStatus.Cancelled,
    );
    const anyPending = nodes.some(
      (n) =>
        n.status === WorkflowNodeStatus.Pending ||
        n.status === WorkflowNodeStatus.Creating ||
        n.status === WorkflowNodeStatus.Created,
    );

    if (allCompleted) {
      wf.state.status = WorkflowStatus.Completed;
      wf.state.completedAt = Date.now();
      wf.callbacks.onWorkflowCompleted?.(wf.state);
      this.resolveWorkflow(wf);
    } else if ((anyFailed || anyCancelled) && !anyPending) {
      // All nodes resolved — some failed/cancelled, some completed
      const anyCompleted = nodes.some(
        (n) => n.status === WorkflowNodeStatus.Completed,
      );
      if (anyCompleted && !wf.cancelOnParentFailure) {
        wf.state.status = WorkflowStatus.PartiallyCompleted;
      } else {
        wf.state.status = WorkflowStatus.Failed;
      }
      wf.state.completedAt = Date.now();
      wf.callbacks.onWorkflowFailed?.(wf.state);
      this.resolveWorkflow(wf);
    }
  }

  private resolveWorkflow(wf: MonitoredWorkflow): void {
    if (wf.timeoutHandle) {
      clearTimeout(wf.timeoutHandle);
      wf.timeoutHandle = undefined;
    }
    if (wf.resolveTerminal) {
      wf.resolveTerminal(wf.state);
      wf.resolveTerminal = undefined;
      wf.rejectTerminal = undefined;
    }
  }

  private stopAll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.completedListenerId !== null) {
      void this.program.removeEventListener(this.completedListenerId);
      this.completedListenerId = null;
    }
    if (this.cancelledListenerId !== null) {
      void this.program.removeEventListener(this.cancelledListenerId);
      this.cancelledListenerId = null;
    }
    this.started = false;
    this.logger.debug("Workflow monitoring stopped");
  }
}
