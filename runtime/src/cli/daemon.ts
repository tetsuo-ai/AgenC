/**
 * CLI command handlers for daemon lifecycle: start, stop, restart, status, service install.
 *
 * @module
 */

import { execFile, fork } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import {
  checkStalePid,
  readPidFile,
  removePidFile,
  isProcessAlive,
  pidFileExists,
  DaemonManager,
  generateSystemdUnit,
  generateLaunchdPlist,
} from "../gateway/daemon.js";
import {
  loadGatewayConfig,
  getDefaultConfigPath,
} from "../gateway/config-watcher.js";
import { sleep, toErrorMessage } from "../utils/async.js";
import { createLogger } from "../utils/logger.js";
import type { CliRuntimeContext, CliStatusCode } from "./types.js";
import type {
  DaemonStartOptions,
  DaemonStopOptions,
  DaemonStatusOptions,
  ServiceInstallOptions,
} from "./types.js";

const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_TIMEOUT_MS = 3_000;
const STOP_POLL_INTERVAL_MS = 200;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_LOG_FILE = "daemon.log";
const PROCESS_SCAN_TIMEOUT_MS = 5_000;

function getDaemonEntryPath(): string {
  // Requires tsup's __filename shim when built as ESM (see tsup.config).
  // Running source directly with tsx/ts-node also provides __filename.
  return resolve(dirname(__filename), "..", "bin", "daemon.js");
}

function getDaemonLogPath(): string {
  return process.env.AGENC_DAEMON_LOG_PATH ??
    join(homedir(), ".agenc", DEFAULT_DAEMON_LOG_FILE);
}

interface DaemonProcessEntry {
  readonly pid: number;
  readonly args: string;
}

async function listProcesses(): Promise<readonly DaemonProcessEntry[]> {
  return new Promise((resolvePromise) => {
    execFile(
      "ps",
      ["-eo", "pid=,args="],
      { timeout: PROCESS_SCAN_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolvePromise([]);
          return;
        }

        const rows = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        const entries: DaemonProcessEntry[] = [];
        for (const row of rows) {
          const match = /^(\d+)\s+(.+)$/.exec(row);
          if (!match) continue;
          const pid = Number.parseInt(match[1], 10);
          if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
          entries.push({ pid, args: match[2] });
        }

        resolvePromise(entries);
      },
    );
  });
}

function looksLikeRuntimeDaemonProcess(args: string): boolean {
  return (
    args.includes("/runtime/dist/bin/daemon.js") ||
    args.includes("/runtime/src/bin/daemon.ts")
  );
}

function commandLineHasFlagValue(args: string, flag: string, value: string): boolean {
  if (!value) return false;
  return (
    args.includes(`${flag} ${value}`) ||
    args.includes(`${flag}=${value}`)
  );
}

async function findDaemonPidsByIdentity(params: {
  pidPath?: string;
  configPath?: string;
}): Promise<readonly number[]> {
  const entries = await listProcesses();
  const matching = entries.filter((entry) => {
    if (!looksLikeRuntimeDaemonProcess(entry.args)) return false;
    if (
      params.pidPath &&
      commandLineHasFlagValue(entry.args, "--pid-path", params.pidPath)
    ) {
      return true;
    }
    if (
      params.configPath &&
      commandLineHasFlagValue(entry.args, "--config", params.configPath)
    ) {
      return true;
    }
    return false;
  });
  return matching.map((entry) => entry.pid);
}

async function signalPids(
  pids: readonly number[],
  signal: NodeJS.Signals,
): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore races (already exited)
    }
  }
}

function uniquePids(pids: readonly number[]): number[] {
  return Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)));
}

// ============================================================================
// start
// ============================================================================

export async function runStartCommand(
  context: CliRuntimeContext,
  options: DaemonStartOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath);

  const conflicting = await findDaemonPidsByIdentity({
    pidPath: options.pidPath,
    configPath,
  });
  if (conflicting.length > 0) {
    context.error({
      status: "error",
      command: "start",
      message:
        `Detected existing daemon process(es) for this config/pid-path: ${conflicting.join(", ")}. ` +
        "Run `stop` or `restart` first to avoid duplicate daemons.",
    });
    return 1;
  }

  // Check for existing daemon
  const stale = await checkStalePid(options.pidPath);
  if (stale.status === "alive") {
    context.error({
      status: "error",
      command: "start",
      message: `Daemon already running (pid ${stale.pid})`,
    });
    return 1;
  }
  if (stale.status === "stale") {
    context.logger.warn(
      `Cleaning stale PID file (pid ${stale.pid} not running)`,
    );
    await removePidFile(options.pidPath);
  }

  // Validate config before starting
  try {
    await loadGatewayConfig(configPath);
  } catch (error) {
    context.error({
      status: "error",
      command: "start",
      message: `Invalid config: ${toErrorMessage(error)}`,
    });
    return 1;
  }

  if (options.foreground) {
    return runForeground(context, configPath, options);
  }

  return runDaemonized(context, configPath, options);
}

