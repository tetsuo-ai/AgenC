#!/usr/bin/env node
/**
 * Daemon entry point. Forked by `agenc start` or run directly with `--foreground`.
 */

import { DaemonManager } from '../gateway/daemon.js';
import { createLogger } from '../utils/logger.js';
import { toErrorMessage } from '../utils/async.js';
import type { LogLevel } from '../utils/logger.js';

function notifyParent(message: Record<string, unknown>): void {
  if (typeof process.send !== "function") return;
  try {
    process.send(message);
  } catch {
    // Best-effort readiness signal for daemonized startup.
  }
}

function parseArgs(argv: string[]): {
  config?: string;
  pidPath?: string;
  logLevel?: string;
  yolo?: boolean;
} {
  const result: {
    config?: string;
    pidPath?: string;
    logLevel?: string;
    yolo?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      result.config = argv[++i];
    } else if (argv[i] === '--pid-path' && argv[i + 1]) {
      result.pidPath = argv[++i];
    } else if (argv[i] === '--log-level' && argv[i + 1]) {
      result.logLevel = argv[++i];
    } else if (argv[i] === "--yolo") {
      result.yolo = true;
    }
  }
  return result;
}

void (async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.config) {
    console.error('--config <path> is required');
    process.exitCode = 1;
    return;
  }

  const logLevel = (args.logLevel ?? 'info') as LogLevel;
  const logger = createLogger(logLevel, '[AgenC Daemon]');

  const dm = new DaemonManager({
    configPath: args.config,
    pidPath: args.pidPath,
    logger,
    yolo: args.yolo,
  });

  try {
    await dm.start();
    notifyParent({
      type: "daemon.ready",
      pid: process.pid,
      configPath: args.config,
    });
    // Process stays alive via Gateway's WebSocket server holding the event loop open.
    // Signal handlers (SIGTERM/SIGINT) call dm.stop() → process.exit().
  } catch (error) {
    notifyParent({
      type: "daemon.startup_error",
      pid: process.pid,
      message: toErrorMessage(error),
      configPath: args.config,
    });
    console.error('Daemon startup failed:', toErrorMessage(error));
    process.exitCode = 1;
  }
})();
