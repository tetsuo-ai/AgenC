import { createServer } from "node:net";
import type { ChannelAdapterLogger } from "@tetsuo-ai/plugin-kit";
import type {
  AgentSetupConfig,
  ConcordiaCheckpointStatus,
  ConcordiaExecutionPhase,
  EventNotification,
  LaunchRequest,
  SimulationLifecycleStatus,
  SimulationReplayEvent,
  SimulationRecord,
  SimulationSummary,
} from "./types.js";

type ReplaySubscriber = (event: SimulationReplayEvent) => void;

interface ReplayStreamHandle {
  readonly history: readonly SimulationReplayEvent[];
  readonly unsubscribe: () => void;
}

export interface NormalizedLaunchRequest
  extends Omit<LaunchRequest, "simulation_id" | "lineage_id" | "parent_simulation_id"> {
  readonly simulation_id: string;
  readonly lineage_id: string | null;
  readonly parent_simulation_id: string | null;
}

export interface ReservedSimulationPorts {
  readonly controlPort: number;
  readonly eventPort: number;
}

type MutableNormalizedLaunchRequest = {
  -readonly [K in keyof NormalizedLaunchRequest]: NormalizedLaunchRequest[K];
};

export interface SimulationHandle<TRunner = unknown, TMemoryContext = unknown, TPending = unknown> {
  readonly simulationId: string;
  worldId: string;
  workspaceId: string;
  lineageId: string | null;
  parentSimulationId: string | null;
  premise: string;
  userId?: string;
  agents: readonly AgentSetupConfig[];
  agentIds: string[];
  maxSteps: number | null;
  gmModel?: string;
  gmProvider?: string;
  executionPhase: ConcordiaExecutionPhase | null;
  status: SimulationLifecycleStatus;
  reason: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pid: number | null;
  controlPort: number | null;
  eventPort: number | null;
  lastCompletedStep: number;
  lastProcessedResolutionStep: number;
  lastStepOutcome: string | null;
  replayEventCount: number;
  replayCursor: number;
  currentAlias: boolean;
  checkpoint: ConcordiaCheckpointStatus | null;
  launchRequest: MutableNormalizedLaunchRequest;
  runner: TRunner | null;
  memoryCtx: TMemoryContext | null;
  readonly pendingResponses: Map<string, TPending>;
  readonly replayEvents: SimulationReplayEvent[];
  readonly replaySubscribers: Set<ReplaySubscriber>;
}

const ACTIVE_STATUS_ORDER: ReadonlyArray<SimulationLifecycleStatus> = [
  "running",
  "paused",
  "launching",
  "stopping",
  "stopped",
  "finished",
  "failed",
  "archived",
  "deleted",
];
const ACTIVE_SIMULATION_STATUSES = new Set<SimulationLifecycleStatus>([
  "launching",
  "running",
  "paused",
  "stopping",
]);
const HISTORICAL_SIMULATION_STATUSES = new Set<SimulationLifecycleStatus>([
  "stopped",
  "finished",
  "failed",
  "archived",
  "deleted",
]);

export interface SimulationRegistryOptions {
  readonly replayBufferLimit?: number;
  readonly archivedReplayEventLimit?: number;
}

function activeStatusRank(status: SimulationLifecycleStatus): number {
  const index = ACTIVE_STATUS_ORDER.indexOf(status);
  return index === -1 ? ACTIVE_STATUS_ORDER.length : index;
}

async function probePort(preferredPort?: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(
      {
        host: "127.0.0.1",
        port: preferredPort ?? 0,
        exclusive: true,
      },
      () => {
        const address = server.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : null;
        if (!port) {
          server.close(() => reject(new Error("Failed to resolve reserved port")));
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      },
    );
  });
}

function cloneAgents(agents: readonly AgentSetupConfig[]): readonly AgentSetupConfig[] {
  return agents.map((agent) => ({ ...agent }));
}

export class SimulationRegistry<TRunner = unknown, TMemoryContext = unknown, TPending = unknown> {
  private readonly handles = new Map<string, SimulationHandle<TRunner, TMemoryContext, TPending>>();
  private readonly reservedPorts = new Set<number>();
  private readonly requestIndex = new Map<string, string>();
  private currentAlias: string | null = null;
  private readonly replayBufferLimit: number;
  private readonly archivedReplayEventLimit: number;

