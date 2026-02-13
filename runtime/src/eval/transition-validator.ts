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

const SEPARATOR = ' -> ';

export function validateTransition(options: TransitionValidationOptions): TransitionValidationViolation | undefined {
  const { previousState, nextState, allowedStarts, transitions, ...details } = options;
  if (previousState === undefined) {
    if (!allowedStarts.has(nextState)) {
      return {
        ...details,
        fromState: undefined,
        toState: nextState,
        reason: `none${SEPARATOR}${nextState}`,
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
  };
}

export function transitionViolationMessage(violation: TransitionValidationViolation): string {
  return `${violation.scope}:${violation.entityId}@${violation.signature}: ${violation.reason} for ${violation.eventName}`;
}
