/**
 * BackgroundRunSupervisor — daemon-owned long-running task supervision for user sessions.
 *
 * Converts explicit long-running user objectives into a bounded background loop:
 * actor step (ChatExecutor + tools) -> verifier step (structured decision) -> reschedule/update.
 *
 * This keeps control in the runtime instead of trusting one chat turn to own
 * the entire task lifecycle.
 *
 * @module
 */

import type { ChatExecutor, ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
  logStructuredTraceEvent,
} from "../llm/provider-trace-logger.js";
import type { ProgressTracker } from "./progress.js";
import type { PolicyDecision, PolicyEngine, PolicyEvaluationScope } from "../policy/index.js";
import type { TelemetryCollector } from "../telemetry/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import { startReplaySpan } from "../replay/trace.js";
import {
  AGENT_RUN_SCHEMA_VERSION,
  assertAgentRunStateTransition,
  assertValidAgentRunContract,
  isTerminalAgentRunState,
} from "./agent-run-contract.js";
import type {
  BackgroundRunControlAction,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from "./background-run-operator.js";
import { BackgroundRunNotifier } from "./background-run-notifier.js";
import {
  assertValidBackgroundRunLineage,
  type BackgroundRunLineage,
} from "./subrun-contract.js";
import {
  BackgroundRunStore,
  DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
  isBackgroundRunFenceConflictError,
  type BackgroundRunEvent,
  type BackgroundRunEventType,
  type BackgroundRunDispatchItem,
  type BackgroundRunContract,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunState,
  type BackgroundRunWorkerPool,
  type BackgroundRunWakeReason,
  type PersistedBackgroundRun,
} from "./background-run-store.js";
import { BackgroundRunWakeBus } from "./background-run-wake-bus.js";
import type { RunDomainRetryPolicy } from "./run-domains.js";

// --- Re-export from extracted constants ---
import {
  DEFAULT_POLL_INTERVAL_MS,
  BUSY_RETRY_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  FAST_FOLLOWUP_POLL_INTERVAL_MS,
  STABLE_POLL_STEP_MS,
  ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS,
  ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS,
  HEARTBEAT_MIN_DELAY_MS,
  HEARTBEAT_MAX_DELAY_MS,
  MAX_USER_UPDATE_CHARS,
  BACKGROUND_RUN_ACTOR_REQUEST_TIMEOUT_MS,
  BACKGROUND_RUN_MAX_TOOL_ROUNDS,
  BACKGROUND_RUN_MAX_TOOL_BUDGET,
  BACKGROUND_RUN_MAX_MODEL_RECALLS,
  MAX_CONSECUTIVE_ERROR_CYCLES,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_DISPATCH_RETRY_MS,
  DEFAULT_DISPATCH_QUEUE_MAX_TOTAL,
  DEFAULT_DISPATCH_QUEUE_MAX_PER_POOL,
  MAX_BACKGROUND_RUN_ALERTS,
  BACKGROUND_ACTOR_SECTION,
  DECISION_SYSTEM_PROMPT,
  CONTRACT_SYSTEM_PROMPT,
  CARRY_FORWARD_SYSTEM_PROMPT,
  UNTIL_STOP_RE,
  KEEP_UPDATING_RE,
  BACKGROUND_RE,
  CONTINUOUS_RE,
  STOP_REQUEST_RE,
  PAUSE_REQUEST_RE,
  RESUME_REQUEST_RE,
  STATUS_REQUEST_RE,
} from "./background-run-supervisor-constants.js";

// --- Re-export from extracted types ---
export type {
  BackgroundRunStatusSnapshot,
  BackgroundRunAlert,
  BackgroundRunFleetStatusSnapshot,
  BackgroundRunSupervisorConfig,
} from "./background-run-supervisor-types.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
  BackgroundRunSupervisorConfig,
  CarryForwardRefreshReason,
  PreparedCycleContext,
  ResolvedCycleOutcome,
  StartBackgroundRunParams,
} from "./background-run-supervisor-types.js";
import type {
  BackgroundRunStatusSnapshot,
  BackgroundRunAlert,
  BackgroundRunFleetStatusSnapshot,
} from "./background-run-supervisor-types.js";
import {
  toPersistedRun,
  toRecentSnapshot,
  toActiveRun,
  toRunMessage,
  toOperatorEventRecords,
  trimHistory,
} from "./background-run-supervisor-types.js";

// --- Re-export from extracted helpers ---
import {
  truncate,
  clampPollIntervalMs,
  normalizePositiveInteger,
  normalizeOperatorStringList,
  summarizeToolCalls,
  sanitizeWorkerPools,
  cloneSignals,
  removeConsumedSignals,
  dropSyntheticInternalSignals,
  formatSignals,
  formatCarryForwardState,
  formatObservedTargets,
  buildInternalToolSignals,
  getWakeEventDomain,
  buildWakeDedupeKey,
  recordToolEvidence,
  recordProviderCompactionArtifacts,
  buildEmptyCarryForwardState,
  buildFallbackCarryForwardState,
  buildCarryForwardAnchors,
  extractLatestProviderContinuation,
  deriveCarryForwardRefreshReason,
  detectCarryForwardDrift,
  repairCarryForwardState,
  parseCarryForwardState,
  buildInitialBudgetState,
  buildInitialCompactionState,
  recordRunActivity,
  refreshDerivedBudgetState,
  clearRunBlockers,
  resolveWorkerPool,
  resolveWorkerAffinityKey,
  getScopedAllowedTools,
  applyRunToolScopeDecision,
  buildBlockerState,
  buildFallbackDecision,
  groundDecision,
  computeConsecutiveErrorCycles,
  applyRepeatedErrorGuard,
  buildDecisionPrompt,
  buildContractPrompt,
  buildCarryForwardPrompt,
  parseDecision,
  parseContract,
  buildFallbackContract,
  buildBackgroundRunTraceIds,
  toOperatorSummary,
} from "./background-run-supervisor-helpers.js";

// --- Re-export from extracted managed-process module ---
import {
  getRunDomain,
  buildDeterministicRunDomainDecision,
  buildPreCycleDomainDecision,
  toDecisionFromDomainVerification,
  observeManagedProcessExitSignal,
  observeManagedProcessTargets,
  getManagedProcessSurface,
  managedProcessStopToolName,
  buildManagedProcessStopArgs,
  buildManagedProcessIdentity,
  findLatestManagedProcessTarget,
  listRunningManagedProcessTargets,
} from "./background-run-supervisor-managed-process.js";
import {
  buildNativeActorResult,
  executeNativeToolCall,
} from "./run-domain-native-tools.js";
import { extractToolFailureText } from "../llm/chat-executor-tool-utils.js";

// ---------------------------------------------------------------------------
// Domain-dependent free functions (kept here to avoid circular deps)
// ---------------------------------------------------------------------------

function resolveRunNextCheckClampMaxMs(
  run: ActiveBackgroundRun,
  retryPolicy?: RunDomainRetryPolicy,
): number {
  return Math.max(
    MAX_POLL_INTERVAL_MS,
    retryPolicy?.maxNextCheckMs ?? getRunDomain(run).retryPolicy?.(run)?.maxNextCheckMs ?? 0,
  );
}

function buildActorPrompt(run: ActiveBackgroundRun): string {
  const recentHistory = run.lastUserUpdate
    ? `Latest published status: ${run.lastUserUpdate}\n`
    : "";
  const recentToolEvidence = run.lastToolEvidence
    ? `Latest tool evidence:\n${run.lastToolEvidence}\n`
    : "";
  const carryForward = formatCarryForwardState(run.carryForward);
  const carryForwardSection = carryForward
    ? `Carry-forward state:\n${carryForward}\n`
    : "";
  const pendingSignals = formatSignals(run.pendingSignals);
  const signalSection = pendingSignals
    ? `Pending external signals:\n${pendingSignals}\n`
    : "";
  const observedTargets = formatObservedTargets(run.observedTargets);
  const observedTargetSection = observedTargets
    ? `Runtime observed targets:\n${observedTargets}\n`
    : "";
  const domain = getRunDomain(run);
  const domainPlannerContract = domain.plannerContract(run);
  const domainVerifierContract = domain.verifierContract(run);
  const domainArtifactContract = domain.artifactContract(run);
  const contractSummary =
    `Run contract:\n${JSON.stringify(run.contract, null, 2)}\n`;
  const firstCycleGuidance = run.cycleCount === 1
    ? "This is the first cycle. Establish the baseline and start any required long-running process before relying on status checks alone.\n"
    : "";
  return (
    `Background objective:\n${run.objective}\n\n` +
    `Cycle: ${run.cycleCount}\n` +
    contractSummary +
    `Domain planner contract:\n- ${domainPlannerContract.join("\n- ")}\n` +
    `Domain verifier contract:\n- ${domainVerifierContract.join("\n- ")}\n` +
    `Domain artifact contract:\n- ${domainArtifactContract.join("\n- ")}\n` +
    carryForwardSection +
    signalSection +
    observedTargetSection +
    recentHistory +
    recentToolEvidence +
    firstCycleGuidance +
    "Take the next best bounded step toward this objective. " +
    "Use tools when necessary. If the task is already running independently, verify its current state instead of narrating.\n"
  );
}

function buildHeartbeatMessage(run: ActiveBackgroundRun): string {
  const domainSummary = getRunDomain(run).summarizeStatus(run);
  const nextCheckMs =
    run.nextCheckAt !== undefined
      ? Math.max(0, run.nextCheckAt - Date.now())
      : undefined;
  const lastVerifiedAgeMs =
    run.lastVerifiedAt !== undefined
      ? Math.max(0, Date.now() - run.lastVerifiedAt)
      : undefined;
  const lastVerifiedText = domainSummary
    ? truncate(domainSummary, 120)
    : run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "Task is still active.";

  return truncate(
    "Still working in the background. " +
      `Last verified update: ${lastVerifiedText}` +
      (lastVerifiedAgeMs !== undefined
        ? ` (${Math.max(1, Math.round(lastVerifiedAgeMs / 1000))}s ago). `
        : " ") +
      (nextCheckMs !== undefined
        ? `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s.`
        : "Next verification is pending."),
    MAX_USER_UPDATE_CHARS,
  );
}

function buildActiveCycleHeartbeatMessage(run: ActiveBackgroundRun): string {
  const domainSummary = getRunDomain(run).summarizeStatus(run);
  const lastVerifiedText = domainSummary
    ? truncate(domainSummary, 120)
    : run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "No verified update has been published yet.";
  const cycleAgeMs = Math.max(0, Date.now() - run.updatedAt);

  return truncate(
    "Still working on the current background cycle. " +
      `Last verified update: ${lastVerifiedText} ` +
      `(cycle active for ~${Math.max(1, Math.ceil(cycleAgeMs / 1000))}s).`,
    MAX_USER_UPDATE_CHARS,
  );
}

