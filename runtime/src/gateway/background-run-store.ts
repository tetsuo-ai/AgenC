import type { LLMMessage } from "../llm/types.js";
import type { MemoryBackend, MemoryEntry } from "../memory/types.js";
import type { PolicyEvaluationScope } from "../policy/types.js";
import type { BackgroundRunLineage } from "./subrun-contract.js";
import {
  assertValidBackgroundRunLineage,
  isSubrunJoinStrategy,
  isSubrunRedundancyPattern,
  isSubrunRole,
} from "./subrun-contract.js";
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
const BACKGROUND_RUN_CHECKPOINT_KEY_PREFIX = "background-run:checkpoint:session:";
const BACKGROUND_RUN_EVENT_SESSION_PREFIX = "background-run:";
const BACKGROUND_RUN_CORRUPT_KEY_PREFIX = "background-run:corrupt:";
const BACKGROUND_RUN_WAKE_QUEUE_KEY_PREFIX = "background-run:wake-queue:session:";
const BACKGROUND_RUN_DISPATCH_QUEUE_KEY = "background-run:dispatch-queue";
const BACKGROUND_RUN_DISPATCH_BEACON_KEY = "background-run:dispatch-beacon";
const BACKGROUND_RUN_WORKER_REGISTRY_KEY = "background-run:workers";
const BACKGROUND_RUN_DISPATCH_LOCK_KEY = "__background-run-dispatch__";
const BACKGROUND_RUN_WORKER_REGISTRY_LOCK_KEY = "__background-run-workers__";
const DEFAULT_LEASE_DURATION_MS = 45_000;
const DEFAULT_DISPATCH_CLAIM_DURATION_MS = 45_000;
export const DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_BACKGROUND_RUN_MAX_CYCLES = 512;
export const DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS = 60 * 60_000;
const DEFAULT_CYCLE_BUDGET_INTERVAL_FLOOR_MS = 30_000;
const DEFAULT_CYCLE_BUDGET_HEADROOM_MULTIPLIER = 2;
const DEFAULT_TERMINAL_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CORRUPT_RECORD_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_WAKE_DEAD_LETTER_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_DISPATCH_DEAD_LETTER_RETENTION_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS = 3;
const DEFAULT_WAKE_QUEUE_MAX_EVENTS = 256;
const DEFAULT_DISPATCH_QUEUE_MAX_ITEMS = 512;
const DEFAULT_WORKER_HEARTBEAT_TTL_MS = 20_000;

export type BackgroundRunKind = AgentRunKind;
export type BackgroundRunState = AgentRunState;
export type BackgroundRunContract = AgentRunContract;
export type BackgroundRunManagedProcessPolicy = AgentRunManagedProcessPolicy;

export function deriveDefaultBackgroundRunMaxCycles(params?: {
  readonly maxRuntimeMs?: number;
  readonly nextCheckMs?: number;
}): number {
  const maxRuntimeMs = params?.maxRuntimeMs ?? DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS;
  const requestedCadenceMs =
    typeof params?.nextCheckMs === "number" && params.nextCheckMs > 0
      ? params.nextCheckMs
      : DEFAULT_CYCLE_BUDGET_INTERVAL_FLOOR_MS;
  const budgetCadenceMs = Math.max(
    requestedCadenceMs,
    DEFAULT_CYCLE_BUDGET_INTERVAL_FLOOR_MS,
  );
  const runtimeScaledCycles =
    Math.ceil(maxRuntimeMs / budgetCadenceMs) *
    DEFAULT_CYCLE_BUDGET_HEADROOM_MULTIPLIER;
  return Math.max(DEFAULT_BACKGROUND_RUN_MAX_CYCLES, runtimeScaledCycles);
}

export type BackgroundRunWorkerPool =
  | "generic"
  | "browser"
  | "desktop"
  | "code"
  | "research"
  | "approval"
  | "remote_mcp";

export interface BackgroundRunManagedProcessLaunchSpec {
  readonly kind?: "process" | "server";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
  readonly logPath?: string;
  readonly idempotencyKey?: string;
  readonly healthUrl?: string;
  readonly host?: string;
  readonly port?: number;
  readonly protocol?: "http" | "https";
  readonly readyStatusCodes?: readonly number[];
  readonly readinessTimeoutMs?: number;
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
  readonly serverId?: string;
  readonly surface?: "desktop" | "host" | "host_server";
  readonly pid?: number;
  readonly pgid?: number;
  readonly desiredState: "running" | "exited";
  readonly exitPolicy: "until_exit" | "keep_running" | "restart_on_exit";
  readonly currentState: "running" | "exited";
  readonly ready?: boolean;
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
  readonly totalTokens: number;
  readonly lastCycleTokens: number;
  readonly managedProcessCount: number;
  readonly maxRuntimeMs: number;
  readonly maxCycles: number;
  readonly maxIdleMs?: number;
  readonly nextCheckIntervalMs: number;
  readonly heartbeatIntervalMs?: number;
  readonly firstAcknowledgedAt?: number;
  readonly firstVerifiedUpdateAt?: number;
  readonly stopRequestedAt?: number;
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
  readonly policyScope?: PolicyEvaluationScope;
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
  readonly preferredWorkerId?: string;
  readonly workerAffinityKey?: string;
}

export interface PersistedBackgroundRun {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly policyScope?: PolicyEvaluationScope;
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
  readonly lineage?: BackgroundRunLineage;
  readonly fenceToken: number;
  readonly preferredWorkerId?: string;
  readonly workerAffinityKey?: string;
  readonly leaseOwnerId?: string;
  readonly leaseExpiresAt?: number;
}

export interface BackgroundRunDispatchItem {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly pool: BackgroundRunWorkerPool;
  readonly reason:
    | BackgroundRunWakeReason
    | "resume"
    | "heartbeat"
    | "recovery"
    | "admission_retry";
  readonly priority: number;
  readonly enqueuedAt: number;
  readonly availableAt: number;
  readonly sequence: number;
  readonly deliveryCount: number;
  readonly maxDeliveryAttempts: number;
  readonly dedupeKey?: string;
  readonly preferredWorkerId?: string;
  readonly affinityKey?: string;
  readonly claimOwnerId?: string;
  readonly claimExpiresAt?: number;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunDispatchDeadLetter {
  readonly item: BackgroundRunDispatchItem;
  readonly failedAt: number;
  readonly reason: string;
}

export interface PersistedBackgroundRunDispatchQueue {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly nextSequence: number;
  readonly updatedAt: number;
  readonly items: readonly BackgroundRunDispatchItem[];
  readonly deadLetters: readonly BackgroundRunDispatchDeadLetter[];
}

export interface PersistedBackgroundRunDispatchBeacon {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly revision: number;
  readonly updatedAt: number;
  readonly queueDepth: number;
  readonly nextAvailableAt?: number;
}

export class BackgroundRunFenceConflictError extends Error {
  readonly attemptedFenceToken: number;
  readonly currentFenceToken: number;

