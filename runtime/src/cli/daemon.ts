/**
 * CLI command handlers for daemon lifecycle: start, stop, restart, status, service install.
 *
 * @module
 */

import { fork } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import {
  checkStalePid,
  readPidFile,
  removePidFile,
  isProcessAlive,
  pidFileExists,
  DaemonManager,
  generateSystemdUnit,
  generateLaunchdPlist,
} from '../gateway/daemon.js';
import { loadGatewayConfig, getDefaultConfigPath } from '../gateway/config-watcher.js';
import { sleep, toErrorMessage } from '../utils/async.js';
import type { CliRuntimeContext, CliStatusCode } from './types.js';
import type {
  DaemonStartOptions,
  DaemonStopOptions,
  DaemonStatusOptions,
  ServiceInstallOptions,
} from './types.js';

const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_TIMEOUT_MS = 3_000;
const STOP_POLL_INTERVAL_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 3_000;

function getDaemonEntryPath(): string {
  // __filename is native in CJS; tsup injects a shim for ESM output
  return resolve(dirname(__filename), '..', 'bin', 'daemon.js');
}

// ============================================================================
// start
// ============================================================================

export async function runStartCommand(
  context: CliRuntimeContext,
  options: DaemonStartOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath);

  // Check for existing daemon
  const stale = await checkStalePid(options.pidPath);
  if (stale.status === 'alive') {
    context.error({
      status: 'error',
      command: 'start',
      message: `Daemon already running (pid ${stale.pid})`,
    });
    return 1;
  }
  if (stale.status === 'stale') {
    context.logger.warn(`Cleaning stale PID file (pid ${stale.pid} not running)`);
    await removePidFile(options.pidPath);
  }

  // Validate config before starting
  try {
    await loadGatewayConfig(configPath);
  } catch (error) {
    context.error({
      status: 'error',
      command: 'start',
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
  });

  try {
    await dm.start();
    context.output({
      status: 'ok',
      command: 'start',
      mode: 'foreground',
      pid: process.pid,
    });

    // Block until the process is terminated by signal
    await new Promise<void>(() => {
      // Intentionally never resolves — signals handle exit
    });
    return 0;
  } catch (error) {
    context.error({
      status: 'error',
      command: 'start',
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
  const args = ['--config', configPath];
  if (options.pidPath) {
    args.push('--pid-path', options.pidPath);
  }
  if (options.logLevel) {
    args.push('--log-level', options.logLevel);
  }

  const child = fork(daemonEntry, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const childPid = child.pid;
  if (childPid === undefined) {
    context.error({
      status: 'error',
      command: 'start',
      message: 'Failed to fork daemon process',
    });
    return 1;
  }

  // Poll for PID file to confirm startup
  const deadline = Date.now() + STARTUP_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(STARTUP_POLL_INTERVAL_MS);
    if (await pidFileExists(options.pidPath)) {
      const info = await readPidFile(options.pidPath);
      if (info !== null) {
        context.output({
          status: 'ok',
          command: 'start',
          mode: 'daemon',
          pid: info.pid,
          port: info.port,
        });
        return 0;
      }
    }
  }

  context.error({
    status: 'error',
    command: 'start',
    message: `Daemon forked (pid ${childPid}) but PID file not found within ${STARTUP_POLL_TIMEOUT_MS}ms`,
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
  if (info === null || !isProcessAlive(info.pid)) {
    if (info !== null) {
      await removePidFile(options.pidPath);
    }
    context.output({
      status: 'ok',
      command: 'stop',
      message: 'Daemon is not running',
      wasRunning: false,
    });
    return 0;
  }

  const pid = info.pid;
  const timeout = options.timeout ?? DEFAULT_STOP_TIMEOUT_MS;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await removePidFile(options.pidPath);
    context.output({
      status: 'ok',
      command: 'stop',
      pid,
      message: 'Process already exited',
      wasRunning: false,
    });
    return 0;
  }

  // Poll until process exits
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(STOP_POLL_INTERVAL_MS);
    if (!isProcessAlive(pid)) {
      await removePidFile(options.pidPath);
      context.output({
        status: 'ok',
        command: 'stop',
        pid,
        wasRunning: true,
      });
      return 0;
    }
  }

  // Timeout: force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCH — already dead
  }
  await removePidFile(options.pidPath);

  context.output({
    status: 'ok',
    command: 'stop',
    pid,
    message: 'Process did not exit gracefully; sent SIGKILL',
    wasRunning: true,
    forced: true,
  });
  return 1;
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
      status: 'ok',
      command: 'status',
      running: false,
    });
    return 0;
  }

  if (!isProcessAlive(info.pid)) {
    await removePidFile(options.pidPath);
    context.output({
      status: 'ok',
      command: 'status',
      running: false,
      message: 'Stale PID file cleaned up',
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
    status: 'ok',
    command: 'status',
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
  let WsConstructor: new (url: string) => import('ws');
  try {
    const wsModule = await import('ws') as { default: new (url: string) => import('ws') };
    WsConstructor = wsModule.default;
  } catch {
    return null;
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WsConstructor(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => {
      ws.close();
      rejectPromise(new Error('Control plane connection timeout'));
    }, CONTROL_PLANE_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'status' }));
    });

    ws.on('message', (data: Buffer | string) => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(String(data));
        ws.close();
        resolvePromise(parsed?.payload ?? parsed);
      } catch {
        ws.close();
        resolvePromise(null);
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      rejectPromise(new Error('Control plane connection failed'));
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
    const plist = generateLaunchdPlist({ execStart });
    context.output({
      status: 'ok',
      command: 'service.install',
      platform: 'launchd',
      template: plist,
    });
  } else {
    const unit = generateSystemdUnit({ execStart });
    context.output({
      status: 'ok',
      command: 'service.install',
      platform: 'systemd',
      template: unit,
    });
  }

  return 0;
}