function chooseNextCheckMs(params: {
  run: ActiveBackgroundRun;
  actorResult: ChatExecutorResult;
  decision: BackgroundRunDecision;
  previousToolEvidence?: string;
}): { nextCheckMs: number; stableWorkingCycles: number; heartbeatMs?: number } {
  const { run, actorResult, decision, previousToolEvidence } = params;
  const domainRetryPolicy = getRunDomain(run).retryPolicy?.(run);
  const nextCheckClampMaxMs = resolveRunNextCheckClampMaxMs(run, domainRetryPolicy);
  const successfulToolCalls = actorResult.toolCalls.filter((toolCall) => !toolCall.isError);
  const failedToolCalls = actorResult.toolCalls.filter((toolCall) => toolCall.isError);
  const currentEvidence = summarizeToolCalls(actorResult.toolCalls);
  const evidenceChanged = currentEvidence !== previousToolEvidence;
  const nextUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
  const updateChanged = nextUserUpdate !== run.lastUserUpdate;

  if (failedToolCalls.length > 0) {
    return {
      nextCheckMs: MIN_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (run.cycleCount === 1 && successfulToolCalls.length > 0) {
    return {
      nextCheckMs: domainRetryPolicy?.fastFollowupMs ?? FAST_FOLLOWUP_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (successfulToolCalls.length > 0 && (evidenceChanged || updateChanged)) {
    return {
      nextCheckMs: Math.min(
        clampPollIntervalMs(decision.nextCheckMs, {
          maxMs: nextCheckClampMaxMs,
        }),
        domainRetryPolicy?.idleNextCheckMs ?? DEFAULT_POLL_INTERVAL_MS,
      ),
      stableWorkingCycles: 0,
    };
  }

  const stableWorkingCycles = evidenceChanged || updateChanged
    ? 0
    : run.stableWorkingCycles + 1;
  const nextCheckMs = clampPollIntervalMs(
    Math.min(
      domainRetryPolicy?.maxNextCheckMs ?? MAX_POLL_INTERVAL_MS,
      (domainRetryPolicy?.idleNextCheckMs ?? DEFAULT_POLL_INTERVAL_MS) +
        (stableWorkingCycles * (domainRetryPolicy?.stableStepMs ?? STABLE_POLL_STEP_MS)),
    ),
    {
      maxMs: nextCheckClampMaxMs,
    },
  );

  return {
    nextCheckMs,
    stableWorkingCycles,
    heartbeatMs:
      nextCheckMs >= (domainRetryPolicy?.heartbeatMinMs ?? HEARTBEAT_MIN_DELAY_MS)
        ? Math.min(
          domainRetryPolicy?.heartbeatMaxMs ?? HEARTBEAT_MAX_DELAY_MS,
          Math.max(
            domainRetryPolicy?.heartbeatMinMs ?? HEARTBEAT_MIN_DELAY_MS,
            Math.floor(nextCheckMs / 2),
          ),
        )
        : undefined,
  };
}

export function inferBackgroundRunIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return (
    UNTIL_STOP_RE.test(text) ||
    KEEP_UPDATING_RE.test(text) ||
    BACKGROUND_RE.test(text) ||
    CONTINUOUS_RE.test(text)
  );
}

export function isBackgroundRunStopRequest(message: string): boolean {
  return STOP_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunPauseRequest(message: string): boolean {
  return PAUSE_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunResumeRequest(message: string): boolean {
  return RESUME_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunStatusRequest(message: string): boolean {
  return STATUS_REQUEST_RE.test(message.trim());
}

export class BackgroundRunSupervisor {
  private readonly chatExecutor: ChatExecutor;
  private readonly supervisorLlm: LLMProvider;
  private readonly getSystemPrompt: () => string;
  private readonly createToolHandler: BackgroundRunSupervisorConfig["createToolHandler"];
  private readonly buildToolRoutingDecision?: BackgroundRunSupervisorConfig["buildToolRoutingDecision"];
  private readonly seedHistoryForSession?: BackgroundRunSupervisorConfig["seedHistoryForSession"];
  private readonly isSessionBusy?: BackgroundRunSupervisorConfig["isSessionBusy"];
  private readonly onStatus?: BackgroundRunSupervisorConfig["onStatus"];
  private readonly publishUpdate: BackgroundRunSupervisorConfig["publishUpdate"];
  private readonly progressTracker?: ProgressTracker;
  private readonly runStore: BackgroundRunStore;
  private readonly policyEngine?: PolicyEngine;
  private readonly resolvePolicyScope?: BackgroundRunSupervisorConfig["resolvePolicyScope"];
  private readonly telemetry?: TelemetryCollector;
  private readonly notifier?: BackgroundRunNotifier;
  private readonly wakeBus: BackgroundRunWakeBus;
  private readonly logger: Logger;
  private readonly traceProviderPayloads: boolean;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly workerPools: readonly BackgroundRunWorkerPool[];
  private readonly workerMaxConcurrentRuns: number;
  private readonly activeRuns = new Map<string, ActiveBackgroundRun>();
  private readonly statusSnapshots = new Map<string, BackgroundRunStatusSnapshot>();
  private readonly recentAlerts: BackgroundRunAlert[] = [];
  private readonly terminatingSessions = new Set<string>();
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledDispatchAt?: number;
  private lastDispatchBeaconRevision?: number;
  private workerHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchPumpRunning = false;
  private workerDraining = false;

  constructor(config: BackgroundRunSupervisorConfig) {
    this.chatExecutor = config.chatExecutor;
    this.supervisorLlm = config.supervisorLlm;
    this.getSystemPrompt = config.getSystemPrompt;
    this.createToolHandler = config.createToolHandler;
    this.buildToolRoutingDecision = config.buildToolRoutingDecision;
    this.seedHistoryForSession = config.seedHistoryForSession;
    this.isSessionBusy = config.isSessionBusy;
    this.onStatus = config.onStatus;
    this.publishUpdate = config.publishUpdate;
    this.progressTracker = config.progressTracker;
    this.runStore = config.runStore;
    this.policyEngine = config.policyEngine;
    this.resolvePolicyScope = config.resolvePolicyScope;
    this.telemetry = config.telemetry;
    this.notifier = config.notifier;
    this.logger = config.logger ?? silentLogger;
    this.traceProviderPayloads = config.traceProviderPayloads ?? false;
    this.instanceId =
      config.instanceId ??
      `background-supervisor-${Math.random().toString(36).slice(2, 10)}`;
    this.now = config.now ?? (() => Date.now());
    this.workerPools = sanitizeWorkerPools(config.workerPools);
    this.workerMaxConcurrentRuns = Math.max(
      1,
      Math.floor(config.workerMaxConcurrentRuns ?? 1),
    );
    this.wakeBus = new BackgroundRunWakeBus({
      runStore: this.runStore,
      logger: this.logger,
      now: this.now,
      onWakeReady: async (sessionId) => {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "external_event",
          preferredWorkerId:
            this.activeRuns.get(sessionId)?.preferredWorkerId ?? this.instanceId,
        });
      },
    });
    void this.heartbeatWorker().catch((error) => {
      this.logger.debug("Initial background worker heartbeat failed", {
        workerId: this.instanceId,
        error: toErrorMessage(error),
      });
    });
    void this.armDispatchLoop().catch((error) => {
      this.logger.debug("Initial background dispatch loop failed", {
        workerId: this.instanceId,
        error: toErrorMessage(error),
      });
    });
  }

  private emitCycleTrace(
    run: ActiveBackgroundRun,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.traceProviderPayloads) return;
    logStructuredTraceEvent({
      logger: this.logger,
      traceLabel: "background_run.cycle",
      traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:cycle`,
      sessionId: run.sessionId,
      staticFields: {
        runId: run.id,
        cycleCount: run.cycleCount,
      },
      eventType,
      payload,
    });
  }

  private summarizeActorResult(
    actorResult: ChatExecutorResult | undefined,
  ): Record<string, unknown> {
    if (!actorResult) {
      return { present: false };
    }
    return {
      present: true,
      stopReason: actorResult.stopReason,
      stopReasonDetail: actorResult.stopReasonDetail,
      usedFallback: actorResult.usedFallback,
      toolCalls: actorResult.toolCalls.map((toolCall) => ({
        name: toolCall.name,
        isError: toolCall.isError,
        durationMs: toolCall.durationMs,
      })),
      plannerSummary: actorResult.plannerSummary
        ? {
          used: actorResult.plannerSummary.used,
          plannerCalls: actorResult.plannerSummary.plannerCalls,
          routeReason: actorResult.plannerSummary.routeReason,
          plannedSteps: actorResult.plannerSummary.plannedSteps,
          deterministicStepsExecuted:
            actorResult.plannerSummary.deterministicStepsExecuted,
          diagnostics: actorResult.plannerSummary.diagnostics,
        }
        : undefined,
    };
  }

  hasActiveRun(sessionId: string): boolean {
    const run = this.activeRuns.get(sessionId);
    return run !== undefined && !isTerminalAgentRunState(run.state);
  }

  getStatusSnapshot(sessionId: string): BackgroundRunStatusSnapshot | undefined {
    const run = this.activeRuns.get(sessionId);
    if (!run) return this.statusSnapshots.get(sessionId);
    const scheduledCheckCount =
      run.state === "working" && run.nextCheckAt !== undefined ? 1 : 0;
    return {
      id: run.id,
      sessionId: run.sessionId,
      objective: run.objective,
      state: run.state,
      cycleCount: run.cycleCount,
      lastVerifiedAt: run.lastVerifiedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nextCheckAt: run.nextCheckAt,
      nextHeartbeatAt: run.nextHeartbeatAt,
      lastUserUpdate: run.lastUserUpdate,
      lastWakeReason: run.lastWakeReason,
      pendingSignals:
        run.pendingSignals.length +
        this.wakeBus.getQueuedCount(sessionId) +
        scheduledCheckCount,
      carryForwardSummary: run.carryForward?.summary,
      blockerSummary: run.blocker?.summary,
      watchCount: run.watchRegistrations.length,
      fenceToken: run.fenceToken,
    };
  }

  async getRecentSnapshot(
    sessionId: string,
  ): Promise<BackgroundRunRecentSnapshot | undefined> {
    const active = this.activeRuns.get(sessionId);
    if (active) return toRecentSnapshot(active, this.wakeBus.getQueuedCount(sessionId));
    return this.runStore.loadRecentSnapshot(sessionId);
  }

  async loadRunRecord(
    sessionId: string,
  ): Promise<PersistedBackgroundRun | undefined> {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      return toPersistedRun(active);
    }
    const persisted = await this.runStore.loadRun(sessionId);
    if (persisted) {
      return persisted;
    }
    return this.runStore.loadCheckpoint(sessionId);
  }

  async listRunRecords(): Promise<readonly PersistedBackgroundRun[]> {
    const [persisted, checkpoints] = await Promise.all([
      this.runStore.listRuns(),
      this.runStore.listCheckpoints(),
    ]);
    const bySessionId = new Map<string, PersistedBackgroundRun>();
    for (const run of persisted) {
      bySessionId.set(run.sessionId, run);
    }
    for (const run of checkpoints) {
      if (!bySessionId.has(run.sessionId)) {
        bySessionId.set(run.sessionId, run);
      }
    }
    for (const run of this.activeRuns.values()) {
      bySessionId.set(run.sessionId, toPersistedRun(run));
    }
    return [...bySessionId.values()];
  }

  async updateRunLineage(
    sessionId: string,
    lineage: BackgroundRunLineage,
  ): Promise<void> {
    assertValidBackgroundRunLineage(lineage);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.lineage = lineage;
      active.updatedAt = this.now();
      await this.persistRun(active, {
        type: "subrun_joined",
        summary: truncate(`Updated durable run lineage for ${active.id}.`, 200),
        timestamp: this.now(),
        data: {
          role: lineage.role,
          rootRunId: lineage.rootRunId,
          parentRunId: lineage.parentRunId,
          childRunIds: [...lineage.childRunIds],
        },
      });
      return;
    }
    const persisted = await this.runStore.loadRun(sessionId);
    if (!persisted) {
      throw new Error(`Background run "${sessionId}" not found`);
    }
    const updatedRun: PersistedBackgroundRun = {
      ...persisted,
      lineage,
      updatedAt: this.now(),
    };
    await this.runStore.saveRun(updatedRun);
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(toActiveRun(updatedRun), await this.runStore.getQueuedWakeEventCount(sessionId)),
    );
    await this.runStore.appendEvent(updatedRun, {
      type: "subrun_joined",
      summary: truncate(`Updated durable run lineage for ${updatedRun.id}.`, 200),
      timestamp: this.now(),
      data: {
        role: lineage.role,
        rootRunId: lineage.rootRunId,
        parentRunId: lineage.parentRunId,
        childRunIds: [...lineage.childRunIds],
      },
    });
  }

  async appendRunEvent(
    sessionId: string,
    event: BackgroundRunEvent,
  ): Promise<void> {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      await this.persistRun(active, event);
      return;
    }
    const persisted = await this.loadRunRecord(sessionId);
    if (!persisted) {
      throw new Error(`Background run "${sessionId}" not found`);
    }
    await this.runStore.appendEvent(persisted, event);
    if (this.notifier?.isEnabled()) {
      const detail = await this.getOperatorDetail(sessionId, 1);
      if (detail) {
        await this.notifier.notify({
          occurredAt: event.timestamp,
          internalEventType: event.type,
          summary: event.summary,
          run: detail,
        });
      }
    }
  }

  getFleetStatusSnapshot(): BackgroundRunFleetStatusSnapshot {
    const stateCounts: Record<BackgroundRunState, number> = {
      pending: 0,
      running: 0,
      working: 0,
      blocked: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      suspended: 0,
    };
    const mergedSnapshots = new Map<string, BackgroundRunStatusSnapshot>();
    for (const [sessionId, snapshot] of this.statusSnapshots.entries()) {
      mergedSnapshots.set(sessionId, snapshot);
    }
    for (const [sessionId] of this.activeRuns.entries()) {
      mergedSnapshots.set(sessionId, this.getStatusSnapshot(sessionId)!);
    }

    let activeTotal = 0;
    let queuedSignalsTotal = 0;
    for (const snapshot of mergedSnapshots.values()) {
      stateCounts[snapshot.state] += 1;
      queuedSignalsTotal += snapshot.pendingSignals;
      if (!isTerminalAgentRunState(snapshot.state)) {
        activeTotal += 1;
      }
    }

    return {
      activeTotal,
      stateCounts,
      queuedSignalsTotal,
      recentAlerts: [...this.recentAlerts],
    };
  }

  async listOperatorSummaries(
    sessionIds?: readonly string[],
  ): Promise<readonly BackgroundRunOperatorSummary[]> {
    const filter = sessionIds ? new Set(sessionIds) : undefined;
    const [recentSnapshots, persistedRuns] = await Promise.all([
      this.runStore.listRecentSnapshots(),
      this.runStore.listRuns(),
    ]);
    const sessionIdSet = new Set<string>();
    for (const snapshot of recentSnapshots) {
      if (!filter || filter.has(snapshot.sessionId)) {
        sessionIdSet.add(snapshot.sessionId);
      }
    }
    for (const run of persistedRuns) {
      if (!filter || filter.has(run.sessionId)) {
        sessionIdSet.add(run.sessionId);
      }
    }
    for (const sessionId of this.activeRuns.keys()) {
      if (!filter || filter.has(sessionId)) {
        sessionIdSet.add(sessionId);
      }
    }

    const details = await Promise.all(
      [...sessionIdSet].map(async (sessionId) => {
        const detail = await this.getOperatorDetail(sessionId);
        return detail;
      }),
    );
    return details
      .filter(
        (detail): detail is BackgroundRunOperatorDetail => detail !== undefined,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async getOperatorDetail(
    sessionId: string,
    eventLimit = 16,
  ): Promise<BackgroundRunOperatorDetail | undefined> {
    const activeRun = this.activeRuns.get(sessionId);
    const [persistedRun, checkpoint, recentSnapshot] = await Promise.all([
      activeRun ? Promise.resolve<PersistedBackgroundRun | undefined>(toPersistedRun(activeRun)) : this.runStore.loadRun(sessionId),
      this.runStore.loadCheckpoint(sessionId),
      activeRun
        ? Promise.resolve<BackgroundRunRecentSnapshot | undefined>(
          toRecentSnapshot(activeRun, this.wakeBus.getQueuedCount(sessionId)),
        )
        : this.runStore.loadRecentSnapshot(sessionId),
    ]);
    const durableRun = activeRun
      ? toPersistedRun(activeRun)
      : persistedRun ?? checkpoint;
    const snapshot =
      recentSnapshot ??
      (durableRun ? toRecentSnapshot(toActiveRun(durableRun), 0) : undefined);
    if (!durableRun || !snapshot) {
      return undefined;
    }
    const eventEntries = await this.runStore.listEvents(durableRun.id, eventLimit);
    const summary = toOperatorSummary({
      snapshot,
      contract: durableRun.contract,
      blocker: durableRun.blocker,
      approvalState: durableRun.approvalState,
      checkpointAvailable: checkpoint !== undefined,
      now: this.now(),
    });

    return {
      ...summary,
      policyScope: durableRun.policyScope,
      contract: durableRun.contract,
      blocker: durableRun.blocker,
      approval: durableRun.approvalState,
      budget: durableRun.budgetState,
      compaction: durableRun.compaction,
      artifacts: durableRun.carryForward?.artifacts ?? [],
      observedTargets: durableRun.observedTargets,
      watchRegistrations: durableRun.watchRegistrations,
      recentEvents: toOperatorEventRecords(eventEntries),
    };
  }

  async applyOperatorControl(
    action: BackgroundRunControlAction,
  ): Promise<BackgroundRunOperatorDetail | undefined> {
    switch (action.action) {
      case "pause":
        await this.pauseRun(action.sessionId, action.reason);
        break;
      case "resume":
        await this.resumeRun(action.sessionId, action.reason);
        break;
      case "stop":
        await this.stopRun(action.sessionId, action.reason);
        break;
      case "cancel":
        await this.cancelRun(action.sessionId, action.reason);
        break;
      case "edit_objective":
        await this.updateRunObjective(
          action.sessionId,
          action.objective,
          action.reason,
        );
        break;
      case "amend_constraints":
        await this.amendRunConstraints(
          action.sessionId,
          action.constraints,
          action.reason,
        );
        break;
      case "adjust_budget":
        await this.adjustRunBudget(
          action.sessionId,
          action.budget,
          action.reason,
        );
        break;
      case "force_compact":
        await this.forceCompactRun(action.sessionId, action.reason);
        break;
      case "reassign_worker":
        await this.reassignRunWorker(
          action.sessionId,
          action.worker,
          action.reason,
        );
        break;
      case "retry_from_checkpoint":
        await this.retryRunFromCheckpoint(action.sessionId, action.reason);
        break;
      case "verification_override":
        await this.applyVerificationOverride(action.sessionId, action.override);
        break;
    }
    return this.getOperatorDetail(action.sessionId);
  }

  private isActiveRun(run: ActiveBackgroundRun): boolean {
    return this.activeRuns.get(run.sessionId) === run;
  }

  private rememberStatusSnapshot(
    run: ActiveBackgroundRun,
    queuedWakeCount = 0,
    extraPendingCount = 0,
  ): void {
    const scheduledCheckCount =
      run.state === "working" && run.nextCheckAt !== undefined ? 1 : 0;
    this.statusSnapshots.set(run.sessionId, {
      id: run.id,
      sessionId: run.sessionId,
      objective: run.objective,
      state: run.state,
      cycleCount: run.cycleCount,
      lastVerifiedAt: run.lastVerifiedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nextCheckAt: run.nextCheckAt,
      nextHeartbeatAt: run.nextHeartbeatAt,
      lastUserUpdate: run.lastUserUpdate,
      lastWakeReason: run.lastWakeReason,
      pendingSignals:
        run.pendingSignals.length +
        queuedWakeCount +
        scheduledCheckCount +
        extraPendingCount,
      carryForwardSummary: run.carryForward?.summary,
      blockerSummary: run.blocker?.summary,
      watchCount: run.watchRegistrations.length,
      fenceToken: run.fenceToken,
    });
  }

  private resolveRunPolicyScope(
    run: ActiveBackgroundRun,
  ): PolicyEvaluationScope | undefined {
    const resolved =
      run.policyScope ??
      this.resolvePolicyScope?.({
        sessionId: run.sessionId,
        runId: run.id,
      });
    if (!resolved) {
      return undefined;
    }
    run.policyScope = {
      ...resolved,
      runId: resolved.runId ?? run.id,
      sessionId: resolved.sessionId ?? run.sessionId,
      channel: resolved.channel ?? "webchat",
    };
    return run.policyScope;
  }

  private async buildScopedManagedProcessCounts(
    run: ActiveBackgroundRun,
  ): Promise<Partial<Record<"global" | "tenant" | "project" | "run", number>>> {
    const scope = this.resolveRunPolicyScope(run);
    const persistedRuns = await this.runStore.listRuns();
    const mergedRuns = new Map<string, PersistedBackgroundRun>();
    for (const persisted of persistedRuns) {
      mergedRuns.set(persisted.sessionId, persisted);
    }
    for (const activeRun of this.activeRuns.values()) {
      refreshDerivedBudgetState(activeRun);
      mergedRuns.set(activeRun.sessionId, toPersistedRun(activeRun));
    }
    refreshDerivedBudgetState(run);
    mergedRuns.set(run.sessionId, toPersistedRun(run));

    const countFor = (
      matcher: (candidate: PersistedBackgroundRun) => boolean,
    ): number => {
      let total = 0;
      for (const candidate of mergedRuns.values()) {
        if (isTerminalAgentRunState(candidate.state) || !matcher(candidate)) {
          continue;
        }
        total += candidate.budgetState.managedProcessCount;
      }
      return total;
    };

    return {
      global: countFor(() => true),
      tenant: scope?.tenantId
        ? countFor((candidate) => candidate.policyScope?.tenantId === scope.tenantId)
        : undefined,
      project: scope?.projectId
        ? countFor((candidate) => candidate.policyScope?.projectId === scope.projectId)
        : undefined,
      run: run.budgetState.managedProcessCount,
    };
  }

  private buildPolicyBudgetDecision(
    decision: PolicyDecision,
  ): BackgroundRunDecision {
    const primaryViolation = decision.violations[0];
    const details = primaryViolation?.details ?? {};
    const scopeLabel =
      typeof details.scope === "string" ? details.scope : "runtime";

    if (primaryViolation?.code === "process_budget_exceeded") {
      return {
        state: "working",
        userUpdate:
          `Background run is waiting for available managed-process capacity (${scopeLabel} scope).`,
        internalSummary: primaryViolation.message,
        nextCheckMs: DEFAULT_DISPATCH_RETRY_MS,
        shouldNotifyUser: true,
      };
    }

    const failureMessage = (() => {
      switch (primaryViolation?.code) {
        case "token_budget_exceeded":
          return "Background run exhausted its token budget before the objective completed.";
        case "runtime_budget_exceeded":
          return "Background run exceeded its runtime budget before the objective completed.";
        case "action_budget_exceeded":
          return "Background run exhausted its action budget before the objective completed.";
        case "spend_budget_exceeded":
          return "Background run exhausted its spend budget before the objective completed.";
        default:
          return primaryViolation?.message ?? "Background run was blocked by runtime policy.";
      }
    })();

    return {
      state: "failed",
      userUpdate: failureMessage,
      internalSummary: primaryViolation?.message ?? failureMessage,
      shouldNotifyUser: true,
    };
  }

  private buildSupervisorPolicyAction(params: {
    run: ActiveBackgroundRun;
    tokenCount?: number;
    processCounts: Partial<Record<"global" | "tenant" | "project" | "run", number>>;
  }) {
    const scope = this.resolveRunPolicyScope(params.run);
    if (!scope) {
      return undefined;
    }
    const elapsedRuntimeMs = Math.max(
      0,
      this.now() - params.run.budgetState.runtimeStartedAt,
    );
    return {
      type: "task_execution" as const,
      name: "background_run.supervision",
      access: "write" as const,
      scope,
      budgetConsumptionMode:
        params.tokenCount !== undefined
          ? ("post_hoc_actual" as const)
          : ("preflight" as const),
      ...(params.tokenCount !== undefined ? { tokenCount: params.tokenCount } : {}),
      elapsedRuntimeMs,
      elapsedRuntimeMsByScope: {
        global: elapsedRuntimeMs,
        tenant: elapsedRuntimeMs,
        project: elapsedRuntimeMs,
        run: elapsedRuntimeMs,
      },
      processCount: params.processCounts.global ?? params.run.budgetState.managedProcessCount,
      processCountByScope: params.processCounts,
      metadata: {
        runId: params.run.id,
        sessionId: params.run.sessionId,
        domain: params.run.contract.domain,
        contractKind: params.run.contract.kind,
      },
    };
  }

  private async evaluateRunGovernance(
    run: ActiveBackgroundRun,
    params: { tokenCount?: number },
  ): Promise<BackgroundRunDecision | undefined> {
    if (!this.policyEngine) {
      return undefined;
    }
    const processCounts = await this.buildScopedManagedProcessCounts(run);
    const action = this.buildSupervisorPolicyAction({
      run,
      tokenCount: params.tokenCount,
      processCounts,
    });
    if (!action) {
      return undefined;
    }
    const decision = this.policyEngine.evaluate(action);
    return decision.allowed ? undefined : this.buildPolicyBudgetDecision(decision);
  }

  private recordRunTelemetry(
    metricName: string,
    value: number,
    run: ActiveBackgroundRun,
    extraLabels?: Record<string, string>,
  ): void {
    this.telemetry?.histogram(metricName, value, {
      domain: run.contract.domain,
      contract_kind: run.contract.kind,
      ...(extraLabels ?? {}),
    });
  }

  private incrementRunTelemetryCounter(
    metricName: string,
    run: ActiveBackgroundRun,
    extraLabels?: Record<string, string>,
  ): void {
    this.telemetry?.counter(metricName, 1, {
      domain: run.contract.domain,
      contract_kind: run.contract.kind,
      ...(extraLabels ?? {}),
    });
  }

  private updateActiveGauge(): void {
    const byDomain = new Map<string, number>();
    for (const run of this.activeRuns.values()) {
      byDomain.set(run.contract.domain, (byDomain.get(run.contract.domain) ?? 0) + 1);
    }
    this.telemetry?.gauge(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_ACTIVE_TOTAL,
      this.activeRuns.size,
      { scope: "all" },
    );
    for (const [domain, count] of byDomain.entries()) {
      this.telemetry?.gauge(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_ACTIVE_TOTAL,
        count,
        { scope: "domain", domain },
      );
    }
  }

  private recordAlert(params: {
    severity: "info" | "warn" | "error";
    code: string;
    message: string;
    run?: Pick<ActiveBackgroundRun, "id" | "sessionId">;
  }): void {
    const alert: BackgroundRunAlert = {
      id: `${params.code}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
      severity: params.severity,
      code: params.code,
      message: truncate(params.message, 240),
      createdAt: this.now(),
      sessionId: params.run?.sessionId,
      runId: params.run?.id,
    };
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > MAX_BACKGROUND_RUN_ALERTS) {
      this.recentAlerts.length = MAX_BACKGROUND_RUN_ALERTS;
    }
  }

  private forgetStatusSnapshot(sessionId: string): void {
    this.statusSnapshots.delete(sessionId);
  }

  private async heartbeatWorker(): Promise<void> {
    if (this.workerHeartbeatTimer) {
      clearTimeout(this.workerHeartbeatTimer);
      this.workerHeartbeatTimer = null;
    }
    const leasedRuns = [...this.activeRuns.values()].filter(
      (run) => run.leaseOwnerId === this.instanceId,
    );
    const inFlightRuns = leasedRuns.filter((run) => run.state === "running");
    await this.runStore.heartbeatWorker({
      workerId: this.instanceId,
      pools: this.workerPools,
      maxConcurrentRuns: this.workerMaxConcurrentRuns,
      state: this.workerDraining ? "draining" : "active",
      currentSessionIds: inFlightRuns.map((run) => run.sessionId),
      affinityKeys: leasedRuns.map((run) => resolveWorkerAffinityKey(run)),
      now: this.now(),
    });
    await this.runStore.garbageCollect({ now: this.now() });
    await this.armDispatchLoop();
    this.workerHeartbeatTimer = setTimeout(() => {
      void this.heartbeatWorker().catch((error) => {
        this.logger.debug("Background worker heartbeat failed", {
          workerId: this.instanceId,
          error: toErrorMessage(error),
        });
      });
    }, DEFAULT_WORKER_HEARTBEAT_MS);
  }

  private async armDispatchLoop(): Promise<void> {
    if (this.dispatchPumpRunning || this.workerDraining) {
      return;
    }
    const beacon = await this.runStore.loadDispatchBeacon();
    const nextAvailableAt = beacon.nextAvailableAt;
    if (nextAvailableAt === undefined) {
      if (this.dispatchTimer) {
        clearTimeout(this.dispatchTimer);
        this.dispatchTimer = null;
      }
      this.scheduledDispatchAt = undefined;
      this.lastDispatchBeaconRevision = beacon.revision;
      return;
    }
    if (
      this.dispatchTimer &&
      this.scheduledDispatchAt === nextAvailableAt &&
      this.lastDispatchBeaconRevision === beacon.revision
    ) {
      return;
    }
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    const delayMs = Math.max(0, nextAvailableAt - this.now());
    this.scheduledDispatchAt = nextAvailableAt;
    this.lastDispatchBeaconRevision = beacon.revision;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.scheduledDispatchAt = undefined;
      void this.pumpDispatchQueue().catch((error) => {
        this.logger.debug("Background worker dispatch pump failed", {
          workerId: this.instanceId,
          error: toErrorMessage(error),
        });
      });
    }, delayMs);
  }

  private async pumpDispatchQueue(): Promise<void> {
    if (this.dispatchPumpRunning || this.workerDraining) {
      return;
    }
    this.dispatchPumpRunning = true;
    try {
      await this.heartbeatWorker();
      while (!this.workerDraining) {
        const claim = await this.runStore.claimDispatchForWorker({
          workerId: this.instanceId,
          pools: this.workerPools,
          now: this.now(),
        });
        if (!claim.claimed || !claim.item) {
          break;
        }
        await this.handleClaimedDispatch(claim.item);
        await this.heartbeatWorker();
      }
    } finally {
      this.dispatchPumpRunning = false;
      this.scheduledDispatchAt = undefined;
      await this.armDispatchLoop();
    }
  }

  private async handleClaimedDispatch(
    item: BackgroundRunDispatchItem,
  ): Promise<void> {
    try {
      const run = await this.ensureRunLoaded(item.sessionId);
      if (!run) {
        await this.runStore.completeDispatch({
          dispatchId: item.id,
          workerId: this.instanceId,
          now: this.now(),
        });
        return;
      }
      await this.runStore.pruneDispatchesForSession({
        sessionId: item.sessionId,
        excludeDispatchId: item.id,
        now: this.now(),
      });
      run.preferredWorkerId = this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      await this.persistRun(run);
      await this.executeCycle(item.sessionId);
      await this.runStore.completeDispatch({
        dispatchId: item.id,
        workerId: this.instanceId,
        now: this.now(),
      });
    } catch (error) {
      this.logger.debug("Background dispatch execution failed", {
        workerId: this.instanceId,
        dispatchId: item.id,
        sessionId: item.sessionId,
        error: toErrorMessage(error),
      });
      await this.runStore.releaseDispatch({
        dispatchId: item.id,
        workerId: this.instanceId,
        now: this.now(),
        availableAt: this.now() + DEFAULT_DISPATCH_RETRY_MS,
        preferredWorkerId: item.preferredWorkerId,
      });
    }
  }

  private async ensureRunLoaded(
    sessionId: string,
  ): Promise<ActiveBackgroundRun | undefined> {
    if (this.terminatingSessions.has(sessionId)) {
      return undefined;
    }
    const active = this.activeRuns.get(sessionId);
    if (active) {
      return active;
    }
    const lease = await this.runStore.claimLease(
      sessionId,
      this.instanceId,
      this.now(),
    );
    if (!lease.claimed || !lease.run) {
      return undefined;
    }
    const run = toActiveRun(lease.run);
    if (run.state === "running" || run.state === "suspended") {
      assertAgentRunStateTransition(
        run.state,
        "working",
        "ensureRunLoaded recovery",
      );
      run.state = "working";
      run.updatedAt = this.now();
      run.nextCheckAt = this.now();
      run.nextHeartbeatAt = undefined;
      run.lastWakeReason = "recovery";
    }
    run.preferredWorkerId = this.instanceId;
    run.workerAffinityKey = resolveWorkerAffinityKey(run);
    run.policyScope = this.resolveRunPolicyScope(run);
    this.activeRuns.set(sessionId, run);
    await this.wakeBus.recoverSession(sessionId);
    return run;
  }

  private async enqueueDispatchForSession(params: {
    sessionId: string;
    reason:
      | BackgroundRunWakeReason
      | "resume"
      | "heartbeat"
      | "recovery"
      | "admission_retry";
    availableAt?: number;
    priority?: number;
    preferredWorkerId?: string;
  }): Promise<void> {
    const run =
      this.activeRuns.get(params.sessionId) ??
      (await this.runStore.loadRun(params.sessionId));
    if (!run) {
      return;
    }
    const pool = resolveWorkerPool(run);
    const dispatchStats = await this.runStore.getDispatchStats();
    const saturated =
      dispatchStats.totalQueued >= DEFAULT_DISPATCH_QUEUE_MAX_TOTAL ||
      dispatchStats.queuedByPool[pool] >= DEFAULT_DISPATCH_QUEUE_MAX_PER_POOL[pool];
    const dispatchReason =
      saturated && params.reason !== "admission_retry"
        ? "admission_retry"
        : params.reason;
    const availableAt =
      saturated && params.reason !== "admission_retry"
        ? Math.max(params.availableAt ?? this.now(), this.now() + DEFAULT_DISPATCH_RETRY_MS)
        : params.availableAt;
    if (dispatchReason === "admission_retry") {
      this.logger.debug("Background dispatch deferred by admission control", {
        sessionId: params.sessionId,
        pool,
        totalQueued: dispatchStats.totalQueued,
        queuedInPool: dispatchStats.queuedByPool[pool],
      });
    }
    await this.runStore.enqueueDispatch({
      sessionId: params.sessionId,
      runId: run.id,
      pool,
      reason: dispatchReason,
      createdAt: this.now(),
      availableAt,
      priority: params.priority,
      dedupeKey: `dispatch:${params.sessionId}:${dispatchReason}`,
      preferredWorkerId:
        params.preferredWorkerId ?? run.preferredWorkerId ?? this.instanceId,
      affinityKey: resolveWorkerAffinityKey(run),
      data: {
        runId: run.id,
        sessionId: params.sessionId,
        reason: dispatchReason,
      },
    });
    const readyAt = availableAt ?? this.now();
    if (!this.workerDraining && readyAt <= this.now()) {
      queueMicrotask(() => {
        void this.pumpDispatchQueue().catch((error) => {
          this.logger.debug("Immediate background dispatch failed", {
            sessionId: params.sessionId,
            workerId: this.instanceId,
            error: toErrorMessage(error),
          });
        });
      });
      return;
    }
    await this.armDispatchLoop();
  }

  async recoverRuns(): Promise<number> {
    await this.heartbeatWorker();
    await this.runStore.garbageCollect({ now: this.now() });
    const persistedRuns = await this.runStore.listRuns();
    const activeWorkers = new Map(
      (await this.runStore.listWorkers())
        .filter(
          (worker) =>
            worker.lastHeartbeatAt + worker.heartbeatTtlMs > this.now() &&
            worker.state === "active",
        )
        .map((worker) => [worker.workerId, worker] as const),
    );
    let recovered = 0;
    for (const persistedRun of persistedRuns) {
      if (isTerminalAgentRunState(persistedRun.state)) {
        await this.runStore.deleteRun(persistedRun.sessionId);
        continue;
      }
      if (
        persistedRun.preferredWorkerId &&
        persistedRun.preferredWorkerId !== this.instanceId &&
        activeWorkers.has(persistedRun.preferredWorkerId)
      ) {
        continue;
      }
      const lease = await this.runStore.claimLease(
        persistedRun.sessionId,
        this.instanceId,
        this.now(),
      );
      if (!lease.claimed || !lease.run) {
        continue;
      }
      const run = toActiveRun(lease.run);
      if (
        (run.state === "running" || run.state === "suspended") &&
        (!run.leaseOwnerId ||
          run.leaseOwnerId === this.instanceId ||
          (run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= this.now()))
      ) {
        assertAgentRunStateTransition(
          run.state,
          "working",
          "recover persisted run",
        );
        run.state = "working";
        run.updatedAt = this.now();
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
        run.leaseOwnerId = undefined;
        run.leaseExpiresAt = undefined;
      }
      run.preferredWorkerId = run.preferredWorkerId ?? this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      run.policyScope = this.resolveRunPolicyScope(run);
      await this.runStore.saveRun(toPersistedRun(run));
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, await this.runStore.getQueuedWakeEventCount(run.sessionId)),
      );
      this.rememberStatusSnapshot(
        run,
        await this.runStore.getQueuedWakeEventCount(run.sessionId),
      );
      await this.wakeBus.recoverSession(run.sessionId);
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_recovered",
        summary: `Recovered background run: ${truncate(run.objective, 200)}`,
        timestamp: this.now(),
        data: { previousState: persistedRun.state },
      });
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_RECOVERED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_RECOVERY_SUCCESS_RATE,
        1,
        run,
      );
      this.recordAlert({
        severity: "info",
        code: "run_recovered",
        message: `Recovered background run "${truncate(run.objective, 120)}".`,
        run,
      });
      if (run.state !== "paused") {
        const nextQueuedWakeAt = await this.runStore.getNextWakeAvailability(
          run.sessionId,
        );
        const hasReadyWake =
          nextQueuedWakeAt !== undefined && nextQueuedWakeAt <= this.now();
        const shouldQueue =
          run.pendingSignals.length > 0 ||
          hasReadyWake ||
          run.state !== "blocked" ||
          run.nextCheckAt !== undefined;
        if (shouldQueue) {
          await this.enqueueDispatchForSession({
            sessionId: run.sessionId,
            reason: "recovery",
            availableAt:
              run.pendingSignals.length > 0 || hasReadyWake
                ? this.now()
                : run.nextCheckAt,
            preferredWorkerId: run.preferredWorkerId,
          });
        }
      }
      recovered += 1;
    }
    this.updateActiveGauge();
    await this.armDispatchLoop();
    return recovered;
  }

  async startRun(params: StartBackgroundRunParams): Promise<BackgroundRunStatusSnapshot> {
    await this.cancelRun(params.sessionId, "Replaced by a new background run.");
    await this.runStore.deleteCheckpoint(params.sessionId);
    if (params.options?.lineage) {
      assertValidBackgroundRunLineage(params.options.lineage);
    }

    const now = this.now();
    const contract =
      params.options?.contract ?? await this.planRunContract(
        params.objective,
        params.sessionId,
      );
    const run: ActiveBackgroundRun = {
      version: AGENT_RUN_SCHEMA_VERSION,
      id: `bg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: params.sessionId,
      objective: params.objective.trim(),
      policyScope: undefined,
      contract,
      state: "pending",
      fenceToken: 1,
      createdAt: now,
      updatedAt: now,
      cycleCount: 0,
      stableWorkingCycles: 0,
      consecutiveErrorCycles: 0,
      lastVerifiedAt: undefined,
      lastUserUpdate: undefined,
      lastToolEvidence: undefined,
      lastHeartbeatContent: undefined,
      lastWakeReason: "start",
      carryForward: undefined,
      blocker: undefined,
      approvalState: { status: "none" },
      budgetState: buildInitialBudgetState(contract, now),
      compaction: buildInitialCompactionState(),
      pendingSignals: [],
      observedTargets: [],
      watchRegistrations: [],
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      internalHistory: [
        ...(
          params.options?.seedHistory?.slice(-6) ??
          this.seedHistoryForSession?.(params.sessionId)?.slice(-6) ??
          []
        ),
      ],
      lineage: params.options?.lineage,
      preferredWorkerId: this.instanceId,
      workerAffinityKey: `session:${params.sessionId}`,
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      timer: null,
      heartbeatTimer: null,
      abortController: null,
    };
    run.policyScope = this.resolveRunPolicyScope(run);

    await this.persistRun(run, {
      type: "run_started",
      summary: `Background run started: ${truncate(run.objective, 200)}`,
      timestamp: now,
      data: {
        contractKind: run.contract.kind,
        nextCheckMs: run.contract.nextCheckMs,
      },
    });
    await this.progressTracker?.append({
      sessionId: params.sessionId,
      type: "task_started",
      summary: truncate(`Background run started: ${run.objective}`, 200),
    });

    if (!params.options?.silent) {
      await this.publishUpdate(
        params.sessionId,
        "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
      );
      run.lastUserUpdate = truncate(
        "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
        MAX_USER_UPDATE_CHARS,
      );
    }
    run.budgetState = {
      ...run.budgetState,
      firstAcknowledgedAt: run.budgetState.firstAcknowledgedAt ?? this.now(),
    };
    const firstAcknowledgedAt = run.budgetState.firstAcknowledgedAt ?? now;
    this.incrementRunTelemetryCounter(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_STARTED_TOTAL,
      run,
    );
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_ACK_MS,
      firstAcknowledgedAt - run.createdAt,
      run,
    );
    if (!params.options?.silent && run.lastUserUpdate) {
      await this.persistRun(run, {
        type: "user_update",
        summary: run.lastUserUpdate,
        timestamp: this.now(),
        data: {
          kind: "ack",
          verified: false,
        },
      });
    }
    this.updateActiveGauge();
    await this.enqueueDispatchForSession({
      sessionId: params.sessionId,
      reason: "start",
      availableAt: now,
      preferredWorkerId: this.instanceId,
    });
    return {
      id: run.id,
      sessionId: run.sessionId,
      objective: run.objective,
      state: run.state,
      cycleCount: run.cycleCount,
      lastVerifiedAt: run.lastVerifiedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nextCheckAt: run.nextCheckAt,
      nextHeartbeatAt: run.nextHeartbeatAt,
      lastUserUpdate: run.lastUserUpdate,
      lastWakeReason: run.lastWakeReason,
      pendingSignals: 0,
      carryForwardSummary: run.carryForward?.summary,
      blockerSummary: run.blocker?.summary,
      watchCount: run.watchRegistrations.length,
      fenceToken: run.fenceToken,
    };
  }

  async signalRun(params: {
    sessionId: string;
    content: string;
    type?: Exclude<
      BackgroundRunWakeReason,
      "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
    >;
    data?: Record<string, unknown>;
  }): Promise<boolean> {
    const content = params.content.trim();
    if (!content) return false;

    const activeRun = this.activeRuns.get(params.sessionId);
    const persistedRun = activeRun
      ? undefined
      : await this.runStore.loadRun(params.sessionId);
    const run = activeRun ?? (persistedRun ? toActiveRun(persistedRun) : undefined);
    if (!run) return false;

    const type = params.type ?? "user_input";
    const now = this.now();
    await this.wakeBus.enqueue({
      sessionId: params.sessionId,
      runId: run.id,
      type,
      domain: getWakeEventDomain(type),
      content,
      data: params.data ? { ...params.data } : undefined,
      createdAt: now,
      availableAt: now,
      dedupeKey: buildWakeDedupeKey({
        sessionId: params.sessionId,
        runId: run.id,
        type,
        data: params.data,
      }),
      dispatchReady: false,
    });
    if (activeRun) {
      run.updatedAt = now;
      run.lastWakeReason = type;
      run.nextCheckAt = run.state === "paused" ? run.nextCheckAt : now;
      if (run.state !== "paused") {
        run.budgetState = {
          ...run.budgetState,
          nextCheckIntervalMs: 0,
        };
      }
      recordRunActivity(run, run.updatedAt);
      await this.persistRun(run, {
        type: "run_signalled",
        summary: truncate(`Background run signalled: ${content}`, 200),
        timestamp: now,
        data: { signalType: type },
      });
    } else {
      await this.runStore.appendEvent(run, {
        type: "run_signalled",
        summary: truncate(`Background run signalled: ${content}`, 200),
        timestamp: now,
        data: { signalType: type },
      });
    }

    if (run.state === "paused") {
      const snapshotRun =
        this.activeRuns.has(params.sessionId)
          ? run
          : toActiveRun(run);
      const queuedDispatchCount = await this.runStore.getQueuedDispatchCountForSession(
        params.sessionId,
      );
      this.rememberStatusSnapshot(
        snapshotRun,
        this.wakeBus.getQueuedCount(params.sessionId),
        queuedDispatchCount,
      );
      return true;
    }

    if (run.state !== "running") {
      await this.enqueueDispatchForSession({
        sessionId: params.sessionId,
        reason: type,
        availableAt: now,
        preferredWorkerId: run.preferredWorkerId,
      });
    }

    if (activeRun && run.state !== "running") {
      if (run.state !== "blocked" && run.state !== "suspended") {
        const completionDecision = buildDeterministicRunDomainDecision(run);
        if (completionDecision && completionDecision.state !== "working") {
          await this.finishRun(run, completionDecision);
          return true;
        }
      }
    }

    return true;
  }

  async pauseRun(
    sessionId: string,
    reason = "Paused the active background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) return false;
      const persistedRun = toActiveRun(lease.run);
      if (persistedRun.state === "paused") {
        await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
          ...toPersistedRun(persistedRun),
        });
        return true;
      }
      assertAgentRunStateTransition(persistedRun.state, "paused", "pauseRun persisted");
      persistedRun.state = "paused";
      persistedRun.updatedAt = this.now();
      persistedRun.lastWakeReason = "user_input";
      persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
      await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
        ...toPersistedRun(persistedRun),
      });
      await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
      this.rememberStatusSnapshot(
        persistedRun,
        0,
        await this.runStore.getQueuedDispatchCountForSession(sessionId),
      );
      await this.runStore.appendEvent(toPersistedRun(persistedRun), {
        type: "run_paused",
        summary: truncate(`Background run paused: ${reason}`, 200),
        timestamp: this.now(),
      });
      await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
      return true;
    }
    if (run.state === "paused") return true;

    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, "paused", "pauseRun");
    run.state = "paused";
    run.updatedAt = this.now();
    run.lastWakeReason = "user_input";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    recordRunActivity(run, run.updatedAt, "progress");

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run paused: ${reason}`, 200),
    });
    await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
      ...toPersistedRun(run),
    });
    this.activeRuns.delete(sessionId);
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    this.rememberStatusSnapshot(
      run,
      this.wakeBus.getQueuedCount(run.sessionId),
      await this.runStore.getQueuedDispatchCountForSession(sessionId),
    );
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "run_paused",
      summary: truncate(`Background run paused: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    return true;
  }

  async resumeRun(
    sessionId: string,
    reason = "Resumed the background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) return false;
      const persistedRun = toActiveRun(lease.run);
      if (persistedRun.state !== "paused") {
        await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
          ...toPersistedRun(persistedRun),
        });
        return false;
      }
      assertAgentRunStateTransition(persistedRun.state, "working", "resumeRun persisted");
      persistedRun.state = "working";
      persistedRun.updatedAt = this.now();
      persistedRun.lastWakeReason = "user_input";
      persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      persistedRun.lastHeartbeatContent = undefined;
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      clearRunBlockers(persistedRun);
      recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
      await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
        ...toPersistedRun(persistedRun),
      });
      await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
      this.rememberStatusSnapshot(persistedRun, 0);
      await this.runStore.appendEvent(toPersistedRun(persistedRun), {
        type: "run_resumed",
        summary: truncate(`Background run resumed: ${reason}`, 200),
        timestamp: this.now(),
      });
      await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "resume",
        availableAt: this.now(),
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
      return true;
    }
    if (run.state !== "paused") return false;

    assertAgentRunStateTransition(run.state, "working", "resumeRun");
    run.state = "working";
    run.updatedAt = this.now();
    run.lastWakeReason = "user_input";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    run.lastHeartbeatContent = undefined;
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt, "progress");

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run resumed: ${reason}`, 200),
    });
    await this.persistRun(run, {
      type: "run_resumed",
      summary: truncate(`Background run resumed: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    await this.enqueueDispatchForSession({
      sessionId,
      reason: "resume",
      availableAt: this.now(),
      preferredWorkerId: run.preferredWorkerId,
    });
    return true;
  }

  async stopRun(
    sessionId: string,
    reason = "Stopped by user.",
  ): Promise<boolean> {
    this.terminatingSessions.add(sessionId);
    try {
      const run = this.activeRuns.get(sessionId);
      if (run) {
        return this.executeOperatorStop(run, reason);
      }
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) {
        return false;
      }
      const persistedRun = toActiveRun(lease.run);
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      return this.executeOperatorStop(persistedRun, reason);
    } finally {
      this.terminatingSessions.delete(sessionId);
    }
  }

  async cancelRun(sessionId: string, reason = "Stopped by user."): Promise<boolean> {
    this.terminatingSessions.add(sessionId);
    try {
      const stopRequestedAt = this.now();
      const run = this.activeRuns.get(sessionId);
      if (!run) {
        const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
        if (!lease.claimed || !lease.run) return false;
        const persistedRun = toActiveRun(lease.run);
        assertAgentRunStateTransition(
          persistedRun.state,
          "cancelled",
          "cancelRun persisted",
        );
        persistedRun.state = "cancelled";
        persistedRun.updatedAt = stopRequestedAt;
        persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
        persistedRun.budgetState = {
          ...persistedRun.budgetState,
          stopRequestedAt,
        };
        persistedRun.preferredWorkerId = this.instanceId;
        persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
        recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
        await this.runStore.saveCheckpoint(toPersistedRun(persistedRun));
        await this.runStore.deleteRun(sessionId);
        await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
        this.forgetStatusSnapshot(sessionId);
        await this.runStore.appendEvent(toPersistedRun(persistedRun), {
          type: "run_cancelled",
          summary: truncate(`Background run cancelled: ${reason}`, 200),
          timestamp: stopRequestedAt,
          data: {
            stopRequestedAt,
          },
        });
        await this.wakeBus.clearSession(sessionId);
        await this.progressTracker?.append({
          sessionId,
          type: "task_completed",
          summary: truncate(`Background run cancelled: ${reason}`, 200),
        });
        await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
        this.recordAlert({
          severity: "info",
          code: "run_cancelled",
          message: truncate(reason, 200),
          run: persistedRun,
        });
        return true;
      }

      this.clearRunTimers(run);
      run.abortController?.abort();
      run.abortController = null;
      assertAgentRunStateTransition(run.state, "cancelled", "cancelRun");
      run.state = "cancelled";
      run.updatedAt = stopRequestedAt;
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.budgetState = {
        ...run.budgetState,
        stopRequestedAt,
      };
      recordRunActivity(run, run.updatedAt, "progress");
      this.activeRuns.delete(sessionId);
      this.forgetStatusSnapshot(sessionId);
      await this.runStore.saveCheckpoint(toPersistedRun(run));
      await this.runStore.deleteRun(sessionId);
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
      );
      await this.wakeBus.clearSession(sessionId);

      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_cancelled",
        summary: truncate(`Background run cancelled: ${reason}`, 200),
        timestamp: stopRequestedAt,
        data: {
          stopRequestedAt,
        },
      });
      await this.progressTracker?.append({
        sessionId,
        type: "task_completed",
        summary: truncate(`Background run cancelled: ${reason}`, 200),
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      this.recordAlert({
        severity: "info",
        code: "run_cancelled",
        message: truncate(reason, 200),
        run,
      });
      this.updateActiveGauge();
      return true;
    } finally {
      this.terminatingSessions.delete(sessionId);
    }
  }

  private async executeOperatorStop(
    run: ActiveBackgroundRun,
    reason: string,
  ): Promise<boolean> {
    const stopRequestedAt = this.now();
    run.budgetState = {
      ...run.budgetState,
      stopRequestedAt,
    };
    run.lastWakeReason = "user_input";
    run.updatedAt = stopRequestedAt;
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;

    const runningTargets = listRunningManagedProcessTargets(run);
    if (runningTargets.length === 0) {
      const latestTarget = findLatestManagedProcessTarget(run.observedTargets);
      const alreadyStoppedDecision: BackgroundRunDecision | undefined =
        latestTarget?.currentState === "exited"
          ? {
              state: "completed",
              userUpdate: truncate(
                `Managed process ${buildManagedProcessIdentity(latestTarget)} is already stopped. Objective satisfied.`,
                MAX_USER_UPDATE_CHARS,
              ),
              internalSummary:
                "Operator stop completed without issuing another tool call because the managed process was already exited.",
              shouldNotifyUser: true,
            }
          : undefined;
      if (alreadyStoppedDecision) {
        await this.finishRun(run, alreadyStoppedDecision);
        return true;
      }
      await this.finishRun(run, {
        state: "cancelled",
        userUpdate: truncate(reason, MAX_USER_UPDATE_CHARS),
        internalSummary:
          "Operator stop found no running durable managed process targets and cancelled supervision only.",
        shouldNotifyUser: true,
      });
      return true;
    }

    const operatorToolHandler = this.createToolHandler({
      sessionId: run.sessionId,
      runId: run.id,
      cycleIndex: run.cycleCount + 1,
    });
    const stopCalls: ChatExecutorResult["toolCalls"][number][] = [];
    for (const target of runningTargets) {
      this.onStatus?.(run.sessionId, {
        phase: "tool_call",
        detail: `Calling ${managedProcessStopToolName(getManagedProcessSurface(target))}`,
      });
      stopCalls.push(
        await executeNativeToolCall(
          operatorToolHandler,
          managedProcessStopToolName(getManagedProcessSurface(target)),
          buildManagedProcessStopArgs(target),
        ),
      );
    }

    const actorResult = buildNativeActorResult(
      stopCalls,
      `Stopped ${runningTargets.length} managed process target${runningTargets.length === 1 ? "" : "s"}.`,
      "managed-process-stop",
    );
    observeManagedProcessTargets(run, actorResult, stopRequestedAt);
    run.lastVerifiedAt = stopRequestedAt;
    recordToolEvidence(run, stopCalls);
    await this.refreshCarryForwardState({ run, actorResult, force: true });

    const failedStop = stopCalls.find((toolCall) => toolCall.isError);
    if (failedStop) {
      const failureText = extractToolFailureText(failedStop);
      await this.parkBlockedRun(run, {
        state: "blocked",
        userUpdate: truncate(
          `Operator stop failed while stopping the managed process: ${failureText}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: `Operator stop failed: ${failureText}`,
        shouldNotifyUser: true,
      });
      return true;
    }

    const stoppedIdentities = runningTargets.map((target) =>
      buildManagedProcessIdentity(target),
    );
    await this.finishRun(run, {
      state: "completed",
      userUpdate: truncate(
        `${reason} Stopped ${stoppedIdentities.join(", ")}. Objective satisfied.`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Operator stop completed after stopping the observed durable managed process targets.",
      shouldNotifyUser: true,
    });
    return true;
  }

  async updateRunObjective(
    sessionId: string,
    objective: string,
    reason = "Updated the run objective.",
  ): Promise<boolean> {
    const nextObjective = objective.trim();
    if (nextObjective.length === 0) {
      return false;
    }
    const nextContract = await this.planRunContract(nextObjective, sessionId);
    const now = this.now();
    const updateMessage = truncate(
      `${reason} Objective is now: ${nextObjective}`,
      MAX_USER_UPDATE_CHARS,
    );
    const apply = (run: ActiveBackgroundRun): void => {
      run.objective = nextObjective;
      run.contract = nextContract;
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = updateMessage;
      run.lastHeartbeatContent = undefined;
      clearRunBlockers(run);
      run.budgetState = {
        ...run.budgetState,
        nextCheckIntervalMs: nextContract.nextCheckMs,
        heartbeatIntervalMs: nextContract.heartbeatMs,
        maxIdleMs: nextContract.requiresUserStop
          ? undefined
          : run.budgetState.maxIdleMs ?? DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
      };
      run.preferredWorkerId = this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_objective_updated",
        summary: truncate(`Background run objective updated: ${nextObjective}`, 200),
        timestamp: now,
        data: { reason },
      });
      await this.publishUpdate(sessionId, updateMessage);
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_objective_updated",
      summary: truncate(`Background run objective updated: ${nextObjective}`, 200),
      timestamp: now,
      data: { reason },
    });
    await this.publishUpdate(sessionId, updateMessage);
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async signalManagedProcessExit(params: {
    processId: string;
    label?: string;
    exitCode?: number | null;
    signal?: string | null;
    occurredAt?: number;
    source?: string;
  }): Promise<boolean> {
    const sessionId = [...this.activeRuns.values()].find((run) =>
      run.observedTargets.some(
        (target) =>
          target.kind === "managed_process" &&
          (target.processId === params.processId ||
            (params.label !== undefined && target.label === params.label)),
      ),
    )?.sessionId;
    if (!sessionId) {
      return false;
    }
    const labelPrefix = params.label ? `"${params.label}" ` : "";
    const statusBits = [
      params.exitCode !== undefined ? `exitCode=${params.exitCode}` : undefined,
      params.signal ? `signal=${params.signal}` : undefined,
    ].filter(Boolean);
    const content =
      `Managed process ${labelPrefix}(${params.processId}) exited` +
      (statusBits.length > 0 ? ` (${statusBits.join(", ")}).` : ".");
    return this.signalRun({
      sessionId,
      type: "process_exit",
      content,
      data: {
        processId: params.processId,
        ...(params.label ? { label: params.label } : {}),
        ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.occurredAt !== undefined ? { occurredAt: params.occurredAt } : {}),
        ...(params.source ? { source: params.source } : {}),
      },
    });
  }

  async amendRunConstraints(
    sessionId: string,
    constraints: {
      readonly successCriteria?: readonly string[];
      readonly completionCriteria?: readonly string[];
      readonly blockedCriteria?: readonly string[];
      readonly nextCheckMs?: number;
      readonly heartbeatMs?: number;
      readonly requiresUserStop?: boolean;
    },
    reason = "Updated the run constraints.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      const nextContract: BackgroundRunContract = {
        ...run.contract,
        successCriteria: normalizeOperatorStringList(
          constraints.successCriteria,
          run.contract.successCriteria,
        ),
        completionCriteria: normalizeOperatorStringList(
          constraints.completionCriteria,
          run.contract.completionCriteria,
        ),
        blockedCriteria: normalizeOperatorStringList(
          constraints.blockedCriteria,
          run.contract.blockedCriteria,
        ),
        nextCheckMs: clampPollIntervalMs(
          constraints.nextCheckMs ?? run.contract.nextCheckMs,
        ),
        heartbeatMs:
          constraints.heartbeatMs !== undefined
            ? normalizePositiveInteger(constraints.heartbeatMs) ??
              run.contract.heartbeatMs
            : run.contract.heartbeatMs,
        requiresUserStop:
          constraints.requiresUserStop ?? run.contract.requiresUserStop,
      };
      assertValidAgentRunContract(nextContract, "amendRunConstraints");
      run.contract = nextContract;
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.lastHeartbeatContent = undefined;
      clearRunBlockers(run);
      run.budgetState = {
        ...run.budgetState,
        nextCheckIntervalMs: nextContract.nextCheckMs,
        heartbeatIntervalMs: nextContract.heartbeatMs,
        maxIdleMs: nextContract.requiresUserStop
          ? undefined
          : run.budgetState.maxIdleMs ?? DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
      };
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_contract_amended",
        summary: truncate(`Background run constraints updated: ${reason}`, 200),
        timestamp: now,
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_contract_amended",
      summary: truncate(`Background run constraints updated: ${reason}`, 200),
      timestamp: now,
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async adjustRunBudget(
    sessionId: string,
    budget: {
      readonly maxRuntimeMs?: number;
      readonly maxCycles?: number;
      readonly maxIdleMs?: number;
    },
    reason = "Adjusted the run budget.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.budgetState = {
        ...run.budgetState,
        maxRuntimeMs:
          normalizePositiveInteger(budget.maxRuntimeMs) ??
          run.budgetState.maxRuntimeMs,
        maxCycles:
          normalizePositiveInteger(budget.maxCycles) ?? run.budgetState.maxCycles,
        maxIdleMs:
          budget.maxIdleMs !== undefined
            ? normalizePositiveInteger(budget.maxIdleMs) ??
              run.budgetState.maxIdleMs
            : run.budgetState.maxIdleMs,
      };
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_budget_adjusted",
        summary: truncate(`Background run budget adjusted: ${reason}`, 200),
        timestamp: now,
        data: { ...budget },
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_budget_adjusted",
      summary: truncate(`Background run budget adjusted: ${reason}`, 200),
      timestamp: now,
      data: { ...budget },
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    return true;
  }

  async forceCompactRun(
    sessionId: string,
    reason = "Forced a carry-forward refresh for this run.",
  ): Promise<boolean> {
    const now = this.now();
    const run = this.activeRuns.get(sessionId);
    if (run) {
      await this.refreshCarryForwardState({ run, force: true });
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      await this.persistRun(run, {
        type: "run_compaction_forced",
        summary: truncate(reason, 200),
        timestamp: now,
      });
      await this.publishUpdate(sessionId, run.lastUserUpdate);
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    await this.refreshCarryForwardState({ run: persistedRun, force: true });
    persistedRun.updatedAt = now;
    persistedRun.lastWakeReason = "user_input";
    persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_compaction_forced",
      summary: truncate(reason, 200),
      timestamp: now,
    });
    await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
    return true;
  }

  async reassignRunWorker(
    sessionId: string,
    worker: {
      readonly preferredWorkerId?: string;
      readonly workerAffinityKey?: string;
    },
    reason = "Updated worker assignment for this run.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.preferredWorkerId = worker.preferredWorkerId?.trim() || undefined;
      run.workerAffinityKey =
        worker.workerAffinityKey?.trim() || resolveWorkerAffinityKey(run);
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_worker_reassigned",
        summary: truncate(reason, 200),
        timestamp: now,
        data: {
          preferredWorkerId: run.preferredWorkerId,
          workerAffinityKey: run.workerAffinityKey,
        },
      });
      await this.publishUpdate(sessionId, run.lastUserUpdate ?? truncate(reason, MAX_USER_UPDATE_CHARS));
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_worker_reassigned",
      summary: truncate(reason, 200),
      timestamp: now,
      data: {
        preferredWorkerId: persistedRun.preferredWorkerId,
        workerAffinityKey: persistedRun.workerAffinityKey,
      },
    });
    await this.publishUpdate(sessionId, persistedRun.lastUserUpdate ?? truncate(reason, MAX_USER_UPDATE_CHARS));
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async retryRunFromCheckpoint(
    sessionId: string,
    reason = "Retrying the run from its last durable checkpoint.",
  ): Promise<boolean> {
    const now = this.now();
    const checkpoint =
      (await this.runStore.loadRun(sessionId)) ??
      (await this.runStore.loadCheckpoint(sessionId));
    if (!checkpoint) {
      return false;
    }

    const run = toActiveRun(checkpoint);
    run.state = "working";
    run.updatedAt = now;
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
    run.lastWakeReason = "user_input";
    run.lastHeartbeatContent = undefined;
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    run.pendingSignals = [];
    run.leaseOwnerId = undefined;
    run.leaseExpiresAt = undefined;
    run.preferredWorkerId = this.instanceId;
    run.workerAffinityKey = resolveWorkerAffinityKey(run);
    clearRunBlockers(run);
    recordRunActivity(run, now, "progress");

    await this.persistRun(run, {
      type: "run_retried",
      summary: truncate(`Background run retried: ${reason}`, 200),
      timestamp: now,
    });
    await this.runStore.saveCheckpoint(toPersistedRun(run));
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    await this.enqueueDispatchForSession({
      sessionId,
      reason: "recovery",
      availableAt: now,
      preferredWorkerId: run.preferredWorkerId,
    });
    return true;
  }

  async applyVerificationOverride(
    sessionId: string,
    override: {
      readonly mode: "continue" | "complete" | "fail";
      readonly reason: string;
      readonly userUpdate?: string;
    },
  ): Promise<boolean> {
    const summary = truncate(
      `Operator verification override (${override.mode}): ${override.reason}`,
      200,
    );
    if (override.mode === "continue") {
      const retried = await this.retryRunFromCheckpoint(
        sessionId,
        override.userUpdate ??
          `Operator override: continue. ${override.reason}`,
      );
      if (retried) {
        const detail = await this.getOperatorDetail(sessionId);
        const runId = detail?.runId;
        if (runId) {
          const runRef = {
            id: runId,
            sessionId,
          };
          await this.runStore.appendEvent(runRef, {
            type: "run_verification_overridden",
            summary,
            timestamp: this.now(),
            data: { mode: override.mode },
          });
        }
      }
      return retried;
    }

    const activeRun = this.activeRuns.get(sessionId);
    const checkpoint =
      activeRun
        ? undefined
        : (await this.runStore.loadRun(sessionId)) ??
          (await this.runStore.loadCheckpoint(sessionId));
    const run = activeRun ?? (checkpoint ? toActiveRun(checkpoint) : undefined);
    if (!run) {
      return false;
    }
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "run_verification_overridden",
      summary,
      timestamp: this.now(),
      data: { mode: override.mode },
    });
    await this.finishRun(run, {
      state: override.mode === "complete" ? "completed" : "failed",
      userUpdate:
        override.userUpdate ??
        `Operator override recorded: ${override.reason}`,
      internalSummary: summary,
      shouldNotifyUser: true,
    });
    return true;
  }

  async shutdown(): Promise<void> {
    this.workerDraining = true;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    this.scheduledDispatchAt = undefined;
    if (this.workerHeartbeatTimer) {
      clearTimeout(this.workerHeartbeatTimer);
      this.workerHeartbeatTimer = null;
    }
    await this.runStore.setWorkerDrainState({
      workerId: this.instanceId,
      draining: true,
      now: this.now(),
    }).catch(() => undefined);
    const runs = [...this.activeRuns.values()];
    for (const run of runs) {
      this.clearRunTimers(run);
      run.abortController?.abort();
      run.abortController = null;
      if (run.state === "running" || run.state === "working" || run.state === "pending") {
        assertAgentRunStateTransition(run.state, "suspended", "shutdown");
        run.state = "suspended";
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
        recordRunActivity(run, this.now());
      }
      await this.runStore.releaseLease(
        run.sessionId,
        this.instanceId,
        this.now(),
        {
          ...toPersistedRun(run),
          state: run.state,
          nextCheckAt: run.nextCheckAt,
          nextHeartbeatAt: run.nextHeartbeatAt,
          lastWakeReason: "daemon_shutdown",
        },
      );
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_suspended",
        summary: "Background run suspended for daemon shutdown and will recover on next boot.",
        timestamp: this.now(),
      });
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
      );
      this.activeRuns.delete(run.sessionId);
      await this.wakeBus.clearSession(run.sessionId);
    }
    await this.runStore.removeWorker(this.instanceId).catch(() => undefined);
    this.wakeBus.dispose();
  }

  private schedule(
    run: ActiveBackgroundRun,
    delayMs: number,
    wakeReason: BackgroundRunWakeReason = "timer",
  ): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    const now = this.now();
    run.nextCheckAt = now + delayMs;
    run.lastWakeReason = wakeReason;
    run.budgetState = {
      ...run.budgetState,
      nextCheckIntervalMs: delayMs,
    };
    void (async () => {
      await this.persistRun(run);
      await this.enqueueDispatchForSession({
        sessionId: run.sessionId,
        reason: wakeReason,
        availableAt: run.nextCheckAt,
        preferredWorkerId: run.preferredWorkerId,
      });
    })().catch((error) => {
      this.logger.debug("Failed to schedule background wake", {
        sessionId: run.sessionId,
        wakeReason,
        error: toErrorMessage(error),
      });
    });
    run.timer = null;
  }

  private clearRunTimers(run: ActiveBackgroundRun): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
  }

  private scheduleHeartbeat(run: ActiveBackgroundRun, delayMs: number | undefined): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextHeartbeatAt = undefined;
    if (delayMs === undefined || delayMs <= 0) return;
    run.nextHeartbeatAt = this.now() + delayMs;
    run.budgetState = {
      ...run.budgetState,
      heartbeatIntervalMs: delayMs,
    };
    void this.persistRun(run).catch((error) => {
      this.logger.debug("Failed to persist background heartbeat schedule", {
        sessionId: run.sessionId,
        error: toErrorMessage(error),
      });
    });
    run.heartbeatTimer = setTimeout(() => {
      void this.emitHeartbeat(run.sessionId).catch((error) => {
        this.logger.warn("Background heartbeat emission failed", {
          sessionId: run.sessionId,
          runId: run.id,
          error: toErrorMessage(error),
        });
      });
    }, delayMs);
  }

  private async emitHeartbeat(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;

    if (this.isSessionBusy?.(sessionId)) {
      this.scheduleHeartbeat(run, BUSY_RETRY_INTERVAL_MS);
      return;
    }

    if (run.state === "running") {
      const content = buildActiveCycleHeartbeatMessage(run);
      run.lastHeartbeatContent = content;
      run.nextHeartbeatAt = undefined;
      this.onStatus?.(sessionId, {
        phase: "background_run",
        detail: `Background run cycle ${run.cycleCount} is still in progress`,
      });
      await this.publishUpdate(sessionId, content);
      this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS);
      return;
    }

    if (run.state !== "working") return;

    const content = buildHeartbeatMessage(run);
    if (run.lastHeartbeatContent === content) return;

    run.lastHeartbeatContent = content;
    run.nextHeartbeatAt = undefined;
    this.onStatus?.(sessionId, {
        phase: "background_wait",
        detail:
          run.nextCheckAt !== undefined
            ? `Next verification in ~${Math.max(1, Math.ceil((run.nextCheckAt - this.now()) / 1000))}s`
            : "Background run waiting for next verification",
      });
    await this.publishUpdate(sessionId, content);
    try {
      await this.persistRun(run);
    } catch (error) {
      if (!isBackgroundRunFenceConflictError(error)) {
        throw error;
      }
      const refreshedRun = await this.runStore.loadRun(sessionId);
      this.logger.debug("Skipped stale background heartbeat persistence", {
        sessionId,
        runId: run.id,
        attemptedFenceToken: error.attemptedFenceToken,
        currentFenceToken: error.currentFenceToken,
      });
      if (!refreshedRun || refreshedRun.leaseOwnerId !== this.instanceId) {
        this.clearRunTimers(run);
        this.activeRuns.delete(sessionId);
        this.forgetStatusSnapshot(sessionId);
        this.updateActiveGauge();
        return;
      }
      run.fenceToken = refreshedRun.fenceToken;
      run.leaseOwnerId = refreshedRun.leaseOwnerId;
      run.leaseExpiresAt = refreshedRun.leaseExpiresAt;
    }
  }

  private async prepareCycleRun(
    run: ActiveBackgroundRun,
    sessionId: string,
  ): Promise<ToolHandler | undefined> {
    const leaseIsCurrent =
      run.leaseOwnerId === this.instanceId &&
      typeof run.leaseExpiresAt === "number" &&
      run.leaseExpiresAt > this.now();
    if (!leaseIsCurrent) {
      const leasedRun = await this.runStore.renewLease(
        toPersistedRun(run),
        this.instanceId,
        this.now(),
      );
      if (!leasedRun) {
        this.clearRunTimers(run);
        this.activeRuns.delete(sessionId);
        return undefined;
      }
      run.leaseOwnerId = leasedRun.leaseOwnerId;
      run.leaseExpiresAt = leasedRun.leaseExpiresAt;
      run.fenceToken = leasedRun.fenceToken;
    }
    const deliveredWakeBatch = await this.wakeBus.drainDueWakeEvents(sessionId);
    if (deliveredWakeBatch.run) {
      run.pendingSignals = cloneSignals(deliveredWakeBatch.run.pendingSignals);
      run.updatedAt = deliveredWakeBatch.run.updatedAt;
      run.fenceToken = deliveredWakeBatch.run.fenceToken;
      run.leaseOwnerId = deliveredWakeBatch.run.leaseOwnerId;
      run.leaseExpiresAt = deliveredWakeBatch.run.leaseExpiresAt;
    }
    if (run.pendingSignals.some((signal) => signal.type === "process_exit")) {
      observeManagedProcessExitSignal(run);
    }
    if (this.isSessionBusy?.(sessionId)) {
      this.schedule(run, BUSY_RETRY_INTERVAL_MS, "busy_retry");
      return undefined;
    }
    if (
      !run.contract.requiresUserStop &&
      this.now() - run.budgetState.runtimeStartedAt > run.budgetState.maxRuntimeMs
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run timed out before the objective was completed.",
        internalSummary: "Exceeded maximum background runtime budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }
    if (!run.contract.requiresUserStop && run.cycleCount >= run.budgetState.maxCycles) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run hit its cycle budget before completing.",
        internalSummary: "Exceeded maximum background cycle budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }
    if (
      run.budgetState.maxIdleMs !== undefined &&
      this.now() - run.budgetState.lastActivityAt > run.budgetState.maxIdleMs
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run exhausted its idle budget before the objective completed.",
        internalSummary: "Exceeded maximum background idle budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }

    assertAgentRunStateTransition(run.state, "running", "executeCycle start");
    run.state = "running";
    run.updatedAt = this.now();
    run.cycleCount += 1;
    run.nextHeartbeatAt = undefined;
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt);
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.abortController = new AbortController();
    this.onStatus?.(sessionId, {
      phase: "background_run",
      detail: `Background run cycle ${run.cycleCount}`,
    });
    await this.persistRun(run, {
      type: "cycle_started",
      summary: `Background run cycle ${run.cycleCount} started.`,
      timestamp: this.now(),
    });
    this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS);

    return this.createToolHandler({
      sessionId,
      runId: run.id,
      cycleIndex: run.cycleCount,
    });
  }

  private async handleWorkingDecision(params: {
    run: ActiveBackgroundRun;
    sessionId: string;
    actorResult: ChatExecutorResult | undefined;
    decision: BackgroundRunDecision;
    heartbeatMs?: number;
  }): Promise<boolean> {
    const { run, sessionId, actorResult, decision, heartbeatMs } = params;
    const carryForwardSignalSnapshot = cloneSignals(run.pendingSignals);
    await this.refreshCarryForwardState({
      run,
      actorResult,
      signalSnapshot: carryForwardSignalSnapshot,
    });
    if (!this.isActiveRun(run)) {
      return true;
    }
    const postRefreshSignalDrivenCompletion = buildDeterministicRunDomainDecision(run);
    if (
      postRefreshSignalDrivenCompletion &&
      postRefreshSignalDrivenCompletion.state !== "working"
    ) {
      await this.finishRun(run, postRefreshSignalDrivenCompletion);
      return true;
    }

    const pendingSignalWake = run.pendingSignals[0];
    const hasPendingSignals = pendingSignalWake !== undefined;
    const nextQueuedWakeAt = this.wakeBus.getNextAvailableAt(sessionId);
    const hasReadyQueuedWakes =
      nextQueuedWakeAt !== undefined && nextQueuedWakeAt <= this.now();
    const nextCheckMs = hasPendingSignals || hasReadyQueuedWakes
      ? 0
      : clampPollIntervalMs(decision.nextCheckMs, {
        maxMs: resolveRunNextCheckClampMaxMs(run),
      });

    assertAgentRunStateTransition(run.state, "working", "executeCycle continue");
    run.state = "working";
    run.updatedAt = this.now();
    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(
        `Background run working: ${decision.internalSummary}`,
        200,
      ),
    });
    if (decision.shouldNotifyUser && !hasPendingSignals && !hasReadyQueuedWakes) {
      await this.publishUpdateIfChanged(run, decision.userUpdate);
    }
    if (!this.isActiveRun(run)) {
      return true;
    }
    if (!hasPendingSignals && !hasReadyQueuedWakes) {
      this.scheduleHeartbeat(run, heartbeatMs);
    }
    this.onStatus?.(sessionId, {
      phase: "background_wait",
      detail: hasPendingSignals || hasReadyQueuedWakes
        ? "Processing newly arrived external signals"
        : `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s`,
    });
    await this.persistRun(run, {
      type: "cycle_working",
      summary: truncate(
        `Background run working: ${decision.internalSummary}`,
        200,
      ),
      timestamp: this.now(),
      data: {
        nextCheckMs,
        consecutiveErrorCycles: run.consecutiveErrorCycles,
        pendingSignals: run.pendingSignals.length,
      },
    });
    this.emitCycleTrace(run, "working_applied", {
      summary: decision.internalSummary,
      userUpdate: decision.userUpdate,
      nextCheckMs,
      heartbeatMs,
      hasPendingSignals,
      hasReadyQueuedWakes,
      pendingSignals: run.pendingSignals.length,
    });
    if (!this.isActiveRun(run)) {
      return true;
    }
    if (hasPendingSignals || hasReadyQueuedWakes) {
      this.wakeBus.dispatchNow(sessionId);
      return true;
    }
    this.schedule(run, nextCheckMs, "timer");
    return true;
  }

  private async resolveCycleDecision(params: {
    run: ActiveBackgroundRun;
    sessionId: string;
    cycleToolHandler: ToolHandler;
    actorPrompt: string;
    actorSystemPrompt: string;
  }): Promise<{
    actorResult?: ChatExecutorResult;
    decision: BackgroundRunDecision;
    heartbeatMs?: number;
  }> {
    const { run, sessionId, cycleToolHandler, actorPrompt, actorSystemPrompt } = params;
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    const actorTrace =
      this.traceProviderPayloads
        ? {
          includeProviderPayloads: true as const,
          onProviderTraceEvent: createProviderTraceEventLogger({
            logger: this.logger,
            traceLabel: "background_run.provider",
            traceId: `background:${sessionId}:${run.id}:${run.cycleCount}:actor`,
            sessionId,
            staticFields: {
              runId: run.id,
              cycleCount: run.cycleCount,
              phase: "actor",
            },
          }),
          onExecutionTraceEvent: createExecutionTraceEventLogger({
            logger: this.logger,
            traceLabel: "background_run.executor",
            traceId: `background:${sessionId}:${run.id}:${run.cycleCount}:actor`,
            sessionId,
            staticFields: {
              runId: run.id,
              cycleCount: run.cycleCount,
              phase: "actor",
            },
          }),
        }
        : undefined;

    try {
      const previousToolEvidence = run.lastToolEvidence;
      const nativeCycle = await getRunDomain(run).executeNativeCycle?.(run, {
        toolHandler: cycleToolHandler,
        now: this.now(),
      });
      if (nativeCycle) {
        actorResult = nativeCycle.actorResult;
        decision = toDecisionFromDomainVerification(nativeCycle.verification);
      } else {
        const baseToolRoutingDecision = this.buildToolRoutingDecision?.(
          sessionId,
          actorPrompt,
          run.internalHistory,
        );
        const toolRoutingDecision = applyRunToolScopeDecision({
          allowedTools: getScopedAllowedTools(run),
          toolRoutingDecision: baseToolRoutingDecision,
        });
        const abortSignal = run.abortController?.signal;
        if (!abortSignal) {
          throw new Error("Background cycle missing abort signal");
        }
        actorResult = await this.chatExecutor.execute({
          message: toRunMessage(actorPrompt, sessionId, run.id, run.cycleCount),
          history: run.internalHistory,
          systemPrompt: actorSystemPrompt,
          sessionId,
          requestTimeoutMs: BACKGROUND_RUN_ACTOR_REQUEST_TIMEOUT_MS,
          stateful: run.carryForward?.providerContinuation
            ? {
              resumeAnchor: {
                previousResponseId: run.carryForward.providerContinuation.responseId,
                ...(run.carryForward.providerContinuation.reconciliationHash
                  ? {
                    reconciliationHash:
                      run.carryForward.providerContinuation.reconciliationHash,
                  }
                  : {}),
              },
            }
            : undefined,
          toolHandler: cycleToolHandler,
          signal: abortSignal,
          maxToolRounds: BACKGROUND_RUN_MAX_TOOL_ROUNDS,
          toolBudgetPerRequest: BACKGROUND_RUN_MAX_TOOL_BUDGET,
          maxModelRecallsPerRequest: BACKGROUND_RUN_MAX_MODEL_RECALLS,
          toolRouting: toolRoutingDecision
            ? {
              routedToolNames: toolRoutingDecision.routedToolNames,
              expandedToolNames: toolRoutingDecision.expandedToolNames,
              expandOnMiss: true,
            }
            : undefined,
          ...(actorTrace ? { trace: actorTrace } : {}),
        });

        run.internalHistory = trimHistory([
          ...run.internalHistory,
          { role: "user", content: actorPrompt },
          { role: "assistant", content: actorResult.content, phase: "commentary" },
        ]);
        run.lastVerifiedAt = this.now();
        recordToolEvidence(run, actorResult.toolCalls);
        recordProviderCompactionArtifacts(run, actorResult);
        const providerContinuation = extractLatestProviderContinuation(
          actorResult,
          run.lastVerifiedAt,
        );
        if (providerContinuation) {
          run.carryForward = {
            ...(run.carryForward ?? buildEmptyCarryForwardState(run.lastVerifiedAt)),
            providerContinuation,
            memoryAnchors: buildCarryForwardAnchors({
              previous: run.carryForward?.memoryAnchors ?? [],
              providerContinuation,
              pendingSignals: [],
              actorResult,
              now: run.lastVerifiedAt,
            }),
            lastCompactedAt: run.carryForward?.lastCompactedAt ?? run.lastVerifiedAt,
          };
          run.compaction = {
            ...run.compaction,
            lastProviderAnchorAt: providerContinuation.updatedAt,
          };
        }
        if (actorResult.toolCalls.length > 0) {
          run.pendingSignals = [
            ...run.pendingSignals,
            ...buildInternalToolSignals({
              sessionId,
              cycleCount: run.cycleCount,
              actorResult,
              observedAt: run.lastVerifiedAt,
            }),
          ];
        }
        getRunDomain(run).observeActorResult?.(run, actorResult, run.lastVerifiedAt);
        const domainDecision = buildDeterministicRunDomainDecision(run);
        decision =
          (
            domainDecision && domainDecision.state !== "working"
              ? domainDecision
              : undefined
          ) ??
          (await this.evaluateDecision(run, actorResult)) ??
          buildFallbackDecision(run, actorResult);
        decision = groundDecision(run, actorResult, decision, domainDecision);
      }

      const cycleTokens = actorResult.tokenUsage.totalTokens;
      run.budgetState = {
        ...run.budgetState,
        lastCycleTokens: cycleTokens,
        totalTokens: run.budgetState.totalTokens + Math.max(0, cycleTokens),
      };
      const governanceDecision = await this.evaluateRunGovernance(run, {
        tokenCount: cycleTokens > 0 ? cycleTokens : undefined,
      });
      if (governanceDecision) {
        decision = governanceDecision;
      }

      const consecutiveErrorCycles = computeConsecutiveErrorCycles(run, actorResult);
      run.consecutiveErrorCycles = consecutiveErrorCycles;
      decision = groundDecision(run, actorResult, decision);
      decision = applyRepeatedErrorGuard(decision, consecutiveErrorCycles);
      run.pendingSignals = dropSyntheticInternalSignals(run.pendingSignals);
      recordRunActivity(
        run,
        this.now(),
        actorResult.toolCalls.some((toolCall) => !toolCall.isError) ||
          decision.state !== "working"
          ? "progress"
          : "activity",
      );
      if (decision.state === "working") {
        const cadence = chooseNextCheckMs({
          run,
          actorResult,
          decision,
          previousToolEvidence,
        });
        run.stableWorkingCycles = cadence.stableWorkingCycles;
        decision = {
          ...decision,
          nextCheckMs: cadence.nextCheckMs,
        };
        heartbeatMs = cadence.heartbeatMs;
      } else {
        run.stableWorkingCycles = 0;
      }
    } catch (error) {
      if (run.abortController?.signal.aborted) {
        throw error;
      }
      run.consecutiveErrorCycles += 1;
      recordRunActivity(run, this.now());
      decision = {
        state:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? "failed"
            : "working",
        userUpdate: truncate(
          `Background run failed: ${toErrorMessage(error)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: toErrorMessage(error),
        nextCheckMs:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? undefined
            : MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      };
    }

    return {
      actorResult,
      decision,
      heartbeatMs,
    };
  }

  private async prepareCycleContext(
    sessionId: string,
  ): Promise<PreparedCycleContext | undefined> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (run.state === "paused") return;
    const cycleToolHandler = await this.prepareCycleRun(run, sessionId);
    if (!cycleToolHandler) return;
    return {
      run,
      sessionId,
      cycleToolHandler,
      actorPrompt: buildActorPrompt(run),
      actorSystemPrompt: `${this.getSystemPrompt()}\n\n${BACKGROUND_ACTOR_SECTION}`,
    };
  }

  private async resolvePreparedCycleOutcome(
    context: PreparedCycleContext,
  ): Promise<ResolvedCycleOutcome | undefined> {
    const { run, sessionId, cycleToolHandler, actorPrompt, actorSystemPrompt } = context;
    const trace = buildBackgroundRunTraceIds(run, "execute_cycle");
    const cycleSpan = startReplaySpan({
      name: "background_run.execute_cycle",
      trace: {
        traceId: trace.traceId,
        spanId: trace.spanId,
        sampled: true,
      },
      attributes: {
        code: "background_run.execute_cycle",
      },
      emitOtel: true,
    });
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    try {
      const preCycleDecision = buildPreCycleDomainDecision(run);
      if (preCycleDecision) {
        return {
          run,
          sessionId,
          actorResult: undefined,
          decision: preCycleDecision,
          heartbeatMs: undefined,
        };
      }
      const governanceDecision = await this.evaluateRunGovernance(run, {});
      if (governanceDecision) {
        return {
          run,
          sessionId,
          actorResult: undefined,
          decision: governanceDecision,
          heartbeatMs: undefined,
        };
      }
      ({ actorResult, decision, heartbeatMs } = await this.resolveCycleDecision({
        run,
        sessionId,
        cycleToolHandler,
        actorPrompt,
        actorSystemPrompt,
      }));
    } catch (error) {
      if (run.abortController?.signal.aborted) {
        cycleSpan.end();
        return;
      }
      cycleSpan.end(error);
      throw error;
    } finally {
      run.abortController = null;
    }

    const signalDrivenCompletion = buildDeterministicRunDomainDecision(run);
    if (signalDrivenCompletion && signalDrivenCompletion.state !== "working") {
      decision = signalDrivenCompletion;
    }

    cycleSpan.end();
    this.emitCycleTrace(run, "decision_resolved", {
      decisionState: decision.state,
      decisionInternalSummary: decision.internalSummary,
      decisionUserUpdate: decision.userUpdate,
      decisionNextCheckMs: decision.nextCheckMs,
      heartbeatMs,
      pendingSignals: run.pendingSignals.length,
      observedTargets: run.observedTargets.map((target) => ({
        kind: target.kind,
        label: target.label,
        processId: target.processId,
        currentState: target.currentState,
        desiredState: target.desiredState,
      })),
      actor: this.summarizeActorResult(actorResult),
    });
    return {
      run,
      sessionId,
      actorResult,
      decision,
      heartbeatMs,
    };
  }

  private async handleResolvedCycleOutcome(
    outcome: ResolvedCycleOutcome,
  ): Promise<void> {
    const {
      run,
      sessionId,
      actorResult,
      decision,
      heartbeatMs,
    } = outcome;

    if (decision.state === "working") {
      if (await this.handleWorkingDecision({
        run,
        sessionId,
        actorResult,
        decision,
        heartbeatMs,
      })) {
        return;
      }
      return;
    }

    await this.finishNonWorkingCycle({
      run,
      actorResult,
      decision,
    });
  }

  private async finishNonWorkingCycle(params: {
    run: ActiveBackgroundRun;
    actorResult?: ChatExecutorResult;
    decision: BackgroundRunDecision;
  }): Promise<void> {
    const { run, actorResult, decision } = params;
    await this.refreshCarryForwardState({ run, actorResult, force: true });
    if (!this.isActiveRun(run)) {
      return;
    }
    if (decision.state === "blocked") {
      this.emitCycleTrace(run, "terminal_applied", {
        state: decision.state,
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
      });
      await this.parkBlockedRun(run, decision);
      return;
    }
    this.emitCycleTrace(run, "terminal_applied", {
      state: decision.state,
      summary: decision.internalSummary,
      userUpdate: decision.userUpdate,
    });
    await this.finishRun(run, decision);
  }

  private async executeCycle(sessionId: string): Promise<void> {
    const context = await this.prepareCycleContext(sessionId);
    if (!context) {
      return;
    }

    const outcome = await this.resolvePreparedCycleOutcome(context);
    if (!outcome) {
      return;
    }
    await this.handleResolvedCycleOutcome(outcome);
  }

  private async evaluateDecision(
    run: ActiveBackgroundRun,
    actorResult: ChatExecutorResult,
  ): Promise<BackgroundRunDecision | undefined> {
    try {
      const providerTrace =
        this.traceProviderPayloads
          ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:decision`,
                sessionId: run.sessionId,
                staticFields: {
                  runId: run.id,
                  cycleCount: run.cycleCount,
                  phase: "decision",
                },
              }),
            },
          }
          : undefined;
      const response = await this.supervisorLlm.chat([
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDecisionPrompt({
            contract: run.contract,
            objective: run.objective,
            actorResult,
            previousUpdate: run.lastUserUpdate,
          }),
        },
      ], {
        toolChoice: "none",
        ...(providerTrace ?? {}),
      });
      return parseDecision(response.content);
    } catch (error) {
      this.logger.debug("Background run decision evaluation failed", {
        sessionId: run.sessionId,
        runId: run.id,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  private async refreshCarryForwardState(params: {
    run: ActiveBackgroundRun;
    actorResult?: ChatExecutorResult;
    force?: boolean;
    signalSnapshot?: readonly BackgroundRunSignal[];
  }): Promise<void> {
    const { run, actorResult, force, signalSnapshot } = params;
    const now = this.now();
    const previousCarryForward = run.carryForward;
    const pendingSignals = signalSnapshot ?? run.pendingSignals;
    const refreshReason = deriveCarryForwardRefreshReason({
      run,
      actorResult,
      force,
      pendingSignals,
    });
    if (!refreshReason) return;
    const providerContinuation =
      extractLatestProviderContinuation(actorResult, now) ??
      previousCarryForward?.providerContinuation;
    let finalReason: CarryForwardRefreshReason = refreshReason;

    try {
      const providerTrace =
        this.traceProviderPayloads
          ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:carry_forward`,
                sessionId: run.sessionId,
                staticFields: {
                  runId: run.id,
                  cycleCount: run.cycleCount,
                  phase: "carry_forward",
                },
              }),
            },
          }
          : undefined;
      const response = await this.supervisorLlm.chat([
        { role: "system", content: CARRY_FORWARD_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildCarryForwardPrompt({
            objective: run.objective,
            contract: run.contract,
            previous: previousCarryForward,
            actorResult,
            latestUpdate: run.lastUserUpdate,
            latestToolEvidence: run.lastToolEvidence,
            pendingSignals,
            observedTargets: run.observedTargets,
          }),
        },
      ], {
        toolChoice: "none",
        ...(providerTrace ?? {}),
      });
      const parsed =
        parseCarryForwardState(response.content, now) ??
        buildFallbackCarryForwardState({
          previous: previousCarryForward,
          latestUpdate: run.lastUserUpdate,
          latestToolEvidence: run.lastToolEvidence,
          pendingSignals,
          now,
        });
      const driftReason = detectCarryForwardDrift({
        candidate: parsed,
        actorResult,
        previous: previousCarryForward,
      });
      if (driftReason) {
        finalReason = "repair";
        run.carryForward = repairCarryForwardState({
          previous: previousCarryForward,
          latestUpdate: run.lastUserUpdate,
          latestToolEvidence: run.lastToolEvidence,
          pendingSignals,
          actorResult,
          now,
          reason: driftReason,
          providerContinuation,
        });
        this.logger.warn("Background run carry-forward drift detected", {
          sessionId: run.sessionId,
          runId: run.id,
          reason: driftReason,
        });
      } else {
        run.carryForward = {
          ...parsed,
          artifacts: previousCarryForward?.artifacts ?? [],
          memoryAnchors: buildCarryForwardAnchors({
            previous: previousCarryForward?.memoryAnchors ?? [],
            providerContinuation,
            pendingSignals,
            actorResult,
            now,
          }),
          providerContinuation,
          summaryHealth: {
            status: "healthy",
            driftCount: previousCarryForward?.summaryHealth.driftCount ?? 0,
            lastDriftAt: previousCarryForward?.summaryHealth.lastDriftAt,
            lastRepairAt: previousCarryForward?.summaryHealth.lastRepairAt,
            lastDriftReason: previousCarryForward?.summaryHealth.lastDriftReason,
          },
          lastCompactedAt: now,
        };
      }
    } catch (error) {
      this.logger.debug("Background run carry-forward refresh failed", {
        sessionId: run.sessionId,
        runId: run.id,
        error: toErrorMessage(error),
      });
      run.carryForward = buildFallbackCarryForwardState({
        previous: previousCarryForward,
        latestUpdate: run.lastUserUpdate,
        latestToolEvidence: run.lastToolEvidence,
        pendingSignals,
        now,
      });
      run.carryForward = {
        ...run.carryForward,
        memoryAnchors: buildCarryForwardAnchors({
          previous: previousCarryForward?.memoryAnchors ?? [],
          providerContinuation,
          pendingSignals,
          actorResult,
          now,
        }),
        providerContinuation,
        summaryHealth: previousCarryForward?.summaryHealth ?? {
          status: "healthy",
          driftCount: 0,
        },
      };
    }

    run.compaction = {
      ...run.compaction,
      lastCompactedAt: run.carryForward.lastCompactedAt,
      lastCompactedCycle: run.cycleCount,
      refreshCount: run.compaction.refreshCount + 1,
      lastHistoryLength: run.internalHistory.length,
      lastMilestoneAt:
        finalReason === "milestone" || finalReason === "repair"
          ? now
          : run.compaction.lastMilestoneAt,
      lastCompactionReason: finalReason,
      repairCount:
        finalReason === "repair"
          ? run.compaction.repairCount + 1
          : run.compaction.repairCount,
      lastProviderAnchorAt:
        providerContinuation?.updatedAt ?? run.compaction.lastProviderAnchorAt,
    };
    if (finalReason === "repair") {
      this.logger.info("Background run repaired carry-forward state", {
        sessionId: run.sessionId,
        runId: run.id,
        refreshCount: run.compaction.refreshCount,
      });
    }
    const latestProviderCompactionArtifact = [...run.carryForward.artifacts]
      .reverse()
      .find((artifact) =>
        artifact.kind === "opaque_provider_state" &&
        artifact.source.endsWith(":context_management")
      );
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "memory_compacted",
      summary: truncate(
        `Background run memory ${finalReason === "repair" ? "repaired" : "refreshed"} (${finalReason}).`,
        200,
      ),
      timestamp: now,
      data: {
        reason: finalReason,
        refreshCount: run.compaction.refreshCount,
        repairCount: run.compaction.repairCount,
        providerResponseId: run.carryForward.providerContinuation?.responseId,
        providerCompactionArtifact: latestProviderCompactionArtifact?.locator,
        providerCompactionDigest: latestProviderCompactionArtifact?.digest,
      },
    });

    if (pendingSignals.length > 0) {
      run.pendingSignals = removeConsumedSignals(run.pendingSignals, pendingSignals);
    }
  }

  private async planRunContract(
    objective: string,
    sessionId?: string,
  ): Promise<BackgroundRunContract> {
    try {
      const providerTrace =
        this.traceProviderPayloads
          ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${sessionId ?? "unscoped"}:contract:${Date.now()}`,
                ...(sessionId ? { sessionId } : {}),
                staticFields: {
                  phase: "contract",
                },
              }),
            },
          }
          : undefined;
      const response = await this.supervisorLlm.chat([
        { role: "system", content: CONTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildContractPrompt(objective) },
      ], {
        toolChoice: "none",
        ...(providerTrace ?? {}),
      });
      return parseContract(response.content, objective) ?? buildFallbackContract(objective);
    } catch (error) {
      this.logger.debug("Background run contract planning failed", {
        objective: truncate(objective, 120),
        error: toErrorMessage(error),
      });
      return buildFallbackContract(objective);
    }
  }

  private async persistRun(
    run: ActiveBackgroundRun,
    event?: BackgroundRunEvent,
  ): Promise<void> {
    refreshDerivedBudgetState(run);
    this.resolveRunPolicyScope(run);
    const queuedSignals = this.wakeBus.getQueuedCount(run.sessionId);
    const persistedRun = toPersistedRun(run);
    const recentSnapshot = toRecentSnapshot(run, queuedSignals);
    this.rememberStatusSnapshot(run, queuedSignals);
    await this.runStore.saveRun(persistedRun);
    await this.runStore.saveRecentSnapshot(recentSnapshot);
    if (event) {
      await this.runStore.appendEvent(persistedRun, event);
      if (this.notifier?.isEnabled()) {
        const summary = toOperatorSummary({
          snapshot: recentSnapshot,
          contract: persistedRun.contract,
          blocker: persistedRun.blocker,
          approvalState: persistedRun.approvalState,
          checkpointAvailable: false,
          now: this.now(),
        });
        await this.notifier.notify({
          occurredAt: event.timestamp,
          internalEventType: event.type,
          summary: event.summary,
          run: summary,
        });
      }
    }
  }

  private async publishUpdateIfChanged(
    run: ActiveBackgroundRun,
    content: string,
  ): Promise<void> {
    const next = truncate(content, MAX_USER_UPDATE_CHARS);
    if (run.lastUserUpdate === next) return;
    run.lastUserUpdate = next;
    run.lastHeartbeatContent = undefined;
    if (
      run.lastVerifiedAt !== undefined &&
      run.budgetState.firstVerifiedUpdateAt === undefined
    ) {
      run.budgetState = {
        ...run.budgetState,
        firstVerifiedUpdateAt: this.now(),
      };
      const firstVerifiedUpdateAt =
        run.budgetState.firstVerifiedUpdateAt ?? run.updatedAt;
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_VERIFIED_UPDATE_MS,
        firstVerifiedUpdateAt - run.createdAt,
        run,
      );
    }
    recordRunActivity(run, this.now(), "progress");
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
      run.nextHeartbeatAt = undefined;
    }
    await this.publishUpdate(run.sessionId, next);
    await this.persistRun(run, {
      type: "user_update",
      summary: next,
      timestamp: this.now(),
      data: {
        kind:
          run.budgetState.firstVerifiedUpdateAt !== undefined
            ? "verified_update"
            : "progress_update",
        verified: run.lastVerifiedAt !== undefined,
      },
    });
  }

  private async parkBlockedRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, "blocked", "parkBlockedRun");
    run.state = "blocked";
    run.updatedAt = this.now();
    const blockerState = buildBlockerState(decision, run.updatedAt);
    run.blocker = blockerState.blocker;
    run.approvalState = blockerState.approvalState;
    recordRunActivity(run, run.updatedAt, "progress");
    if (decision.shouldNotifyUser) {
      run.lastUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
    }
    run.lastHeartbeatContent = undefined;

    await this.progressTracker?.append({
      sessionId: run.sessionId,
      type: "decision",
      summary: truncate(`Background run blocked: ${decision.internalSummary}`, 200),
    });
    await this.persistRun(run, {
      type: "run_blocked",
      summary: truncate(`Background run blocked: ${decision.internalSummary}`, 200),
      timestamp: this.now(),
      data: {
        pendingSignals: run.pendingSignals.length,
      },
    });
    this.incrementRunTelemetryCounter(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_BLOCKED_TOTAL,
      run,
    );
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_BLOCKED_WITHOUT_NOTICE_RATE,
      decision.shouldNotifyUser ? 0 : 1,
      run,
    );
    this.recordAlert({
      severity: decision.shouldNotifyUser ? "warn" : "error",
      code: "run_blocked",
      message: decision.internalSummary,
      run,
    });
    await this.runStore.releaseLease(run.sessionId, this.instanceId, this.now(), {
      ...toPersistedRun(run),
    });
    this.activeRuns.delete(run.sessionId);
    this.updateActiveGauge();
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    this.rememberStatusSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId));
    this.onStatus?.(run.sessionId, {
      phase: "background_blocked",
      detail: "Background run is blocked and waiting for a new signal or intervention",
    });
    if (decision.shouldNotifyUser) {
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "user_update",
        summary: truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS),
        timestamp: this.now(),
        data: {
          kind: "blocked_notice",
          verified: run.lastVerifiedAt !== undefined,
        },
      });
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }

  private async finishRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, decision.state, "finishRun");
    run.state = decision.state;
    run.updatedAt = this.now();
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt, "progress");
    if (decision.shouldNotifyUser) {
      run.lastUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
    }
    this.activeRuns.delete(run.sessionId);
    this.forgetStatusSnapshot(run.sessionId);
    await this.runStore.saveCheckpoint(toPersistedRun(run));
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    await this.wakeBus.clearSession(run.sessionId);

    const progressType = decision.state === "completed"
      ? "task_completed"
      : "error";
    await this.progressTracker?.append({
      sessionId: run.sessionId,
      type: progressType,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
    });
    const eventType: BackgroundRunEventType =
      decision.state === "completed"
        ? "run_completed"
        : decision.state === "failed"
          ? "run_failed"
          : "run_cancelled";
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: eventType,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
      timestamp: this.now(),
      data:
        decision.state === "cancelled" && run.budgetState.stopRequestedAt !== undefined
          ? {
              stopRequestedAt: run.budgetState.stopRequestedAt,
            }
          : undefined,
    });
    if (this.notifier?.isEnabled()) {
      const summary = toOperatorSummary({
        snapshot: toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
        contract: run.contract,
        blocker: run.blocker,
        approvalState: run.approvalState,
        checkpointAvailable: true,
        now: this.now(),
      });
      await this.notifier.notify({
        occurredAt: this.now(),
        internalEventType: eventType,
        summary: truncate(
          `Background run ${decision.state}: ${decision.internalSummary}`,
          200,
        ),
        run: summary,
      });
    }
    const latencyMs = Math.max(0, run.updatedAt - run.createdAt);
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_LATENCY_MS,
      latencyMs,
      run,
    );
    if (decision.state === "completed") {
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_COMPLETED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_FALSE_COMPLETION_RATE,
        run.lastVerifiedAt === undefined ? 1 : 0,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_VERIFIER_ACCURACY,
        run.lastVerifiedAt === undefined ? 0 : 1,
        run,
      );
      this.recordAlert({
        severity: "info",
        code: "run_completed",
        message: decision.internalSummary,
        run,
      });
    } else if (decision.state === "failed") {
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_FAILED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_VERIFIER_ACCURACY,
        run.lastVerifiedAt === undefined ? 0 : 1,
        run,
      );
      this.recordAlert({
        severity: "error",
        code: "run_failed",
        message: decision.internalSummary,
        run,
      });
    } else if (run.budgetState.stopRequestedAt !== undefined) {
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_STOP_LATENCY_MS,
        Math.max(0, run.updatedAt - run.budgetState.stopRequestedAt),
        run,
      );
    }
    await this.runStore.deleteRun(run.sessionId);
    this.updateActiveGauge();

    if (decision.shouldNotifyUser) {
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }
}