  constructor(params: {
    attemptedFenceToken: number;
    currentFenceToken: number;
  }) {
    super(
      `Stale BackgroundRun fence token ${params.attemptedFenceToken}; current token is ${params.currentFenceToken}`,
    );
    this.name = "BackgroundRunFenceConflictError";
    this.attemptedFenceToken = params.attemptedFenceToken;
    this.currentFenceToken = params.currentFenceToken;
  }
}

export function isBackgroundRunFenceConflictError(
  error: unknown,
): error is BackgroundRunFenceConflictError {
  return error instanceof BackgroundRunFenceConflictError;
}

export interface BackgroundRunWorkerRecord {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly workerId: string;
  readonly pools: readonly BackgroundRunWorkerPool[];
  readonly state: "active" | "draining";
  readonly registeredAt: number;
  readonly lastHeartbeatAt: number;
  readonly heartbeatTtlMs: number;
  readonly maxConcurrentRuns: number;
  readonly inFlightRuns: number;
  readonly currentSessionIds: readonly string[];
  readonly affinityKeys: readonly string[];
}

export interface PersistedBackgroundRunWorkerRegistry {
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  readonly updatedAt: number;
  readonly workers: readonly BackgroundRunWorkerRecord[];
}

export type BackgroundRunEventType =
  | "run_recovered"
  | "run_started"
  | "run_signalled"
  | "run_paused"
  | "run_resumed"
  | "run_cancelled"
  | "run_suspended"
  | "run_objective_updated"
  | "run_contract_amended"
  | "run_budget_adjusted"
  | "run_compaction_forced"
  | "run_worker_reassigned"
  | "run_retried"
  | "run_verification_overridden"
  | "cycle_started"
  | "cycle_working"
  | "decision"
  | "memory_compacted"
  | "user_update"
  | "run_blocked"
  | "run_completed"
  | "run_failed"
  | "subrun_spawned"
  | "subrun_joined"
  | "subrun_failed_attribution";

export interface BackgroundRunEvent {
  readonly type: BackgroundRunEventType;
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
  readonly dispatchDeadLetterRetentionMs?: number;
}

export interface BackgroundRunGarbageCollectResult {
  readonly releasedExpiredLeases: number;
  readonly deletedTerminalSnapshots: number;
  readonly deletedCorruptRecords: number;
  readonly deletedWakeDeadLetters: number;
  readonly deletedDispatchDeadLetters: number;
  readonly deletedStaleWorkers: number;
  readonly releasedExpiredDispatchClaims: number;
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

export interface EnqueueBackgroundRunDispatchParams {
  readonly sessionId: string;
  readonly runId?: string;
  readonly pool: BackgroundRunWorkerPool;
  readonly reason:
    | BackgroundRunWakeReason
    | "resume"
    | "heartbeat"
    | "recovery"
    | "admission_retry";
  readonly createdAt?: number;
  readonly availableAt?: number;
  readonly priority?: number;
  readonly maxDeliveryAttempts?: number;
  readonly dedupeKey?: string;
  readonly preferredWorkerId?: string;
  readonly affinityKey?: string;
  readonly data?: Record<string, unknown>;
}

export interface BackgroundRunDispatchClaimResult {
  readonly claimed: boolean;
  readonly item?: BackgroundRunDispatchItem;
  readonly queueDepth: number;
}

export interface BackgroundRunPruneDispatchResult {
  readonly removedCount: number;
  readonly queueDepth: number;
}

export interface BackgroundRunDispatchStats {
  readonly totalQueued: number;
  readonly totalClaimed: number;
  readonly queuedByPool: Record<BackgroundRunWorkerPool, number>;
  readonly claimedByPool: Record<BackgroundRunWorkerPool, number>;
}

export interface BackgroundRunStoreConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly leaseDurationMs?: number;
  readonly dispatchClaimDurationMs?: number;
  readonly workerHeartbeatTtlMs?: number;
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

function backgroundRunCheckpointKey(sessionId: string): string {
  return `${BACKGROUND_RUN_CHECKPOINT_KEY_PREFIX}${sessionId}`;
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

function coerceHttpStatusCodes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const codes = value.filter(
    (item): item is number =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 100 &&
      item <= 599,
  );
  return codes.length > 0 ? [...new Set(codes)] : undefined;
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
    kind: raw.kind === "process" || raw.kind === "server" ? raw.kind : undefined,
    command: raw.command,
    args,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    logPath: typeof raw.logPath === "string" ? raw.logPath : undefined,
    idempotencyKey:
      typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : undefined,
    healthUrl: typeof raw.healthUrl === "string" ? raw.healthUrl : undefined,
    host: typeof raw.host === "string" ? raw.host : undefined,
    port: coercePositiveInteger(raw.port),
    protocol:
      raw.protocol === "http" || raw.protocol === "https"
        ? raw.protocol
        : undefined,
    readyStatusCodes: coerceHttpStatusCodes(raw.readyStatusCodes),
    readinessTimeoutMs: coercePositiveInteger(raw.readinessTimeoutMs),
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

function isBackgroundRunWorkerPool(value: unknown): value is BackgroundRunWorkerPool {
  return (
    value === "generic" ||
    value === "browser" ||
    value === "desktop" ||
    value === "code" ||
    value === "research" ||
    value === "approval" ||
    value === "remote_mcp"
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

function buildDefaultDispatchQueue(now: number): PersistedBackgroundRunDispatchQueue {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    nextSequence: 0,
    updatedAt: now,
    items: [],
    deadLetters: [],
  };
}

function buildDispatchBeacon(
  queue: PersistedBackgroundRunDispatchQueue,
  revision: number,
): PersistedBackgroundRunDispatchBeacon {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    revision,
    updatedAt: queue.updatedAt,
    queueDepth: queue.items.length,
    nextAvailableAt: queue.items[0]?.availableAt,
  };
}

function buildDefaultDispatchBeacon(now: number): PersistedBackgroundRunDispatchBeacon {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    queueDepth: 0,
  };
}

function buildDefaultWorkerRegistry(now: number): PersistedBackgroundRunWorkerRegistry {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    updatedAt: now,
    workers: [],
  };
}

function buildActiveWorkerMap(
  registry: PersistedBackgroundRunWorkerRegistry,
  now: number,
): ReadonlyMap<string, BackgroundRunWorkerRecord> {
  return new Map(
    registry.workers
      .filter(
        (entry) =>
          entry.state === "active" &&
          entry.lastHeartbeatAt + entry.heartbeatTtlMs > now,
      )
      .map((entry) => [entry.workerId, entry] as const),
  );
}

function dispatchPriority(
  item: Pick<BackgroundRunDispatchItem, "reason" | "priority">,
): number {
  switch (item.reason) {
    case "approval":
      return 0;
    case "resume":
      return 1;
    case "user_input":
      return 2;
    case "process_exit":
      return 3;
    case "tool_result":
      return 4;
    case "webhook":
      return 5;
    case "external_event":
      return 6;
    case "heartbeat":
      return 7;
    case "start":
      return 8;
    case "recovery":
      return 9;
    case "timer":
      return 10;
    case "busy_retry":
      return 11;
    case "admission_retry":
      return 12;
    case "daemon_shutdown":
      return 13;
  }
}

function compareDispatchItems(
  left: BackgroundRunDispatchItem,
  right: BackgroundRunDispatchItem,
): number {
  return (
    left.availableAt - right.availableAt ||
    dispatchPriority(left) - dispatchPriority(right) ||
    left.priority - right.priority ||
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

function coerceDispatchItem(value: unknown): BackgroundRunDispatchItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const reason = raw.reason;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.id !== "string" ||
    typeof raw.sessionId !== "string" ||
    typeof raw.sequence !== "number" ||
    typeof raw.enqueuedAt !== "number" ||
    typeof raw.availableAt !== "number" ||
    typeof raw.deliveryCount !== "number" ||
    typeof raw.priority !== "number" ||
    !isBackgroundRunWorkerPool(raw.pool) ||
    !(
      isAgentRunWakeReason(reason) ||
      reason === "resume" ||
      reason === "heartbeat" ||
      reason === "recovery" ||
      reason === "admission_retry"
    )
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: raw.id,
    sessionId: raw.sessionId,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    pool: raw.pool,
    reason,
    priority: raw.priority,
    enqueuedAt: raw.enqueuedAt,
    availableAt: raw.availableAt,
    sequence: raw.sequence,
    deliveryCount: raw.deliveryCount,
    maxDeliveryAttempts:
      coercePositiveInteger(raw.maxDeliveryAttempts) ??
      DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS,
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : undefined,
    preferredWorkerId:
      typeof raw.preferredWorkerId === "string"
        ? raw.preferredWorkerId
        : undefined,
    affinityKey:
      typeof raw.affinityKey === "string" ? raw.affinityKey : undefined,
    claimOwnerId:
      typeof raw.claimOwnerId === "string" ? raw.claimOwnerId : undefined,
    claimExpiresAt:
      typeof raw.claimExpiresAt === "number" ? raw.claimExpiresAt : undefined,
    data:
      raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? cloneJson(raw.data as Record<string, unknown>)
        : undefined,
  };
}

function coerceDispatchDeadLetter(
  value: unknown,
): BackgroundRunDispatchDeadLetter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const item = coerceDispatchItem(raw.item);
  if (!item || typeof raw.failedAt !== "number" || typeof raw.reason !== "string") {
    return undefined;
  }
  return {
    item,
    failedAt: raw.failedAt,
    reason: raw.reason,
  };
}

