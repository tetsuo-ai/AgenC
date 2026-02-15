/**
 * Environment Health and Diagnostics CLI Commands
 *
 * Implements #994 P2-505: Operator onboarding and environment health bootstrap
 *
 * @module
 */

import { Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEVNET_RPC } from '@agenc/sdk';

/**
 * Health check category.
 */
export type HealthCategory = 'rpc' | 'store' | 'wallet' | 'config' | 'capability';

/**
 * Health check status.
 */
export type HealthStatus = 'pass' | 'warn' | 'fail';

/**
 * Individual health check result.
 */
export interface HealthCheckResult {
  /** Check identifier */
  id: string;
  /** Check category */
  category: HealthCategory;
  /** Check status */
  status: HealthStatus;
  /** Human-readable message */
  message: string;
  /** Optional remediation suggestion */
  remediation?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Aggregated health report.
 */
export interface HealthReport {
  /** Overall status */
  status: HealthStatus;
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Exit code (0=healthy, 1=warnings, 2=errors) */
  exitCode: 0 | 1 | 2;
  /** Individual check results */
  checks: HealthCheckResult[];
  /** Summary counts */
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failed: number;
  };
}

/**
 * Health command options.
 */
export interface HealthOptions {
  /** RPC URL to check */
  rpcUrl?: string;
  /** Path to SQLite store */
  sqlitePath?: string;
  /** Path to wallet file */
  walletPath?: string;
  /** Enable deep checks (latency, integrity) */
  deep?: boolean;
  /** Non-interactive mode for CI/CD */
  nonInteractive?: boolean;
}

/**
 * Doctor command options.
 */
export interface DoctorOptions extends HealthOptions {
  /** Attempt automatic fixes */
  fix?: boolean;
}

/**
 * Run an individual health check.
 */
async function runCheck(
  id: string,
  category: HealthCategory,
  checker: () => Promise<{ status: HealthStatus; message: string; remediation?: string }>,
): Promise<HealthCheckResult> {
  const startTime = Date.now();
  try {
    const result = await checker();
    return {
      id,
      category,
      ...result,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      id,
      category,
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
      remediation: 'Check the error details and verify configuration',
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Check RPC connectivity.
 */
async function checkRpcConnectivity(rpcUrl: string): Promise<HealthCheckResult> {
  return runCheck('rpc-connectivity', 'rpc', async () => {
    const connection = new Connection(rpcUrl, 'confirmed');
    const version = await connection.getVersion();
    return {
      status: 'pass',
      message: `Connected to RPC (Solana ${version['solana-core']})`,
    };
  });
}

/**
 * Check RPC latency (deep check).
 */
async function checkRpcLatency(rpcUrl: string): Promise<HealthCheckResult> {
  return runCheck('rpc-latency', 'rpc', async () => {
    const connection = new Connection(rpcUrl, 'confirmed');
    const start = Date.now();
    await connection.getSlot();
    const latency = Date.now() - start;

    if (latency > 2000) {
      return {
        status: 'warn',
        message: `High RPC latency: ${latency}ms`,
        remediation: 'Consider using a faster RPC endpoint',
      };
    }

    return {
      status: 'pass',
      message: `RPC latency: ${latency}ms`,
    };
  });
}

/**
 * Check store accessibility.
 */
async function checkStoreAccessibility(sqlitePath?: string): Promise<HealthCheckResult> {
  return runCheck('store-access', 'store', async () => {
    if (!sqlitePath) {
      return {
        status: 'pass',
        message: 'Using in-memory store (no persistence)',
      };
    }

    const dir = path.dirname(sqlitePath);

    // Check if directory exists and is writable
    if (!fs.existsSync(dir)) {
      return {
        status: 'fail',
        message: `Store directory does not exist: ${dir}`,
        remediation: `Create directory: mkdir -p ${dir}`,
      };
    }

    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return {
        status: 'pass',
        message: `Store directory writable: ${dir}`,
      };
    } catch {
      return {
        status: 'fail',
        message: `Store directory not writable: ${dir}`,
        remediation: `Check permissions: chmod 755 ${dir}`,
      };
    }
  });
}

/**
 * Get the user's home directory in a cross-platform way.
 */
function getHomeDir(): string {
  return os.homedir();
}

/**
 * Check wallet file detection.
 */
async function checkWalletFile(walletPath?: string): Promise<HealthCheckResult> {
  return runCheck('wallet-file', 'wallet', async () => {
    const homeDir = getHomeDir();
    const defaultPath = walletPath || path.join(homeDir, '.config', 'solana', 'id.json');

    if (!fs.existsSync(defaultPath)) {
      return {
        status: 'warn',
        message: `Wallet file not found: ${defaultPath}`,
        remediation: 'Generate a keypair: solana-keygen new',
      };
    }

    try {
      const content = fs.readFileSync(defaultPath, 'utf-8');
      JSON.parse(content);
      return {
        status: 'pass',
        message: `Wallet file found: ${defaultPath}`,
      };
    } catch {
      return {
        status: 'fail',
        message: `Invalid wallet file format: ${defaultPath}`,
        remediation: 'Verify the wallet file contains a valid JSON keypair array',
      };
    }
  });
}

/**
 * Check config file validity.
 */
async function checkConfigFile(): Promise<HealthCheckResult> {
  return runCheck('config-file', 'config', async () => {
    const homeDir = getHomeDir();
    const configPaths = [
      '.agenc.json',
      'agenc.config.json',
      path.join(homeDir, '.config', 'agenc', 'config.json'),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          JSON.parse(content);
          return {
            status: 'pass',
            message: `Config file valid: ${configPath}`,
          };
        } catch {
          return {
            status: 'warn',
            message: `Config file invalid JSON: ${configPath}`,
            remediation: 'Fix JSON syntax errors in config file',
          };
        }
      }
    }

    return {
      status: 'pass',
      message: 'No config file found (using defaults)',
    };
  });
}

