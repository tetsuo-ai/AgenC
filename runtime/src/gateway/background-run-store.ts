import type { LLMMessage } from "../llm/types.js";
import type { MemoryBackend, MemoryEntry } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";

const BACKGROUND_RUN_KEY_PREFIX = "background-run:session:";
const BACKGROUND_RUN_RECENT_KEY_PREFIX = "background-run:recent:session:";
const BACKGROUND_RUN_EVENT_SESSION_PREFIX = "background-run:";
const DEFAULT_LEASE_DURATION_MS = 45_000;

export type BackgroundRunKind =
  | "finite"
  | "until_condition"
  | "until_stopped";

export type BackgroundRunState =
  | "pending"
  | "running"
  | "working"
  | "paused"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface BackgroundRunContract {
  readonly kind: BackgroundRunKind;
  readonly successCriteria: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly blockedCriteria: readonly string[];
  readonly nextCheckMs: number;
  readonly heartbeatMs?: number;
  readonly requiresUserStop: boolean;
  readonly managedProcessPolicy?: BackgroundRunManagedProcessPolicy;
}

export interface BackgroundRunManagedProcessPolicy {
  readonly mode: "none" | "until_exit" | "keep_running" | "restart_on_exit";
  readonly maxRestarts?: number;
  readonly restartBackoffMs?: number;
}

export interface BackgroundRunManagedProcessLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
  readonly logPath?: string;
}

export type BackgroundRunWakeReason =
  | "start"
  | "timer"
  | "busy_retry"
  | "recovery"
  | "user_input"
  | "external_event"
  | "tool_result"
  | "process_exit"
  | "webhook"
  | "daemon_shutdown";

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

export interface BackgroundRunObservedManagedProcessTarget {
  readonly kind: "managed_process";
  readonly processId: string;
  readonly label?: string;
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
  readonly lastCompactedAt: number;
}

export interface BackgroundRunRecentSnapshot {
  readonly version: 1;
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
}

export interface PersistedBackgroundRun {
  readonly version: 1;
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
  readonly pendingSignals: readonly BackgroundRunSignal[];
  readonly observedTargets: readonly BackgroundRunObservedTarget[];
  readonly internalHistory: readonly LLMMessage[];
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
    lastCompactedAt: raw.lastCompactedAt,
  };
}

function coerceRecentSnapshot(
  value: unknown,
): BackgroundRunRecentSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  const contractKind = raw.contractKind;
  const lastWakeReason = raw.lastWakeReason;
  if (
    raw.version !== 1 ||
    typeof raw.runId !== "string" ||
    typeof raw.sessionId !== "string" ||
    typeof raw.objective !== "string" ||
    typeof raw.requiresUserStop !== "boolean" ||
    typeof raw.cycleCount !== "number" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.pendingSignals !== "number" ||
    (
      state !== "pending" &&
      state !== "running" &&
      state !== "working" &&
      state !== "paused" &&
      state !== "completed" &&
      state !== "blocked" &&
      state !== "failed" &&
      state !== "cancelled"
    ) ||
    (
      contractKind !== "finite" &&
      contractKind !== "until_condition" &&
      contractKind !== "until_stopped"
    )
  ) {
    return undefined;
  }
  return {
    version: 1,
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
      typeof lastWakeReason === "string"
        ? lastWakeReason as BackgroundRunWakeReason
        : undefined,
    pendingSignals: raw.pendingSignals,
    carryForwardSummary:
      typeof raw.carryForwardSummary === "string"
        ? raw.carryForwardSummary
        : undefined,
  };
}

function coerceContract(value: unknown): BackgroundRunContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (
    kind !== "finite" &&
    kind !== "until_condition" &&
    kind !== "until_stopped"
  ) {
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
  const managedProcessMode = managedProcessPolicy?.mode;
  return {
    kind,
    successCriteria: normalizeStringArray(raw.successCriteria),
    completionCriteria: normalizeStringArray(raw.completionCriteria),
    blockedCriteria: normalizeStringArray(raw.blockedCriteria),
    nextCheckMs,
    heartbeatMs,
    requiresUserStop: Boolean(raw.requiresUserStop),
    managedProcessPolicy:
      managedProcessMode === "none" ||
      managedProcessMode === "until_exit" ||
      managedProcessMode === "keep_running" ||
      managedProcessMode === "restart_on_exit"
        ? {
            mode: managedProcessMode,
            maxRestarts: coercePositiveInteger(managedProcessPolicy?.maxRestarts),
            restartBackoffMs: coercePositiveInteger(
              managedProcessPolicy?.restartBackoffMs,
            ),
          }
        : undefined,
  };
}

function coerceRun(value: unknown): PersistedBackgroundRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  if (
    state !== "pending" &&
    state !== "running" &&
    state !== "working" &&
    state !== "paused" &&
    state !== "completed" &&
    state !== "blocked" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    return undefined;
  }
  const contract = coerceContract(raw.contract);
  const carryForward = coerceCarryForward(raw.carryForward);
  const pendingSignals = Array.isArray(raw.pendingSignals)
    ? raw.pendingSignals
      .map((item) => coerceSignal(item))
      .filter((item): item is BackgroundRunSignal => item !== undefined)
    : [];
  const observedTargets = Array.isArray(raw.observedTargets)
    ? raw.observedTargets
      .map((item) => coerceObservedTarget(item))
      .filter((item): item is BackgroundRunObservedTarget => item !== undefined)
    : [];
  if (!contract) return undefined;
  if (
    raw.version !== 1 ||
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
  return {
    version: 1,
    id: raw.id,
    sessionId: raw.sessionId,
    objective: raw.objective,
    contract,
    state,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    cycleCount: raw.cycleCount,
    stableWorkingCycles: raw.stableWorkingCycles,
    consecutiveErrorCycles: raw.consecutiveErrorCycles,
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
      typeof raw.lastWakeReason === "string"
        ? (raw.lastWakeReason as BackgroundRunWakeReason)
        : undefined,
    carryForward,
    pendingSignals,
    observedTargets,
    internalHistory: cloneJson(raw.internalHistory as readonly LLMMessage[]),
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

  async saveRun(run: PersistedBackgroundRun): Promise<void> {
    await this.queue.run(run.sessionId, async () => {
      await this.memoryBackend.set(backgroundRunKey(run.sessionId), cloneJson(run));
    });
  }

  async loadRun(sessionId: string): Promise<PersistedBackgroundRun | undefined> {
    const value = await this.memoryBackend.get(backgroundRunKey(sessionId));
    return coerceRun(value);
  }

  async deleteRun(sessionId: string): Promise<void> {
    await this.queue.run(sessionId, async () => {
      await this.memoryBackend.delete(backgroundRunKey(sessionId));
    });
  }

  async saveRecentSnapshot(snapshot: BackgroundRunRecentSnapshot): Promise<void> {
    await this.queue.run(snapshot.sessionId, async () => {
      await this.memoryBackend.set(
        backgroundRunRecentKey(snapshot.sessionId),
        cloneJson(snapshot),
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
        return this.loadRun(sessionId);
      }),
    );
    return runs.filter(
      (run): run is PersistedBackgroundRun => run !== undefined,
    );
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
        leaseOwnerId: instanceId,
        leaseExpiresAt: now + this.leaseDurationMs,
      };
      await this.memoryBackend.set(
        backgroundRunKey(sessionId),
        cloneJson(claimed),
      );
      return { claimed: true, run: claimed };
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
      await this.memoryBackend.set(backgroundRunKey(sessionId), cloneJson(next));
      return next;
    });
  }
}