function coerceDispatchQueue(
  value: unknown,
): PersistedBackgroundRunDispatchQueue | undefined {
  if (value === undefined) {
    return buildDefaultDispatchQueue(Date.now());
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.nextSequence !== "number" ||
    typeof raw.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    nextSequence: raw.nextSequence,
    updatedAt: raw.updatedAt,
    items: Array.isArray(raw.items)
      ? raw.items
          .map((item) => coerceDispatchItem(item))
          .filter((item): item is BackgroundRunDispatchItem => item !== undefined)
          .sort(compareDispatchItems)
      : [],
    deadLetters: Array.isArray(raw.deadLetters)
      ? raw.deadLetters
          .map((item) => coerceDispatchDeadLetter(item))
          .filter(
            (item): item is BackgroundRunDispatchDeadLetter => item !== undefined,
          )
      : [],
  };
}

function coerceDispatchBeacon(
  value: unknown,
): PersistedBackgroundRunDispatchBeacon | undefined {
  if (value === undefined) {
    return buildDefaultDispatchBeacon(Date.now());
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.revision !== "number" ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.queueDepth !== "number"
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    revision: raw.revision,
    updatedAt: raw.updatedAt,
    queueDepth: raw.queueDepth,
    nextAvailableAt:
      typeof raw.nextAvailableAt === "number" ? raw.nextAvailableAt : undefined,
  };
}

function coerceWorkerRecord(value: unknown): BackgroundRunWorkerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.workerId !== "string" ||
    (raw.state !== "active" && raw.state !== "draining") ||
    typeof raw.registeredAt !== "number" ||
    typeof raw.lastHeartbeatAt !== "number"
  ) {
    return undefined;
  }
  const pools = Array.isArray(raw.pools)
    ? raw.pools.filter((pool): pool is BackgroundRunWorkerPool =>
        isBackgroundRunWorkerPool(pool),
      )
    : [];
  if (pools.length === 0) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    workerId: raw.workerId,
    pools,
    state: raw.state,
    registeredAt: raw.registeredAt,
    lastHeartbeatAt: raw.lastHeartbeatAt,
    heartbeatTtlMs:
      coercePositiveInteger(raw.heartbeatTtlMs) ?? DEFAULT_WORKER_HEARTBEAT_TTL_MS,
    maxConcurrentRuns: coercePositiveInteger(raw.maxConcurrentRuns) ?? 1,
    inFlightRuns: coerceNonNegativeInteger(raw.inFlightRuns) ?? 0,
    currentSessionIds: normalizeStringArray(raw.currentSessionIds),
    affinityKeys: normalizeStringArray(raw.affinityKeys),
  };
}