/**
 * Run health checks.
 */
export async function runHealthChecks(options: HealthOptions): Promise<HealthReport> {
  const checks: HealthCheckResult[] = [];
  const rpcUrl = options.rpcUrl || DEVNET_RPC;

  // Core checks
  checks.push(await checkRpcConnectivity(rpcUrl));
  checks.push(await checkStoreAccessibility(options.sqlitePath));
  checks.push(await checkWalletFile(options.walletPath));
  checks.push(await checkConfigFile());

  // Deep checks
  if (options.deep) {
    checks.push(await checkRpcLatency(rpcUrl));
  }

  // Calculate summary
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;

  // Determine overall status and exit code
  let status: HealthStatus = 'pass';
  let exitCode: 0 | 1 | 2 = 0;

  if (failed > 0) {
    status = 'fail';
    exitCode = 2;
  } else if (warnings > 0) {
    status = 'warn';
    exitCode = 1;
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    exitCode,
    checks,
    summary: {
      total: checks.length,
      passed,
      warnings,
      failed,
    },
  };
}

/**
 * Callback for doctor fix suggestions.
 */
export type DoctorFixCallback = (checkId: string, remediation: string) => void;

/**
 * Run doctor checks with optional fix suggestions.
 * Note: The fix option logs remediation suggestions but does not execute automatic fixes.
 * Use the onFix callback to handle fix suggestions programmatically.
 */
export async function runDoctorChecks(
  options: DoctorOptions,
  onFix?: DoctorFixCallback,
): Promise<HealthReport> {
  const report = await runHealthChecks(options);

  if (options.fix) {
    // Output remediation suggestions for failed checks
    for (const check of report.checks) {
      if (check.status === 'fail' && check.remediation) {
        if (onFix) {
          onFix(check.id, check.remediation);
        }
      }
    }
  }

  return report;
}

/**
 * Format health report for CLI output.
 */
export function formatHealthReport(report: HealthReport, format: 'json' | 'table'): string {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];
  lines.push(`Health Report - ${report.timestamp}`);
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push('');

  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[WARN]' : '[FAIL]';
    lines.push(`${icon} ${check.id}: ${check.message}`);
    if (check.remediation && check.status !== 'pass') {
      lines.push(`    Fix: ${check.remediation}`);
    }
  }

  lines.push('');
  lines.push(`Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`);

  return lines.join('\n');
}
