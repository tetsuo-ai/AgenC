/**
 * EventMonitor — lifecycle manager for event subscriptions with metrics.
 *
 * Provides a unified interface for subscribing to all AgenC protocol events
 * (task, dispute, protocol, agent) with transparent metrics counting.
 *
 * Subscriptions are immediately live when subscribe methods are called.
 * start()/stop() control lifecycle flags and metrics only.
 *
 * @module
 */

import { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../types/agenc_coordination.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  EventCallback,
  EventSubscription,
  TaskEventCallbacks,
  TaskEventFilterOptions,
  DisputeEventCallbacks,
  DisputeEventFilterOptions,
  ProtocolEventCallbacks,
  ProtocolEventFilterOptions,
} from "./types.js";
import type {
  AgentEventCallbacks,
  EventSubscriptionOptions,
} from "../agent/events.js";
import { subscribeToAllTaskEvents } from "./task.js";
import { subscribeToAllDisputeEvents } from "./dispute.js";
import { subscribeToAllProtocolEvents } from "./protocol.js";
import { subscribeToAllAgentEvents } from "../agent/events.js";

export interface EventMonitorConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Logger instance (defaults to silentLogger) */
  logger?: Logger;
}

export interface EventMonitorMetrics {
  /** Total events received across all subscriptions */
  totalEventsReceived: number;
  /** Events received per event name */
  eventCounts: Record<string, number>;
  /** Timestamp when monitoring started (null if not started) */
  startedAt: number | null;
  /** Duration monitoring has been active (ms), 0 if not started */
  uptimeMs: number;
}

export class EventMonitor {
  private readonly program: Program<AgencCoordination>;
  private readonly logger: Logger;
  private subscriptions: EventSubscription[] = [];
  private started = false;
  private startedAt: number | null = null;
  private totalEventsReceived = 0;
  private eventCounts: Record<string, number> = {};

  constructor(config: EventMonitorConfig) {
    if (!config.program) {
      throw new Error("EventMonitorConfig.program is required");
    }
    this.program = config.program;
    this.logger = config.logger ?? silentLogger;
  }

  /**
   * Subscribe to task events.
   * Immediately creates live Anchor listeners.
   */
  subscribeToTaskEvents(
    callbacks: TaskEventCallbacks,
    options?: TaskEventFilterOptions,
  ): void {
    const wrapped = this.wrapTaskCallbacks(callbacks);
    const sub = subscribeToAllTaskEvents(this.program, wrapped, options);
    this.subscriptions.push(sub);
    this.logger.debug("Subscribed to task events");
  }

  /**
   * Subscribe to dispute events.
   * Immediately creates live Anchor listeners.
   */
  subscribeToDisputeEvents(
    callbacks: DisputeEventCallbacks,
    options?: DisputeEventFilterOptions,
  ): void {
    const wrapped = this.wrapDisputeCallbacks(callbacks);
    const sub = subscribeToAllDisputeEvents(this.program, wrapped, options);
    this.subscriptions.push(sub);
    this.logger.debug("Subscribed to dispute events");
  }

  /**
   * Subscribe to protocol events.
   * Immediately creates live Anchor listeners.
   */
  subscribeToProtocolEvents(
    callbacks: ProtocolEventCallbacks,
    options?: ProtocolEventFilterOptions,
  ): void {
    const wrapped = this.wrapProtocolCallbacks(callbacks);
    const sub = subscribeToAllProtocolEvents(this.program, wrapped, options);
    this.subscriptions.push(sub);
    this.logger.debug("Subscribed to protocol events");
  }

  /**
   * Subscribe to agent events (delegates to Phase 1 agent/events.ts).
   * Immediately creates live Anchor listeners.
   */
  subscribeToAgentEvents(
    callbacks: AgentEventCallbacks,
    options?: EventSubscriptionOptions,
  ): void {
    const wrapped = this.wrapAgentCallbacks(callbacks);
    const sub = subscribeToAllAgentEvents(this.program, wrapped, options);
    this.subscriptions.push(sub);
    this.logger.debug("Subscribed to agent events");
  }

