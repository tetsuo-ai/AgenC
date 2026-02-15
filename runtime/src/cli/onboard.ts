/**
 * Operator Onboarding CLI Command
 *
 * Implements #994 P2-505: Operator onboarding and environment health bootstrap
 *
 * @module
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CliFileConfig } from './types.js';
import { runHealthChecks, type HealthReport, type HealthOptions } from './health.js';

/**
 * Onboard command options.
 */
export interface OnboardOptions {
  /** Output path for generated config */
  configPath?: string;
  /** RPC URL to use */
  rpcUrl?: string;
  /** Program ID to use */
  programId?: string;
  /** Store type */
  storeType?: 'memory' | 'sqlite';
  /** SQLite path (if storeType is sqlite) */
  sqlitePath?: string;
  /** Wallet path */
  walletPath?: string;
  /** Skip health checks */
  skipHealthChecks?: boolean;
  /** Non-interactive mode for CI/CD */
  nonInteractive?: boolean;
  /** Force overwrite existing config */
  force?: boolean;
}

/**
 * Onboard result.
 */
export interface OnboardResult {
  success: boolean;
  configPath: string;
  config: CliFileConfig;
  healthReport?: HealthReport;
  errors: string[];
  warnings: string[];
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: CliFileConfig = {
  configVersion: '1.0.0',
  rpcUrl: 'https://api.devnet.solana.com',
  storeType: 'memory',
  strictMode: false,
  idempotencyWindow: 300,
  outputFormat: 'table',
  logLevel: 'info',
};

/**
 * Default config file path.
 */
const DEFAULT_CONFIG_PATH = '.agenc.json';

/**
 * Validate RPC URL format.
 */
function isValidRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate program ID format (base58 Solana public key: 43-44 chars).
 */
function isValidProgramId(id: string): boolean {
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  return base58Regex.test(id) && id.length >= 43 && id.length <= 44;
}

/**
 * Generate validated runtime configuration.
 */
export function generateConfig(options: OnboardOptions): { config: CliFileConfig; errors: string[] } {
  const errors: string[] = [];
  const config: CliFileConfig = { ...DEFAULT_CONFIG };

  // Validate and set RPC URL
  if (options.rpcUrl) {
    if (isValidRpcUrl(options.rpcUrl)) {
      config.rpcUrl = options.rpcUrl;
    } else {
      errors.push(`Invalid RPC URL: ${options.rpcUrl}`);
    }
  }

  // Validate and set program ID
  if (options.programId) {
    if (isValidProgramId(options.programId)) {
      config.programId = options.programId;
    } else {
      errors.push(`Invalid program ID: ${options.programId}`);
    }
  }

  // Set store type
  if (options.storeType) {
    config.storeType = options.storeType;
  }

  // Set SQLite path
  if (options.storeType === 'sqlite') {
    config.sqlitePath = options.sqlitePath || './agenc-store.db';
  }

  return { config, errors };
}

/**
 * Write config to file.
 */
function writeConfig(configPath: string, config: CliFileConfig, force: boolean): { success: boolean; error?: string } {
  // Check if file exists
  if (fs.existsSync(configPath) && !force) {
    return {
      success: false,
      error: `Config file already exists: ${configPath}. Use --force to overwrite.`,
    };
  }

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (dir !== '.' && !fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return {
        success: false,
        error: `Failed to create directory: ${dir}`,
      };
    }
  }

  // Write config
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run onboarding process.
 */
export async function runOnboard(options: OnboardOptions): Promise<OnboardResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  // Generate configuration
  const { config, errors: configErrors } = generateConfig(options);
  errors.push(...configErrors);

  // Run health checks unless skipped
  let healthReport: HealthReport | undefined;
  if (!options.skipHealthChecks) {
    const healthOptions: HealthOptions = {
      rpcUrl: config.rpcUrl,
      sqlitePath: config.sqlitePath,
      walletPath: options.walletPath,
      nonInteractive: options.nonInteractive,
    };

    healthReport = await runHealthChecks(healthOptions);

    // Add warnings from health checks
    for (const check of healthReport.checks) {
      if (check.status === 'warn') {
        warnings.push(`${check.id}: ${check.message}`);
      } else if (check.status === 'fail') {
        errors.push(`${check.id}: ${check.message}`);
      }
    }
  }

  // Write config if no errors (or only warnings)
  if (errors.length === 0) {
    const writeResult = writeConfig(configPath, config, options.force || false);
    if (!writeResult.success && writeResult.error) {
      errors.push(writeResult.error);
    }
  }

  return {
    success: errors.length === 0,
    configPath,
    config,
    healthReport,
    errors,
    warnings,
  };
}

/**
 * Format onboard result for CLI output.
 */
export function formatOnboardResult(result: OnboardResult, format: 'json' | 'table'): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];

  if (result.success) {
    lines.push('Onboarding completed successfully!');
    lines.push(`Config written to: ${result.configPath}`);
  } else {
    lines.push('Onboarding failed with errors:');
    for (const error of result.errors) {
      lines.push(`  [ERROR] ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  [WARN] ${warning}`);
    }
  }

  if (result.healthReport) {
    lines.push('');
    lines.push(`Health: ${result.healthReport.summary.passed}/${result.healthReport.summary.total} checks passed`);
  }

  return lines.join('\n');
}

/**
 * Parse onboard CLI arguments.
 * Returns parsed options or throws on missing required values.
 */
export function parseOnboardArgs(args: string[]): OnboardOptions {
  const options: OnboardOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config' || arg === '-c') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.configPath = args[++i];
    } else if (arg === '--rpc-url' || arg === '-r') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.rpcUrl = args[++i];
    } else if (arg === '--program-id' || arg === '-p') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.programId = args[++i];
    } else if (arg === '--store-type') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      const value = args[++i];
      if (value === 'memory' || value === 'sqlite') {
        options.storeType = value;
      }
    } else if (arg === '--sqlite-path') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.sqlitePath = args[++i];
    } else if (arg === '--wallet-path' || arg === '-w') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.walletPath = args[++i];
    } else if (arg === '--skip-health-checks') {
      options.skipHealthChecks = true;
    } else if (arg === '--non-interactive' || arg === '-y') {
      options.nonInteractive = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    }
  }

  return options;
}
