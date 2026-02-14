/**
 * Deterministic transition validation for replay projection streams.
 */

export type ReplayLifecycleType = 'task' | 'dispute' | 'speculation';

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
  TASK_DOUBLE_COMPLETE: 'TASK_DOUBLE_COMPLETE',
  TASK_INVALID_START: 'TASK_INVALID_START',
  TASK_TERMINAL_TRANSITION: 'TASK_TERMINAL_TRANSITION',
  DISPUTE_INVALID_START: 'DISPUTE_INVALID_START',
  DISPUTE_TERMINAL_TRANSITION: 'DISPUTE_TERMINAL_TRANSITION',
  SPECULATION_INVALID_START: 'SPECULATION_INVALID_START',
  SPECULATION_TERMINAL_TRANSITION: 'SPECULATION_TERMINAL_TRANSITION',
  UNKNOWN_TRANSITION: 'UNKNOWN_TRANSITION',
} as const;

const SEPARATOR = ' -> ';

function deriveAnomalyCode(
  scope: ReplayLifecycleType,
  previousState: string | undefined,
  nextState: string,
  transitions: Record<string, ReadonlySet<string>>,
): string {
  if (previousState === undefined) {
    return `${scope.toUpperCase()}_INVALID_START`;
  }

  if (previousState === nextState && nextState === 'completed') {
    return ANOMALY_CODES.TASK_DOUBLE_COMPLETE;
  }

  const allowed = transitions[previousState];
  const isTerminal = allowed !== undefined && allowed.size === 0;
  if (isTerminal) {
    return `${scope.toUpperCase()}_TERMINAL_TRANSITION`;
  }

  return ANOMALY_CODES.UNKNOWN_TRANSITION;
}

export function validateTransition(options: TransitionValidationOptions): TransitionValidationViolation | undefined {
  const { previousState, nextState, allowedStarts, transitions, ...details } = options;
  if (previousState === undefined) {
    if (!allowedStarts.has(nextState)) {
      return {
        ...details,
        fromState: undefined,
        toState: nextState,
        reason: `none${SEPARATOR}${nextState}`,
        anomalyCode: deriveAnomalyCode(details.scope, previousState, nextState, transitions),
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
    anomalyCode: deriveAnomalyCode(details.scope, previousState, nextState, transitions),
  };
}

export function transitionViolationMessage(violation: TransitionValidationViolation): string {
  return `${violation.scope}:${violation.entityId}@${violation.signature}: ${violation.reason} for ${violation.eventName}`;
}
