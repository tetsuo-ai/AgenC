/**
 * Gateway lifecycle, config management, and log commands for the CLI.
 *
 * Start/stop/restart/logs are stubs — actual daemon management is Phase 2.4.
 * Status connects to the control plane WebSocket for a live status query.
 *
 * @module
 */

import type { CliRuntimeContext, CliStatusCode, GatewayCommandOptions, ConfigInitOptions, LogsOptions } from './types.js';
import type { GatewayConfig, ControlResponse } from '../gateway/types.js';
import {
  getDefaultConfigPath,
  loadGatewayConfig,
  validateGatewayConfig,
} from '../gateway/config-watcher.js';
import { runSetupWizard } from './wizard.js';

// ============================================================================
// gateway start (stub)
// ============================================================================

export async function runGatewayStartCommand(
  context: CliRuntimeContext,
  options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch (err) {
    context.error({
      status: 'error',
      command: 'gateway.start',
      message: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    });
    return 1;
  }

  const validation = validateGatewayConfig(config);
  if (!validation.valid) {
    context.error({
      status: 'error',
      command: 'gateway.start',
      message: `Config validation failed: ${validation.errors.join('; ')}`,
    });
    return 1;
  }

  context.output({
    status: 'ok',
    command: 'gateway.start',
    message: 'Gateway config validated — ready to start (daemon management not yet implemented)',
    configPath,
    port: config.gateway.port,
  });
  return 0;
}

// ============================================================================
// gateway stop (stub)
// ============================================================================

export async function runGatewayStopCommand(
  context: CliRuntimeContext,
  _options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  context.output({
    status: 'ok',
    command: 'gateway.stop',
    message: 'Gateway stop not yet implemented (daemon management is Phase 2.4)',
  });
  return 0;
}

// ============================================================================
// gateway restart (stub)
// ============================================================================

export async function runGatewayRestartCommand(
  context: CliRuntimeContext,
  _options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  context.output({
    status: 'ok',
    command: 'gateway.restart',
    message: 'Gateway restart not yet implemented (daemon management is Phase 2.4)',
  });
  return 0;
}

// ============================================================================
// gateway status
// ============================================================================

export async function runGatewayStatusCommand(
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
      command: 'gateway.status',
      gateway: { state: 'not_running', message: 'Config not found or invalid — gateway likely not running' },
    });
    return 0;
  }

  const port = config.gateway.port;
  const bind = config.gateway.bind ?? '127.0.0.1';
  const wsUrl = `ws://${bind}:${port}`;

  try {
    const response = await queryControlPlane(wsUrl, { type: 'status' });
    context.output({
      status: 'ok',
      command: 'gateway.status',
      gateway: response.payload ?? { state: 'running' },
    });
    return 0;
  } catch {
    context.output({
      status: 'ok',
      command: 'gateway.status',
      gateway: { state: 'not_running', message: `No gateway responding on ${wsUrl}` },
    });
    return 0;
  }
}

// ============================================================================
// config init
// ============================================================================

export async function runConfigInitCommand(
  context: CliRuntimeContext,
  options: ConfigInitOptions,
): Promise<CliStatusCode> {
  const result = await runSetupWizard({
    configPath: options.configPath ?? getDefaultConfigPath(),
    nonInteractive: options.nonInteractive,
    force: options.force,
  });

  context.output({
    status: 'ok',
    command: 'config.init',
    configPath: result.configPath,
    workspacePath: result.workspacePath,
    diagnosticsPassed: result.diagnosticsPassed,
  });
  return 0;
}

// ============================================================================
// config validate
// ============================================================================

export async function runConfigValidateCommand(
  context: CliRuntimeContext,
  options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch (err) {
    context.error({
      status: 'error',
      command: 'config.validate',
      configPath,
      message: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    });
    return 1;
  }

  const validation = validateGatewayConfig(config);
  if (!validation.valid) {
    context.error({
      status: 'error',
      command: 'config.validate',
      configPath,
      errors: validation.errors,
    });
    return 1;
  }

  context.output({
    status: 'ok',
    command: 'config.validate',
    configPath,
    valid: true,
  });
  return 0;
}

// ============================================================================
// config show
// ============================================================================

/** Fields that are redacted in `config show` output to prevent credential leakage. */
const SENSITIVE_CONFIG_FIELDS = new Set(['apiKey', 'secretKey', 'token', 'password', 'secret']);

function redactSensitiveFields(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveFields);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_CONFIG_FIELDS.has(key) && typeof value === 'string') {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveFields(value);
    }
  }
  return result;
}

export async function runConfigShowCommand(
  context: CliRuntimeContext,
  options: GatewayCommandOptions,
): Promise<CliStatusCode> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch (err) {
    context.error({
      status: 'error',
      command: 'config.show',
      configPath,
      message: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    });
    return 1;
  }

  context.output({
    status: 'ok',
    command: 'config.show',
    configPath,
    config: redactSensitiveFields(config),
  });
  return 0;
}

// ============================================================================
// logs (stub)
// ============================================================================

export async function runLogsCommand(
  context: CliRuntimeContext,
  _options: LogsOptions,
): Promise<CliStatusCode> {
  context.output({
    status: 'ok',
    command: 'logs',
    message: 'Log tailing not yet implemented (requires daemon — Phase 2.4)',
  });
  return 0;
}

// ============================================================================
// Control plane query helper (shared — also imported by sessions.ts)
// ============================================================================

export async function queryControlPlane(
  wsUrl: string,
  message: { type: string; id?: string },
  timeoutMs = 5000,
): Promise<ControlResponse> {
  const { WebSocket } = await import('ws');
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
