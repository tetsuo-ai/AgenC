/**
 * Shared operator-facing background run inspection and control contracts.
 *
 * These types are consumed by the runtime, webchat control plane, and web UI so
 * operator tooling can inspect and mutate durable runs without protocol drift.
 *
 * @module
 */

import type {
  BackgroundRunApprovalState,
  BackgroundRunArtifactRef,
  BackgroundRunBlockerState,
  BackgroundRunBudgetState,
  BackgroundRunCompactionState,
  BackgroundRunContract,
  BackgroundRunObservedTarget,
  BackgroundRunState,
  BackgroundRunWakeReason,
  BackgroundRunWatchRegistration,
} from "./background-run-store.js";
import type { PolicyEvaluationScope } from "../policy/types.js";

export interface BackgroundRunEventRecord {
  readonly summary: string;
  readonly timestamp: number;
  readonly eventType?: string;
  readonly data: Record<string, unknown>;
}

export type BackgroundRunOperatorAvailabilityCode =
  | "autonomy_disabled"
  | "background_runs_feature_disabled"
  | "background_runs_kill_switch"
  | "operator_unavailable";

export interface BackgroundRunOperatorAvailability {
  readonly enabled: boolean;
  readonly operatorAvailable: boolean;
  readonly inspectAvailable: boolean;
  readonly controlAvailable: boolean;
  readonly disabledCode?: BackgroundRunOperatorAvailabilityCode;
  readonly disabledReason?: string;
}

export interface BackgroundRunOperatorErrorPayload {
  readonly code:
    | "background_run_unavailable"
    | "background_run_missing";
  readonly sessionId?: string;
  readonly backgroundRunAvailability?: BackgroundRunOperatorAvailability;
}

export interface BackgroundRunOperatorSummary {
  readonly runId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: BackgroundRunState;
  readonly currentPhase: string;
  readonly explanation: string;
  readonly unsafeToContinue: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastVerifiedAt?: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly cycleCount: number;
  readonly contractKind: BackgroundRunContract["kind"];
  readonly contractDomain: BackgroundRunContract["domain"];
  readonly requiresUserStop: boolean;
  readonly pendingSignals: number;
  readonly watchCount: number;
  readonly fenceToken: number;
  readonly lastUserUpdate?: string;
  readonly lastToolEvidence?: string;
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly carryForwardSummary?: string;
  readonly blockerSummary?: string;
  readonly approvalRequired: boolean;
  readonly approvalState: BackgroundRunApprovalState["status"];
  readonly preferredWorkerId?: string;
  readonly workerAffinityKey?: string;
  readonly checkpointAvailable: boolean;
  readonly availability?: BackgroundRunOperatorAvailability;
}

export interface BackgroundRunOperatorDetail
  extends BackgroundRunOperatorSummary {
  readonly policyScope?: PolicyEvaluationScope;
  readonly contract: BackgroundRunContract;
  readonly blocker?: BackgroundRunBlockerState;
  readonly approval: BackgroundRunApprovalState;
  readonly budget: BackgroundRunBudgetState;
  readonly compaction: BackgroundRunCompactionState;
  readonly artifacts: readonly BackgroundRunArtifactRef[];
  readonly observedTargets: readonly BackgroundRunObservedTarget[];
  readonly watchRegistrations: readonly BackgroundRunWatchRegistration[];
  readonly recentEvents: readonly BackgroundRunEventRecord[];
}

export type BackgroundRunVerificationOverrideMode =
  | "continue"
  | "complete"
  | "fail";

