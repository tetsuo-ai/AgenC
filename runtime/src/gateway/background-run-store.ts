import type { LLMMessage } from "../llm/types.js";
import type { MemoryBackend, MemoryEntry } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import {
  AGENT_RUN_SCHEMA_VERSION,
  assertValidAgentRunContract,
  inferAgentRunDomain,
  isAgentRunDomain,
  isAgentManagedProcessPolicyMode,
  isAgentRunKind,
  isAgentRunState,
  isAgentRunWakeReason,
  type AgentRunContract,
  type AgentRunKind,
  type AgentRunManagedProcessPolicy,
  type AgentRunState,
  type AgentRunWakeReason,
} from "./agent-run-contract.js";

const BACKGROUND_RUN_KEY_PREFIX = "background-run:session:";
const BACKGROUND_RUN_RECENT_KEY_PREFIX = "background-run:recent:session:";
const BACKGROUND_RUN_EVENT_SESSION_PREFIX = "background-run:";
const BACKGROUND_RUN_CORRUPT_KEY_PREFIX = "background-run:corrupt:";
const BACKGROUND_RUN_WAKE_QUEUE_KEY_PREFIX = "background-run:wake-queue:session:";
const DEFAULT_LEASE_DURATION_MS = 45_000;
export const DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_BACKGROUND_RUN_MAX_CYCLES = 512;
export const DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS = 60 * 60_000;
const DEFAULT_TERMINAL_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CORRUPT_RECORD_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_WAKE_DEAD_LETTER_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_WAKE_QUEUE_MAX_EVENTS = 256;

export type BackgroundRunKind = AgentRunKind;
export type BackgroundRunState = AgentRunState;
export type BackgroundRunContract = AgentRunContract;
export type BackgroundRunManagedProcessPolicy = AgentRunManagedProcessPolicy;

export interface BackgroundRunManagedProcessLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
  readonly logPath?: string;
}

export type BackgroundRunWakeReason = AgentRunWakeReason;