  /**
   * Mark monitoring as started. Sets isRunning() to true and records startedAt.
   * Subscriptions are already live from subscribe calls — this is for lifecycle tracking.
   * Idempotent — calling when already started is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.logger.info("EventMonitor started");
  }

  /**
   * Stop monitoring and unsubscribe from all events.
   * Idempotent — calling when already stopped is a no-op.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const count = this.subscriptions.length;
    await Promise.all(this.subscriptions.map((s) => s.unsubscribe()));
    this.subscriptions = [];
    this.startedAt = null;
    this.logger.info(`EventMonitor stopped, ${count} subscriptions cleaned up`);
  }

  /** Get current monitoring metrics. */
  getMetrics(): EventMonitorMetrics {
    return {
      totalEventsReceived: this.totalEventsReceived,
      eventCounts: { ...this.eventCounts },
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** Check if monitor is currently running. */
  isRunning(): boolean {
    return this.started;
  }

  /** Get the number of active subscriptions. */
  getSubscriptionCount(): number {
    return this.subscriptions.length;
  }

  // --- Private helpers ---

  private recordEvent(eventName: string): void {
    this.totalEventsReceived++;
    this.eventCounts[eventName] = (this.eventCounts[eventName] ?? 0) + 1;
  }

  private wrapCallback<T>(
    eventName: string,
    callback: EventCallback<T>,
  ): EventCallback<T> {
    return (event: T, slot: number, signature: string) => {
      this.recordEvent(eventName);
      callback(event, slot, signature);
    };
  }

  private wrapTaskCallbacks(callbacks: TaskEventCallbacks): TaskEventCallbacks {
    return {
      onTaskCreated: callbacks.onTaskCreated
        ? this.wrapCallback("taskCreated", callbacks.onTaskCreated)
        : undefined,
      onTaskClaimed: callbacks.onTaskClaimed
        ? this.wrapCallback("taskClaimed", callbacks.onTaskClaimed)
        : undefined,
      onTaskCompleted: callbacks.onTaskCompleted
        ? this.wrapCallback("taskCompleted", callbacks.onTaskCompleted)
        : undefined,
      onTaskCancelled: callbacks.onTaskCancelled
        ? this.wrapCallback("taskCancelled", callbacks.onTaskCancelled)
        : undefined,
      onDependentTaskCreated: callbacks.onDependentTaskCreated
        ? this.wrapCallback(
            "dependentTaskCreated",
            callbacks.onDependentTaskCreated,
          )
        : undefined,
    };
  }

  private wrapDisputeCallbacks(
    callbacks: DisputeEventCallbacks,
  ): DisputeEventCallbacks {
    return {
      onDisputeInitiated: callbacks.onDisputeInitiated
        ? this.wrapCallback("disputeInitiated", callbacks.onDisputeInitiated)
        : undefined,
      onDisputeVoteCast: callbacks.onDisputeVoteCast
        ? this.wrapCallback("disputeVoteCast", callbacks.onDisputeVoteCast)
        : undefined,
      onDisputeResolved: callbacks.onDisputeResolved
        ? this.wrapCallback("disputeResolved", callbacks.onDisputeResolved)
        : undefined,
      onDisputeExpired: callbacks.onDisputeExpired
        ? this.wrapCallback("disputeExpired", callbacks.onDisputeExpired)
        : undefined,
      onDisputeCancelled: callbacks.onDisputeCancelled
        ? this.wrapCallback("disputeCancelled", callbacks.onDisputeCancelled)
        : undefined,
      onArbiterVotesCleanedUp: callbacks.onArbiterVotesCleanedUp
        ? this.wrapCallback(
            "arbiterVotesCleanedUp",
            callbacks.onArbiterVotesCleanedUp,
          )
        : undefined,
    };
  }

  private wrapProtocolCallbacks(
    callbacks: ProtocolEventCallbacks,
  ): ProtocolEventCallbacks {
    return {
      onStateUpdated: callbacks.onStateUpdated
        ? this.wrapCallback("stateUpdated", callbacks.onStateUpdated)
        : undefined,
      onProtocolInitialized: callbacks.onProtocolInitialized
        ? this.wrapCallback(
            "protocolInitialized",
            callbacks.onProtocolInitialized,
          )
        : undefined,
      onRewardDistributed: callbacks.onRewardDistributed
        ? this.wrapCallback("rewardDistributed", callbacks.onRewardDistributed)
        : undefined,
      onRateLimitHit: callbacks.onRateLimitHit
        ? this.wrapCallback("rateLimitHit", callbacks.onRateLimitHit)
        : undefined,
      onMigrationCompleted: callbacks.onMigrationCompleted
        ? this.wrapCallback(
            "migrationCompleted",
            callbacks.onMigrationCompleted,
          )
        : undefined,
      onProtocolVersionUpdated: callbacks.onProtocolVersionUpdated
        ? this.wrapCallback(
            "protocolVersionUpdated",
            callbacks.onProtocolVersionUpdated,
          )
        : undefined,
      onRateLimitsUpdated: callbacks.onRateLimitsUpdated
        ? this.wrapCallback("rateLimitsUpdated", callbacks.onRateLimitsUpdated)
        : undefined,
      onProtocolFeeUpdated: callbacks.onProtocolFeeUpdated
        ? this.wrapCallback(
            "protocolFeeUpdated",
            callbacks.onProtocolFeeUpdated,
          )
        : undefined,
      onReputationChanged: callbacks.onReputationChanged
        ? this.wrapCallback("reputationChanged", callbacks.onReputationChanged)
        : undefined,
      onBondDeposited: callbacks.onBondDeposited
        ? this.wrapCallback("bondDeposited", callbacks.onBondDeposited)
        : undefined,
      onBondLocked: callbacks.onBondLocked
        ? this.wrapCallback("bondLocked", callbacks.onBondLocked)
        : undefined,
      onBondReleased: callbacks.onBondReleased
        ? this.wrapCallback("bondReleased", callbacks.onBondReleased)
        : undefined,
      onBondSlashed: callbacks.onBondSlashed
        ? this.wrapCallback("bondSlashed", callbacks.onBondSlashed)
        : undefined,
      onSpeculativeCommitmentCreated: callbacks.onSpeculativeCommitmentCreated
        ? this.wrapCallback(
            "speculativeCommitmentCreated",
            callbacks.onSpeculativeCommitmentCreated,
          )
        : undefined,
    };
  }

  private wrapAgentCallbacks(
    callbacks: AgentEventCallbacks,
  ): AgentEventCallbacks {
    return {
      onRegistered: callbacks.onRegistered
        ? this.wrapCallback("agentRegistered", callbacks.onRegistered)
        : undefined,
      onUpdated: callbacks.onUpdated
        ? this.wrapCallback("agentUpdated", callbacks.onUpdated)
        : undefined,
      onDeregistered: callbacks.onDeregistered
        ? this.wrapCallback("agentDeregistered", callbacks.onDeregistered)
        : undefined,
      onSuspended: callbacks.onSuspended
        ? this.wrapCallback("agentSuspended", callbacks.onSuspended)
        : undefined,
      onUnsuspended: callbacks.onUnsuspended
        ? this.wrapCallback("agentUnsuspended", callbacks.onUnsuspended)
        : undefined,
    };
  }
}
