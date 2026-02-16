/**
 * CLI command handlers for gateway session management: list and kill.
 *
 * Sessions correspond to WebSocket control plane client connections.
 * Commands communicate with the running daemon via the control plane.
 *
 * @module
 */

import { readPidFile, isProcessAlive } from '../gateway/daemon.js';
import type { CliRuntimeContext, CliStatusCode, SessionsListOptions, SessionsKillOptions } from './types.js';

const CONTROL_PLANE_TIMEOUT_MS = 3_000;

// ============================================================================
// Control plane query helper
// ============================================================================

interface SessionInfo {
  id: string;
  connected: boolean;
}

async function queryControlPlaneSessions(
  port: number,
  type: 'sessions' | 'sessions.kill',
  payload?: unknown,
): Promise<{ payload?: unknown; error?: string }> {
  type WsLike = { on(e: string, h: (...a: unknown[]) => void): void; send(d: string): void; close(): void };
  let WsConstructor: new (url: string) => WsLike;
  try {
    const wsModule = await import('ws') as { default: new (url: string) => WsLike };
    WsConstructor = wsModule.default;
  } catch {
    throw new Error('ws module not available');
  }

  return new Promise<{ payload?: unknown; error?: string }>((resolvePromise, rejectPromise) => {
    const ws = new WsConstructor(`ws://127.0.0.1:${port}`);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      rejectPromise(new Error('Control plane connection timeout'));
    }, CONTROL_PLANE_TIMEOUT_MS);

    const resolve = (val: { payload?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(val);
    };

    const reject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    };

    ws.on('open', () => {
      const msg: Record<string, unknown> = { type };
      if (payload !== undefined) msg.payload = payload;
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data: unknown) => {
      try {
        const parsed = JSON.parse(String(data)) as { payload?: unknown; error?: string };
        ws.close();
        resolve(parsed);
      } catch {
        ws.close();
        resolve({ error: 'Invalid response' });
      }
    });

    ws.on('close', () => {
      resolve({ error: 'Connection closed' });
    });

    ws.on('error', () => {
      reject(new Error('Control plane connection failed'));
    });
  });
}

// ============================================================================
// Resolve daemon port from PID file
// ============================================================================

async function resolveDaemonPort(
  pidPath: string,
  overridePort?: number,
): Promise<{ port: number } | { error: string }> {
  const info = await readPidFile(pidPath);
  if (info === null) {
    return { error: 'Daemon is not running (no PID file found)' };
  }
  if (!isProcessAlive(info.pid)) {
    return { error: `Daemon is not running (stale PID ${info.pid})` };
  }
  return { port: overridePort ?? info.port };
}

// ============================================================================
// sessions list
// ============================================================================

export async function runSessionsListCommand(
  context: CliRuntimeContext,
  options: SessionsListOptions,
): Promise<CliStatusCode> {
  const portResult = await resolveDaemonPort(options.pidPath, options.controlPlanePort);
  if ('error' in portResult) {
    context.error({
      status: 'error',
      command: 'sessions.list',
      message: portResult.error,
    });
    return 1;
  }

  let response: { payload?: unknown; error?: string };
  try {
    response = await queryControlPlaneSessions(portResult.port, 'sessions');
  } catch (err) {
    context.error({
      status: 'error',
      command: 'sessions.list',
      message: `Failed to query control plane: ${(err as Error).message}`,
    });
    return 1;
  }

  if (response.error) {
    context.error({
      status: 'error',
      command: 'sessions.list',
      message: response.error,
    });
    return 1;
  }

  const sessions = (response.payload ?? []) as SessionInfo[];

  context.output({
    status: 'ok',
    command: 'sessions.list',
    sessions,
    count: sessions.length,
  });

  return 0;
}

// ============================================================================
// sessions kill
// ============================================================================

export async function runSessionsKillCommand(
  context: CliRuntimeContext,
  options: SessionsKillOptions,
): Promise<CliStatusCode> {
  const portResult = await resolveDaemonPort(options.pidPath, options.controlPlanePort);
  if ('error' in portResult) {
    context.error({
      status: 'error',
      command: 'sessions.kill',
      message: portResult.error,
    });
    return 1;
  }

  let response: { payload?: unknown; error?: string };
  try {
    response = await queryControlPlaneSessions(
      portResult.port,
      'sessions.kill',
      { sessionId: options.sessionId },
    );
  } catch (err) {
    context.error({
      status: 'error',
      command: 'sessions.kill',
      message: `Failed to query control plane: ${(err as Error).message}`,
    });
    return 1;
  }

  if (response.error) {
    context.error({
      status: 'error',
      command: 'sessions.kill',
      message: response.error,
      sessionId: options.sessionId,
    });
    return 1;
  }

  context.output({
    status: 'ok',
    command: 'sessions.kill',
    killed: options.sessionId,
  });

  return 0;
}
