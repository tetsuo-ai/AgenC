import type {
  ConcordiaChannelConfig,
  ConcordiaOperationalMetrics,
  ConcordiaRunBudget,
  LaunchRequest,
  SimulationLifecycleStatus,
} from "./types.js";
import type { SimulationRegistry } from "./simulation-registry.js";

export const DEFAULT_CONCORDIA_OPERATIONS = {
  maxConcurrentSimulations: 4,
  maxHistoricalSimulations: 12,
  archivedSimulationRetentionMs: 6 * 60 * 60 * 1000,
  replayBufferLimit: 1000,
  archivedReplayEventLimit: 200,
  runnerStartupTimeoutMs: 30_000,
  runnerShutdownTimeoutMs: 2_000,
  stepStuckTimeoutMs: 5 * 60 * 1000,
  actTimeoutMs: 120_000,
  generateAgentsTimeoutMs: 60_000,
  simultaneousMaxWorkers: 8,
  proxyActionTimeoutSeconds: 120,
  proxyActionMaxRetries: 2,
  proxyRetryDelaySeconds: 2,
} as const;

export interface ConcordiaResolvedOperationsConfig {
  readonly maxConcurrentSimulations: number;
  readonly maxHistoricalSimulations: number;
  readonly archivedSimulationRetentionMs: number;
  readonly replayBufferLimit: number;
  readonly archivedReplayEventLimit: number;
  readonly runnerStartupTimeoutMs: number;
  readonly runnerShutdownTimeoutMs: number;
  readonly stepStuckTimeoutMs: number;
  readonly actTimeoutMs: number;
  readonly generateAgentsTimeoutMs: number;
  readonly simultaneousMaxWorkers: number;
  readonly proxyActionTimeoutSeconds: number;
  readonly proxyActionMaxRetries: number;
  readonly proxyRetryDelaySeconds: number;
}

export class ConcordiaAdmissionError extends Error {
  readonly code = "concordia_capacity_exhausted";
  readonly limit: number;
  readonly active: number;

  constructor(limit: number, active: number) {
    super(
      `Concordia admission control rejected launch: capacity exhausted (active=${active}, limit=${limit})`,
    );
    this.name = "ConcordiaAdmissionError";
    this.limit = limit;
    this.active = active;
  }
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function clampPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value > 0 ? value : fallback;
}

export function resolveOperationsConfig(
  config: Readonly<ConcordiaChannelConfig>,
): ConcordiaResolvedOperationsConfig {
  return {
    maxConcurrentSimulations: clampPositiveInteger(
      config.max_concurrent_simulations,
      DEFAULT_CONCORDIA_OPERATIONS.maxConcurrentSimulations,
    ),
    maxHistoricalSimulations: clampPositiveInteger(
      config.max_historical_simulations,
      DEFAULT_CONCORDIA_OPERATIONS.maxHistoricalSimulations,
    ),
    archivedSimulationRetentionMs: clampPositiveInteger(
      config.archived_simulation_retention_ms,
      DEFAULT_CONCORDIA_OPERATIONS.archivedSimulationRetentionMs,
    ),
    replayBufferLimit: clampPositiveInteger(
      config.replay_buffer_limit,
      DEFAULT_CONCORDIA_OPERATIONS.replayBufferLimit,
    ),
    archivedReplayEventLimit: clampPositiveInteger(
      config.archived_replay_event_limit,
      DEFAULT_CONCORDIA_OPERATIONS.archivedReplayEventLimit,
    ),
    runnerStartupTimeoutMs: clampPositiveInteger(
      config.runner_startup_timeout_ms,
      DEFAULT_CONCORDIA_OPERATIONS.runnerStartupTimeoutMs,
    ),
    runnerShutdownTimeoutMs: clampPositiveInteger(
      config.runner_shutdown_timeout_ms,
      DEFAULT_CONCORDIA_OPERATIONS.runnerShutdownTimeoutMs,
    ),
    stepStuckTimeoutMs: clampPositiveInteger(
      config.step_stuck_timeout_ms,
      DEFAULT_CONCORDIA_OPERATIONS.stepStuckTimeoutMs,
    ),
    actTimeoutMs: clampPositiveInteger(
      config.act_timeout_ms,
      DEFAULT_CONCORDIA_OPERATIONS.actTimeoutMs,
    ),
    generateAgentsTimeoutMs: clampPositiveInteger(
      config.generate_agents_timeout_ms,
      DEFAULT_CONCORDIA_OPERATIONS.generateAgentsTimeoutMs,
    ),
    simultaneousMaxWorkers: clampPositiveInteger(
      config.simultaneous_max_workers,
      DEFAULT_CONCORDIA_OPERATIONS.simultaneousMaxWorkers,
    ),
    proxyActionTimeoutSeconds: clampPositiveNumber(
      config.proxy_action_timeout_seconds,
      DEFAULT_CONCORDIA_OPERATIONS.proxyActionTimeoutSeconds,
    ),
    proxyActionMaxRetries: clampPositiveInteger(
      config.proxy_action_max_retries,
      DEFAULT_CONCORDIA_OPERATIONS.proxyActionMaxRetries,
    ),
    proxyRetryDelaySeconds: clampPositiveNumber(
      config.proxy_retry_delay_seconds,
      DEFAULT_CONCORDIA_OPERATIONS.proxyRetryDelaySeconds,
    ),
  };
}