function coerceWorkerRegistry(
  value: unknown,
): PersistedBackgroundRunWorkerRegistry | undefined {
  if (value === undefined) {
    return buildDefaultWorkerRegistry(Date.now());
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== AGENT_RUN_SCHEMA_VERSION) ||
    typeof raw.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    updatedAt: raw.updatedAt,
    workers: Array.isArray(raw.workers)
      ? raw.workers
          .map((item) => coerceWorkerRecord(item))
          .filter((item): item is BackgroundRunWorkerRecord => item !== undefined)
      : [],
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
    serverId: typeof raw.serverId === "string" ? raw.serverId : undefined,
    surface:
      raw.surface === "desktop" ||
      raw.surface === "host" ||
      raw.surface === "host_server"
        ? raw.surface
        : undefined,
    pid: typeof raw.pid === "number" ? raw.pid : undefined,
    pgid: typeof raw.pgid === "number" ? raw.pgid : undefined,
    desiredState: raw.desiredState,
    exitPolicy: raw.exitPolicy,
    currentState: raw.currentState,
    ready: typeof raw.ready === "boolean" ? raw.ready : undefined,
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
    totalTokens: 0,
    lastCycleTokens: 0,
    managedProcessCount: 0,
    maxRuntimeMs: DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
    maxCycles: deriveDefaultBackgroundRunMaxCycles({
      maxRuntimeMs: DEFAULT_BACKGROUND_RUN_MAX_RUNTIME_MS,
      nextCheckMs: params.contract.nextCheckMs,
    }),
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
    totalTokens:
      coerceNonNegativeInteger(raw.totalTokens) ?? defaults.totalTokens,
    lastCycleTokens:
      coerceNonNegativeInteger(raw.lastCycleTokens) ?? defaults.lastCycleTokens,
    managedProcessCount:
      coerceNonNegativeInteger(raw.managedProcessCount) ??
      defaults.managedProcessCount,
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
    firstAcknowledgedAt:
      typeof raw.firstAcknowledgedAt === "number"
        ? raw.firstAcknowledgedAt
        : defaults.firstAcknowledgedAt,
    firstVerifiedUpdateAt:
      typeof raw.firstVerifiedUpdateAt === "number"
        ? raw.firstVerifiedUpdateAt
        : defaults.firstVerifiedUpdateAt,
    stopRequestedAt:
      typeof raw.stopRequestedAt === "number"
        ? raw.stopRequestedAt
        : defaults.stopRequestedAt,
  };
}

function coercePolicyScope(
  value: unknown,
): PolicyEvaluationScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const tenantId =
    typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
      ? raw.tenantId.trim()
      : undefined;
  const projectId =
    typeof raw.projectId === "string" && raw.projectId.trim().length > 0
      ? raw.projectId.trim()
      : undefined;
  const runId =
    typeof raw.runId === "string" && raw.runId.trim().length > 0
      ? raw.runId.trim()
      : undefined;
  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0
      ? raw.sessionId.trim()
      : undefined;
  const channel =
    typeof raw.channel === "string" && raw.channel.trim().length > 0
      ? raw.channel.trim()
      : undefined;
  if (!tenantId && !projectId && !runId && !sessionId && !channel) {
    return undefined;
  }
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(channel ? { channel } : {}),
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
    policyScope: coercePolicyScope(raw.policyScope),
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
    preferredWorkerId:
      typeof raw.preferredWorkerId === "string"
        ? raw.preferredWorkerId
        : undefined,
    workerAffinityKey:
      typeof raw.workerAffinityKey === "string"
        ? raw.workerAffinityKey
        : undefined,
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

function coerceRunLineage(value: unknown): BackgroundRunLineage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const scope = raw.scope && typeof raw.scope === "object"
    ? raw.scope as Record<string, unknown>
    : undefined;
  const artifactContract =
    raw.artifactContract && typeof raw.artifactContract === "object"
      ? raw.artifactContract as Record<string, unknown>
      : undefined;
  const budget = raw.budget && typeof raw.budget === "object"
    ? raw.budget as Record<string, unknown>
    : undefined;
  const lineage: BackgroundRunLineage = {
    rootRunId: typeof raw.rootRunId === "string" ? raw.rootRunId : "",
    parentRunId:
      typeof raw.parentRunId === "string" ? raw.parentRunId : undefined,
    role: isSubrunRole(raw.role) ? raw.role : "worker",
    depth:
      typeof raw.depth === "number" && Number.isInteger(raw.depth) ? raw.depth : -1,
    joinStrategy: isSubrunJoinStrategy(raw.joinStrategy)
      ? raw.joinStrategy
      : undefined,
    redundancyPattern: isSubrunRedundancyPattern(raw.redundancyPattern)
      ? raw.redundancyPattern
      : undefined,
    scope: {
      allowedTools: Array.isArray(scope?.allowedTools)
        ? scope.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : [],
      allowedWriteRoots: Array.isArray(scope?.allowedWriteRoots)
        ? scope.allowedWriteRoots.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      allowedHosts: Array.isArray(scope?.allowedHosts)
        ? scope.allowedHosts.filter((entry): entry is string => typeof entry === "string")
        : undefined,
    },
    artifactContract: {
      requiredKinds: Array.isArray(artifactContract?.requiredKinds)
        ? artifactContract.requiredKinds.filter(
          (kind): kind is BackgroundRunArtifactRef["kind"] =>
            kind === "file" ||
            kind === "url" ||
            kind === "log" ||
            kind === "process" ||
            kind === "download" ||
            kind === "opaque_provider_state",
        )
        : [],
      minArtifactCount:
        typeof artifactContract?.minArtifactCount === "number"
          ? artifactContract.minArtifactCount
          : undefined,
      summaryRequired:
        typeof artifactContract?.summaryRequired === "boolean"
          ? artifactContract.summaryRequired
          : undefined,
    },
    budget: {
      maxRuntimeMs:
        typeof budget?.maxRuntimeMs === "number" ? budget.maxRuntimeMs : 0,
      maxTokens:
        typeof budget?.maxTokens === "number" ? budget.maxTokens : undefined,
      maxToolCalls:
        typeof budget?.maxToolCalls === "number" ? budget.maxToolCalls : undefined,
      maxChildren:
        typeof budget?.maxChildren === "number" ? budget.maxChildren : undefined,
    },
    childRunIds: Array.isArray(raw.childRunIds)
      ? raw.childRunIds.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
  try {
    assertValidBackgroundRunLineage(lineage);
    return lineage;
  } catch {
    return undefined;
  }
}

