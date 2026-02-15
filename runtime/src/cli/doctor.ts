/**
 * Gateway diagnostics for `agenc doctor`.
 *
 * Runs gateway-specific health checks: config validation, workspace
 * existence, and control plane connectivity. Returns a structured
 * DiagnosticResult per the issue #1058 spec.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { GatewayConfig } from '../gateway/types.js';
import {
  getDefaultConfigPath,
  loadGatewayConfig,
  validateGatewayConfig,
} from '../gateway/config-watcher.js';
import { WORKSPACE_FILES } from '../gateway/workspace-files.js';
import { queryControlPlane } from './gateway-commands.js';

// ============================================================================
// Types
// ============================================================================

/** Result of a single diagnostic check. */
export interface DiagnosticResult {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly message: string;
  readonly remediation?: string;
}

/** Aggregate result of running all gateway diagnostics. */
export interface DiagnosticReport {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly results: DiagnosticResult[];
  readonly timestamp: string;
}

// ============================================================================
// Diagnostic checks
// ============================================================================

async function checkConfig(configPath: string): Promise<DiagnosticResult> {
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch {
    return {
      id: 'gateway.config.load',
      label: 'Gateway config file',
      status: 'fail',
      message: `Config not found or unreadable at ${configPath}`,
      remediation: 'Run `agenc config init` to generate a config file.',
    };
  }

  const validation = validateGatewayConfig(config);
  if (!validation.valid) {
    return {
      id: 'gateway.config.validate',
      label: 'Gateway config validation',
      status: 'fail',
      message: `Config validation failed: ${validation.errors.join('; ')}`,
      remediation: 'Run `agenc config validate` to see details, then fix the config file.',
    };
  }

  return {
    id: 'gateway.config.validate',
    label: 'Gateway config validation',
    status: 'pass',
    message: 'Config is valid.',
  };
}

function checkWorkspace(configPath: string): DiagnosticResult {
  const workspacePath = join(dirname(configPath), 'workspace');
  if (!existsSync(workspacePath)) {
    return {
      id: 'gateway.workspace.exists',
      label: 'Workspace directory',
      status: 'warn',
      message: `Workspace directory not found at ${workspacePath}`,
      remediation: 'Run `agenc config init` to scaffold the workspace.',
    };
  }

  const missingFiles: string[] = [];
  for (const fileName of Object.values(WORKSPACE_FILES)) {
    if (!existsSync(join(workspacePath, fileName))) {
      missingFiles.push(fileName);
    }
  }

  if (missingFiles.length > 0) {
    return {
      id: 'gateway.workspace.files',
      label: 'Workspace files',
      status: 'warn',
      message: `Missing workspace files: ${missingFiles.join(', ')}`,
      remediation: 'Run `agenc config init` to scaffold missing files.',
    };
  }

  return {
    id: 'gateway.workspace.files',
    label: 'Workspace files',
    status: 'pass',
    message: 'All workspace files present.',
  };
}

async function checkControlPlane(configPath: string): Promise<DiagnosticResult> {
  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch {
    return {
      id: 'gateway.controlplane.connect',
      label: 'Control plane connectivity',
      status: 'warn',
      message: 'Cannot check control plane — config not loaded.',
    };
  }

  const port = config.gateway.port;
  const bind = config.gateway.bind ?? '127.0.0.1';
  const wsUrl = `ws://${bind}:${port}`;

  try {
    await queryControlPlane(wsUrl, { type: 'status' }, 3000);
    return {
      id: 'gateway.controlplane.connect',
      label: 'Control plane connectivity',
      status: 'pass',
      message: `Gateway responding on ${wsUrl}.`,
    };
  } catch {
    return {
      id: 'gateway.controlplane.connect',
      label: 'Control plane connectivity',
      status: 'warn',
      message: `No gateway responding on ${wsUrl}. Gateway may not be running.`,
      remediation: 'Start the gateway with `agenc gateway start`.',
    };
  }
}

// ============================================================================
// Run all diagnostics
// ============================================================================

export async function runGatewayDiagnostics(configPath?: string): Promise<DiagnosticReport> {
  const resolvedPath = configPath ?? getDefaultConfigPath();
  const results: DiagnosticResult[] = [];

  results.push(await checkConfig(resolvedPath));
  results.push(checkWorkspace(resolvedPath));
  results.push(await checkControlPlane(resolvedPath));

  const hasFail = results.some((r) => r.status === 'fail');
  const hasWarn = results.some((r) => r.status === 'warn');

  return {
    status: hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy',
    results,
    timestamp: new Date().toISOString(),
  };
}