async function runForeground(
  context: CliRuntimeContext,
  configPath: string,
  options: DaemonStartOptions,
): Promise<CliStatusCode> {
  const dm = new DaemonManager({
    configPath,
    pidPath: options.pidPath,
    logger: createLogger("debug"),
  });

  try {
    await dm.start();
    context.output({
      status: "ok",
      command: "start",
      mode: "foreground",
      pid: process.pid,
    });

    // Block until terminated: DaemonManager.setupSignalHandlers() registers
    // SIGTERM/SIGINT handlers that call stop() then process.exit(), so this
    // promise intentionally never resolves.
    await new Promise<void>(() => {});
    return 0; // Unreachable — process.exit() is called by signal handlers above
  } catch (error) {
    context.error({
      status: "error",
      command: "start",
      message: toErrorMessage(error),
    });
    return 1;
  }
}

async function runDaemonized(
  context: CliRuntimeContext,
  configPath: string,
  options: DaemonStartOptions,
): Promise<CliStatusCode> {
  const daemonEntry = getDaemonEntryPath();
  const args = ["--config", configPath];
  if (options.pidPath) {
    args.push("--pid-path", options.pidPath);
  }
  if (options.logLevel) {
    args.push("--log-level", options.logLevel);
  }

  let logFd: number | undefined;
  const logPath = getDaemonLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, "a");
  } catch (error) {
    context.logger.warn(
      `Failed to open daemon log at ${logPath}: ${toErrorMessage(error)}; falling back to stdio=ignore`,
    );
  }

  const child = fork(daemonEntry, args, {
    detached: true,
    // Keep IPC for exit tracking and attach stdout/stderr to a persistent log file.
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd, "ipc"],
  });
  if (logFd !== undefined) {
    closeSync(logFd);
  }
  child.unref();

  const closeIpc = (): void => {
    try {
      child.removeAllListeners("exit");
      if (child.connected) {
        child.disconnect();
      }
    } catch {
      // best effort
    }
  };

  const childPid = child.pid;
  if (childPid === undefined) {
    context.error({
      status: "error",
      command: "start",
      message: "Failed to fork daemon process",
    });
    return 1;
  }

  // Track early child exit so we can report crashes instead of waiting for timeout
  let childExited = false;
  let childExitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  // Poll for PID file to confirm startup
  const deadline = Date.now() + STARTUP_POLL_TIMEOUT_MS;
  let observedForeignPid: number | undefined;
  while (Date.now() < deadline) {
    await sleep(STARTUP_POLL_INTERVAL_MS);

    if (childExited) {
      closeIpc();
      context.error({
        status: "error",
        command: "start",
        message: `Daemon exited during startup (code ${childExitCode})`,
      });
      return 1;
    }

    if (await pidFileExists(options.pidPath)) {
      const info = await readPidFile(options.pidPath);
      if (info !== null) {
        if (info.pid !== childPid) {
          if (isProcessAlive(info.pid)) {
            observedForeignPid = info.pid;
          }
          continue;
        }
        closeIpc();
        context.output({
          status: "ok",
          command: "start",
          mode: "daemon",
          pid: info.pid,
          port: info.port,
          ...(logFd !== undefined ? { logPath } : {}),
        });
        return 0;
      }
    }
  }

  closeIpc();
  context.error({
    status: "error",
    command: "start",
    message: observedForeignPid
      ? `Daemon forked (pid ${childPid}) but PID file stayed bound to a different live process (pid ${observedForeignPid}).`
      : `Daemon forked (pid ${childPid}) but PID file not found within ${STARTUP_POLL_TIMEOUT_MS}ms`,
  });
  return 1;
}

// ============================================================================
// stop
// ============================================================================

