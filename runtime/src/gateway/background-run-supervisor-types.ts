/**
 * Internal types, interfaces, and run-conversion functions for the BackgroundRunSupervisor.
 *
 * Extracted from background-run-supervisor.ts to separate type definitions
 * from orchestration logic.
 *
 * @module
 */

import type { ChatExecutor, ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMMessage, LLMProvider, ToolHandler } from "../llm/types.js";
import type { GatewayMessage } from "./message.js";
import type { Logger } from "../utils/logger.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import type { ProgressTracker } from "./progress.js";
import type { PolicyEvaluationScope, PolicyEngine } from "../policy/index.js";
import type { TelemetryCollector } from "../telemetry/types.js";
import type { BackgroundRunNotifier } from "./background-run-notifier.js";
import {
  AGENT_RUN_SCHEMA_VERSION,
} from "./agent-run-contract.js";
import {
  type BackgroundRunApprovalState,
  type BackgroundRunBlockerState,
  type BackgroundRunBudgetState,
  type BackgroundRunCarryForwardState,
  type BackgroundRunCompactionState,
  type BackgroundRunContract,
  type BackgroundRunObservedTarget,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunState,
  type BackgroundRunWakeReason,
  type BackgroundRunWatchRegistration,
  type BackgroundRunWorkerPool,
  type PersistedBackgroundRun,
  BackgroundRunStore,
} from "./background-run-store.js";
import type { BackgroundRunLineage } from "./subrun-contract.js";
import type {
  BackgroundRunEventRecord,
} from "./background-run-operator.js";
import { MAX_RUN_HISTORY_MESSAGES } from "./background-run-supervisor-constants.js";
import { cloneSignals } from "./background-run-supervisor-helpers.js";

export interface BackgroundRunStatusSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: BackgroundRunState;
  readonly cycleCount: number;
  readonly lastVerifiedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastUserUpdate?: string;
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly pendingSignals: number;
  readonly carryForwardSummary?: string;
  readonly blockerSummary?: string;
  readonly watchCount: number;
  readonly fenceToken: number;
}

export interface BackgroundRunAlert {
  readonly id: string;
  readonly severity: "info" | "warn" | "error";
  readonly code: string;
  readonly message: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface BackgroundRunFleetStatusSnapshot {
  readonly activeTotal: number;
  readonly stateCounts: Record<BackgroundRunState, number>;
  readonly queuedSignalsTotal: number;
  readonly recentAlerts: readonly BackgroundRunAlert[];
}

export interface BackgroundRunDecision {
  readonly state: Exclude<BackgroundRunState, "pending" | "running" | "suspended">;
  readonly userUpdate: string;
  readonly internalSummary: string;
  readonly nextCheckMs?: number;
  readonly shouldNotifyUser: boolean;
}

export interface ActiveBackgroundRun {
  version: typeof AGENT_RUN_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  objective: string;
  policyScope?: PolicyEvaluationScope;
  contract: BackgroundRunContract;
  state: BackgroundRunState;
  fenceToken: number;
  createdAt: number;
  updatedAt: number;
  cycleCount: number;
  stableWorkingCycles: number;
  consecutiveErrorCycles: number;
  nextCheckAt?: number;
  nextHeartbeatAt?: number;
  lastVerifiedAt?: number;
  lastUserUpdate?: string;
  lastToolEvidence?: string;
  lastHeartbeatContent?: string;
  lastWakeReason?: BackgroundRunWakeReason;
  carryForward?: BackgroundRunCarryForwardState;
  blocker?: BackgroundRunBlockerState;
  approvalState: BackgroundRunApprovalState;
  budgetState: BackgroundRunBudgetState;
  compaction: BackgroundRunCompactionState;
  pendingSignals: BackgroundRunSignal[];
  observedTargets: BackgroundRunObservedTarget[];
  watchRegistrations: BackgroundRunWatchRegistration[];
  internalHistory: LLMMessage[];
  lineage?: BackgroundRunLineage;
  preferredWorkerId?: string;
  workerAffinityKey?: string;
  leaseOwnerId?: string;
  leaseExpiresAt?: number;
  timer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export interface BackgroundRunSupervisorConfig {
  readonly chatExecutor: ChatExecutor;
  readonly supervisorLlm: LLMProvider;
  readonly getSystemPrompt: () => string;
  readonly createToolHandler: (params: {
    sessionId: string;
    runId: string;
    cycleIndex: number;
  }) => ToolHandler;
  readonly buildToolRoutingDecision?: (
    sessionId: string,
    messageText: string,
    history: readonly LLMMessage[],
  ) => ToolRoutingDecision | undefined;
  readonly seedHistoryForSession?: (sessionId: string) => readonly LLMMessage[];
  readonly isSessionBusy?: (sessionId: string) => boolean;
  readonly onStatus?: (
    sessionId: string,
    payload: { phase: string; detail?: string },
  ) => void;
  readonly publishUpdate: (sessionId: string, content: string) => Promise<void>;
  readonly progressTracker?: ProgressTracker;
  readonly runStore: BackgroundRunStore;
  readonly policyEngine?: PolicyEngine;
  readonly resolvePolicyScope?: (params: {
    sessionId: string;
    runId: string;
  }) => PolicyEvaluationScope | undefined;
  readonly telemetry?: TelemetryCollector;
  readonly logger?: Logger;
  readonly instanceId?: string;
  readonly now?: () => number;
  readonly workerPools?: readonly BackgroundRunWorkerPool[];
  readonly workerMaxConcurrentRuns?: number;
  readonly notifier?: BackgroundRunNotifier;
  readonly traceProviderPayloads?: boolean;
}

export interface StartBackgroundRunParams {
  readonly sessionId: string;
  readonly objective: string;
  readonly options?: {
    readonly silent?: boolean;
    readonly contract?: BackgroundRunContract;
    readonly seedHistory?: readonly LLMMessage[];
    readonly lineage?: BackgroundRunLineage;
  };
}

export interface PreparedCycleContext {
  readonly run: ActiveBackgroundRun;
  readonly sessionId: string;
  readonly cycleToolHandler: ToolHandler;
  readonly actorPrompt: string;
  readonly actorSystemPrompt: string;
}

export interface ResolvedCycleOutcome {
  readonly run: ActiveBackgroundRun;
  readonly sessionId: string;
  readonly actorResult?: ChatExecutorResult;
  readonly decision: BackgroundRunDecision;
  readonly heartbeatMs?: number;
}

export interface NativeManagedProcessCycleResult {
  readonly actorResult: ChatExecutorResult;
  readonly decision: BackgroundRunDecision;
}

export interface ManagedProcessCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export type CarryForwardRefreshReason =
  | "history_threshold"
  | "milestone"
  | "forced"
  | "repair";

export function trimHistory(history: LLMMessage[]): LLMMessage[] {
  if (history.length <= MAX_RUN_HISTORY_MESSAGES) return history;
  return history.slice(history.length - MAX_RUN_HISTORY_MESSAGES);
}

export function toPersistedRun(run: ActiveBackgroundRun): PersistedBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    policyScope: run.policyScope,
    contract: run.contract,
    state: run.state,
    fenceToken: run.fenceToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    carryForward: run.carryForward,
    blocker: run.blocker,
    approvalState: run.approvalState,
    budgetState: run.budgetState,
    compaction: run.compaction,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    watchRegistrations: [...run.watchRegistrations],
    internalHistory: trimHistory([...run.internalHistory]),
    lineage: run.lineage,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
  };
}

