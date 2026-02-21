/**
 * Deterministic transition validation for replay projection streams.
 */

import { OnChainTaskStatus } from "../task/types.js";
import { OnChainDisputeStatus } from "../dispute/types.js";

export { OnChainTaskStatus, OnChainDisputeStatus };

export type ReplayLifecycleType = "task" | "dispute" | "speculation";

/**
 * On-chain task transition matrix.
 * Source of truth: programs/agenc-coordination/src/state.rs TaskStatus::can_transition_to()
 *
 * Key = from status, Value = set of valid to statuses.
 * Terminal states (Completed, Cancelled) have empty sets.
 */
export const ON_CHAIN_TASK_TRANSITIONS: Readonly<
  Record<OnChainTaskStatus, ReadonlySet<OnChainTaskStatus>>
> = {
  [OnChainTaskStatus.Open]: new Set([
    OnChainTaskStatus.InProgress,
    OnChainTaskStatus.Cancelled,
  ]),
  [OnChainTaskStatus.InProgress]: new Set([
    OnChainTaskStatus.InProgress, // additional claims on collaborative tasks
    OnChainTaskStatus.Completed,
    OnChainTaskStatus.Cancelled,
    OnChainTaskStatus.Disputed,
    OnChainTaskStatus.PendingValidation,
  ]),
  [OnChainTaskStatus.PendingValidation]: new Set([
    OnChainTaskStatus.Completed,
    OnChainTaskStatus.Disputed,
  ]),
  [OnChainTaskStatus.Completed]: new Set(), // terminal
  [OnChainTaskStatus.Cancelled]: new Set(), // terminal
  [OnChainTaskStatus.Disputed]: new Set([
    OnChainTaskStatus.Completed,
    OnChainTaskStatus.Cancelled,
  ]),
};

/** Valid start states for tasks (initial status when created). */
export const ON_CHAIN_TASK_START_STATES: ReadonlySet<OnChainTaskStatus> =
  new Set([OnChainTaskStatus.Open]);

/**
 * On-chain dispute transition matrix.
 * Derived from instruction handler logic (resolve_dispute, expire_dispute,
 * cancel_dispute). Unlike TaskStatus, DisputeStatus does not have a
 * can_transition_to() method — transitions are enforced by each instruction.
 * Active can go to Resolved, Expired, or Cancelled.
 * All other states are terminal.
 */
export const ON_CHAIN_DISPUTE_TRANSITIONS: Readonly<
  Record<OnChainDisputeStatus, ReadonlySet<OnChainDisputeStatus>>
> = {
  [OnChainDisputeStatus.Active]: new Set([
    OnChainDisputeStatus.Resolved,
    OnChainDisputeStatus.Expired,
    OnChainDisputeStatus.Cancelled,
  ]),
  [OnChainDisputeStatus.Resolved]: new Set(), // terminal
  [OnChainDisputeStatus.Expired]: new Set(), // terminal
  [OnChainDisputeStatus.Cancelled]: new Set(), // terminal
};

/** Valid start states for disputes. */
export const ON_CHAIN_DISPUTE_START_STATES: ReadonlySet<OnChainDisputeStatus> =
  new Set([OnChainDisputeStatus.Active]);

/**
 * Maps on-chain event names to the on-chain TaskStatus they transition TO.
 * Used to validate that replay events correspond to valid on-chain transitions.
 */
export const EVENT_TO_TASK_STATUS: Readonly<Record<string, OnChainTaskStatus>> =
  {
    taskCreated: OnChainTaskStatus.Open,
    taskClaimed: OnChainTaskStatus.InProgress,
    taskCompleted: OnChainTaskStatus.Completed,
    taskCancelled: OnChainTaskStatus.Cancelled,
  };

/**
 * Maps on-chain event names to the on-chain DisputeStatus they transition TO.
 */
export const EVENT_TO_DISPUTE_STATUS: Readonly<
  Record<string, OnChainDisputeStatus>