function coerceRun(value: unknown): PersistedBackgroundRun | undefined {
  const core = coerceRunCore(value);
  if (!core) return undefined;
  const { raw, contract, carryForward, pendingSignals, observedTargets } = core;
  const id = raw.id as string;
  const sessionId = raw.sessionId as string;
  const objective = raw.objective as string;
  const policyScope = coercePolicyScope(raw.policyScope);
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
    policyScope,
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
    lineage: coerceRunLineage(raw.lineage),
    fenceToken: durableState.fenceToken,
    preferredWorkerId:
      typeof raw.preferredWorkerId === "string"
        ? raw.preferredWorkerId
        : undefined,
    workerAffinityKey:
      typeof raw.workerAffinityKey === "string"
        ? raw.workerAffinityKey
        : undefined,
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
  private readonly dispatchClaimDurationMs: number;
  private readonly workerHeartbeatTtlMs: number;
  private readonly queue: KeyedAsyncQueue;

  constructor(config: BackgroundRunStoreConfig) {
    this.memoryBackend = config.memoryBackend;
    this.logger = config.logger ?? silentLogger;
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.dispatchClaimDurationMs =
      config.dispatchClaimDurationMs ?? DEFAULT_DISPATCH_CLAIM_DURATION_MS;
    this.workerHeartbeatTtlMs =
      config.workerHeartbeatTtlMs ?? DEFAULT_WORKER_HEARTBEAT_TTL_MS;
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

  private async loadRawDispatchQueue(): Promise<unknown> {
    return this.memoryBackend.get(BACKGROUND_RUN_DISPATCH_QUEUE_KEY);
  }

  private async loadRawDispatchBeacon(): Promise<unknown> {
    return this.memoryBackend.get(BACKGROUND_RUN_DISPATCH_BEACON_KEY);
  }

  private async loadRawWorkerRegistry(): Promise<unknown> {
    return this.memoryBackend.get(BACKGROUND_RUN_WORKER_REGISTRY_KEY);
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
      if (current && validated.leaseOwnerId !== undefined) {
        if (current.fenceToken > validated.fenceToken) {
          throw new BackgroundRunFenceConflictError({
            attemptedFenceToken: validated.fenceToken,
            currentFenceToken: current.fenceToken,
          });
        }
        if (
          current.fenceToken < validated.fenceToken &&
          current.leaseOwnerId &&
          current.leaseOwnerId !== validated.leaseOwnerId
        ) {
          throw new Error(
            `BackgroundRun lease owner mismatch for forward fence write: attempted ${validated.leaseOwnerId}, current ${current.leaseOwnerId}`,
          );
        }
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
    await this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const queue = await this.loadDispatchQueue();
      const items = queue.items.filter((item) => item.sessionId !== sessionId);
      if (items.length === queue.items.length) {
        return;
      }
      await this.memoryBackend.set(
        BACKGROUND_RUN_DISPATCH_QUEUE_KEY,
        cloneJson({
          ...queue,
          updatedAt: Date.now(),
          items,
        } satisfies PersistedBackgroundRunDispatchQueue),
      );
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

  async saveCheckpoint(run: PersistedBackgroundRun): Promise<void> {
    const validated = coerceRun(run);
    if (!validated) {
      throw new Error("Invalid BackgroundRun checkpoint");
    }
    await this.queue.run(run.sessionId, async () => {
      await this.memoryBackend.set(
        backgroundRunCheckpointKey(run.sessionId),
        cloneJson(validated),
      );
    });
  }

  async loadCheckpoint(sessionId: string): Promise<PersistedBackgroundRun | undefined> {
    const value = await this.memoryBackend.get(backgroundRunCheckpointKey(sessionId));
    return coerceRun(value);
  }

  async listCheckpoints(): Promise<readonly PersistedBackgroundRun[]> {
    const keys = await this.memoryBackend.listKeys(
      BACKGROUND_RUN_CHECKPOINT_KEY_PREFIX,
    );
    const runs = await Promise.all(
      keys.map(async (key) => {
        const value = await this.memoryBackend.get(key);
        return coerceRun(value);
      }),
    );
    return runs
      .filter((run): run is PersistedBackgroundRun => run !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async deleteCheckpoint(sessionId: string): Promise<void> {
    await this.queue.run(sessionId, async () => {
      await this.memoryBackend.delete(backgroundRunCheckpointKey(sessionId));
    });
  }

  async listRecentSnapshots(): Promise<readonly BackgroundRunRecentSnapshot[]> {
    const keys = await this.memoryBackend.listKeys(BACKGROUND_RUN_RECENT_KEY_PREFIX);
    const snapshots = await Promise.all(
      keys.map(async (key) => {
        const value = await this.memoryBackend.get(key);
        return coerceRecentSnapshot(value);
      }),
    );
    return snapshots
      .filter((snapshot): snapshot is BackgroundRunRecentSnapshot => snapshot !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt);
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

  async loadDispatchQueue(): Promise<PersistedBackgroundRunDispatchQueue> {
    const value = await this.loadRawDispatchQueue();
    const queue = coerceDispatchQueue(value);
    if (!queue) {
      const rawValue = await this.loadRawDispatchQueue();
      const fallback = buildDefaultDispatchQueue(Date.now());
      await this.saveDispatchQueueAndBeacon(fallback, 0);
      this.logger.warn("Reset invalid background dispatch queue", {
        hadRawValue: rawValue !== undefined,
      });
      return fallback;
    }
    return queue;
  }

  async loadDispatchBeacon(): Promise<PersistedBackgroundRunDispatchBeacon> {
    const value = await this.loadRawDispatchBeacon();
    const beacon = coerceDispatchBeacon(value);
    if (!beacon) {
      const fallbackQueue = await this.loadDispatchQueue();
      const fallback = buildDispatchBeacon(fallbackQueue, 0);
      await this.memoryBackend.set(
        BACKGROUND_RUN_DISPATCH_BEACON_KEY,
        cloneJson(fallback),
      );
      this.logger.warn("Reset invalid background dispatch beacon", {
        hadRawValue: value !== undefined,
      });
      return fallback;
    }
    return beacon;
  }

  private async saveDispatchQueueAndBeacon(
    queue: PersistedBackgroundRunDispatchQueue,
    previousRevision?: number,
  ): Promise<PersistedBackgroundRunDispatchBeacon> {
    const currentBeacon =
      previousRevision !== undefined
        ? undefined
        : coerceDispatchBeacon(await this.loadRawDispatchBeacon());
    const revision = (previousRevision ?? currentBeacon?.revision ?? 0) + 1;
    const beacon = buildDispatchBeacon(queue, revision);
    await this.memoryBackend.set(
      BACKGROUND_RUN_DISPATCH_QUEUE_KEY,
      cloneJson(queue),
    );
    await this.memoryBackend.set(
      BACKGROUND_RUN_DISPATCH_BEACON_KEY,
      cloneJson(beacon),
    );
    return beacon;
  }

  async loadWorkerRegistry(): Promise<PersistedBackgroundRunWorkerRegistry> {
    const value = await this.loadRawWorkerRegistry();
    const registry = coerceWorkerRegistry(value);
    if (!registry) {
      const rawValue = await this.loadRawWorkerRegistry();
      await this.memoryBackend.set(
        BACKGROUND_RUN_WORKER_REGISTRY_KEY,
        buildDefaultWorkerRegistry(Date.now()),
      );
      this.logger.warn("Reset invalid background worker registry", {
        hadRawValue: rawValue !== undefined,
      });
      return buildDefaultWorkerRegistry(Date.now());
    }
    return registry;
  }

  async listWorkers(): Promise<readonly BackgroundRunWorkerRecord[]> {
    const registry = await this.loadWorkerRegistry();
    return registry.workers;
  }

  async heartbeatWorker(params: {
    workerId: string;
    pools: readonly BackgroundRunWorkerPool[];
    maxConcurrentRuns: number;
    state?: BackgroundRunWorkerRecord["state"];
    currentSessionIds?: readonly string[];
    affinityKeys?: readonly string[];
    now?: number;
  }): Promise<BackgroundRunWorkerRecord> {
    const now = params.now ?? Date.now();
    return this.queue.run(BACKGROUND_RUN_WORKER_REGISTRY_LOCK_KEY, async () => {
      const registry = await this.loadWorkerRegistry();
      const nextWorker: BackgroundRunWorkerRecord = {
        version: AGENT_RUN_SCHEMA_VERSION,
        workerId: params.workerId,
        pools: [...new Set(params.pools)].filter(isBackgroundRunWorkerPool),
        state: params.state ?? "active",
        registeredAt:
          registry.workers.find((worker) => worker.workerId === params.workerId)?.registeredAt ??
          now,
        lastHeartbeatAt: now,
        heartbeatTtlMs: this.workerHeartbeatTtlMs,
        maxConcurrentRuns: Math.max(1, Math.floor(params.maxConcurrentRuns)),
        inFlightRuns: params.currentSessionIds?.length ?? 0,
        currentSessionIds: params.currentSessionIds ? [...params.currentSessionIds] : [],
        affinityKeys: params.affinityKeys ? [...new Set(params.affinityKeys)] : [],
      };
      const workers = registry.workers.filter(
        (worker) => worker.workerId !== params.workerId,
      );
      workers.push(nextWorker);
      const nextRegistry: PersistedBackgroundRunWorkerRegistry = {
        version: AGENT_RUN_SCHEMA_VERSION,
        updatedAt: now,
        workers,
      };
      await this.memoryBackend.set(
        BACKGROUND_RUN_WORKER_REGISTRY_KEY,
        cloneJson(nextRegistry),
      );
      return nextWorker;
    });
  }

  async setWorkerDrainState(params: {
    workerId: string;
    draining: boolean;
    now?: number;
  }): Promise<BackgroundRunWorkerRecord | undefined> {
    const now = params.now ?? Date.now();
    return this.queue.run(BACKGROUND_RUN_WORKER_REGISTRY_LOCK_KEY, async () => {
      const registry = await this.loadWorkerRegistry();
      const existing = registry.workers.find(
        (worker) => worker.workerId === params.workerId,
      );
      if (!existing) {
        return undefined;
      }
      const nextWorker: BackgroundRunWorkerRecord = {
        ...existing,
        state: params.draining ? "draining" : "active",
        lastHeartbeatAt: now,
      };
      const workers = registry.workers.map((worker) =>
        worker.workerId === params.workerId ? nextWorker : worker,
      );
      await this.memoryBackend.set(
        BACKGROUND_RUN_WORKER_REGISTRY_KEY,
        cloneJson({
          version: AGENT_RUN_SCHEMA_VERSION,
          updatedAt: now,
          workers,
        } satisfies PersistedBackgroundRunWorkerRegistry),
      );
      return nextWorker;
    });
  }

  async removeWorker(workerId: string): Promise<void> {
    await this.queue.run(BACKGROUND_RUN_WORKER_REGISTRY_LOCK_KEY, async () => {
      const registry = await this.loadWorkerRegistry();
      const workers = registry.workers.filter((worker) => worker.workerId !== workerId);
      await this.memoryBackend.set(
        BACKGROUND_RUN_WORKER_REGISTRY_KEY,
        cloneJson({
          version: AGENT_RUN_SCHEMA_VERSION,
          updatedAt: Date.now(),
          workers,
        } satisfies PersistedBackgroundRunWorkerRegistry),
      );
    });
  }

  async enqueueDispatch(
    params: EnqueueBackgroundRunDispatchParams,
  ): Promise<BackgroundRunDispatchItem> {
    const createdAt = params.createdAt ?? Date.now();
    const availableAt = params.availableAt ?? createdAt;
    return this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const currentQueue = await this.loadDispatchQueue();
      const existingIndex =
        params.dedupeKey !== undefined
          ? currentQueue.items.findIndex((item) => item.dedupeKey === params.dedupeKey)
          : -1;
      const nextItem: BackgroundRunDispatchItem = {
        version: AGENT_RUN_SCHEMA_VERSION,
        id:
          existingIndex >= 0
            ? currentQueue.items[existingIndex]!.id
            : `dispatch-${createdAt.toString(36)}-${currentQueue.nextSequence.toString(36)}`,
        sessionId: params.sessionId,
        runId: params.runId,
        pool: params.pool,
        reason: params.reason,
        priority: params.priority ?? 0,
        enqueuedAt:
          existingIndex >= 0
            ? currentQueue.items[existingIndex]!.enqueuedAt
            : createdAt,
        availableAt,
        sequence:
          existingIndex >= 0
            ? currentQueue.items[existingIndex]!.sequence
            : currentQueue.nextSequence,
        deliveryCount:
          existingIndex >= 0
            ? currentQueue.items[existingIndex]!.deliveryCount
            : 0,
        maxDeliveryAttempts:
          params.maxDeliveryAttempts ?? DEFAULT_WAKE_EVENT_MAX_DELIVERY_ATTEMPTS,
        dedupeKey: params.dedupeKey,
        preferredWorkerId: params.preferredWorkerId,
        affinityKey: params.affinityKey,
        claimOwnerId:
          existingIndex >= 0 ? currentQueue.items[existingIndex]!.claimOwnerId : undefined,
        claimExpiresAt:
          existingIndex >= 0 ? currentQueue.items[existingIndex]!.claimExpiresAt : undefined,
        data: params.data ? cloneJson(params.data) : undefined,
      };

      let items = [...currentQueue.items];
      let nextSequence = currentQueue.nextSequence;
      if (existingIndex >= 0) {
        items.splice(existingIndex, 1, nextItem);
      } else {
        items.push(nextItem);
        nextSequence += 1;
      }
      items.sort(compareDispatchItems);

      const deadLetters = [...currentQueue.deadLetters];
      while (items.length > DEFAULT_DISPATCH_QUEUE_MAX_ITEMS) {
        const overflow = items.pop();
        if (!overflow) break;
        deadLetters.push({
          item: overflow,
          failedAt: createdAt,
          reason: "dispatch_queue_overflow",
        });
      }

      const nextQueue: PersistedBackgroundRunDispatchQueue = {
        version: AGENT_RUN_SCHEMA_VERSION,
        nextSequence,
        updatedAt: createdAt,
        items,
        deadLetters,
      };
      await this.saveDispatchQueueAndBeacon(nextQueue);
      return nextItem;
    });
  }

  async getDispatchStats(): Promise<BackgroundRunDispatchStats> {
    const queue = await this.loadDispatchQueue();
    const queuedByPool = {
      generic: 0,
      browser: 0,
      desktop: 0,
      code: 0,
      research: 0,
      approval: 0,
      remote_mcp: 0,
    } satisfies Record<BackgroundRunWorkerPool, number>;
    const claimedByPool = {
      generic: 0,
      browser: 0,
      desktop: 0,
      code: 0,
      research: 0,
      approval: 0,
      remote_mcp: 0,
    } satisfies Record<BackgroundRunWorkerPool, number>;
    let totalClaimed = 0;
    for (const item of queue.items) {
      if (item.claimOwnerId && item.claimExpiresAt && item.claimExpiresAt > Date.now()) {
        totalClaimed += 1;
        claimedByPool[item.pool] += 1;
      } else {
        queuedByPool[item.pool] += 1;
      }
    }
    return {
      totalQueued: queue.items.length - totalClaimed,
      totalClaimed,
      queuedByPool,
      claimedByPool,
    };
  }

  async getNextDispatchAvailability(): Promise<number | undefined> {
    const beacon = await this.loadDispatchBeacon();
    return beacon.nextAvailableAt;
  }

  async getQueuedDispatchCountForSession(sessionId: string): Promise<number> {
    const now = Date.now();
    const queue = await this.loadDispatchQueue();
    return queue.items.filter(
      (item) =>
        item.sessionId === sessionId &&
        (!item.claimOwnerId || !item.claimExpiresAt || item.claimExpiresAt <= now),
    ).length;
  }

  async claimDispatchForWorker(params: {
    workerId: string;
    pools: readonly BackgroundRunWorkerPool[];
    now?: number;
  }): Promise<BackgroundRunDispatchClaimResult> {
    const now = params.now ?? Date.now();
    return this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const [queue, registry] = await Promise.all([
        this.loadDispatchQueue(),
        this.loadWorkerRegistry(),
      ]);
      const worker = registry.workers.find((entry) => entry.workerId === params.workerId);
      if (!worker || worker.state === "draining") {
        return { claimed: false, queueDepth: queue.items.length };
      }
      if (worker.inFlightRuns >= worker.maxConcurrentRuns) {
        return { claimed: false, queueDepth: queue.items.length };
      }
      const activeWorkers = buildActiveWorkerMap(registry, now);

      const index = queue.items.findIndex((item) => {
        if (!params.pools.includes(item.pool)) return false;
        if (item.availableAt > now) return false;
        if (item.claimOwnerId && item.claimExpiresAt && item.claimExpiresAt > now) {
          const claimOwner = activeWorkers.get(item.claimOwnerId);
          if (claimOwner?.state === "active") {
            return false;
          }
        }
        if (item.preferredWorkerId && item.preferredWorkerId !== params.workerId) {
          const preferred = activeWorkers.get(item.preferredWorkerId);
          if (preferred && preferred.state === "active") {
            return false;
          }
        }
        if (item.affinityKey) {
          const affinityOwner = [...activeWorkers.values()].find(
            (activeWorker) =>
              activeWorker.workerId !== params.workerId &&
              activeWorker.affinityKeys.includes(item.affinityKey!),
          );
          if (affinityOwner) {
            return false;
          }
        }
        return true;
      });

      if (index < 0) {
        return { claimed: false, queueDepth: queue.items.length };
      }

      const item = queue.items[index]!;
      const claimedItem: BackgroundRunDispatchItem = {
        ...item,
        deliveryCount: item.deliveryCount + 1,
        claimOwnerId: params.workerId,
        claimExpiresAt: now + this.dispatchClaimDurationMs,
      };
      const items = [...queue.items];
      items.splice(index, 1, claimedItem);
      await this.saveDispatchQueueAndBeacon({
        ...queue,
        updatedAt: now,
        items,
      } satisfies PersistedBackgroundRunDispatchQueue);
      return {
        claimed: true,
        item: claimedItem,
        queueDepth: items.length,
      };
    });
  }

  async completeDispatch(params: {
    dispatchId: string;
    workerId: string;
    now?: number;
  }): Promise<void> {
    const now = params.now ?? Date.now();
    await this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const queue = await this.loadDispatchQueue();
      const items = queue.items.filter(
        (item) =>
          !(
            item.id === params.dispatchId &&
            item.claimOwnerId === params.workerId
          ),
      );
      if (items.length === queue.items.length) {
        return;
      }
      await this.saveDispatchQueueAndBeacon({
        ...queue,
        updatedAt: now,
        items,
      } satisfies PersistedBackgroundRunDispatchQueue);
    });
  }

  async pruneDispatchesForSession(params: {
    sessionId: string;
    excludeDispatchId?: string;
    now?: number;
  }): Promise<BackgroundRunPruneDispatchResult> {
    const now = params.now ?? Date.now();
    return this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const queue = await this.loadDispatchQueue();
      const items = queue.items.filter((item) =>
        item.sessionId !== params.sessionId ||
        item.id === params.excludeDispatchId
      );
      const removedCount = queue.items.length - items.length;
      if (removedCount === 0) {
        return {
          removedCount: 0,
          queueDepth: queue.items.length,
        };
      }
      await this.saveDispatchQueueAndBeacon({
        ...queue,
        updatedAt: now,
        items,
      } satisfies PersistedBackgroundRunDispatchQueue);
      return {
        removedCount,
        queueDepth: items.length,
      };
    });
  }

  async releaseDispatch(params: {
    dispatchId: string;
    workerId: string;
    now?: number;
    availableAt?: number;
    preferredWorkerId?: string;
  }): Promise<void> {
    const now = params.now ?? Date.now();
    await this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const queue = await this.loadDispatchQueue();
      const index = queue.items.findIndex((item) => item.id === params.dispatchId);
      if (index < 0) {
        return;
      }
      const item = queue.items[index]!;
      if (item.claimOwnerId && item.claimOwnerId !== params.workerId) {
        return;
      }
      const released: BackgroundRunDispatchItem = {
        ...item,
        availableAt: params.availableAt ?? now,
        preferredWorkerId: params.preferredWorkerId ?? item.preferredWorkerId,
        claimOwnerId: undefined,
        claimExpiresAt: undefined,
      };
      const items = [...queue.items];
      if (released.deliveryCount >= released.maxDeliveryAttempts) {
        items.splice(index, 1);
        await this.saveDispatchQueueAndBeacon({
          ...queue,
          updatedAt: now,
          items,
          deadLetters: [
            ...queue.deadLetters,
            {
              item: released,
              failedAt: now,
              reason: "dispatch_delivery_attempts_exhausted",
            },
          ],
        } satisfies PersistedBackgroundRunDispatchQueue);
        return;
      }
      items.splice(index, 1, released);
      items.sort(compareDispatchItems);
      await this.saveDispatchQueueAndBeacon({
        ...queue,
        updatedAt: now,
        items,
      } satisfies PersistedBackgroundRunDispatchQueue);
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
    const dispatchDeadLetterRetentionMs =
      options.dispatchDeadLetterRetentionMs ?? DEFAULT_DISPATCH_DEAD_LETTER_RETENTION_MS;
    let releasedExpiredLeases = 0;
    let deletedTerminalSnapshots = 0;
    let deletedCorruptRecords = 0;
    let deletedWakeDeadLetters = 0;
    let deletedDispatchDeadLetters = 0;
    let deletedStaleWorkers = 0;
    let releasedExpiredDispatchClaims = 0;

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

    await this.queue.run(BACKGROUND_RUN_DISPATCH_LOCK_KEY, async () => {
      const dispatchQueue = await this.loadDispatchQueue();
      const items = dispatchQueue.items.map((item) => {
        if (
          item.claimOwnerId &&
          typeof item.claimExpiresAt === "number" &&
          item.claimExpiresAt <= now
        ) {
          releasedExpiredDispatchClaims += 1;
          return {
            ...item,
            claimOwnerId: undefined,
            claimExpiresAt: undefined,
          } satisfies BackgroundRunDispatchItem;
        }
        return item;
      });
      const retainedDeadLetters = dispatchQueue.deadLetters.filter(
        (deadLetter) =>
          deadLetter.failedAt + dispatchDeadLetterRetentionMs > now,
      );
      deletedDispatchDeadLetters +=
        dispatchQueue.deadLetters.length - retainedDeadLetters.length;
      await this.saveDispatchQueueAndBeacon({
        ...dispatchQueue,
        updatedAt: now,
        items,
        deadLetters: retainedDeadLetters,
      } satisfies PersistedBackgroundRunDispatchQueue);
    });

    await this.queue.run(BACKGROUND_RUN_WORKER_REGISTRY_LOCK_KEY, async () => {
      const registry = await this.loadWorkerRegistry();
      const workers = registry.workers.filter((worker) => {
        const alive = worker.lastHeartbeatAt + worker.heartbeatTtlMs > now;
        if (!alive) {
          deletedStaleWorkers += 1;
        }
        return alive;
      });
      await this.memoryBackend.set(
        BACKGROUND_RUN_WORKER_REGISTRY_KEY,
        cloneJson({
          version: AGENT_RUN_SCHEMA_VERSION,
          updatedAt: now,
          workers,
        } satisfies PersistedBackgroundRunWorkerRegistry),
      );
    });

    return {
      releasedExpiredLeases,
      deletedTerminalSnapshots,
      deletedCorruptRecords,
      deletedWakeDeadLetters,
      deletedDispatchDeadLetters,
      deletedStaleWorkers,
      releasedExpiredDispatchClaims,
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
      const [current, workerRegistry] = await Promise.all([
        this.loadRun(sessionId),
        this.loadWorkerRegistry(),
      ]);
      if (!current) return { claimed: false };
      const activeWorkers = buildActiveWorkerMap(workerRegistry, now);
      const leaseIsActive =
        current.leaseOwnerId &&
        current.leaseOwnerId !== instanceId &&
        typeof current.leaseExpiresAt === "number" &&
        current.leaseExpiresAt > now &&
        activeWorkers.has(current.leaseOwnerId);
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