export async function runStopCommand(
  context: CliRuntimeContext,
  options: DaemonStopOptions,
): Promise<CliStatusCode> {
  const info = await readPidFile(options.pidPath);
  const pidFromFile = info?.pid;
  const siblingPids = await findDaemonPidsByIdentity({
    pidPath: options.pidPath,
    configPath: info?.configPath,
  });
  const targetPids = uniquePids([
    ...(pidFromFile !== undefined ? [pidFromFile] : []),
    ...siblingPids,
  ]);
  const aliveTargetPids = targetPids.filter((pid) => isProcessAlive(pid));
  if (aliveTargetPids.length === 0) {
    if (info !== null) {
      await removePidFile(options.pidPath);
    }
    context.output({
      status: "ok",
      command: "stop",
      message: "Daemon is not running",
      wasRunning: false,
    });
    return 0;
  }

  const timeout = options.timeout ?? DEFAULT_STOP_TIMEOUT_MS;
  await signalPids(aliveTargetPids, "SIGTERM");

  // Poll until process exits — immediate first check, then periodic
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const remaining = aliveTargetPids.filter((candidatePid) =>
      isProcessAlive(candidatePid),
    );
    if (remaining.length === 0) {
      await removePidFile(options.pidPath);
      context.output({
        status: "ok",
        command: "stop",
        pid: pidFromFile ?? aliveTargetPids[0],
        pids: aliveTargetPids,
        wasRunning: true,
      });
      return 0;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  // Timeout: force kill
  await signalPids(aliveTargetPids, "SIGKILL");
  await removePidFile(options.pidPath);

  context.output({
    status: "ok",
    command: "stop",
    pid: pidFromFile ?? aliveTargetPids[0],
    pids: aliveTargetPids,
    message: "Process did not exit gracefully; sent SIGKILL",
    wasRunning: true,
    forced: true,
  });
  return 0;
}

// ============================================================================
// restart
// ============================================================================

export async function runRestartCommand(
  context: CliRuntimeContext,
  startOptions: DaemonStartOptions,
  stopOptions: DaemonStopOptions,
): Promise<CliStatusCode> {
  // Stop (ignore "not running")
  await runStopCommand(context, stopOptions);
  // Start
  return runStartCommand(context, startOptions);
}

// ============================================================================
// status
// ============================================================================

export async function runStatusCommand(
  context: CliRuntimeContext,
  options: DaemonStatusOptions,
): Promise<CliStatusCode> {
  const info = await readPidFile(options.pidPath);

  if (info === null) {
    context.output({
      status: "ok",
      command: "status",
      running: false,
    });
    return 0;
  }

  if (!isProcessAlive(info.pid)) {
    await removePidFile(options.pidPath);
    context.output({
      status: "ok",
      command: "status",
      running: false,
      message: "Stale PID file cleaned up",
      stalePid: info.pid,
    });
    return 0;
  }

  const port = options.controlPlanePort ?? info.port;

  // Try connecting to control plane for detailed status
  let gatewayStatus: unknown = null;
  try {
    gatewayStatus = await queryControlPlane(port);
  } catch {
    // Control plane unavailable — report what we can from PID file
  }

  context.output({
    status: "ok",
    command: "status",
    running: true,
    pid: info.pid,
    port: info.port,
    configPath: info.configPath,
    gatewayStatus,
  });
  return 0;
}

async function queryControlPlane(port: number): Promise<unknown> {
  // Dynamic import to handle missing ws dependency
  type WsLike = {
    on(e: string, h: (...a: unknown[]) => void): void;
    send(d: string): void;
    close(): void;
  };
  let WsConstructor: new (url: string) => WsLike;
  try {
    const wsModule = (await import("ws")) as {
      default: new (url: string) => WsLike;
    };
    WsConstructor = wsModule.default;
  } catch {
    return null;
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WsConstructor(`ws://127.0.0.1:${port}`);
    let settled = false;

    const settle = (fn: (v: unknown) => void, val: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      ws.close();
      settle(rejectPromise, new Error("Control plane connection timeout"));
    }, CONTROL_PLANE_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "status" }));
    });

    ws.on("message", (data: unknown) => {
      try {
        const parsed = JSON.parse(String(data));
        ws.close();
        settle(resolvePromise, parsed?.payload ?? parsed);
      } catch {
        ws.close();
        settle(resolvePromise, null);
      }
    });

    ws.on("close", () => {
      settle(resolvePromise, null);
    });

    ws.on("error", () => {
      settle(rejectPromise, new Error("Control plane connection failed"));
    });
  });
}

// ============================================================================
// service install
// ============================================================================

export async function runServiceInstallCommand(
  context: CliRuntimeContext,
  options: ServiceInstallOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath ?? getDefaultConfigPath());
  const daemonEntry = getDaemonEntryPath();
  const execStart = `node ${daemonEntry} --config ${configPath} --foreground`;

  if (options.macos) {
    const plist = generateLaunchdPlist({
      programArguments: [
        "node",
        daemonEntry,
        "--config",
        configPath,
        "--foreground",
      ],
    });
    context.output({
      status: "ok",
      command: "service.install",
      platform: "launchd",
      template: plist,
    });
  } else {
    const unit = generateSystemdUnit({ execStart });
    context.output({
      status: "ok",
      command: "service.install",
      platform: "systemd",
      template: unit,
    });
  }

  return 0;
}