> = {
  disputeInitiated: OnChainDisputeStatus.Active,
  disputeResolved: OnChainDisputeStatus.Resolved,
  disputeExpired: OnChainDisputeStatus.Expired,
  disputeCancelled: OnChainDisputeStatus.Cancelled,
};

export interface TransitionValidationViolation {
  scope: ReplayLifecycleType;
  entityId: string;
  eventName: string;
  eventType: string;
  fromState?: string;
  toState: string;
  reason: string;
  signature: string;
  slot: number;
  sourceEventSequence: number;
  anomalyCode: string;
}

export interface TransitionValidationOptions {
  scope: ReplayLifecycleType;
  entityId: string;
  eventName: string;
  eventType: string;
  previousState: string | undefined;
  nextState: string;
  signature: string;
  slot: number;
  sourceEventSequence: number;
  transitions: Record<string, ReadonlySet<string>>;
  allowedStarts: ReadonlySet<string>;
}

export const ANOMALY_CODES = {
  TASK_DOUBLE_COMPLETE: "TASK_DOUBLE_COMPLETE",
  TASK_INVALID_START: "TASK_INVALID_START",
  TASK_TERMINAL_TRANSITION: "TASK_TERMINAL_TRANSITION",
  DISPUTE_INVALID_START: "DISPUTE_INVALID_START",
  DISPUTE_TERMINAL_TRANSITION: "DISPUTE_TERMINAL_TRANSITION",
  SPECULATION_INVALID_START: "SPECULATION_INVALID_START",
  SPECULATION_TERMINAL_TRANSITION: "SPECULATION_TERMINAL_TRANSITION",
  UNKNOWN_TRANSITION: "UNKNOWN_TRANSITION",
} as const;

const SEPARATOR = " -> ";

function deriveAnomalyCode(
  scope: ReplayLifecycleType,
  previousState: string | undefined,
  nextState: string,
  transitions: Record<string, ReadonlySet<string>>,
): string {
  if (previousState === undefined) {
    return `${scope.toUpperCase()}_INVALID_START`;
  }

  if (previousState === nextState && nextState === "completed") {
    return ANOMALY_CODES.TASK_DOUBLE_COMPLETE;
  }

  const allowed = transitions[previousState];
  const isTerminal = allowed !== undefined && allowed.size === 0;
  if (isTerminal) {
    return `${scope.toUpperCase()}_TERMINAL_TRANSITION`;
  }

  return ANOMALY_CODES.UNKNOWN_TRANSITION;
}

export function validateTransition(
  options: TransitionValidationOptions,
): TransitionValidationViolation | undefined {
  const { previousState, nextState, allowedStarts, transitions, ...details } =
    options;
  if (previousState === undefined) {
    if (!allowedStarts.has(nextState)) {
      return {
        ...details,
        fromState: undefined,
        toState: nextState,
        reason: `none${SEPARATOR}${nextState}`,
        anomalyCode: deriveAnomalyCode(
          details.scope,
          previousState,
          nextState,
          transitions,
        ),
      };
    }
    return undefined;
  }

  const allowedTransitions = transitions[previousState];
  if (allowedTransitions && allowedTransitions.has(nextState)) {
    return undefined;
  }

  return {
    ...details,
    fromState: previousState,
    toState: nextState,
    reason: `${previousState}${SEPARATOR}${nextState}`,
    anomalyCode: deriveAnomalyCode(
      details.scope,
      previousState,
      nextState,
      transitions,
    ),
  };
}

export function transitionViolationMessage(
  violation: TransitionValidationViolation,
): string {
  return `${violation.scope}:${violation.entityId}@${violation.signature}: ${violation.reason} for ${violation.eventName}`;
}

export interface TransitionValidationResult {
  valid: boolean;
  violation?: TransitionValidationViolation;
}

export interface TransitionAnomalyPayload {
  type: "transition_invalid";
  scope: ReplayLifecycleType;
  from: string | undefined;
  to: string;
  reason: string;
  taskPda?: string;
  disputePda?: string;
  entityId: string;
  slot: number;
  signature: string;
  sourceEventSequence: number;
  eventName: string;
  onChainFrom?: number;
  onChainTo?: number;
}

