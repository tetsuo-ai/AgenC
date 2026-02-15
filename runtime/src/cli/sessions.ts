/**
 * Session management CLI commands.
 *
 * @module
 */

import type { CliRuntimeContext, GatewayCommandOptions, SessionsKillOptions } from './types.js';
import type { GatewayConfig } from '../gateway/types.js';
import {
  getDefaultConfigPath,
  loadGatewayConfig,
} from '../gateway/config-watcher.js';
import { queryControlPlane } from './gateway-commands.js';

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

// queryControlPlane is imported from gateway-commands.ts (shared utility)
