/**
 * Operator onboarding workflow for bootstrapping runtime CLI configuration.
 *
 * @module
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { validateConfigStrict } from "../types/config-migration.js";
import { DEFAULT_SQLITE_REPLAY_PATH } from "./replay.js";
import type {
  CliFileConfig,
  CliRuntimeContext,
  OnboardOptions,
} from "./types.js";
import {
  type HealthCheckResult,
  checkConfigValidity,
  checkRpcReachability,
  checkWalletAvailability,
} from "./health.js";

/** Onboard configuration output. */
export interface OnboardResult {
  configPath: string;
  configGenerated: boolean;
  walletDetected: boolean;
  rpcReachable: boolean;
  checks: HealthCheckResult[];
  exitCode: 0 | 1 | 2;
}

const DEFAULT_CONFIG_PATH = ".agenc-runtime.json";

function resolveConfigPath(configPath: string | undefined): string {
  if (typeof configPath === "string" && configPath.length > 0) {
    return path.resolve(process.cwd(), configPath);
  }

  const envPath = process.env.AGENC_RUNTIME_CONFIG;
  if (typeof envPath === "string" && envPath.length > 0) {
    return path.resolve(process.cwd(), envPath);
  }

  return path.resolve(process.cwd(), DEFAULT_CONFIG_PATH);
}

function computeExitCode(checks: HealthCheckResult[]): 0 | 1 | 2 {
  const hasErrors = checks.some((check) => check.status === "fail");
  const hasWarnings = checks.some((check) => check.status === "warn");
  return hasErrors ? 2 : hasWarnings ? 1 : 0;
}

function buildDefaultConfig(options: OnboardOptions): CliFileConfig {
  const storeType = options.storeType ?? "sqlite";
  const sqlitePath =
    storeType === "sqlite"
      ? (options.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH)
      : undefined;

  return {
    rpcUrl: options.rpcUrl ?? "https://api.devnet.solana.com",
    storeType,
    ...(sqlitePath ? { sqlitePath } : {}),
    logLevel: "info",
    outputFormat: "json",
    strictMode: false,
    idempotencyWindow: options.idempotencyWindow,
  };
}

export async function runOnboardCommand(
  context: CliRuntimeContext,
  options: OnboardOptions,
): Promise<0 | 1 | 2> {
  const checks: HealthCheckResult[] = [];

  const configPath = resolveConfigPath(options.configPath);
  const configExists = existsSync(configPath);

  if (configExists && !options.force) {
    checks.push({
      id: "config.exists",
      category: "config",
      status: "warn",
      message: `Config file already exists at ${configPath}. Use --force to overwrite.`,
    });
  }

  const defaultConfig = buildDefaultConfig(options);
  const validation = validateConfigStrict(
    defaultConfig as unknown as Record<string, unknown>,
    false,
  );
  if (!validation.valid) {
    checks.push({
      id: "config.generated",
      category: "config",
      status: "fail",
      message: `Generated config failed validation: ${validation.errors.map((e) => e.message).join("; ")}`,
      remediation: "Fix runtime defaults or supply explicit config values",
    });
  }

  let configGenerated = false;
  if ((!configExists || options.force) && validation.valid) {
    try {
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(validation.migratedConfig, null, 2),
        "utf8",
      );
      configGenerated = true;
      checks.push({
        id: "config.generated",
        category: "config",
        status: "pass",
        message: `Config written to ${configPath}`,
      });
    } catch (error) {
      checks.push({
        id: "config.generated",
        category: "config",
        status: "fail",
        message: `Failed to write config to ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Ensure the config directory is writable",
      });
    }
  }

  const walletDetected = await checkWalletAvailability(checks);
  const rpcUrl = defaultConfig.rpcUrl ?? options.rpcUrl;
  const rpcReachable = await checkRpcReachability(rpcUrl, checks);

  checkConfigValidity(configPath, checks);

  const exitCode = computeExitCode(checks);

  const result: OnboardResult = {
    configPath,
    configGenerated,
    walletDetected,
    rpcReachable,
    checks,
    exitCode,
  };

  context.output({
    status: "ok",
    command: "onboard",
    result,
  });

  return exitCode;
}