/**
 * Validates state transitions for both replay lifecycle and on-chain status.
 *
 * Usage:
 *   const validator = new TransitionValidator();
 *   const result = validator.validate({ scope: 'task', ... });
 *   if (!result.valid) { // emit anomaly from result.violation }
 */
export class TransitionValidator {
  private readonly onChainTaskStates = new Map<string, OnChainTaskStatus>();
  private readonly onChainDisputeStates = new Map<
    string,
    OnChainDisputeStatus
  >();

  /**
   * Validate a replay lifecycle transition AND the corresponding on-chain
   * status transition (when a mapping exists).
   */
  validate(options: TransitionValidationOptions): TransitionValidationResult {
    // 1. Run existing replay lifecycle validation
    const replayViolation = validateTransition(options);
    if (replayViolation) {
      return { valid: false, violation: replayViolation };
    }

    // 2. If this event maps to an on-chain status, validate that too
    if (options.scope === "task") {
      const onChainTo = EVENT_TO_TASK_STATUS[options.eventName];
      if (onChainTo !== undefined) {
        const onChainFrom = this.onChainTaskStates.get(options.entityId);
        if (onChainFrom !== undefined) {
          const allowed = ON_CHAIN_TASK_TRANSITIONS[onChainFrom];
          if (!allowed.has(onChainTo)) {
            return {
              valid: false,
              violation: {
                scope: "task",
                entityId: options.entityId,
                eventName: options.eventName,
                eventType: options.eventType,
                fromState: OnChainTaskStatus[onChainFrom],
                toState: OnChainTaskStatus[onChainTo],
                reason: `on-chain: ${OnChainTaskStatus[onChainFrom]} -> ${OnChainTaskStatus[onChainTo]}`,
                signature: options.signature,
                slot: options.slot,
                sourceEventSequence: options.sourceEventSequence,
                anomalyCode: ANOMALY_CODES.UNKNOWN_TRANSITION,
              },
            };
          }
        }
        this.onChainTaskStates.set(options.entityId, onChainTo);
      }
    }

    if (options.scope === "dispute") {
      const onChainTo = EVENT_TO_DISPUTE_STATUS[options.eventName];
      if (onChainTo !== undefined) {
        const onChainFrom = this.onChainDisputeStates.get(options.entityId);
        if (onChainFrom !== undefined) {
          const allowed = ON_CHAIN_DISPUTE_TRANSITIONS[onChainFrom];
          if (!allowed.has(onChainTo)) {
            return {
              valid: false,
              violation: {
                scope: "dispute",
                entityId: options.entityId,
                eventName: options.eventName,
                eventType: options.eventType,
                fromState: OnChainDisputeStatus[onChainFrom],
                toState: OnChainDisputeStatus[onChainTo],
                reason: `on-chain: ${OnChainDisputeStatus[onChainFrom]} -> ${OnChainDisputeStatus[onChainTo]}`,
                signature: options.signature,
                slot: options.slot,
                sourceEventSequence: options.sourceEventSequence,
                anomalyCode: ANOMALY_CODES.UNKNOWN_TRANSITION,
              },
            };
          }
        }
        this.onChainDisputeStates.set(options.entityId, onChainTo);
      }
    }

    return { valid: true };
  }

  /** Emit a structured anomaly payload for a transition violation. */
  toAnomaly(
    violation: TransitionValidationViolation,
    context?: {
      taskPda?: string;
      disputePda?: string;
    },
  ): TransitionAnomalyPayload {
    return {
      type: "transition_invalid",
      scope: violation.scope,
      from: violation.fromState,
      to: violation.toState,
      reason: violation.reason,
      taskPda: context?.taskPda,
      disputePda: context?.disputePda,
      entityId: violation.entityId,
      slot: violation.slot,
      signature: violation.signature,
      sourceEventSequence: violation.sourceEventSequence,
      eventName: violation.eventName,
    };
  }

  /** Reset all tracked state (for testing or re-processing). */
  reset(): void {
    this.onChainTaskStates.clear();
    this.onChainDisputeStates.clear();
  }
}
