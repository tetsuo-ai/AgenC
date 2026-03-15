import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import { getDefaultConfigPath, loadGatewayConfig } from "../gateway/config-watcher.js";
import { getDefaultPidPath, isProcessAlive, readPidFile } from "../gateway/daemon.js";
import {
  findDaemonProcessesByIdentity,
  runStartCommand,
  type DaemonIdentityMatch,
} from "./daemon.js";
import type {
  CliLogger,
  CliOutputFormat,
  CliRuntimeContext,
  CliStatusCode,
  DaemonStartOptions,
} from "./types.js";

export interface OperatorConsoleOptions {
  configPath?: string;
  pidPath?: string;
  logLevel?: string;
  yolo?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface GatewayPidInfo {
  readonly pid: number;
  readonly port: number;
  readonly configPath: string;
}

interface SpawnedProcess {
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface SpawnProcessOptions {
  stdio: "inherit";
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface OperatorConsoleDeps {
  readonly defaultConfigPath: () => string;
  readonly defaultPidPath: () => string;
  readonly loadGatewayConfig: typeof loadGatewayConfig;
  readonly readPidFile: typeof readPidFile;
  readonly isProcessAlive: typeof isProcessAlive;
  readonly runStartCommand: (
    context: CliRuntimeContext,
    options: DaemonStartOptions,
  ) => Promise<CliStatusCode>;
  readonly findDaemonProcessesByIdentity: (
    params: {
      pidPath?: string;
      configPath?: string;
    },
  ) => Promise<readonly DaemonIdentityMatch[]>;
  readonly resolveConsoleEntryPath: () => string | null;
  readonly resolveOperatorEventsModulePath: () => string | null;
  readonly spawnProcess: (
    command: string,
    args: string[],
    options: SpawnProcessOptions,
  ) => SpawnedProcess;
  readonly processExecPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly createLogger: typeof createLogger;
}

const DEFAULT_DEPS: OperatorConsoleDeps = {
  defaultConfigPath: getDefaultConfigPath,
  defaultPidPath: getDefaultPidPath,
  loadGatewayConfig,
  readPidFile,
  isProcessAlive,
  runStartCommand,
  findDaemonProcessesByIdentity,
  resolveConsoleEntryPath,
  resolveOperatorEventsModulePath,
  spawnProcess: spawn,
  processExecPath: process.execPath,
  cwd: process.cwd(),
  env: process.env,
  createLogger,
};

function deriveProjectWatchClientKey(launchCwd: string): string {
  const resolvedCwd = resolve(launchCwd);
  const normalizedCwd = existsSync(resolvedCwd)
    ? realpathSync.native(resolvedCwd)
    : resolvedCwd;
  const baseName = basename(normalizedCwd)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "workspace";
  const digest = createHash("sha256")
    .update(normalizedCwd)
    .digest("hex")
    .slice(0, 12);
  return `agenc-${baseName}-${digest}`;
}

function resolveConsoleEntryPath(): string | null {
  const candidates = [
    resolve(dirname(__filename), "..", "bin", "agenc-watch.js"),
    resolve(dirname(__filename), "..", "..", "..", "scripts", "agenc-watch.mjs"),
    resolve(process.cwd(), "scripts", "agenc-watch.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveOperatorEventsModulePath(): string | null {
  const candidates = [
    resolve(dirname(__filename), "..", "operator-events.mjs"),
    resolve(process.cwd(), "runtime", "dist", "operator-events.mjs"),
    resolve(process.cwd(), "dist", "operator-events.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
  }
  return null;
}

function createSilentContext(logger: CliLogger): {
  context: CliRuntimeContext;
  getLastError: () => string | null;
} {
  let lastError: string | null = null;
  const outputFormat: CliOutputFormat = "json";
  return {
    context: {
      logger,
      output: () => {
        // console launcher should stay quiet on success
      },
      error: (value) => {
        lastError = extractMessage(value) ?? lastError;
      },
      outputFormat,
    },
    getLastError: () => lastError,
  };
}

async function ensureDaemon(
  options: Required<Pick<OperatorConsoleOptions, "configPath" | "pidPath">> &
    Pick<OperatorConsoleOptions, "logLevel" | "yolo">,
  deps: OperatorConsoleDeps,
): Promise<GatewayPidInfo> {
  const configPath = resolve(options.configPath);
  const pidPath = resolve(options.pidPath);
  const config = await deps.loadGatewayConfig(configPath);
  const running = await deps.readPidFile(pidPath);
  if (running && deps.isProcessAlive(running.pid)) {
    const runningConfigPath = resolve(running.configPath);
    if (runningConfigPath !== configPath) {
      throw new Error(
        `daemon already running with config ${runningConfigPath}; stop it or use the matching --config`,
      );
    }
    return {
      pid: running.pid,
      port: running.port ?? config.gateway.port,
      configPath: running.configPath,
    };
  }

  const existingDaemons = await deps.findDaemonProcessesByIdentity({
    pidPath,
    configPath,
  });
  if (existingDaemons.length > 1) {
    throw new Error(
      `multiple daemon processes already match this config/pid-path (${existingDaemons.map((entry) => entry.pid).join(", ")}); run \`restart\` to recover`,
    );
  }
  const existingDaemon = existingDaemons[0];
  if (existingDaemon) {
    if (existingDaemon.matchedConfigPath) {
      return {
        pid: existingDaemon.pid,
        port: config.gateway.port,
        configPath,
      };
    }
    throw new Error(
      `daemon already running with config ${existingDaemon.configPath ?? "<unknown>"}; stop it or use the matching --config`,
    );
  }

  const logger = deps.createLogger("warn", "[AgenC]");
  const { context, getLastError } = createSilentContext(logger);
  const code = await deps.runStartCommand(context, {
    configPath,
    pidPath,
    foreground: false,
    logLevel: options.logLevel,
    yolo: options.yolo,
  });
  if (code !== 0) {
    throw new Error(getLastError() ?? "failed to start daemon");
  }

  const started = await deps.readPidFile(pidPath);
  return {
    pid: started?.pid ?? 0,
    port: started?.port ?? config.gateway.port,
    configPath: started?.configPath ?? configPath,
  };
}

async function launchConsoleProcess(
  port: number,
  options: OperatorConsoleOptions,
  deps: OperatorConsoleDeps,
): Promise<CliStatusCode> {
  const consoleEntryPath = deps.resolveConsoleEntryPath();
  if (!consoleEntryPath) {
    throw new Error(
      "unable to locate the operator console entrypoint (expected scripts/agenc-watch.mjs)",
    );
  }
  const operatorEventsModulePath = deps.resolveOperatorEventsModulePath();
  if (!operatorEventsModulePath) {
    throw new Error(
      "unable to locate the built operator event contract (expected runtime/dist/operator-events.mjs); run `npm --prefix runtime run build`",
    );
  }

  const launchCwd = resolve(options.cwd ?? deps.cwd);
  const mergedEnv: NodeJS.ProcessEnv = {
    ...deps.env,
    ...options.env,
    AGENC_WATCH_WS_URL: `ws://127.0.0.1:${port}`,
    AGENC_WATCH_OPERATOR_EVENTS_MODULE: operatorEventsModulePath,
    AGENC_WATCH_PROJECT_ROOT: launchCwd,
  };
  const explicitClientKey = mergedEnv.AGENC_WATCH_CLIENT_KEY?.trim();
  if (!explicitClientKey) {
    mergedEnv.AGENC_WATCH_CLIENT_KEY = deriveProjectWatchClientKey(launchCwd);
  }

  const child = deps.spawnProcess(
    deps.processExecPath,
    [consoleEntryPath],
    {
      stdio: "inherit",
      cwd: launchCwd,
      env: mergedEnv,
    },
  );

  return await new Promise<CliStatusCode>((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code === 0 ? 0 : 1);
    });
  });
}

export async function runOperatorConsole(
  options: OperatorConsoleOptions = {},
  deps: OperatorConsoleDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const configPath = options.configPath ?? deps.defaultConfigPath();
  const pidPath = options.pidPath ?? deps.defaultPidPath();

  // Try to resolve port from existing daemon first (instant if already running).
  const config = await deps.loadGatewayConfig(resolve(configPath));
  const running = await deps.readPidFile(resolve(pidPath));
  const alreadyRunning = running && deps.isProcessAlive(running.pid);
  const port = running?.port ?? config.gateway.port;

  if (alreadyRunning) {
    return launchConsoleProcess(port, options, deps);
  }

  // Daemon not running — launch the TUI immediately with the expected port
  // so the user sees the loading/connecting screen instead of a blank terminal.
  // Start the daemon in the background; the TUI will reconnect when it's ready.
  const consolePromise = launchConsoleProcess(port, options, deps);

  // Fire-and-forget daemon start — the TUI handles reconnection.
  ensureDaemon(
    { configPath, pidPath, logLevel: options.logLevel, yolo: options.yolo },
    deps,
  ).catch(() => {
    // If daemon fails to start, the TUI will show a connection error
    // and the user can diagnose from there.
  });

  return consolePromise;
}