export function resolveRunBudget(
  request: LaunchRequest,
  operations: ConcordiaResolvedOperationsConfig,
): ConcordiaRunBudget {
  return {
    act_timeout_ms: clampPositiveInteger(
      request.run_budget?.act_timeout_ms,
      operations.actTimeoutMs,
    ),
    proxy_action_timeout_seconds: clampPositiveNumber(
      request.run_budget?.proxy_action_timeout_seconds,
      operations.proxyActionTimeoutSeconds,
    ),
    proxy_action_max_retries: clampPositiveInteger(
      request.run_budget?.proxy_action_max_retries,
      operations.proxyActionMaxRetries,
    ),
    proxy_retry_delay_seconds: clampPositiveNumber(
      request.run_budget?.proxy_retry_delay_seconds,
      operations.proxyRetryDelaySeconds,
    ),
    simultaneous_max_workers: clampPositiveInteger(
      request.run_budget?.simultaneous_max_workers,
      operations.simultaneousMaxWorkers,
    ),
  };
}

export function isActiveSimulationStatus(
  status: SimulationLifecycleStatus,
): boolean {
  return (
    status === "launching" ||
    status === "running" ||
    status === "paused" ||
    status === "stopping"
  );
}

export function isTerminalSimulationStatus(
  status: SimulationLifecycleStatus,
): boolean {
  return (
    status === "stopped" ||
    status === "finished" ||
    status === "failed" ||
    status === "archived" ||
    status === "deleted"
  );
}

export function buildOperationalMetricsSnapshot(
  registry: Pick<
    SimulationRegistry,
    | "countActiveHandles"
    | "countHistoricalHandles"
    | "countStuckHandles"
    | "getPendingResponseCount"
    | "getReplayBufferEventCount"
    | "getReservedPortCount"
    | "getCheckpointCount"
    | "getConfiguredThreadBudgetCount"
  >,
  operations: ConcordiaResolvedOperationsConfig,
  counters: {
    readonly launchRequests: number;
    readonly rejectedLaunches: number;
  },
): ConcordiaOperationalMetrics {
  return {
    max_concurrent_simulations: operations.maxConcurrentSimulations,
    max_historical_simulations: operations.maxHistoricalSimulations,
    archived_simulation_retention_ms: operations.archivedSimulationRetentionMs,
    replay_buffer_limit: operations.replayBufferLimit,
    archived_replay_event_limit: operations.archivedReplayEventLimit,
    runner_startup_timeout_ms: operations.runnerStartupTimeoutMs,
    runner_shutdown_timeout_ms: operations.runnerShutdownTimeoutMs,
    step_stuck_timeout_ms: operations.stepStuckTimeoutMs,
    act_timeout_ms: operations.actTimeoutMs,
    generate_agents_timeout_ms: operations.generateAgentsTimeoutMs,
    simultaneous_max_workers: operations.simultaneousMaxWorkers,
    proxy_action_timeout_seconds: operations.proxyActionTimeoutSeconds,
    proxy_action_max_retries: operations.proxyActionMaxRetries,
    proxy_retry_delay_seconds: operations.proxyRetryDelaySeconds,
    active_simulations: registry.countActiveHandles(),
    historical_simulations: registry.countHistoricalHandles(),
    stuck_simulations: registry.countStuckHandles(operations.stepStuckTimeoutMs),
    pending_action_count: registry.getPendingResponseCount(),
    replay_buffer_events: registry.getReplayBufferEventCount(),
    reserved_port_count: registry.getReservedPortCount(),
    configured_thread_budget: registry.getConfiguredThreadBudgetCount(),
    checkpoint_volume: registry.getCheckpointCount(),
    launch_requests: counters.launchRequests,
    rejected_launches: counters.rejectedLaunches,
  };
}