export function toRecentSnapshot(
  run: ActiveBackgroundRun,
  queuedWakeCount = 0,
): BackgroundRunRecentSnapshot {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    runId: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    policyScope: run.policyScope,
    state: run.state,
    contractKind: run.contract.kind,
    requiresUserStop: run.contract.requiresUserStop,
    cycleCount: run.cycleCount,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastVerifiedAt: run.lastVerifiedAt,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastWakeReason: run.lastWakeReason,
    pendingSignals: run.pendingSignals.length + queuedWakeCount,
    carryForwardSummary: run.carryForward?.summary,
    blockerSummary: run.blocker?.summary,
    watchCount: run.watchRegistrations.length,
    fenceToken: run.fenceToken,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
  };
}

export function toActiveRun(run: PersistedBackgroundRun): ActiveBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: run.id,
    sessionId: run.sessionId,
    objective: run.objective,
    policyScope: run.policyScope,
    contract: run.contract,
    state: run.state,
    fenceToken: run.fenceToken,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cycleCount: run.cycleCount,
    stableWorkingCycles: run.stableWorkingCycles,
    consecutiveErrorCycles: run.consecutiveErrorCycles,
    nextCheckAt: run.nextCheckAt,
    nextHeartbeatAt: run.nextHeartbeatAt,
    lastVerifiedAt: run.lastVerifiedAt,
    lastUserUpdate: run.lastUserUpdate,
    lastToolEvidence: run.lastToolEvidence,
    lastHeartbeatContent: run.lastHeartbeatContent,
    lastWakeReason: run.lastWakeReason,
    carryForward: run.carryForward,
    blocker: run.blocker,
    approvalState: run.approvalState,
    budgetState: run.budgetState,
    compaction: run.compaction,
    pendingSignals: cloneSignals(run.pendingSignals),
    observedTargets: [...run.observedTargets],
    watchRegistrations: [...run.watchRegistrations],
    internalHistory: [...run.internalHistory],
    lineage: run.lineage,
    preferredWorkerId: run.preferredWorkerId,
    workerAffinityKey: run.workerAffinityKey,
    leaseOwnerId: run.leaseOwnerId,
    leaseExpiresAt: run.leaseExpiresAt,
    timer: null,
    heartbeatTimer: null,
    abortController: null,
  };
}

export function toRunMessage(content: string, sessionId: string, runId: string, cycleIndex: number): GatewayMessage {
  return {
    id: `background-run:${runId}:${cycleIndex}:${Date.now()}`,
    channel: "webchat",
    senderId: `background-run:${runId}`,
    senderName: "Background Supervisor",
    sessionId,
    content,
    scope: "dm",
    attachments: [],
    timestamp: Date.now(),
  } as GatewayMessage;
}

export function toOperatorEventRecords(
  entries: readonly import("../memory/types.js").MemoryEntry[],
): BackgroundRunEventRecord[] {
  return entries.map((entry) => ({
    summary: entry.content,
    timestamp: entry.timestamp,
    eventType:
      typeof entry.metadata?.eventType === "string"
        ? entry.metadata.eventType
        : undefined,
    data:
      entry.metadata && typeof entry.metadata === "object"
        ? { ...entry.metadata }
        : {},
  }));
}
