/**
 * Operator environment health checks for runtime CLI bootstrap and diagnostics.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { validateIdl } from "../idl.js";
import { validateConfigStrict } from "../types/config-migration.js";
import { DEFAULT_SQLITE_REPLAY_PATH } from "./replay.js";
import type {
  CliRuntimeContext,
  DoctorOptions,
  HealthOptions,
} from "./types.js";

/** Individual health check result. */
export interface HealthCheckResult {
  id: string; // e.g. 'rpc.reachable', 'store.sqlite', 'wallet.exists'
  category: "rpc" | "store" | "wallet" | "capability" | "config" | "program";
  status: "pass" | "warn" | "fail";
  message: string;
  remediation?: string; // suggested fix
  durationMs?: number;
}

/** Aggregate health report. */
export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheckResult[];
  timestamp: string; // ISO-8601
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

export function aggregateHealthReport(
  checks: HealthCheckResult[],
): HealthReport {
  const hasErrors = checks.some((check) => check.status === "fail");
  const hasWarnings = checks.some((check) => check.status === "warn");
  const status: HealthReport["status"] = hasErrors
    ? "unhealthy"
    : hasWarnings
      ? "degraded"
      : "healthy";
  const exitCode: 0 | 1 | 2 = hasErrors ? 2 : hasWarnings ? 1 : 0;

  return {
    status,
    checks,
    timestamp: new Date().toISOString(),
    exitCode,
  };
}

