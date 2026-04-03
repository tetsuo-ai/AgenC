import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAdapterLogger } from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig, LaunchRequest } from "./types.js";
import { withSimulationIdentity } from "./simulation-identity.js";

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_BRIDGE_PORT = 3200;
const DEFAULT_EVENT_PORT = 3201;
const DEFAULT_CONTROL_PORT = 3202;
const DEFAULT_ENGINE_TYPE = "simultaneous";
const DEFAULT_GM_MODEL = "grok-4-1-fast-non-reasoning";
const DEFAULT_GM_PROVIDER = "grok";
const DEFAULT_GM_PREFAB = "generic";
const DEFAULT_SIMULTANEOUS_MAX_WORKERS = 8;
const DEFAULT_PROXY_ACTION_TIMEOUT_SECONDS = 120;
const DEFAULT_PROXY_ACTION_MAX_RETRIES = 2;
const DEFAULT_PROXY_RETRY_DELAY_SECONDS = 2;
const STARTUP_POLL_INTERVAL_MS = 250;

export interface SpawnedSimulationRunner {
  readonly child: ChildProcess;
  readonly tempDir: string;
}

interface LaunchSimulationRunnerParams {
  readonly request: LaunchRequest;
  readonly config: Readonly<ConcordiaChannelConfig>;
  readonly logger: ChannelAdapterLogger;
  readonly runnerStartupTimeoutMs: number;
  readonly runnerShutdownTimeoutMs: number;
}

export async function launchSimulationRunner(
  params: LaunchSimulationRunnerParams,
): Promise<SpawnedSimulationRunner> {
  const repoRoot = resolveRunnerRepoRoot();
  const tempDir = await mkdtemp(join(tmpdir(), "agenc-concordia-"));
  const configPath = join(tempDir, "simulation-config.json");

  await writeRunnerConfig(configPath, buildRunnerPayload(params));

  let child: ChildProcess | null = null;
  try {
    child = spawnRunnerProcess(params, repoRoot, configPath);
    attachRunnerLogging(child, params.logger);
    await waitForControlServer(
      child,
      getControlPort(params.request),
      params.runnerStartupTimeoutMs,
    );
    return { child, tempDir };
  } catch (error) {
    await cleanupFailedRunnerLaunch(
      child,
      tempDir,
      params.runnerShutdownTimeoutMs,
    );
    throw error;
  }
}

function resolveRunnerRepoRoot(): string {
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return resolve(pluginDir, "..");
}

function buildRunnerPayload(
  params: LaunchSimulationRunnerParams,
) {
  const { request, config } = params;

  return withSimulationIdentity(
    {
      world_id: request.world_id,
      workspace_id: request.workspace_id,
      ...(request.user_id ? { user_id: request.user_id } : {}),
      premise: request.premise,
      agents: request.agents,
      max_steps: request.max_steps ?? DEFAULT_MAX_STEPS,
      gm_model: request.gm_model ?? DEFAULT_GM_MODEL,
      gm_provider: request.gm_provider ?? DEFAULT_GM_PROVIDER,
      gm_api_key: request.gm_api_key ?? "",
      gm_base_url: request.gm_base_url ?? "",
      event_port: request.event_port ?? DEFAULT_EVENT_PORT,
      control_port: request.control_port ?? DEFAULT_CONTROL_PORT,
      engine_type: request.engine_type ?? DEFAULT_ENGINE_TYPE,
      gm_prefab: request.gm_prefab ?? DEFAULT_GM_PREFAB,
      bridge_url: `http://127.0.0.1:${config.bridge_port ?? DEFAULT_BRIDGE_PORT}`,
      simultaneous_max_workers:
        request.run_budget?.simultaneous_max_workers ??
        config.simultaneous_max_workers ??
        DEFAULT_SIMULTANEOUS_MAX_WORKERS,
      proxy_action_timeout_seconds:
        request.run_budget?.proxy_action_timeout_seconds ??
        config.proxy_action_timeout_seconds ??
        DEFAULT_PROXY_ACTION_TIMEOUT_SECONDS,
      proxy_action_max_retries:
        request.run_budget?.proxy_action_max_retries ??
        config.proxy_action_max_retries ??
        DEFAULT_PROXY_ACTION_MAX_RETRIES,
      proxy_retry_delay_seconds:
        request.run_budget?.proxy_retry_delay_seconds ??
        config.proxy_retry_delay_seconds ??
        DEFAULT_PROXY_RETRY_DELAY_SECONDS,
    },
    {
      simulationId: request.simulation_id ?? null,
      lineageId: request.lineage_id ?? null,
      parentSimulationId: request.parent_simulation_id ?? null,
    },
  );
}

async function writeRunnerConfig(
  configPath: string,
  payload: unknown,
): Promise<void> {
  await writeFile(configPath, JSON.stringify(payload, null, 2), "utf-8");
}

function spawnRunnerProcess(
  params: LaunchSimulationRunnerParams,
  repoRoot: string,
  configPath: string,
): ChildProcess {
  return spawn(
    params.config.python_command ?? "python3",
    ["-m", "concordia_bridge.cli", "run-json", "--config-file", configPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function attachRunnerLogging(
  child: ChildProcess,
  logger: ChannelAdapterLogger,
): void {
  attachRunnerStreamLogger(child.stdout, logger, "stdout");
  attachRunnerStreamLogger(child.stderr, logger, "stderr");
}

async function cleanupFailedRunnerLaunch(
  child: ChildProcess | null,
  tempDir: string,
  timeoutMs: number,
): Promise<void> {
  await stopChildProcess(child, timeoutMs);
  await rm(tempDir, { recursive: true, force: true });
}

function getControlPort(request: LaunchRequest): number {
  return request.control_port ?? DEFAULT_CONTROL_PORT;
}

function attachRunnerStreamLogger(
  stream: NodeJS.ReadableStream | null,
  logger: ChannelAdapterLogger,
  fallbackSource: "stdout" | "stderr",
): void {
  if (!stream) {
    return;
  }

  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const rawLine of lines) {
      logRunnerLine(rawLine, logger, fallbackSource);
    }
  });
  stream.on("end", () => {
    if (buffered.trim().length > 0) {
      logRunnerLine(buffered, logger, fallbackSource);
    }
  });
}

function logRunnerLine(
  rawLine: string,
  logger: ChannelAdapterLogger,
  fallbackSource: "stdout" | "stderr",
): void {
  const line = rawLine.trim();
  if (line.length === 0) {
    return;
  }

  const prefixed = `[concordia-runner] ${line}`;
  if (/\bERROR\b/.test(line)) {
    logger.error?.(prefixed);
    return;
  }
  if (/\bWARN(?:ING)?\b/.test(line)) {
    logger.warn?.(prefixed);
    return;
  }
  if (/\bINFO\b/.test(line)) {
    logger.info?.(prefixed);
    return;
  }
  if (fallbackSource === "stderr") {
    logger.warn?.(prefixed);
    return;
  }
  logger.info?.(prefixed);
}

export async function stopSimulationRunner(
  runner: SpawnedSimulationRunner | null,
  timeoutMs = 2_000,
): Promise<void> {
  if (!runner) {
    return;
  }

  await stopChildProcess(runner.child, timeoutMs);
  await rm(runner.tempDir, { recursive: true, force: true });
}

async function stopChildProcess(
  child: ChildProcess | null,
  timeoutMs: number,
): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForControlServer(
  child: ChildProcess,
  controlPort: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Concordia runner exited early with code ${String(child.exitCode)}`,
      );
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${controlPort}/simulation/status`);
      if (resp.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for Concordia control server on port ${controlPort}`,
  );
}
