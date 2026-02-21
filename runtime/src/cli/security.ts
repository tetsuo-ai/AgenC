/**
 * Security posture checks for the `doctor security` CLI subcommand.
 *
 * @module
 */

import { existsSync, statSync, chmodSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CliRuntimeContext, SecurityOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

export type SecurityCategory =
  | "secrets"
  | "webhook"
  | "model"
  | "execution"
  | "network"
  | "policy"
  | "filesystem";

export interface SecurityCheck {
  id: string;
  severity: SecuritySeverity;
  category: SecurityCategory;
  description: string;
  check: (
    context: SecurityCheckContext,
  ) => Promise<SecurityCheckResult> | SecurityCheckResult;
  remediation: string;
  autoFixable: boolean;
  fix?: (context: SecurityCheckContext) => Promise<boolean>;
}

export interface SecurityCheckContext {
  config: Record<string, unknown>;
  rpcUrl?: string;
  programId?: string;
  configPath: string;
  deep: boolean;
}

export interface SecurityCheckResult {
  id: string;
  passed: boolean;
  severity: SecuritySeverity;
  category: SecurityCategory;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface SecurityReport {
  status: "secure" | "at_risk" | "vulnerable";
  totalChecks: number;
  passed: number;
  failed: number;
  results: SecurityCheckResult[];
  timestamp: string;
  exitCode: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Built-in checks
// ---------------------------------------------------------------------------

export const BUILT_IN_SECURITY_CHECKS: SecurityCheck[] = [
  // --- Secrets ---
  {
    id: "secrets.keypair_file_mode",
    severity: "critical",
    category: "secrets",
    description: "Keypair file should not be world-readable",
    remediation: "Run: chmod 600 <keypair_path>",
    autoFixable: true,
    check: (_ctx) => {
      const keyPath =
        process.env.SOLANA_KEYPAIR_PATH ??
        path.join(os.homedir(), ".config", "solana", "id.json");
      if (!existsSync(keyPath)) {
        return {
          id: "secrets.keypair_file_mode",
          passed: true,
          severity: "critical",
          category: "secrets",
          message: "Keypair file not found (skipped)",
        };
      }
      const stat = statSync(keyPath);
      const mode = stat.mode & 0o777;
      const passed = (mode & 0o077) === 0;
      return {
        id: "secrets.keypair_file_mode",
        passed,
        severity: "critical",
        category: "secrets",
        message: passed
          ? "Keypair file has correct permissions"
          : `Keypair file ${keyPath} has mode ${mode.toString(8)}`,
        remediation: passed ? undefined : `chmod 600 ${keyPath}`,
        details: { path: keyPath, mode: mode.toString(8) },
      };
    },
    fix: async () => {
      const keyPath =
        process.env.SOLANA_KEYPAIR_PATH ??
        path.join(os.homedir(), ".config", "solana", "id.json");
      if (!existsSync(keyPath)) return false;
      chmodSync(keyPath, 0o600);
      return true;
    },
  },

  // --- Webhook ---
  {
    id: "webhook.https_only",
    severity: "high",
    category: "webhook",
    description: "Webhook URLs should use HTTPS",
    remediation: "Change webhook URL to use https:// scheme",
    autoFixable: false,
    check: (ctx) => {
      const replay = ctx.config.replay as Record<string, unknown> | undefined;
      const alerting = replay?.alerting as Record<string, unknown> | undefined;
      const webhook = alerting?.webhook as Record<string, unknown> | undefined;
      const webhookUrl =
        typeof webhook?.url === "string" ? webhook.url : undefined;
      if (!webhookUrl) {
        return {
          id: "webhook.https_only",
          passed: true,
          severity: "high",
          category: "webhook",
          message: "No webhook configured (skipped)",
        };
      }
      const passed = webhookUrl.startsWith("https://");
      return {
        id: "webhook.https_only",
        passed,
        severity: "high",
        category: "webhook",
        message: passed
          ? "Webhook uses HTTPS"
          : `Webhook URL "${webhookUrl}" does not use HTTPS`,
        remediation: passed
          ? undefined
          : "Change webhook URL to use https:// scheme",
      };
    },
  },

  // --- Model/Provider ---
  {
    id: "model.unsafe_tool_execution",
    severity: "high",
    category: "model",
    description: "LLM tool execution should have policy guard enabled",
    remediation:
      "Enable policy engine in runtime config: { policy: { enabled: true } }",
    autoFixable: false,
    check: (ctx) => {
      const policy = ctx.config.policy as Record<string, unknown> | undefined;
      const enabled = policy?.enabled === true;
      return {
        id: "model.unsafe_tool_execution",
        passed: enabled,
        severity: "high",
        category: "model",
        message: enabled
          ? "Policy engine is enabled"
          : "Policy engine is disabled — tool calls are unguarded",
        remediation: enabled
          ? undefined
          : "Enable policy engine: { policy: { enabled: true } }",
      };
    },
  },

  // --- Execution ---
  {
    id: "execution.max_risk_score",
    severity: "medium",
    category: "execution",
    description: "Max risk score threshold should be explicitly set",
    remediation: "Set policy.maxRiskScore in config (recommended: 0.7)",
    autoFixable: false,
    check: (ctx) => {
      const policy = ctx.config.policy as Record<string, unknown> | undefined;
      const hasMaxRisk = typeof policy?.maxRiskScore === "number";
      return {
        id: "execution.max_risk_score",
        passed: hasMaxRisk,
        severity: "medium",
        category: "execution",
        message: hasMaxRisk
          ? `Max risk score set to ${policy?.maxRiskScore}`
          : "No max risk score configured",
        remediation: hasMaxRisk
          ? undefined
          : "Set policy.maxRiskScore in config (recommended: 0.7)",
      };
    },
  },

  // --- Network ---
  {
    id: "network.rpc_not_localhost_in_prod",
    severity: "medium",
    category: "network",
    description: "Production should not use localhost RPC",
    remediation: "Use a production RPC endpoint (devnet/mainnet)",
    autoFixable: false,
    check: (ctx) => {
      if (!ctx.rpcUrl) {
        return {
          id: "network.rpc_not_localhost_in_prod",
          passed: true,
          severity: "medium",
          category: "network",
          message: "No RPC URL configured (skipped)",
        };
      }
      const isLocalhost =
        ctx.rpcUrl.includes("localhost") || ctx.rpcUrl.includes("127.0.0.1");
      const isProduction = process.env.NODE_ENV === "production";
      const passed = !isProduction || !isLocalhost;
      return {
        id: "network.rpc_not_localhost_in_prod",
        passed,
        severity: "medium",
        category: "network",
        message: passed
          ? "RPC endpoint is appropriate"
          : "Localhost RPC in production environment",
        remediation: passed ? undefined : "Use a production RPC endpoint",
      };
    },
  },

  // --- Network (deep) ---
  {
    id: "network.rpc_authenticated",
    severity: "low",
    category: "network",
    description: "RPC endpoint should require authentication in production",
    remediation: "Use an authenticated RPC provider (Helius, QuickNode, etc.)",
    autoFixable: false,
    check: (ctx) => {
      if (!ctx.deep || !ctx.rpcUrl) {
        return {
          id: "network.rpc_authenticated",
          passed: true,
          severity: "low",
          category: "network",
          message: "Deep check skipped or no RPC configured",
        };
      }
      const hasApiKey = /api[_-]?key|token=|\/v\d+\/[a-f0-9]{20,}/i.test(
        ctx.rpcUrl,
      );
      return {
        id: "network.rpc_authenticated",
        passed: hasApiKey,
        severity: "low",
        category: "network",
        message: hasApiKey
          ? "RPC URL appears to include authentication"
          : "RPC URL may be unauthenticated",
        remediation: hasApiKey
          ? undefined
          : "Consider using an authenticated RPC provider",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateSecurityReport(
  results: SecurityCheckResult[],
): SecurityReport {
  const failed = results.filter((r) => !r.passed);
  const hasCritical = failed.some((r) => r.severity === "critical");
  const hasHigh = failed.some((r) => r.severity === "high");
  const status: SecurityReport["status"] = hasCritical
    ? "vulnerable"
    : hasHigh
      ? "at_risk"
      : "secure";
  const exitCode: 0 | 1 | 2 = hasCritical ? 2 : failed.length > 0 ? 1 : 0;

  return {
    status,
    totalChecks: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: failed.length,
    results,
    timestamp: new Date().toISOString(),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runSecurityChecks(
  checks: SecurityCheck[],
  checkContext: SecurityCheckContext,
  fix: boolean,
): Promise<SecurityReport> {
  const results: SecurityCheckResult[] = [];

  for (const check of checks) {
    const result = await check.check(checkContext);
    results.push(result);
  }

  if (fix) {
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const check = checks[i]!;
      if (!result.passed && check.autoFixable && check.fix) {
        const fixed = await check.fix(checkContext);
        if (fixed) {
          results[i] = {
            ...result,
            passed: true,
            message: result.message + " (auto-fixed)",
          };
        }
      }
    }
  }

  return aggregateSecurityReport(results);
}

export async function runSecurityCommand(
  context: CliRuntimeContext,
  options: SecurityOptions,
): Promise<0 | 1 | 2> {
  const checkContext: SecurityCheckContext = {
    config: {},
    rpcUrl: options.rpcUrl,
    programId: options.programId,
    configPath: "",
    deep: options.deep ?? false,
  };

  const report = await runSecurityChecks(
    BUILT_IN_SECURITY_CHECKS,
    checkContext,
    options.fix ?? false,
  );

  context.output({
    status: "ok",
    command: "doctor.security",
    report,
  });

  return report.exitCode;
}