export type BackgroundRunControlAction =
  | {
    readonly action: "pause";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "resume";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "stop";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "cancel";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "edit_objective";
    readonly sessionId: string;
    readonly objective: string;
    readonly reason?: string;
  }
  | {
    readonly action: "amend_constraints";
    readonly sessionId: string;
    readonly constraints: {
      readonly successCriteria?: readonly string[];
      readonly completionCriteria?: readonly string[];
      readonly blockedCriteria?: readonly string[];
      readonly nextCheckMs?: number;
      readonly heartbeatMs?: number;
      readonly requiresUserStop?: boolean;
    };
    readonly reason?: string;
  }
  | {
    readonly action: "adjust_budget";
    readonly sessionId: string;
    readonly budget: {
      readonly maxRuntimeMs?: number;
      readonly maxCycles?: number;
      readonly maxIdleMs?: number;
    };
    readonly reason?: string;
  }
  | {
    readonly action: "force_compact";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "reassign_worker";
    readonly sessionId: string;
    readonly worker: {
      readonly preferredWorkerId?: string;
      readonly workerAffinityKey?: string;
    };
    readonly reason?: string;
  }
  | {
    readonly action: "retry_from_checkpoint";
    readonly sessionId: string;
    readonly reason?: string;
  }
  | {
    readonly action: "verification_override";
    readonly sessionId: string;
    readonly override: {
      readonly mode: BackgroundRunVerificationOverrideMode;
      readonly reason: string;
      readonly userUpdate?: string;
    };
  };

export function buildBackgroundRunExplanation(params: {
  readonly state: BackgroundRunState;
  readonly blocker?: BackgroundRunBlockerState;
  readonly approval: BackgroundRunApprovalState;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly requiresUserStop: boolean;
  readonly now?: number;
}): { currentPhase: string; explanation: string; unsafeToContinue: boolean } {
  const now = params.now ?? Date.now();
  const secondsUntil = (value: number | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const remainingMs = Math.max(0, value - now);
    return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
  };

  if (params.state === "blocked") {
    if (params.approval.status === "waiting" || params.blocker?.requiresApproval) {
      return {
        currentPhase: "waiting_approval",
        explanation:
          params.blocker?.summary ??
          params.approval.summary ??
          "Run is waiting for approval before it can continue.",
        unsafeToContinue: false,
      };
    }
    return {
      currentPhase: "blocked",
      explanation:
        params.blocker?.summary ??
        "Run is blocked and needs new evidence or operator intervention.",
      unsafeToContinue:
        params.blocker?.retryable === false ||
        params.blocker?.requiresOperatorAction === true,
    };
  }

  if (params.state === "paused") {
    return {
      currentPhase: "paused",
      explanation: "Run is paused by an operator and will not make progress until resumed.",
      unsafeToContinue: false,
    };
  }

  if (params.state === "working" || params.state === "running" || params.state === "pending") {
    const nextCheck = secondsUntil(params.nextCheckAt);
    const nextHeartbeat = secondsUntil(params.nextHeartbeatAt);
    const cadence =
      nextCheck !== undefined
        ? ` Next verification in ~${nextCheck}.`
        : nextHeartbeat !== undefined
          ? ` Next heartbeat in ~${nextHeartbeat}.`
          : "";
    return {
      currentPhase: "active",
      explanation:
        params.requiresUserStop
          ? `Run is active and will continue until explicitly stopped.${cadence}`
          : `Run is active and waiting for the next verification cycle.${cadence}`,
      unsafeToContinue: false,
    };
  }

  if (params.state === "completed") {
    return {
      currentPhase: "completed",
      explanation: "Run completed and the runtime recorded a terminal result.",
      unsafeToContinue: false,
    };
  }

  if (params.state === "failed") {
    return {
      currentPhase: "failed",
      explanation:
        params.blocker?.summary ??
        "Run failed and needs operator review before it is retried.",
      unsafeToContinue: true,
    };
  }

  if (params.state === "cancelled") {
    return {
      currentPhase: "cancelled",
      explanation: "Run was cancelled and is no longer executing.",
      unsafeToContinue: false,
    };
  }

  return {
    currentPhase: "suspended",
    explanation:
      params.lastWakeReason === "daemon_shutdown"
        ? "Run was suspended during daemon shutdown and will recover when resumed."
        : "Run is suspended and waiting for recovery.",
    unsafeToContinue: false,
  };
}