export async function checkRpcReachability(
  rpcUrl: string | undefined,
  checks: HealthCheckResult[],
): Promise<boolean> {
  if (!rpcUrl) {
    checks.push({
      id: "rpc.configured",
      category: "rpc",
      status: "fail",
      message: "No RPC URL configured",
      remediation:
        "Set --rpc or AGENC_RUNTIME_RPC_URL or rpcUrl in config file",
    });
    return false;
  }

  try {
    const start = Date.now();
    const connection = new Connection(rpcUrl);
    await connection.getSlot();
    checks.push({
      id: "rpc.reachable",
      category: "rpc",
      status: "pass",
      message: `RPC at ${rpcUrl} is reachable`,
      durationMs: Date.now() - start,
    });
    return true;
  } catch (error) {
    checks.push({
      id: "rpc.reachable",
      category: "rpc",
      status: "fail",
      message: `RPC at ${rpcUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Check RPC URL and network connectivity",
    });
    return false;
  }
}

async function checkRpcLatency(
  rpcUrl: string | undefined,
  checks: HealthCheckResult[],
): Promise<void> {
  if (!rpcUrl) {
    checks.push({
      id: "rpc.latency",
      category: "rpc",
      status: "warn",
      message: "RPC latency check skipped (no RPC configured)",
    });
    return;
  }

  try {
    const start = Date.now();
    const connection = new Connection(rpcUrl);
    await connection.getSlot();
    checks.push({
      id: "rpc.latency",
      category: "rpc",
      status: "pass",
      message: "RPC latency sample collected",
      durationMs: Date.now() - start,
    });
  } catch (error) {
    checks.push({
      id: "rpc.latency",
      category: "rpc",
      status: "warn",
      message: `RPC latency check skipped (RPC unreachable): ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function checkReplayStore(
  options: { storeType: "memory" | "sqlite"; sqlitePath?: string },
  checks: HealthCheckResult[],
): void {
  if (options.storeType === "sqlite") {
    const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH;
    const absoluteSqlitePath = path.resolve(process.cwd(), sqlitePath);
    const parentDir = path.dirname(absoluteSqlitePath);
    if (!existsSync(parentDir)) {
      checks.push({
        id: "store.directory",
        category: "store",
        status: "fail",
        message: `SQLite parent directory ${parentDir} does not exist`,
        remediation: `Run: mkdir -p ${parentDir}`,
      });
      return;
    }

    checks.push({
      id: "store.sqlite",
      category: "store",
      status: "pass",
      message: `SQLite store path ${absoluteSqlitePath} is accessible`,
    });
    return;
  }

  checks.push({
    id: "store.memory",
    category: "store",
    status: "pass",
    message: "In-memory store configured (no persistence)",
  });
}

async function checkStoreIntegrity(
  options: { storeType: "memory" | "sqlite"; sqlitePath?: string },
  checks: HealthCheckResult[],
): Promise<void> {
  if (options.storeType !== "sqlite") {
    checks.push({
      id: "store.integrity",
      category: "store",
      status: "pass",
      message: "Store integrity check not applicable (memory store)",
    });
    return;
  }

  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH;
  const absoluteSqlitePath = path.resolve(process.cwd(), sqlitePath);
  const parentDir = path.dirname(absoluteSqlitePath);
  if (!existsSync(parentDir)) {
    checks.push({
      id: "store.integrity",
      category: "store",
      status: "warn",
      message: "Store integrity check skipped (SQLite directory missing)",
      remediation: `Run: mkdir -p ${parentDir}`,
    });
    return;
  }

  try {
    const start = Date.now();
    const mod = await import("better-sqlite3");
    const Database = (mod.default ?? mod) as unknown as new (
      ...args: unknown[]
    ) => any;
    const db = new Database(absoluteSqlitePath);
    try {
      const result = db.pragma("integrity_check", { simple: true }) as string;
      const passed = result === "ok";
      checks.push({
        id: "store.integrity",
        category: "store",
        status: passed ? "pass" : "fail",
        message: passed
          ? "SQLite integrity check passed"
          : `SQLite integrity check failed: ${result}`,
        remediation: passed
          ? undefined
          : "Consider backing up and recreating the SQLite store",
        durationMs: Date.now() - start,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    checks.push({
      id: "store.integrity",
      category: "store",
      status: "fail",
      message: `SQLite integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Ensure better-sqlite3 is installed and the SQLite path is writable",
    });
  }
}

export async function checkWalletAvailability(
  checks: HealthCheckResult[],
): Promise<boolean> {
  const defaultKeyPath = path.join(
    os.homedir(),
    ".config",
    "solana",
    "id.json",
  );
  const envKeyPath = process.env.SOLANA_KEYPAIR_PATH;
  const keyPath =
    typeof envKeyPath === "string" && envKeyPath.length > 0
      ? envKeyPath
      : defaultKeyPath;

  if (!existsSync(keyPath)) {
    checks.push({
      id: "wallet.exists",
      category: "wallet",
      status: "warn",
      message: `Keypair not found at ${keyPath}`,
      remediation: "Run: solana-keygen new",
    });
    return false;
  }

  checks.push({
    id: "wallet.exists",
    category: "wallet",
    status: "pass",
    message: `Keypair found at ${keyPath}`,
  });

  return true;
}

export function checkProgramAvailability(
  programId: string | undefined,
  checks: HealthCheckResult[],
): void {
  if (programId === undefined) {
    checks.push({
      id: "program.id",
      category: "program",
      status: "pass",
      message: "Program id not configured (using SDK default)",
    });
  } else {
    try {
      // PublicKey constructor validates base58 and byte length.
      new PublicKey(programId);
      checks.push({
        id: "program.id",
        category: "program",
        status: "pass",
        message: `Program id ${programId} is valid`,
      });
    } catch (error) {
      checks.push({
        id: "program.id",
        category: "program",
        status: "fail",
        message: `Program id is invalid: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Set --program-id to a valid base58 public key",
      });
    }
  }

  try {
    validateIdl();
    checks.push({
      id: "capability.idl",
      category: "capability",
      status: "pass",
      message: "Program IDL is available",
    });
  } catch (error) {
    checks.push({
      id: "capability.idl",
      category: "capability",
      status: "fail",
      message: `Program IDL validation failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Run: anchor build",
    });
  }
}

export function checkConfigValidity(
  configPath: string | undefined,
  checks: HealthCheckResult[],
): void {
  const resolvedPath = resolveConfigPath(configPath);
  if (!existsSync(resolvedPath)) {
    checks.push({
      id: "config.exists",
      category: "config",
      status: "warn",
      message: `Config file not found at ${resolvedPath}`,
      remediation: "Run: agenc-runtime onboard",
    });
    return;
  }

  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      checks.push({
        id: "config.valid",
        category: "config",
        status: "fail",
        message: `Config file at ${resolvedPath} must be a JSON object`,
        remediation:
          "Fix the config file or regenerate via agenc-runtime onboard",
      });
      return;
    }

    const validation = validateConfigStrict(
      parsed as Record<string, unknown>,
      false,
    );
    if (!validation.valid) {
      checks.push({
        id: "config.valid",
        category: "config",
        status: "fail",
        message: `Config validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
        remediation:
          "Fix the config file or regenerate via agenc-runtime onboard",
      });
      return;
    }

    checks.push({
      id: "config.valid",
      category: "config",
      status: "pass",
      message: `Config file at ${resolvedPath} is valid`,
    });
  } catch (error) {
    checks.push({
      id: "config.valid",
      category: "config",
      status: "fail",
      message: `Config file at ${resolvedPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Fix the config file or regenerate via agenc-runtime onboard",
    });
  }
}

export async function runAllHealthChecks(
  options: Pick<
    HealthOptions,
    "rpcUrl" | "programId" | "storeType" | "sqlitePath" | "deep" | "configPath"
  >,
  checks: HealthCheckResult[],
): Promise<void> {
  const rpcReachable = await checkRpcReachability(options.rpcUrl, checks);
  checkReplayStore(
    { storeType: options.storeType, sqlitePath: options.sqlitePath },
    checks,
  );
  await checkWalletAvailability(checks);
  checkProgramAvailability(options.programId, checks);
  checkConfigValidity(options.configPath, checks);

  if (options.deep) {
    if (rpcReachable) {
      await checkRpcLatency(options.rpcUrl, checks);
    } else {
      checks.push({
        id: "rpc.latency",
        category: "rpc",
        status: "warn",
        message: "RPC latency check skipped (RPC unreachable)",
      });
    }

    await checkStoreIntegrity(
      { storeType: options.storeType, sqlitePath: options.sqlitePath },
      checks,
    );
  }
}

async function attemptAutoFix(
  check: HealthCheckResult,
  options: DoctorOptions,
): Promise<boolean> {
  if (check.id === "store.directory" && options.storeType === "sqlite") {
    const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH;
    const absoluteSqlitePath = path.resolve(process.cwd(), sqlitePath);
    const parentDir = path.dirname(absoluteSqlitePath);
    try {
      await mkdir(parentDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function runHealthCommand(
  context: CliRuntimeContext,
  options: HealthOptions,
): Promise<0 | 1 | 2> {
  const checks: HealthCheckResult[] = [];
  await runAllHealthChecks(
    {
      rpcUrl: options.rpcUrl,
      programId: options.programId,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
      deep: options.deep,
      configPath: options.configPath,
    },
    checks,
  );

  const report = aggregateHealthReport(checks);

  context.output({
    status: "ok",
    command: "health",
    report,
  });

  return report.exitCode;
}

export async function runDoctorCommand(
  context: CliRuntimeContext,
  options: DoctorOptions,
): Promise<0 | 1 | 2> {
  const checks: HealthCheckResult[] = [];

  await runAllHealthChecks(
    {
      rpcUrl: options.rpcUrl,
      programId: options.programId,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
      deep: options.deep,
      configPath: options.configPath,
    },
    checks,
  );

  if (options.fix) {
    for (const check of checks) {
      if (check.status !== "fail") {
        continue;
      }

      const fixed = await attemptAutoFix(check, options);
      if (fixed) {
        check.status = "pass";
        check.message += " (auto-fixed)";
      }
    }
  }

  const report = aggregateHealthReport(checks);
  const recommendations = checks
    .filter((check) => check.status !== "pass")
    .map((check) => ({
      id: check.id,
      status: check.status,
      remediation: check.remediation ?? "No auto-fix available",
    }));

  context.output({
    status: "ok",
    command: "doctor",
    report,
    recommendations,
  });

  return report.exitCode;
}