export interface BackgroundRunSignal {
  readonly id: string;
  readonly type: Exclude<
    BackgroundRunWakeReason,
    "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
  >;
  readonly content: string;
  readonly timestamp: number;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunWakeEvent {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly type: BackgroundRunWakeReason;
  readonly domain:
    | "scheduler"
    | "operator"
    | "approval"
    | "tool"
    | "process"
    | "webhook"
    | "external";
  readonly content: string;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly sequence: number;
  readonly deliveryCount: number;
  readonly maxDeliveryAttempts: number;
  readonly dedupeKey?: string;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunWakeDeadLetter {
  readonly event: BackgroundRunWakeEvent;
  readonly failedAt: number;
  readonly reason: string;
}

export interface PersistedBackgroundRunWakeQueue {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly updatedAt: number;
  readonly events: readonly BackgroundRunWakeEvent[];
  readonly deadLetters: readonly BackgroundRunWakeDeadLetter[];
}

export interface BackgroundRunObservedManagedProcessTarget {
  readonly kind: "managed_process";
  readonly processId: string;
  readonly label?: string;
  readonly surface?: "desktop" | "host";
  readonly pid?: number;
  readonly pgid?: number;
  readonly desiredState: "running" | "exited";
  readonly exitPolicy: "until_exit" | "keep_running" | "restart_on_exit";
  readonly currentState: "running" | "exited";
  readonly lastObservedAt: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly launchSpec?: BackgroundRunManagedProcessLaunchSpec;
  readonly restartCount?: number;
  readonly lastRestartAt?: number;
}

export type BackgroundRunObservedTarget =
  | BackgroundRunObservedManagedProcessTarget;

export interface BackgroundRunCarryForwardState {
  readonly summary: string;
  readonly verifiedFacts: readonly string[];
  readonly openLoops: readonly string[];
  readonly nextFocus?: string;
  readonly artifacts: readonly BackgroundRunArtifactRef[];
  readonly memoryAnchors: readonly BackgroundRunMemoryAnchor[];
  readonly providerContinuation?: BackgroundRunProviderContinuation;
  readonly summaryHealth: BackgroundRunSummaryHealth;
  readonly lastCompactedAt: number;
}

export interface BackgroundRunArtifactRef {
  readonly kind:
    | "file"
    | "url"
    | "log"
    | "process"
    | "download"
    | "opaque_provider_state";
  readonly locator: string;
  readonly label?: string;
  readonly source: string;
  readonly observedAt: number;
  readonly digest?: string;
}

export interface BackgroundRunMemoryAnchor {
  readonly kind: "progress" | "event" | "provider_response";
  readonly reference: string;
  readonly summary: string;
  readonly createdAt: number;
}

export interface BackgroundRunProviderContinuation {
  readonly provider: string;
  readonly responseId: string;
  readonly reconciliationHash?: string;
  readonly updatedAt: number;
  readonly mode: "previous_response_id";
}

export interface BackgroundRunSummaryHealth {
  readonly status: "healthy" | "repairing";
  readonly driftCount: number;
  readonly lastDriftAt?: number;
  readonly lastRepairAt?: number;
  readonly lastDriftReason?: string;
}

export interface BackgroundRunBlockerState {
  readonly code:
    | "approval_required"
    | "operator_input_required"
    | "managed_process_exit"
    | "tool_failure"
    | "missing_prerequisite"
    | "runtime_budget_exhausted"
    | "unknown";
  readonly summary: string;
  readonly details?: string;
  readonly since: number;
  readonly requiresOperatorAction: boolean;
  readonly requiresApproval: boolean;
  readonly retryable: boolean;
}

export interface BackgroundRunApprovalState {
  readonly status: "none" | "waiting";
  readonly requestedAt?: number;
  readonly summary?: string;
}

export interface BackgroundRunWatchRegistration {
  readonly id: string;
  readonly kind: "managed_process";
  readonly targetId: string;
  readonly label?: string;
  readonly wakeOn: readonly ("process_exit" | "tool_result")[];
  readonly registeredAt: number;
  readonly lastTriggeredAt?: number;
}

export interface BackgroundRunBudgetState {
  readonly runtimeStartedAt: number;
  readonly lastActivityAt: number;
  readonly lastProgressAt: number;
  readonly maxRuntimeMs: number;
  readonly maxCycles: number;
  readonly maxIdleMs?: number;
  readonly nextCheckIntervalMs: number;
  readonly heartbeatIntervalMs?: number;
}

export interface BackgroundRunCompactionState {
  readonly lastCompactedAt?: number;
  readonly lastCompactedCycle: number;
  readonly refreshCount: number;
  readonly lastHistoryLength: number;
  readonly lastMilestoneAt?: number;
  readonly lastCompactionReason?: "history_threshold" | "milestone" | "forced" | "repair";
  readonly repairCount: number;
  readonly lastProviderAnchorAt?: number;
}

export interface BackgroundRunRecentSnapshot {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: BackgroundRunState;
  readonly contractKind: BackgroundRunKind;
  readonly requiresUserStop: boolean;
  readonly cycleCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastVerifiedAt?: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastUserUpdate?: string;
  readonly lastToolEvidence?: string;
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly pendingSignals: number;
  readonly carryForwardSummary?: string;
  readonly blockerSummary?: string;
  readonly watchCount: number;
  readonly fenceToken: number;
}

export interface PersistedBackgroundRun {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly contract: BackgroundRunContract;
  readonly state: BackgroundRunState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cycleCount: number;
  readonly stableWorkingCycles: number;
  readonly consecutiveErrorCycles: number;
  readonly nextCheckAt?: number;
  readonly nextHeartbeatAt?: number;
  readonly lastVerifiedAt?: number;
  readonly lastUserUpdate?: string;
  readonly lastToolEvidence?: string;
  readonly lastHeartbeatContent?: string;
  readonly lastWakeReason?: BackgroundRunWakeReason;
  readonly carryForward?: BackgroundRunCarryForwardState;
  readonly blocker?: BackgroundRunBlockerState;
  readonly approvalState: BackgroundRunApprovalState;
  readonly budgetState: BackgroundRunBudgetState;
  readonly compaction: BackgroundRunCompactionState;
  readonly pendingSignals: readonly BackgroundRunSignal[];
  readonly observedTargets: readonly BackgroundRunObservedTarget[];
  readonly watchRegistrations: readonly BackgroundRunWatchRegistration[];
  readonly internalHistory: readonly LLMMessage[];
  readonly fenceToken: number;
  readonly leaseOwnerId?: string;
  readonly leaseExpiresAt?: number;
}

export interface BackgroundRunEvent {
  readonly type: string;
  readonly summary: string;
  readonly timestamp: number;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunLeaseResult {
  readonly claimed: boolean;
  readonly run?: PersistedBackgroundRun;
}

export interface BackgroundRunGarbageCollectOptions {
  readonly now?: number;
  readonly terminalSnapshotRetentionMs?: number;
  readonly corruptRecordRetentionMs?: number;
  readonly wakeDeadLetterRetentionMs?: number;
}

export interface BackgroundRunGarbageCollectResult {
  readonly releasedExpiredLeases: number;
  readonly deletedTerminalSnapshots: number;
  readonly deletedCorruptRecords: number;
  readonly deletedWakeDeadLetters: number;
}

export interface EnqueueBackgroundRunWakeEventParams {
  readonly sessionId: string;
  readonly runId?: string;
  readonly type: BackgroundRunWakeReason;
  readonly domain: BackgroundRunWakeEvent["domain"];
  readonly content: string;
  readonly createdAt?: number;
  readonly availableAt?: number;
  readonly dedupeKey?: string;
  readonly maxDeliveryAttempts?: number;
  readonly data?: Record<string, unknown>;
  readonly dispatchReady?: boolean;
}

export interface DequeueBackgroundRunWakeEventsResult {
  readonly run?: PersistedBackgroundRun;
  readonly deliveredSignals: readonly BackgroundRunSignal[];
  readonly remainingQueuedEvents: number;
  readonly nextAvailableAt?: number;
}

export interface BackgroundRunStoreConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly leaseDurationMs?: number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function backgroundRunKey(sessionId: string): string {
  return `${BACKGROUND_RUN_KEY_PREFIX}${sessionId}`;
}

function backgroundRunRecentKey(sessionId: string): string {
  return `${BACKGROUND_RUN_RECENT_KEY_PREFIX}${sessionId}`;
}

function backgroundRunEventSessionId(runId: string): string {
  return `${BACKGROUND_RUN_EVENT_SESSION_PREFIX}${runId}`;
}

function backgroundRunCorruptKey(sessionId: string): string {
  return `${BACKGROUND_RUN_CORRUPT_KEY_PREFIX}${sessionId}`;
}

function backgroundRunWakeQueueKey(sessionId: string): string {
  return `${BACKGROUND_RUN_WAKE_QUEUE_KEY_PREFIX}${sessionId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function coercePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function coerceNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function coerceLaunchSpec(
  value: unknown,
): BackgroundRunManagedProcessLaunchSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    return undefined;
  }
  const args = normalizeStringArray(raw.args);
  return {
    command: raw.command,
    args,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    logPath: typeof raw.logPath === "string" ? raw.logPath : undefined,
  };
}

function coerceSignal(value: unknown): BackgroundRunSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (
    type !== "user_input" &&
    type !== "approval" &&
    type !== "external_event" &&
    type !== "tool_result" &&
    type !== "process_exit" &&
    type !== "webhook"
  ) {
    return undefined;
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.content !== "string" ||
    typeof raw.timestamp !== "number"
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    type,
    content: raw.content,
    timestamp: raw.timestamp,
    data:
      raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? cloneJson(raw.data as Record<string, unknown>)
        : undefined,
  };
}

function isWakeEventDomain(value: unknown): value is BackgroundRunWakeEvent["domain"] {
  return (
    value === "scheduler" ||
    value === "operator" ||
    value === "approval" ||
    value === "tool" ||
    value === "process" ||
    value === "webhook" ||
    value === "external"
  );
}

function wakeEventPriority(
  event: Pick<BackgroundRunWakeEvent, "domain">,
): number {
  switch (event.domain) {
    case "approval":
      return 0;
    case "operator":
      return 1;
    case "process":
      return 2;
    case "tool":
      return 3;
    case "scheduler":
      return 4;
    case "webhook":
      return 5;
    case "external":
      return 6;
  }
}

function compareWakeEvents(
  left: BackgroundRunWakeEvent,
  right: BackgroundRunWakeEvent,
): number {
  return (
    left.availableAt - right.availableAt ||
    wakeEventPriority(left) - wakeEventPriority(right) ||
    left.sequence - right.sequence
  );
}

function coerceWakeEvent(value: unknown): BackgroundRunWakeEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.id !== "string" ||
    typeof raw.sessionId !== "string" ||
    !isAgentRunWakeReason(raw.type) ||
    !isWakeEventDomain(raw.domain) ||
    typeof raw.content !== "string" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.availableAt !== "number" ||
    typeof raw.sequence !== "number" ||
    typeof raw.deliveryCount !== "number"
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: raw.id,
    sessionId: raw.sessionId,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    type: raw.type,
    domain: raw.domain,
    content: raw.content,
    createdAt: raw.createdAt,
    availableAt: raw.availableAt,
    sequence: raw.sequence,
    deliveryCount: raw.deliveryCount,
    maxDeliveryAttempts:
      coercePositiveInteger(raw.maxDeliveryAttempts) ??
      DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS,
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : undefined,
    data:
      raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? cloneJson(raw.data as Record<string, unknown>)
        : undefined,
  };
}

function coerceWakeDeadLetter(
  value: unknown,
): BackgroundRunWakeDeadLetter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const event = coerceWakeEvent(raw.event);
  if (!event || typeof raw.failedAt !== "number" || typeof raw.reason !== "string") {
    return undefined;
  }
  return {
    event,
    failedAt: raw.failedAt,
    reason: raw.reason,
  };
}

function buildDefaultWakeQueue(
  sessionId: string,
  now: number,
): PersistedBackgroundRunWakeQueue {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    sessionId,
    nextSequence: 1,
    updatedAt: now,
    events: [],
    deadLetters: [],
  };
}

function coerceWakeQueue(
  sessionId: string,
  value: unknown,
): PersistedBackgroundRunWakeQueue | undefined {
  if (value === undefined) {
    return buildDefaultWakeQueue(sessionId, Date.now());
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.sessionId !== "string" ||
    raw.sessionId !== sessionId
  ) {
    return undefined;
  }
  const events = Array.isArray(raw.events)
    ? raw.events
        .map((item) => coerceWakeEvent(item))
        .filter((item): item is BackgroundRunWakeEvent => item !== undefined)
        .sort(compareWakeEvents)
    : [];
  const deadLetters = Array.isArray(raw.deadLetters)
    ? raw.deadLetters
        .map((item) => coerceWakeDeadLetter(item))
        .filter((item): item is BackgroundRunWakeDeadLetter => item !== undefined)
    : [];
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    sessionId,
    nextSequence: coercePositiveInteger(raw.nextSequence) ?? events.length + 1,
    updatedAt:
      typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    events,
    deadLetters,
  };
}

function coerceObservedTarget(
  value: unknown,
): BackgroundRunObservedTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "managed_process") return undefined;
  if (
    typeof raw.processId !== "string" ||
    (raw.desiredState !== "running" && raw.desiredState !== "exited") ||
    (
      raw.exitPolicy !== "until_exit" &&
      raw.exitPolicy !== "keep_running" &&
      raw.exitPolicy !== "restart_on_exit"
    ) ||
    (raw.currentState !== "running" && raw.currentState !== "exited") ||
    typeof raw.lastObservedAt !== "number"
  ) {
    return undefined;
  }
  return {
    kind: "managed_process",
    processId: raw.processId,
    label: typeof raw.label === "string" ? raw.label : undefined,
    surface:
      raw.surface === "desktop" || raw.surface === "host"
        ? raw.surface
        : undefined,
    pid: typeof raw.pid === "number" ? raw.pid : undefined,
    pgid: typeof raw.pgid === "number" ? raw.pgid : undefined,
    desiredState: raw.desiredState,
    exitPolicy: raw.exitPolicy,
    currentState: raw.currentState,
    lastObservedAt: raw.lastObservedAt,
    exitCode:
      raw.exitCode === null || typeof raw.exitCode === "number"
        ? raw.exitCode
        : undefined,
    signal:
      raw.signal === null || typeof raw.signal === "string"
        ? raw.signal
        : undefined,
    launchSpec: coerceLaunchSpec(raw.launchSpec),
    restartCount: coerceNonNegativeInteger(raw.restartCount),
    lastRestartAt:
      typeof raw.lastRestartAt === "number" ? raw.lastRestartAt : undefined,
  };
}

function coerceCarryForward(
  value: unknown,
): BackgroundRunCarryForwardState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.summary !== "string" ||
    typeof raw.lastCompactedAt !== "number"
  ) {
    return undefined;
  }
  return {
    summary: raw.summary,
    verifiedFacts: normalizeStringArray(raw.verifiedFacts),
    openLoops: normalizeStringArray(raw.openLoops),
    nextFocus:
      typeof raw.nextFocus === "string" ? raw.nextFocus : undefined,
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts
        .map((item) => coerceArtifactRef(item))
        .filter((item): item is BackgroundRunArtifactRef => item !== undefined)
      : [],
    memoryAnchors: Array.isArray(raw.memoryAnchors)
      ? raw.memoryAnchors
        .map((item) => coerceMemoryAnchor(item))
        .filter((item): item is BackgroundRunMemoryAnchor => item !== undefined)
      : [],
    providerContinuation: coerceProviderContinuation(raw.providerContinuation),
    summaryHealth: coerceSummaryHealth(raw.summaryHealth),
    lastCompactedAt: raw.lastCompactedAt,
  };
}

function coerceArtifactRef(
  value: unknown,
): BackgroundRunArtifactRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (
    kind !== "file" &&
    kind !== "url" &&
    kind !== "log" &&
    kind !== "process" &&
    kind !== "download" &&
    kind !== "opaque_provider_state"
  ) {
    return undefined;
  }
  if (typeof raw.locator !== "string" || typeof raw.source !== "string") {
    return undefined;
  }
  if (typeof raw.observedAt !== "number") {
    return undefined;
  }
  return {
    kind,
    locator: raw.locator,
    label: typeof raw.label === "string" ? raw.label : undefined,
    source: raw.source,
    observedAt: raw.observedAt,
    digest: typeof raw.digest === "string" ? raw.digest : undefined,
  };
}

function coerceMemoryAnchor(
  value: unknown,
): BackgroundRunMemoryAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (
    kind !== "progress" &&
    kind !== "event" &&
    kind !== "provider_response"
  ) {
    return undefined;
  }
  if (
    typeof raw.reference !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.createdAt !== "number"
  ) {
    return undefined;
  }
  return {
    kind,
    reference: raw.reference,
    summary: raw.summary,
    createdAt: raw.createdAt,
  };
}

function coerceProviderContinuation(
  value: unknown,
): BackgroundRunProviderContinuation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.mode !== "previous_response_id" ||
    typeof raw.provider !== "string" ||
    typeof raw.responseId !== "string" ||
    typeof raw.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    provider: raw.provider,
    responseId: raw.responseId,
    reconciliationHash:
      typeof raw.reconciliationHash === "string"
        ? raw.reconciliationHash
        : undefined,
    updatedAt: raw.updatedAt,
    mode: "previous_response_id",
  };
}

function coerceSummaryHealth(value: unknown): BackgroundRunSummaryHealth {
  if (!value || typeof value !== "object") {
    return {
      status: "healthy",
      driftCount: 0,
    };
  }
  const raw = value as Record<string, unknown>;
  return {
    status: raw.status === "repairing" ? "repairing" : "healthy",
    driftCount: coerceNonNegativeInteger(raw.driftCount) ?? 0,
    lastDriftAt:
      typeof raw.lastDriftAt === "number" ? raw.lastDriftAt : undefined,
    lastRepairAt:
      typeof raw.lastRepairAt === "number" ? raw.lastRepairAt : undefined,
    lastDriftReason:
      typeof raw.lastDriftReason === "string" ? raw.lastDriftReason : undefined,
  };
}

function buildDefaultWatchRegistrations(
  observedTargets: readonly BackgroundRunObservedTarget[],
): BackgroundRunWatchRegistration[] {
  return observedTargets.flatMap((target) => {
    if (target.kind !== "managed_process") return [];
    return [{
      id: `watch:managed_process:${target.processId}`,
      kind: "managed_process" as const,
      targetId: target.processId,
      label: target.label,
      wakeOn: ["process_exit", "tool_result"] as const,
      registeredAt: target.lastObservedAt,
      lastTriggeredAt: target.currentState === "exited"
        ? target.lastObservedAt
        : undefined,
    }];
  });
}

function buildDefaultBudgetState(params: {
  createdAt: number;
  updatedAt: number;
  contract: BackgroundRunContract;
}): BackgroundRunBudgetState {
  return {
    runtimeStartedAt: params.createdAt,
    lastActivityAt: params.updatedAt,
    lastProgressAt: params.updatedAt,
    maxRuntimeMs: DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
    maxCycles: DEFAULT_BACKGROUND_RUN_MAX_CYCLES,
    maxIdleMs: params.contract.requiresUserStop ? undefined : DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
    nextCheckIntervalMs: params.contract.nextCheckMs,
    heartbeatIntervalMs: params.contract.heartbeatMs,
  };
}

function buildDefaultCompactionState(params: {
  carryForward?: BackgroundRunCarryForwardState;
  cycleCount: number;
  internalHistoryLength: number;
}): BackgroundRunCompactionState {
  return {
    lastCompactedAt: params.carryForward?.lastCompactedAt,
    lastCompactedCycle: params.carryForward ? params.cycleCount : 0,
    refreshCount: params.carryForward ? 1 : 0,
    lastHistoryLength: params.internalHistoryLength,
    lastMilestoneAt: undefined,
    lastCompactionReason: undefined,
    repairCount: 0,
    lastProviderAnchorAt: params.carryForward?.providerContinuation?.updatedAt,
  };
}

function coerceBlockerState(
  value: unknown,
): BackgroundRunBlockerState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const code = raw.code;
  if (
    code !== "approval_required" &&
    code !== "operator_input_required" &&
    code !== "managed_process_exit" &&
    code !== "tool_failure" &&
    code !== "missing_prerequisite" &&
    code !== "runtime_budget_exhausted" &&
    code !== "unknown"
  ) {
    return undefined;
  }
  if (
    typeof raw.summary !== "string" ||
    typeof raw.since !== "number" ||
    typeof raw.requiresOperatorAction !== "boolean" ||
    typeof raw.requiresApproval !== "boolean" ||
    typeof raw.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code,
    summary: raw.summary,
    details: typeof raw.details === "string" ? raw.details : undefined,
    since: raw.since,
    requiresOperatorAction: raw.requiresOperatorAction,
    requiresApproval: raw.requiresApproval,
    retryable: raw.retryable,
  };
}

function coerceApprovalState(
  value: unknown,
): BackgroundRunApprovalState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.status !== "none" && raw.status !== "waiting") {
    return undefined;
  }
  return {
    status: raw.status,
    requestedAt:
      typeof raw.requestedAt === "number" ? raw.requestedAt : undefined,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
  };
}

function coerceWatchRegistration(
  value: unknown,
): BackgroundRunWatchRegistration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "managed_process" ||
    typeof raw.id !== "string" ||
    typeof raw.targetId !== "string" ||
    typeof raw.registeredAt !== "number"
  ) {
    return undefined;
  }
  const wakeOn = Array.isArray(raw.wakeOn)
    ? raw.wakeOn.filter(
        (item): item is "process_exit" | "tool_result" =>
          item === "process_exit" || item === "tool_result",
      )
    : [];
  return {
    id: raw.id,
    kind: "managed_process",
    targetId: raw.targetId,
    label: typeof raw.label === "string" ? raw.label : undefined,
    wakeOn,
    registeredAt: raw.registeredAt,
    lastTriggeredAt:
      typeof raw.lastTriggeredAt === "number"
        ? raw.lastTriggeredAt
        : undefined,
  };
}

function coerceBudgetState(
  value: unknown,
  defaults: BackgroundRunBudgetState,
): BackgroundRunBudgetState {
  if (!value || typeof value !== "object") return defaults;
  const raw = value as Record<string, unknown>;
  return {
    runtimeStartedAt:
      typeof raw.runtimeStartedAt === "number"
        ? raw.runtimeStartedAt
        : defaults.runtimeStartedAt,
    lastActivityAt:
      typeof raw.lastActivityAt === "number"
        ? raw.lastActivityAt
        : defaults.lastActivityAt,
    lastProgressAt:
      typeof raw.lastProgressAt === "number"
        ? raw.lastProgressAt
        : defaults.lastProgressAt,
    maxRuntimeMs:
      coercePositiveInteger(raw.maxRuntimeMs) ?? defaults.maxRuntimeMs,
    maxCycles:
      coercePositiveInteger(raw.maxCycles) ?? defaults.maxCycles,
    maxIdleMs:
      coercePositiveInteger(raw.maxIdleMs) ?? defaults.maxIdleMs,
    nextCheckIntervalMs:
      coercePositiveInteger(raw.nextCheckIntervalMs) ??
      defaults.nextCheckIntervalMs,
    heartbeatIntervalMs:
      coercePositiveInteger(raw.heartbeatIntervalMs) ??
      defaults.heartbeatIntervalMs,
  };
}

function coerceCompactionState(
  value: unknown,
  defaults: BackgroundRunCompactionState,
): BackgroundRunCompactionState {
  if (!value || typeof value !== "object") return defaults;
  const raw = value as Record<string, unknown>;
  return {
    lastCompactedAt:
      typeof raw.lastCompactedAt === "number"
        ? raw.lastCompactedAt
        : defaults.lastCompactedAt,
    lastCompactedCycle:
      coerceNonNegativeInteger(raw.lastCompactedCycle) ??
      defaults.lastCompactedCycle,
    refreshCount:
      coerceNonNegativeInteger(raw.refreshCount) ?? defaults.refreshCount,
    lastHistoryLength:
      coerceNonNegativeInteger(raw.lastHistoryLength) ??
      defaults.lastHistoryLength,
    lastMilestoneAt:
      typeof raw.lastMilestoneAt === "number"
        ? raw.lastMilestoneAt
        : defaults.lastMilestoneAt,
    lastCompactionReason:
      raw.lastCompactionReason === "history_threshold" ||
      raw.lastCompactionReason === "milestone" ||
      raw.lastCompactionReason === "forced" ||
      raw.lastCompactionReason === "repair"
        ? raw.lastCompactionReason
        : defaults.lastCompactionReason,
    repairCount:
      coerceNonNegativeInteger(raw.repairCount) ?? defaults.repairCount,
    lastProviderAnchorAt:
      typeof raw.lastProviderAnchorAt === "number"
        ? raw.lastProviderAnchorAt
        : defaults.lastProviderAnchorAt,
  };
}

function coerceRecentSnapshot(
  value: unknown,
): BackgroundRunRecentSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  const contractKind = raw.contractKind;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.runId !== "string" ||
    typeof raw.sessionId !== "string" ||
    typeof raw.objective !== "string" ||
    typeof raw.requiresUserStop !== "boolean" ||
    typeof raw.cycleCount !== "number" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.pendingSignals !== "number" ||
    !isAgentRunState(state) ||
    !isAgentRunKind(contractKind)
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    runId: raw.runId,
    sessionId: raw.sessionId,
    objective: raw.objective,
    state,
    contractKind,
    requiresUserStop: raw.requiresUserStop,
    cycleCount: raw.cycleCount,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastVerifiedAt:
      typeof raw.lastVerifiedAt === "number" ? raw.lastVerifiedAt : undefined,
    nextCheckAt:
      typeof raw.nextCheckAt === "number" ? raw.nextCheckAt : undefined,
    nextHeartbeatAt:
      typeof raw.nextHeartbeatAt === "number" ? raw.nextHeartbeatAt : undefined,
    lastUserUpdate:
      typeof raw.lastUserUpdate === "string" ? raw.lastUserUpdate : undefined,
    lastToolEvidence:
      typeof raw.lastToolEvidence === "string"
        ? raw.lastToolEvidence
        : undefined,
    lastWakeReason:
      isAgentRunWakeReason(raw.lastWakeReason)
        ? raw.lastWakeReason
        : undefined,
    pendingSignals: raw.pendingSignals,
    carryForwardSummary:
      typeof raw.carryForwardSummary === "string"
        ? raw.carryForwardSummary
        : undefined,
    blockerSummary:
      typeof raw.blockerSummary === "string" ? raw.blockerSummary : undefined,
    watchCount:
      coerceNonNegativeInteger(raw.watchCount) ?? 0,
    fenceToken:
      coercePositiveInteger(raw.fenceToken) ?? 1,
  };
}

function coerceContract(
  value: unknown,
  objective?: string,
): BackgroundRunContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isAgentRunKind(raw.kind)) {
    return undefined;
  }
  const nextCheckMs =
    typeof raw.nextCheckMs === "number" && Number.isFinite(raw.nextCheckMs)
      ? raw.nextCheckMs
      : 8_000;
  const heartbeatMs =
    typeof raw.heartbeatMs === "number" && Number.isFinite(raw.heartbeatMs)
      ? raw.heartbeatMs
      : undefined;
  const managedProcessPolicy =
    raw.managedProcessPolicy &&
    typeof raw.managedProcessPolicy === "object" &&
    !Array.isArray(raw.managedProcessPolicy)
      ? raw.managedProcessPolicy as Record<string, unknown>
      : undefined;
  const normalizedManagedProcessPolicy =
    isAgentManagedProcessPolicyMode(managedProcessPolicy?.mode)
      ? {
          mode: managedProcessPolicy.mode,
          maxRestarts: coercePositiveInteger(managedProcessPolicy?.maxRestarts),
          restartBackoffMs: coercePositiveInteger(
            managedProcessPolicy?.restartBackoffMs,
          ),
        }
      : undefined;
  const contract: BackgroundRunContract = {
    domain: isAgentRunDomain(raw.domain)
      ? raw.domain
      : inferAgentRunDomain({
          objective,
          successCriteria: normalizeStringArray(raw.successCriteria),
          completionCriteria: normalizeStringArray(raw.completionCriteria),
          blockedCriteria: normalizeStringArray(raw.blockedCriteria),
          requiresUserStop: Boolean(raw.requiresUserStop),
          managedProcessPolicy: normalizedManagedProcessPolicy,
        }),
    kind: raw.kind,
    successCriteria: normalizeStringArray(raw.successCriteria),
    completionCriteria: normalizeStringArray(raw.completionCriteria),
    blockedCriteria: normalizeStringArray(raw.blockedCriteria),
    nextCheckMs,
    heartbeatMs,
    requiresUserStop: Boolean(raw.requiresUserStop),
    managedProcessPolicy: normalizedManagedProcessPolicy,
  };
  try {
    assertValidAgentRunContract(contract, "Persisted BackgroundRun contract");
    return contract;
  } catch {
    return undefined;
  }
}

interface CoercedRunCore {
  readonly raw: Record<string, unknown>;
  readonly contract: BackgroundRunContract;
  readonly carryForward?: BackgroundRunCarryForwardState;
  readonly pendingSignals: BackgroundRunSignal[];
  readonly observedTargets: BackgroundRunObservedTarget[];
}

function coerceRunCore(value: unknown): CoercedRunCore | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isAgentRunState(raw.state)) {
    return undefined;
  }
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.id !== "string" ||
    typeof raw.sessionId !== "string" ||
    typeof raw.objective !== "string" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.cycleCount !== "number" ||
    typeof raw.stableWorkingCycles !== "number" ||
    typeof raw.consecutiveErrorCycles !== "number" ||
    !Array.isArray(raw.internalHistory)
  ) {
    return undefined;
  }
  const contract = coerceContract(
    raw.contract,
    typeof raw.objective === "string" ? raw.objective : undefined,
  );
  if (!contract) return undefined;
  return {
    raw,
    contract,
    carryForward: coerceCarryForward(raw.carryForward),
    pendingSignals: Array.isArray(raw.pendingSignals)
      ? raw.pendingSignals
        .map((item) => coerceSignal(item))
        .filter((item): item is BackgroundRunSignal => item !== undefined)
      : [],
    observedTargets: Array.isArray(raw.observedTargets)
      ? raw.observedTargets
        .map((item) => coerceObservedTarget(item))
        .filter((item): item is BackgroundRunObservedTarget => item !== undefined)
      : [],
  };
}

function inferLegacyBlockerState(
  raw: Record<string, unknown>,
): BackgroundRunBlockerState | undefined {
  if (raw.state !== "blocked") return undefined;
  const blockerText = [
    typeof raw.lastUserUpdate === "string" ? raw.lastUserUpdate : "",
    typeof raw.lastToolEvidence === "string" ? raw.lastToolEvidence : "",
  ].join(" ");
  const requiresApproval = /approval/i.test(blockerText);
  return {
    code: requiresApproval ? "approval_required" : "unknown",
    summary:
      typeof raw.lastUserUpdate === "string" && raw.lastUserUpdate.trim().length > 0
        ? raw.lastUserUpdate
        : "Background run is blocked and waiting for intervention.",
    details:
      typeof raw.lastToolEvidence === "string" ? raw.lastToolEvidence : undefined,
    since: raw.updatedAt as number,
    requiresOperatorAction: true,
    requiresApproval,
    retryable: true,
  };
}

function coerceRunDurableState(params: {
  raw: Record<string, unknown>;
  contract: BackgroundRunContract;
  carryForward?: BackgroundRunCarryForwardState;
  observedTargets: readonly BackgroundRunObservedTarget[];
}): Pick<
  PersistedBackgroundRun,
  | "blocker"
  | "approvalState"
  | "budgetState"
  | "compaction"
  | "watchRegistrations"
  | "fenceToken"
> {
  const { raw, contract, carryForward, observedTargets } = params;
  const blocker =
    coerceBlockerState(raw.blocker) ?? inferLegacyBlockerState(raw);
  const approvalState =
    coerceApprovalState(raw.approvalState) ??
    (blocker?.requiresApproval
      ? {
          status: "waiting" as const,
          requestedAt: blocker.since,
          summary: blocker.summary,
        }
      : { status: "none" as const });
  const budgetState = coerceBudgetState(
    raw.budgetState,
    buildDefaultBudgetState({
      createdAt: raw.createdAt as number,
      updatedAt: raw.updatedAt as number,
      contract,
    }),
  );
  const compaction = coerceCompactionState(
    raw.compaction,
    buildDefaultCompactionState({
      carryForward,
      cycleCount: raw.cycleCount as number,
      internalHistoryLength: (raw.internalHistory as readonly unknown[]).length,
    }),
  );
  const watchRegistrations = Array.isArray(raw.watchRegistrations)
    ? raw.watchRegistrations
      .map((item) => coerceWatchRegistration(item))
      .filter((item): item is BackgroundRunWatchRegistration => item !== undefined)
    : buildDefaultWatchRegistrations(observedTargets);
  return {
    blocker,
    approvalState,
    budgetState,
    compaction,
    watchRegistrations,
    fenceToken: coercePositiveInteger(raw.fenceToken) ?? 1,
  };
}

function coerceRun(value: unknown): PersistedBackgroundRun | undefined {
  const core = coerceRunCore(value);
  if (!core) return undefined;
  const { raw, contract, carryForward, pendingSignals, observedTargets } = core;
  const id = raw.id as string;
  const sessionId = raw.sessionId as string;
  const objective = raw.objective as string;
  const state = raw.state as BackgroundRunState;
  const createdAt = raw.createdAt as number;
  const updatedAt = raw.updatedAt as number;
  const cycleCount = raw.cycleCount as number;
  const stableWorkingCycles = raw.stableWorkingCycles as number;
  const consecutiveErrorCycles = raw.consecutiveErrorCycles as number;
  const durableState = coerceRunDurableState({
    raw,
    contract,
    carryForward,
    observedTargets,
  });
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id,
    sessionId,
    objective,
    contract,
    state,
    createdAt,
    updatedAt,
    cycleCount,
    stableWorkingCycles,
    consecutiveErrorCycles,
    nextCheckAt:
      typeof raw.nextCheckAt === "number" ? raw.nextCheckAt : undefined,
    nextHeartbeatAt:
      typeof raw.nextHeartbeatAt === "number" ? raw.nextHeartbeatAt : undefined,
    lastVerifiedAt:
      typeof raw.lastVerifiedAt === "number" ? raw.lastVerifiedAt : undefined,
    lastUserUpdate:
      typeof raw.lastUserUpdate === "string" ? raw.lastUserUpdate : undefined,
    lastToolEvidence:
      typeof raw.lastToolEvidence === "string"
        ? raw.lastToolEvidence
        : undefined,
    lastHeartbeatContent:
      typeof raw.lastHeartbeatContent === "string"
        ? raw.lastHeartbeatContent
        : undefined,
    lastWakeReason:
      isAgentRunWakeReason(raw.lastWakeReason)
        ? raw.lastWakeReason
        : undefined,
    carryForward,
    blocker: durableState.blocker,
    approvalState: durableState.approvalState,
    budgetState: durableState.budgetState,
    compaction: durableState.compaction,
    pendingSignals,
    observedTargets,
    watchRegistrations: durableState.watchRegistrations,
    internalHistory: cloneJson(raw.internalHistory as readonly LLMMessage[]),
    fenceToken: durableState.fenceToken,
    leaseOwnerId:
      typeof raw.leaseOwnerId === "string" ? raw.leaseOwnerId : undefined,
    leaseExpiresAt:
      typeof raw.leaseExpiresAt === "number" ? raw.leaseExpiresAt : undefined,
  };
}

export class BackgroundRunStore {
  private readonly memoryBackend: MemoryBackend;
  private readonly logger: Logger;
  private readonly leaseDurationMs: number;
  private readonly queue: KeyedAsyncQueue;

  constructor(config: BackgroundRunStoreConfig) {
    this.memoryBackend = config.memoryBackend;
    this.logger = config.logger ?? silentLogger;
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.queue = new KeyedAsyncQueue({
      logger: this.logger,
      label: "Background run store",
    });
  }

  private async loadRawRun(sessionId: string): Promise<unknown> {
    return this.memoryBackend.get(backgroundRunKey(sessionId));
  }

  private async loadRawWakeQueue(sessionId: string): Promise<unknown> {
    return this.memoryBackend.get(backgroundRunWakeQueueKey(sessionId));
  }

  private async quarantineCorruptRun(
    sessionId: string,
    rawValue: unknown,
    reason: string,
  ): Promise<void> {
    await this.memoryBackend.set(backgroundRunCorruptKey(sessionId), {
      quarantinedAt: Date.now(),
      reason,
      rawValue,
    });
    await this.memoryBackend.delete(backgroundRunKey(sessionId));
    this.logger.warn("Quarantined corrupt background run record", {
      sessionId,
      reason,
    });
  }

  async saveRun(run: PersistedBackgroundRun): Promise<void> {
    const validated = coerceRun(run);
    if (!validated) {
      throw new Error("Invalid persisted BackgroundRun record");
    }
    await this.queue.run(run.sessionId, async () => {
      const current = await this.loadRun(run.sessionId);
      if (
        current &&
        current.fenceToken !== validated.fenceToken &&
        validated.leaseOwnerId !== undefined
      ) {
        throw new Error(
          `Stale BackgroundRun fence token ${validated.fenceToken}; current token is ${current.fenceToken}`,
        );
      }
      await this.memoryBackend.set(
        backgroundRunKey(run.sessionId),
        cloneJson(validated),
      );
    });
  }

  async loadRun(sessionId: string): Promise<PersistedBackgroundRun | undefined> {
    const value = await this.loadRawRun(sessionId);
    const run = coerceRun(value);
    if (value !== undefined && !run) {
      const latest = await this.loadRawRun(sessionId);
      if (latest !== undefined && !coerceRun(latest)) {
        await this.quarantineCorruptRun(
          sessionId,
          latest,
          "Persisted BackgroundRun record could not be migrated or validated",
        );
      }
      return undefined;
    }
    return run;
  }

  async deleteRun(sessionId: string): Promise<void> {
    await this.queue.run(sessionId, async () => {
      await this.memoryBackend.delete(backgroundRunKey(sessionId));
      await this.memoryBackend.delete(backgroundRunWakeQueueKey(sessionId));
    });
  }

  async saveRecentSnapshot(snapshot: BackgroundRunRecentSnapshot): Promise<void> {
    const validated = coerceRecentSnapshot(snapshot);
    if (!validated) {
      throw new Error("Invalid BackgroundRun recent snapshot");
    }
    await this.queue.run(snapshot.sessionId, async () => {
      await this.memoryBackend.set(
        backgroundRunRecentKey(snapshot.sessionId),
        cloneJson(validated),
      );
    });
  }

  async loadRecentSnapshot(
    sessionId: string,
  ): Promise<BackgroundRunRecentSnapshot | undefined> {
    const value = await this.memoryBackend.get(backgroundRunRecentKey(sessionId));
    return coerceRecentSnapshot(value);
  }

  async listRuns(): Promise<readonly PersistedBackgroundRun[]> {
    const keys = await this.memoryBackend.listKeys(BACKGROUND_RUN_KEY_PREFIX);
    const runs = await Promise.all(
      keys.map(async (key) => {
        const sessionId = key.slice(BACKGROUND_RUN_KEY_PREFIX.length);
        const value = await this.loadRawRun(sessionId);
        const run = coerceRun(value);
        if (value !== undefined && !run) {
          const latest = await this.loadRawRun(sessionId);
          if (latest !== undefined && !coerceRun(latest)) {
            await this.quarantineCorruptRun(
              sessionId,
              latest,
              "Persisted BackgroundRun record could not be migrated or validated",
            );
          }
          return undefined;
        }
        return run;
      }),
    );
    return runs.filter(
      (run): run is PersistedBackgroundRun => run !== undefined,
    );
  }

  async listCorruptRunKeys(): Promise<readonly string[]> {
    return this.memoryBackend.listKeys(BACKGROUND_RUN_CORRUPT_KEY_PREFIX);
  }

  async loadWakeQueue(
    sessionId: string,
  ): Promise<PersistedBackgroundRunWakeQueue> {
    const value = await this.loadRawWakeQueue(sessionId);
    const queue = coerceWakeQueue(sessionId, value);
    if (!queue) {
      const rawValue = await this.loadRawWakeQueue(sessionId);
      await this.memoryBackend.set(
        backgroundRunWakeQueueKey(sessionId),
        buildDefaultWakeQueue(sessionId, Date.now()),
      );
      this.logger.warn("Reset invalid background wake queue", {
        sessionId,
        hadRawValue: rawValue !== undefined,
      });
      return buildDefaultWakeQueue(sessionId, Date.now());
    }
    return queue;
  }

  async listWakeDeadLetters(
    sessionId: string,
  ): Promise<readonly BackgroundRunWakeDeadLetter[]> {
    const queue = await this.loadWakeQueue(sessionId);
    return queue.deadLetters;
  }

  async getQueuedWakeEventCount(sessionId: string): Promise<number> {
    const queue = await this.loadWakeQueue(sessionId);
    return queue.events.length;
  }

  async getNextWakeAvailability(
    sessionId: string,
  ): Promise<number | undefined> {
    const queue = await this.loadWakeQueue(sessionId);
    return queue.events[0]?.availableAt;
  }

  async enqueueWakeEvent(
    params: EnqueueBackgroundRunWakeEventParams,
  ): Promise<BackgroundRunWakeEvent> {
    const createdAt = params.createdAt ?? Date.now();
    const availableAt = params.availableAt ?? createdAt;
    return this.queue.run(params.sessionId, async () => {
      const currentQueue = await this.loadWakeQueue(params.sessionId);
      const existingIndex =
        params.dedupeKey !== undefined
          ? currentQueue.events.findIndex(
              (event) => event.dedupeKey === params.dedupeKey,
            )
          : -1;
      const baseEvent: BackgroundRunWakeEvent = {
        version: AGENT_RUN_SCHEMA_VERSION,
        id:
          existingIndex >= 0
            ? currentQueue.events[existingIndex]!.id
            : `wake-${createdAt.toString(36)}-${currentQueue.nextSequence.toString(36)}`,
        sessionId: params.sessionId,
        runId: params.runId,
        type: params.type,
        domain: params.domain,
        content: params.content,
        createdAt:
          existingIndex >= 0
            ? currentQueue.events[existingIndex]!.createdAt
            : createdAt,
        availableAt,
        sequence:
          existingIndex >= 0
            ? currentQueue.events[existingIndex]!.sequence
            : currentQueue.nextSequence,
        deliveryCount:
          existingIndex >= 0
            ? currentQueue.events[existingIndex]!.deliveryCount
            : 0,
        maxDeliveryAttempts:
          params.maxDeliveryAttempts ?? DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS,
        dedupeKey: params.dedupeKey,
        data: params.data ? cloneJson(params.data) : undefined,
      };

      let events = [...currentQueue.events];
      let nextSequence = currentQueue.nextSequence;
      if (existingIndex >= 0) {
        events.splice(existingIndex, 1, baseEvent);
      } else {
        events.push(baseEvent);
        nextSequence += 1;
      }
      events.sort(compareWakeEvents);

      let deadLetters = [...currentQueue.deadLetters];
      while (events.length > DEFAULT_WAKE_QUEUE_MAX_EVENTS) {
        const overflow = events.shift();
        if (!overflow) break;
        deadLetters.push({
          event: overflow,
          failedAt: createdAt,
          reason: "wake_queue_overflow",
        });
      }

      const nextQueue: PersistedBackgroundRunWakeQueue = {
        version: AGENT_RUN_SCHEMA_VERSION,
        sessionId: params.sessionId,
        nextSequence,
        updatedAt: createdAt,
        events,
        deadLetters,
      };
      await this.memoryBackend.set(
        backgroundRunWakeQueueKey(params.sessionId),
        cloneJson(nextQueue),
      );
      return baseEvent;
    });
  }

  async deliverDueWakeEventsToRun(params: {
    sessionId: string;
    now?: number;
    limit?: number;
  }): Promise<DequeueBackgroundRunWakeEventsResult> {
    const now = params.now ?? Date.now();
    const limit = params.limit ?? 32;
    return this.queue.run(params.sessionId, async () => {
      const run = await this.loadRun(params.sessionId);
      const currentQueue = await this.loadWakeQueue(params.sessionId);
      if (!run) {
        return {
          run: undefined,
          deliveredSignals: [],
          remainingQueuedEvents: currentQueue.events.length,
          nextAvailableAt: currentQueue.events[0]?.availableAt,
        };
      }

      const existingSignalIds = new Set(run.pendingSignals.map((signal) => signal.id));
      const deliverableEvents: BackgroundRunWakeEvent[] = [];
      const deadLetters = [...currentQueue.deadLetters];
      const remainingEvents: BackgroundRunWakeEvent[] = [];

      for (const event of currentQueue.events) {
        if (event.availableAt > now) {
          remainingEvents.push(event);
          continue;
        }
        if (deliverableEvents.length >= limit) {
          remainingEvents.push(event);
          continue;
        }
        if (existingSignalIds.has(event.id)) {
          continue;
        }
        if (event.deliveryCount + 1 >= event.maxDeliveryAttempts) {
          deadLetters.push({
            event: {
              ...event,
              deliveryCount: event.deliveryCount + 1,
            },
            failedAt: now,
            reason: "wake_delivery_attempts_exhausted",
          });
          continue;
        }
        deliverableEvents.push({
          ...event,
          deliveryCount: event.deliveryCount + 1,
        });
      }

      const nextRun =
        deliverableEvents.length > 0
          ? coerceRun({
              ...run,
              updatedAt: now,
              pendingSignals: [
                ...run.pendingSignals,
                ...deliverableEvents
                  .filter(
                    (event): event is BackgroundRunWakeEvent & {
                      type: Exclude<
                        BackgroundRunWakeReason,
                        "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
                      >;
                    } =>
                      event.type !== "start" &&
                      event.type !== "timer" &&
                      event.type !== "busy_retry" &&
                      event.type !== "recovery" &&
                      event.type !== "daemon_shutdown",
                  )
                  .map((event) => ({
                    id: event.id,
                    type: event.type,
                    content: event.content,
                    timestamp: event.createdAt,
                    data: event.data,
                  })),
              ],
            })
          : run;
      if (!nextRun) {
        throw new Error("Invalid BackgroundRun record after wake delivery");
      }
      const nextQueue: PersistedBackgroundRunWakeQueue = {
        version: AGENT_RUN_SCHEMA_VERSION,
        sessionId: params.sessionId,
        nextSequence: currentQueue.nextSequence,
        updatedAt: now,
        events: remainingEvents,
        deadLetters,
      };
      await this.memoryBackend.set(
        backgroundRunKey(params.sessionId),
        cloneJson(nextRun),
      );
      await this.memoryBackend.set(
        backgroundRunWakeQueueKey(params.sessionId),
        cloneJson(nextQueue),
      );
      return {
        run: nextRun,
        deliveredSignals:
          deliverableEvents
            .filter(
              (event): event is BackgroundRunWakeEvent & {
                type: Exclude<
                  BackgroundRunWakeReason,
                  "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
                >;
              } =>
                event.type !== "start" &&
                event.type !== "timer" &&
                event.type !== "busy_retry" &&
                event.type !== "recovery" &&
                event.type !== "daemon_shutdown",
            )
            .map((event) => ({
              id: event.id,
              type: event.type,
              content: event.content,
              timestamp: event.createdAt,
              data: event.data,
            })),
        remainingQueuedEvents: remainingEvents.length,
        nextAvailableAt: remainingEvents[0]?.availableAt,
      };
    });
  }

  async garbageCollect(
    options: BackgroundRunGarbageCollectOptions = {},
  ): Promise<BackgroundRunGarbageCollectResult> {
    const now = options.now ?? Date.now();
    const terminalSnapshotRetentionMs =
      options.terminalSnapshotRetentionMs ?? DEFAULT_TERMINAL_SNAPSHOT_RETENTION_MS;
    const corruptRecordRetentionMs =
      options.corruptRecordRetentionMs ?? DEFAULT_CORRUPT_RECORD_RETENTION_MS;
    const wakeDeadLetterRetentionMs =
      options.wakeDeadLetterRetentionMs ?? DEFAULT_WAKE_DEAD_LETTER_RETENTION_MS;
    let releasedExpiredLeases = 0;
    let deletedTerminalSnapshots = 0;
    let deletedCorruptRecords = 0;
    let deletedWakeDeadLetters = 0;

    const runKeys = await this.memoryBackend.listKeys(BACKGROUND_RUN_KEY_PREFIX);
    for (const key of runKeys) {
      const sessionId = key.slice(BACKGROUND_RUN_KEY_PREFIX.length);
      const run = await this.loadRun(sessionId);
      if (!run) continue;
      if (
        run.leaseOwnerId &&
        typeof run.leaseExpiresAt === "number" &&
        run.leaseExpiresAt <= now
      ) {
        await this.memoryBackend.set(key, cloneJson({
          ...run,
          updatedAt: now,
          leaseOwnerId: undefined,
          leaseExpiresAt: undefined,
        }));
        releasedExpiredLeases += 1;
      }
    }

    const recentKeys = await this.memoryBackend.listKeys(BACKGROUND_RUN_RECENT_KEY_PREFIX);
    for (const key of recentKeys) {
      const sessionId = key.slice(BACKGROUND_RUN_RECENT_KEY_PREFIX.length);
      const snapshot = await this.loadRecentSnapshot(sessionId);
      if (!snapshot) continue;
      if (
        (
          snapshot.state === "completed" ||
          snapshot.state === "failed" ||
          snapshot.state === "cancelled"
        ) &&
        snapshot.updatedAt + terminalSnapshotRetentionMs <= now
      ) {
        await this.memoryBackend.delete(key);
        deletedTerminalSnapshots += 1;
      }
    }

    const corruptKeys = await this.listCorruptRunKeys();
    for (const key of corruptKeys) {
      const record = await this.memoryBackend.get<Record<string, unknown>>(key);
      const quarantinedAt =
        record && typeof record.quarantinedAt === "number"
          ? record.quarantinedAt
          : undefined;
      if (
        quarantinedAt !== undefined &&
        quarantinedAt + corruptRecordRetentionMs <= now
      ) {
        await this.memoryBackend.delete(key);
        deletedCorruptRecords += 1;
      }
    }

    const wakeQueueKeys = await this.memoryBackend.listKeys(
      BACKGROUND_RUN_WAKE_QUEUE_KEY_PREFIX,
    );
    for (const key of wakeQueueKeys) {
      const sessionId = key.slice(BACKGROUND_RUN_WAKE_QUEUE_KEY_PREFIX.length);
      const wakeQueue = await this.loadWakeQueue(sessionId);
      const retainedDeadLetters = wakeQueue.deadLetters.filter(
        (deadLetter) => deadLetter.failedAt + wakeDeadLetterRetentionMs > now,
      );
      if (retainedDeadLetters.length === wakeQueue.deadLetters.length) {
        continue;
      }
      deletedWakeDeadLetters +=
        wakeQueue.deadLetters.length - retainedDeadLetters.length;
      await this.memoryBackend.set(key, cloneJson({
        ...wakeQueue,
        updatedAt: now,
        deadLetters: retainedDeadLetters,
      }));
    }

    return {
      releasedExpiredLeases,
      deletedTerminalSnapshots,
      deletedCorruptRecords,
      deletedWakeDeadLetters,
    };
  }

  async listEvents(runId: string, limit?: number): Promise<readonly MemoryEntry[]> {
    return this.memoryBackend.getThread(backgroundRunEventSessionId(runId), limit);
  }

  async appendEvent(
    run: Pick<PersistedBackgroundRun, "id" | "sessionId">,
    event: BackgroundRunEvent,
  ): Promise<void> {
    await this.queue.run(run.sessionId, async () => {
      await this.memoryBackend.addEntry({
        sessionId: backgroundRunEventSessionId(run.id),
        role: "system",
        content: event.summary,
        metadata: {
          backgroundRunSessionId: run.sessionId,
          backgroundRunId: run.id,
          eventType: event.type,
          ...event.data,
        },
      });
    });
  }

  async claimLease(
    sessionId: string,
    instanceId: string,
    now = Date.now(),
  ): Promise<BackgroundRunLeaseResult> {
    return this.queue.run(sessionId, async () => {
      const current = await this.loadRun(sessionId);
      if (!current) return { claimed: false };
      const leaseIsActive =
        current.leaseOwnerId &&
        current.leaseOwnerId !== instanceId &&
        typeof current.leaseExpiresAt === "number" &&
        current.leaseExpiresAt > now;
      if (leaseIsActive) {
        return { claimed: false, run: current };
      }
      const claimed: PersistedBackgroundRun = {
        ...current,
        updatedAt: now,
        fenceToken: current.fenceToken + 1,
        leaseOwnerId: instanceId,
        leaseExpiresAt: now + this.leaseDurationMs,
      };
      const validated = coerceRun(claimed);
      if (!validated) {
        throw new Error("Invalid persisted BackgroundRun lease claim");
      }
      await this.memoryBackend.set(
        backgroundRunKey(sessionId),
        cloneJson(validated),
      );
      return { claimed: true, run: validated };
    });
  }

  async renewLease(
    run: PersistedBackgroundRun,
    instanceId: string,
    now = Date.now(),
  ): Promise<PersistedBackgroundRun | undefined> {
    const result = await this.claimLease(run.sessionId, instanceId, now);
    return result.claimed ? result.run : undefined;
  }

  async releaseLease(
    sessionId: string,
    instanceId: string,
    now = Date.now(),
    updates?: Partial<PersistedBackgroundRun>,
  ): Promise<PersistedBackgroundRun | undefined> {
    return this.queue.run(sessionId, async () => {
      const current = await this.loadRun(sessionId);
      if (!current) return undefined;
      if (current.leaseOwnerId && current.leaseOwnerId !== instanceId) {
        return current;
      }
      const next: PersistedBackgroundRun = {
        ...current,
        ...updates,
        updatedAt: now,
        leaseOwnerId: undefined,
        leaseExpiresAt: undefined,
      };
      const validated = coerceRun(next);
      if (!validated) {
        throw new Error("Invalid persisted BackgroundRun lease release");
      }
      await this.memoryBackend.set(
        backgroundRunKey(sessionId),
        cloneJson(validated),
      );
      return validated;
    });
  }
}
