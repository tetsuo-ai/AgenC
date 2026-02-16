/**
 * CLI command handler for gateway log tailing.
 *
 * The daemon process logs to stdout/stderr by default. This command checks
 * for a running daemon and provides guidance on how to view logs depending
 * on the daemon's run mode (foreground, systemd, or background).
 *
 * @module
 */

import { readPidFile, isProcessAlive } from '../gateway/daemon.js';
import type { CliRuntimeContext, CliStatusCode, LogsOptions } from './types.js';

// ============================================================================
// logs
// ============================================================================

export async function runLogsCommand(
  context: CliRuntimeContext,
  options: LogsOptions,
): Promise<CliStatusCode> {
  const info = await readPidFile(options.pidPath);

  if (info === null) {
    context.error({
      status: 'error',
      command: 'logs',
      message: 'Daemon is not running (no PID file found)',
      hint: 'Start the daemon with: agenc-runtime start --config <path>',
    });
    return 1;
  }

  if (!isProcessAlive(info.pid)) {
    context.error({
      status: 'error',
      command: 'logs',
      message: `Daemon is not running (stale PID ${info.pid})`,
      hint: 'Start the daemon with: agenc-runtime start --config <path>',
    });
    return 1;
  }

  // The daemon process logs to stdout/stderr. When running as a background
  // process, stdio is detached. Provide instructions for the appropriate
  // logging method based on how the daemon was started.
  context.output({
    status: 'ok',
    command: 'logs',
    pid: info.pid,
    port: info.port,
    message: 'Gateway daemon logs to stdout/stderr. Use one of the following methods to view logs:',
    methods: [
      {
        mode: 'foreground',
        command: `agenc-runtime start --foreground --config ${info.configPath}`,
        description: 'Run in foreground to see logs directly in the terminal',
      },
      {
        mode: 'systemd',
        command: `journalctl --user -u agenc -f${options.lines ? ` -n ${options.lines}` : ''}`,
        description: 'View logs from systemd journal (if installed as a service)',
      },
      {
        mode: 'launchd',
        command: 'cat ~/Library/Logs/com.agenc.daemon.log',
        description: 'View logs from launchd (macOS, if installed as a service)',
      },
    ],
    ...(options.sessionId ? { sessionFilter: options.sessionId } : {}),
  });

  return 0;
}