  constructor(
    private readonly logger?: ChannelAdapterLogger,
    options: number | SimulationRegistryOptions = {},
  ) {
    if (typeof options === "number") {
      this.replayBufferLimit = options;
      this.archivedReplayEventLimit = Math.min(options, 200);
      return;
    }
    this.replayBufferLimit = options.replayBufferLimit ?? 1000;
    this.archivedReplayEventLimit = options.archivedReplayEventLimit ?? 200;
  }

  has(simulationId: string): boolean {
    return this.handles.has(simulationId);
  }

  get(simulationId: string): SimulationHandle<TRunner, TMemoryContext, TPending> | undefined {
    return this.handles.get(simulationId);
  }

  require(simulationId: string): SimulationHandle<TRunner, TMemoryContext, TPending> {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      throw new Error(`Unknown simulation: ${simulationId}`);
    }
    return handle;
  }

  listHandles(): SimulationHandle<TRunner, TMemoryContext, TPending>[] {
    return Array.from(this.handles.values()).sort((left, right) => {
      if (left.currentAlias !== right.currentAlias) {
        return left.currentAlias ? -1 : 1;
      }
      const statusDelta = activeStatusRank(left.status) - activeStatusRank(right.status);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      return right.updatedAt - left.updatedAt;
    });
  }

  listSummaries(): SimulationSummary[] {
    return this.listHandles().map((handle) => this.toSummary(handle));
  }

  countActiveHandles(excludeSimulationId?: string): number {
    return this.listHandles().filter((handle) => (
      handle.simulationId !== excludeSimulationId &&
      ACTIVE_SIMULATION_STATUSES.has(handle.status)
    )).length;
  }

  countHistoricalHandles(): number {
    return this.listHandles().filter((handle) => (
      HISTORICAL_SIMULATION_STATUSES.has(handle.status)
    )).length;
  }

  countStuckHandles(stepStuckTimeoutMs: number, now = Date.now()): number {
    return this.listHandles().filter((handle) => {
      if (!ACTIVE_SIMULATION_STATUSES.has(handle.status)) {
        return false;
      }
      const updatedAt = handle.updatedAt || handle.createdAt;
      return now - updatedAt >= stepStuckTimeoutMs;
    }).length;
  }

  getPendingResponseCount(): number {
    return this.listHandles().reduce(
      (total, handle) => total + handle.pendingResponses.size,
      0,
    );
  }

  getReplayBufferEventCount(): number {
    return this.listHandles().reduce(
      (total, handle) => total + handle.replayEvents.length,
      0,
    );
  }

  getReservedPortCount(): number {
    return this.reservedPorts.size;
  }

  getCheckpointCount(): number {
    return this.listHandles().filter((handle) => handle.checkpoint !== null).length;
  }

  getConfiguredThreadBudgetCount(): number {
    return this.listHandles().reduce((total, handle) => (
      total + (handle.launchRequest.run_budget?.simultaneous_max_workers ?? 0)
    ), 0);
  }

  pruneHistoricalHandles(options: {
    readonly maxHistoricalSimulations: number;
    readonly archivedSimulationRetentionMs: number;
    readonly archivedReplayEventLimit?: number;
    readonly now?: number;
  }): {
    readonly removedSimulationIds: readonly string[];
    readonly removedSessions: readonly { simulationId: string; workspaceId: string }[];
    readonly trimmedReplayEvents: number;
  } {
    const now = options.now ?? Date.now();
    const retainedReplayLimit = options.archivedReplayEventLimit ?? this.archivedReplayEventLimit;
    const historicalHandles = this.listHandles().filter((handle) => (
      HISTORICAL_SIMULATION_STATUSES.has(handle.status)
    ));
    const sortedHistorical = [...historicalHandles].sort((left, right) => (
      right.updatedAt - left.updatedAt
    ));
    const keep = new Set(
      sortedHistorical
        .slice(0, Math.max(options.maxHistoricalSimulations, 0))
        .map((handle) => handle.simulationId),
    );
    const removedSimulationIds = [];
    const removedSessions = [];
    let trimmedReplayEvents = 0;

    for (const handle of sortedHistorical) {
      const ageMs = now - (handle.endedAt ?? handle.updatedAt ?? handle.createdAt);
      const shouldRemove = ageMs > options.archivedSimulationRetentionMs || !keep.has(handle.simulationId);
      if (shouldRemove) {
        removedSimulationIds.push(handle.simulationId);
        removedSessions.push({
          simulationId: handle.simulationId,
          workspaceId: handle.workspaceId,
        });
        this.deleteHandle(handle.simulationId);
        continue;
      }
      if (handle.replayEvents.length > retainedReplayLimit) {
        const trimCount = handle.replayEvents.length - retainedReplayLimit;
        handle.replayEvents.splice(0, trimCount);
        handle.replayEventCount = handle.replayEvents.length;
        handle.updatedAt = now;
        trimmedReplayEvents += trimCount;
      }
    }

    return { removedSimulationIds, removedSessions, trimmedReplayEvents };
  }

  getRecord(simulationId: string): SimulationRecord | null {
    const handle = this.handles.get(simulationId);
    return handle ? this.toRecord(handle) : null;
  }

  getCurrentAlias(): string | null {
    return this.currentAlias;
  }

  getCurrentHandle(): SimulationHandle<TRunner, TMemoryContext, TPending> | undefined {
    return this.currentAlias ? this.handles.get(this.currentAlias) : undefined;
  }

  setCurrentAlias(simulationId: string | null): void {
    this.currentAlias = simulationId;
    for (const handle of this.handles.values()) {
      handle.currentAlias = handle.simulationId === simulationId;
    }
  }

  async reservePorts(input: {
    readonly controlPort?: number | null;
    readonly eventPort?: number | null;
  } = {}): Promise<ReservedSimulationPorts> {
    const blocked = new Set(this.reservedPorts);
    const controlPort = await this.reserveSinglePort(input.controlPort ?? undefined, blocked);
    blocked.add(controlPort);
    const eventPort = await this.reserveSinglePort(input.eventPort ?? undefined, blocked);
    this.reservedPorts.add(controlPort);
    this.reservedPorts.add(eventPort);
    return { controlPort, eventPort };
  }

  releasePorts(handle: Pick<SimulationHandle<TRunner, TMemoryContext, TPending>, "controlPort" | "eventPort">): void {
    if (typeof handle.controlPort === "number") {
      this.reservedPorts.delete(handle.controlPort);
    }
    if (typeof handle.eventPort === "number") {
      this.reservedPorts.delete(handle.eventPort);
    }
  }

  createHandle(params: {
    readonly request: NormalizedLaunchRequest;
    readonly status?: SimulationLifecycleStatus;
    readonly controlPort?: number | null;
    readonly eventPort?: number | null;
    readonly currentAlias?: boolean;
  }): SimulationHandle<TRunner, TMemoryContext, TPending> {
    if (this.handles.has(params.request.simulation_id)) {
      throw new Error(`Simulation already exists: ${params.request.simulation_id}`);
    }

    const now = Date.now();
    const handle: SimulationHandle<TRunner, TMemoryContext, TPending> = {
      simulationId: params.request.simulation_id,
      worldId: params.request.world_id,
      workspaceId: params.request.workspace_id,
      lineageId: params.request.lineage_id ?? null,
      parentSimulationId: params.request.parent_simulation_id ?? null,
      premise: params.request.premise,
      userId: params.request.user_id,
      agents: cloneAgents(params.request.agents),
      agentIds: params.request.agents.map((agent) => agent.agent_id),
      maxSteps: params.request.max_steps ?? null,
      gmModel: params.request.gm_model,
      gmProvider: params.request.gm_provider,
      executionPhase: params.status === "launching" ? "launching" : null,
      status: params.status ?? "launching",
      reason: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      pid: null,
      controlPort: params.controlPort ?? params.request.control_port ?? null,
      eventPort: params.eventPort ?? params.request.event_port ?? null,
      lastCompletedStep: 0,
      lastProcessedResolutionStep: 0,
      lastStepOutcome: null,
      replayEventCount: 0,
      replayCursor: 0,
      currentAlias: false,
      checkpoint: null,
      launchRequest: {
        ...params.request,
      },
      runner: null,
      memoryCtx: null,
      pendingResponses: new Map(),
      replayEvents: [],
      replaySubscribers: new Set(),
    };
    this.handles.set(handle.simulationId, handle);
    if (params.currentAlias ?? true) {
      this.setCurrentAlias(handle.simulationId);
    }
    return handle;
  }

  deleteHandle(simulationId: string): void {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return;
    }
    this.releasePorts(handle);
    for (const requestId of handle.pendingResponses.keys()) {
      this.requestIndex.delete(requestId);
    }
    handle.replaySubscribers.clear();
    this.handles.delete(simulationId);
    if (this.currentAlias === simulationId) {
      this.setCurrentAlias(this.listHandles()[0]?.simulationId ?? null);
    }
  }

  clear(): void {
    for (const handle of this.handles.values()) {
      this.releasePorts(handle);
    }
    this.handles.clear();
    this.requestIndex.clear();
    this.currentAlias = null;
  }

  mutateHandle(
    simulationId: string,
    mutate: (handle: SimulationHandle<TRunner, TMemoryContext, TPending>) => void,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> | undefined {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return undefined;
    }
    mutate(handle);
    handle.updatedAt = Date.now();
    return handle;
  }

  attachRunner(
    simulationId: string,
    runner: TRunner,
    pid: number | null,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.runner = runner;
      handle.pid = pid;
      handle.startedAt ??= Date.now();
      handle.endedAt = null;
      if (handle.status === "launching") {
        handle.status = "running";
        handle.executionPhase = handle.executionPhase ?? "launching";
        handle.reason = null;
        handle.error = null;
      }
    });
  }

  detachRunner(
    simulationId: string,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.runner = null;
      handle.pid = null;
      this.releasePorts(handle);
      handle.controlPort = null;
      handle.eventPort = null;
    });
  }

  attachMemoryContext(
    simulationId: string,
    memoryCtx: TMemoryContext | null,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.memoryCtx = memoryCtx;
    });
  }

  setCheckpoint(
    simulationId: string,
    checkpoint: ConcordiaCheckpointStatus | null,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.checkpoint = checkpoint;
    });
  }

  setLaunchMetadata(
    simulationId: string,
    update: {
      readonly worldId?: string;
      readonly workspaceId?: string;
      readonly lineageId?: string | null;
      readonly parentSimulationId?: string | null;
      readonly premise?: string;
      readonly userId?: string;
      readonly agents?: readonly AgentSetupConfig[];
      readonly maxSteps?: number | null;
      readonly gmModel?: string;
      readonly gmProvider?: string;
      readonly gmInstructions?: string;
      readonly scenes?: LaunchRequest["scenes"];
      readonly runBudget?: LaunchRequest["run_budget"] | null;
    },
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      if (update.worldId !== undefined) {
        handle.worldId = update.worldId;
        handle.launchRequest.world_id = update.worldId;
      }
      if (update.workspaceId !== undefined) {
        handle.workspaceId = update.workspaceId;
        handle.launchRequest.workspace_id = update.workspaceId;
      }
      if (update.lineageId !== undefined) {
        handle.lineageId = update.lineageId;
        handle.launchRequest.lineage_id = update.lineageId;
      }
      if (update.parentSimulationId !== undefined) {
        handle.parentSimulationId = update.parentSimulationId;
        handle.launchRequest.parent_simulation_id = update.parentSimulationId;
      }
      if (update.premise !== undefined) {
        handle.premise = update.premise;
        handle.launchRequest.premise = update.premise;
      }
      if (update.userId !== undefined) {
        handle.userId = update.userId;
        handle.launchRequest.user_id = update.userId;
      }
      if (update.agents !== undefined) {
        handle.agents = cloneAgents(update.agents);
        handle.agentIds = update.agents.map((agent) => agent.agent_id);
        handle.launchRequest.agents = cloneAgents(update.agents);
      }
      if (update.maxSteps !== undefined) {
        handle.maxSteps = update.maxSteps;
        handle.launchRequest.max_steps = update.maxSteps ?? undefined;
      }
      if (update.gmModel !== undefined) {
        handle.gmModel = update.gmModel;
        handle.launchRequest.gm_model = update.gmModel;
      }
      if (update.gmProvider !== undefined) {
        handle.gmProvider = update.gmProvider;
        handle.launchRequest.gm_provider = update.gmProvider;
      }
      if (update.gmInstructions !== undefined) {
        handle.launchRequest.gm_instructions = update.gmInstructions;
      }
      if (update.scenes !== undefined) {
        handle.launchRequest.scenes = update.scenes;
      }
      if (update.runBudget !== undefined) {
        handle.launchRequest.run_budget = update.runBudget ?? undefined;
      }
    });
  }

  updateLifecycle(
    simulationId: string,
    update: {
      readonly status?: SimulationLifecycleStatus;
      readonly executionPhase?: ConcordiaExecutionPhase | null;
      readonly reason?: string | null;
      readonly error?: string | null;
      readonly lastCompletedStep?: number;
      readonly lastStepOutcome?: string | null;
      readonly startedAt?: number | null;
      readonly endedAt?: number | null;
      readonly pid?: number | null;
      readonly controlPort?: number | null;
      readonly eventPort?: number | null;
      readonly replayEventCount?: number;
    },
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      if (update.status !== undefined) {
        handle.status = update.status;
      }
      if (update.executionPhase !== undefined) {
        handle.executionPhase = update.executionPhase;
      }
      if (update.reason !== undefined) {
        handle.reason = update.reason;
      }
      if (update.error !== undefined) {
        handle.error = update.error;
      }
      if (update.lastCompletedStep !== undefined) {
        handle.lastCompletedStep = update.lastCompletedStep;
      }
      if (update.lastStepOutcome !== undefined) {
        handle.lastStepOutcome = update.lastStepOutcome;
      }
      if (update.startedAt !== undefined) {
        handle.startedAt = update.startedAt;
      }
      if (update.endedAt !== undefined) {
        handle.endedAt = update.endedAt;
      }
      if (update.pid !== undefined) {
        handle.pid = update.pid;
      }
      if (update.controlPort !== undefined) {
        handle.controlPort = update.controlPort;
        handle.launchRequest.control_port = update.controlPort ?? undefined;
      }
      if (update.eventPort !== undefined) {
        handle.eventPort = update.eventPort;
        handle.launchRequest.event_port = update.eventPort ?? undefined;
      }
      if (update.replayEventCount !== undefined) {
        handle.replayEventCount = update.replayEventCount;
      }
    });
  }

  incrementReplayEventCount(simulationId: string, amount = 1): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.replayEventCount += amount;
    });
  }

  appendReplayEvent(
    simulationId: string,
    event: EventNotification,
  ): SimulationReplayEvent {
    const record = this.requireMutated(simulationId, (handle) => {
      handle.replayCursor += 1;
      const replayEvent: SimulationReplayEvent = {
        ...event,
        event_id: String(handle.replayCursor),
      };
      handle.replayEvents.push(replayEvent);
      if (handle.replayEvents.length > this.replayBufferLimit) {
        handle.replayEvents.splice(0, handle.replayEvents.length - this.replayBufferLimit);
      }
      handle.replayEventCount = handle.replayEvents.length;
      for (const subscriber of handle.replaySubscribers) {
        try {
          subscriber(replayEvent);
        } catch (error) {
          this.logger?.warn?.(
            `[concordia] replay subscriber failed for ${simulationId}: ${String(error)}`,
          );
        }
      }
    });

    return record.replayEvents[record.replayEvents.length - 1]!;
  }

  listReplayEvents(
    simulationId: string,
    afterCursor?: string | null,
  ): readonly SimulationReplayEvent[] {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return [];
    }
    const cursor = parseReplayCursor(afterCursor);
    return cursor === null
      ? [...handle.replayEvents]
      : handle.replayEvents.filter((event) => parseReplayCursor(event.event_id) !== null && parseReplayCursor(event.event_id)! > cursor);
  }

  openReplayStream(
    simulationId: string,
    afterCursor: string | null | undefined,
    subscriber: ReplaySubscriber,
  ): ReplayStreamHandle | null {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return null;
    }
    handle.replaySubscribers.add(subscriber);
    return {
      history: this.listReplayEvents(simulationId, afterCursor),
      unsubscribe: () => {
        handle.replaySubscribers.delete(subscriber);
      },
    };
  }

  registerPendingResponse(
    simulationId: string,
    requestId: string,
    pending: TPending,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    return this.requireMutated(simulationId, (handle) => {
      handle.pendingResponses.set(requestId, pending);
      this.requestIndex.set(requestId, simulationId);
    });
  }

  deletePendingResponse(simulationId: string, requestId: string): void {
    this.mutateHandle(simulationId, (handle) => {
      handle.pendingResponses.delete(requestId);
      this.requestIndex.delete(requestId);
    });
  }

  getPendingByRequestId(requestId: string): {
    handle: SimulationHandle<TRunner, TMemoryContext, TPending>;
    pending: TPending;
  } | null {
    const simulationId = this.requestIndex.get(requestId);
    if (!simulationId) {
      return null;
    }
    const handle = this.handles.get(simulationId);
    if (!handle) {
      this.requestIndex.delete(requestId);
      return null;
    }
    const pending = handle.pendingResponses.get(requestId);
    if (!pending) {
      this.requestIndex.delete(requestId);
      return null;
    }
    return { handle, pending };
  }

  findPendingBySession(
    simulationId: string,
    sessionId: string,
    getSessionId: (pending: TPending) => string,
  ): Array<[string, TPending]> {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return [];
    }
    return Array.from(handle.pendingResponses.entries()).filter(([, pending]) => (
      getSessionId(pending) === sessionId
    ));
  }

  clearPending(
    simulationId: string,
    rejectPending: (requestId: string, pending: TPending) => void,
  ): void {
    const handle = this.handles.get(simulationId);
    if (!handle) {
      return;
    }
    for (const [requestId, pending] of Array.from(handle.pendingResponses.entries())) {
      rejectPending(requestId, pending);
    }
  }

  toSummary(handle: SimulationHandle<TRunner, TMemoryContext, TPending>): SimulationSummary {
    return {
      simulation_id: handle.simulationId,
      world_id: handle.worldId,
      workspace_id: handle.workspaceId,
      lineage_id: handle.lineageId,
      parent_simulation_id: handle.parentSimulationId,
      status: handle.status,
      execution_phase: handle.executionPhase,
      reason: handle.reason,
      error: handle.error,
      created_at: handle.createdAt,
      updated_at: handle.updatedAt,
      started_at: handle.startedAt,
      ended_at: handle.endedAt,
      agent_ids: [...handle.agentIds],
      current_alias: handle.currentAlias,
      pid: handle.pid,
      last_completed_step: handle.lastCompletedStep,
      last_step_outcome: handle.lastStepOutcome,
      replay_event_count: handle.replayEventCount,
      checkpoint: handle.checkpoint,
    };
  }

  toRecord(handle: SimulationHandle<TRunner, TMemoryContext, TPending>): SimulationRecord {
    return {
      ...this.toSummary(handle),
      agents: cloneAgents(handle.agents),
      premise: handle.premise,
      max_steps: handle.maxSteps,
      ...(handle.gmModel ? { gm_model: handle.gmModel } : {}),
      ...(handle.gmProvider ? { gm_provider: handle.gmProvider } : {}),
      ...(handle.launchRequest.gm_instructions ? { gm_instructions: handle.launchRequest.gm_instructions } : {}),
      ...(handle.launchRequest.scenes ? { scenes: handle.launchRequest.scenes } : {}),
      run_budget: handle.launchRequest.run_budget ?? null,
    };
  }

  private async reserveSinglePort(
    preferredPort: number | undefined,
    blocked: Set<number>,
  ): Promise<number> {
    if (preferredPort !== undefined) {
      if (blocked.has(preferredPort)) {
        throw new Error(`Port already reserved: ${preferredPort}`);
      }
      const port = await probePort(preferredPort);
      blocked.add(port);
      return port;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await probePort();
      if (!blocked.has(port)) {
        blocked.add(port);
        return port;
      }
    }
    throw new Error("Failed to allocate a unique port for the simulation runner");
  }

  private requireMutated(
    simulationId: string,
    mutate: (handle: SimulationHandle<TRunner, TMemoryContext, TPending>) => void,
  ): SimulationHandle<TRunner, TMemoryContext, TPending> {
    const handle = this.mutateHandle(simulationId, mutate);
    if (!handle) {
      const message = `Unknown simulation: ${simulationId}`;
      this.logger?.warn?.(`[concordia] ${message}`);
      throw new Error(message);
    }
    return handle;
  }
}

function parseReplayCursor(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
