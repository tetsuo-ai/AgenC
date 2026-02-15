/**
 * Session management CLI commands.
 *
 * @module
 */

import { WebSocket } from 'ws';
import type { CliRuntimeContext, GatewayCommandOptions, SessionsKillOptions } from './types.js';
import type { GatewayConfig, ControlResponse } from '../gateway/types.js';
import {
  getDefaultConfigPath,
  loadGatewayConfig,
} from '../gateway/config-watcher.js';

type CliStatusCode = 0 | 1 | 2;

// ============================================================================
// sessions list
// ============================================================================

export async function runSessionsListCommand(
  context: CliRuntimeContext,
  options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch {
    context.output({
      status: 'ok',
      command: 'sessions.list',
      sessions: [],
      message: 'Config not found or invalid — no sessions available',
    });
    return 0;
  }

  const port = config.gateway.port;
  const bind = config.gateway.bind ?? '127.0.0.1';
  const wsUrl = `ws://${bind}:${port}`;

  try {
    const response = await queryControlPlane(wsUrl, { type: 'status' });
    const payload = response.payload as Record<string, unknown> | undefined;
    context.output({
      status: 'ok',
      command: 'sessions.list',
      sessions: payload?.activeSessions ?? [],
      gateway: payload,
    });
    return 0;
  } catch {
    context.output({
      status: 'ok',
      command: 'sessions.list',
      sessions: [],
      message: `No gateway responding on ${wsUrl}`,
    });
    return 0;
  }
}

// ============================================================================
// sessions kill (stub)
// ============================================================================

export async function runSessionsKillCommand(
  context: CliRuntimeContext,
  options: SessionsKillOptions,
): Promise<CliStatusCode> {
  context.output({
    status: 'ok',
    command: 'sessions.kill',
    sessionId: options.sessionId,
    message: 'Session kill not yet implemented (requires extended control plane — Phase 2.4)',
  });
  return 0;
}

// ============================================================================
// Control plane query helper
// ============================================================================

function queryControlPlane(
  wsUrl: string,
  message: { type: string; id?: string },
  timeoutMs = 5000,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Control plane query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(message));
    });

    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(String(data)) as ControlResponse;
        ws.close();
        resolve(response);
      } catch (err) {
        ws.close();
        reject(new Error(`Invalid control plane response: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
