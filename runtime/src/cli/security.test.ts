import { describe, expect, it, vi } from "vitest";
import {
  aggregateSecurityReport,
  BUILT_IN_SECURITY_CHECKS,
  runSecurityChecks,
  type SecurityCheckContext,
  type SecurityCheckResult,
} from "./security.js";

function makeContext(
  overrides: Partial<SecurityCheckContext> = {},
): SecurityCheckContext {
  return {
    config: {},
    configPath: "/tmp/test-config.json",
    deep: false,
    ...overrides,
  };
}

describe("aggregateSecurityReport", () => {
  it("returns secure when all checks pass", () => {
    const results: SecurityCheckResult[] = [
      {
        id: "a",
        passed: true,
        severity: "info",
        category: "secrets",
        message: "ok",
      },
      {
        id: "b",
        passed: true,
        severity: "low",
        category: "network",
        message: "ok",
      },
    ];
    const report = aggregateSecurityReport(results);
    expect(report.status).toBe("secure");
    expect(report.exitCode).toBe(0);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
  });

  it("returns vulnerable on critical failure", () => {
    const results: SecurityCheckResult[] = [
      {
        id: "a",
        passed: false,
        severity: "critical",
        category: "secrets",
        message: "bad",
      },
      {
        id: "b",
        passed: true,
        severity: "low",
        category: "network",
        message: "ok",
      },
    ];
    const report = aggregateSecurityReport(results);
    expect(report.status).toBe("vulnerable");
    expect(report.exitCode).toBe(2);
    expect(report.failed).toBe(1);
  });

  it("returns at_risk on high failure without critical", () => {
    const results: SecurityCheckResult[] = [
      {
        id: "a",
        passed: false,
        severity: "high",
        category: "webhook",
        message: "bad",
      },
      {
        id: "b",
        passed: true,
        severity: "low",
        category: "network",
        message: "ok",
      },
    ];
    const report = aggregateSecurityReport(results);
    expect(report.status).toBe("at_risk");
    expect(report.exitCode).toBe(1);
  });

  it("returns at_risk on medium failure without critical/high", () => {
    const results: SecurityCheckResult[] = [
      {
        id: "a",
        passed: false,
        severity: "medium",
        category: "execution",
        message: "bad",
      },
    ];
    const report = aggregateSecurityReport(results);
    // medium failures still count as failed, status=secure requires zero failures
    expect(report.exitCode).toBe(1);
  });

  it("includes timestamp in ISO format", () => {
    const results: SecurityCheckResult[] = [];
    const report = aggregateSecurityReport(results);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("built-in checks", () => {
  it("model.unsafe_tool_execution fails when policy is disabled", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "model.unsafe_tool_execution",
    )!;
    const result = check.check(
      makeContext({ config: {} }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("model.unsafe_tool_execution passes when policy is enabled", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "model.unsafe_tool_execution",
    )!;
    const result = check.check(
      makeContext({ config: { policy: { enabled: true } } }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(true);
  });

  it("execution.max_risk_score fails without maxRiskScore", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "execution.max_risk_score",
    )!;
    const result = check.check(
      makeContext({ config: {} }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("medium");
  });

  it("execution.max_risk_score passes with maxRiskScore", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "execution.max_risk_score",
    )!;
    const result = check.check(
      makeContext({ config: { policy: { maxRiskScore: 0.7 } } }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(true);
  });

  it("webhook.https_only passes when no webhook configured", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "webhook.https_only",
    )!;
    const result = check.check(makeContext()) as SecurityCheckResult;
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skipped");
  });

  it("webhook.https_only fails for http webhook URL", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "webhook.https_only",
    )!;
    const result = check.check(
      makeContext({
        config: {
          replay: { alerting: { webhook: { url: "http://example.com/hook" } } },
        },
      }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("webhook.https_only passes for https webhook URL", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "webhook.https_only",
    )!;
    const result = check.check(
      makeContext({
        config: {
          replay: {
            alerting: { webhook: { url: "https://example.com/hook" } },
          },
        },
      }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(true);
  });

  it("network.rpc_not_localhost_in_prod passes when no RPC configured", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "network.rpc_not_localhost_in_prod",
    )!;
    const result = check.check(makeContext()) as SecurityCheckResult;
    expect(result.passed).toBe(true);
  });

  it("network.rpc_not_localhost_in_prod passes in non-production", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "network.rpc_not_localhost_in_prod",
    )!;
    const result = check.check(
      makeContext({ rpcUrl: "http://localhost:8899" }),
    ) as SecurityCheckResult;
    // NODE_ENV is not 'production' in tests
    expect(result.passed).toBe(true);
  });

  it("network.rpc_authenticated skips without deep mode", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "network.rpc_authenticated",
    )!;
    const result = check.check(
      makeContext({ rpcUrl: "http://localhost:8899", deep: false }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skipped");
  });

  it("network.rpc_authenticated runs in deep mode", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "network.rpc_authenticated",
    )!;
    const result = check.check(
      makeContext({ rpcUrl: "http://localhost:8899", deep: true }),
    ) as SecurityCheckResult;
    // Localhost URL doesn't have API key pattern
    expect(result.passed).toBe(false);
  });

  it("network.rpc_authenticated passes with authenticated URL in deep mode", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "network.rpc_authenticated",
    )!;
    const result = check.check(
      makeContext({
        rpcUrl: "https://rpc.helius.xyz/v1/abcdef0123456789abcdef0123456789",
        deep: true,
      }),
    ) as SecurityCheckResult;
    expect(result.passed).toBe(true);
  });

  it("secrets.keypair_file_mode skips when file does not exist", () => {
    const check = BUILT_IN_SECURITY_CHECKS.find(
      (c) => c.id === "secrets.keypair_file_mode",
    )!;
    const origEnv = process.env.SOLANA_KEYPAIR_PATH;
    process.env.SOLANA_KEYPAIR_PATH = "/tmp/non-existent-keypair-12345.json";
    try {
      const result = check.check(makeContext()) as SecurityCheckResult;
      expect(result.passed).toBe(true);
      expect(result.message).toContain("not found");
    } finally {
      if (origEnv === undefined) {
        delete process.env.SOLANA_KEYPAIR_PATH;
      } else {
        process.env.SOLANA_KEYPAIR_PATH = origEnv;
      }
    }
  });
});

describe("runSecurityChecks", () => {
  it("runs all checks and produces a report", async () => {
    const checks = [
      {
        id: "test.pass",
        severity: "info" as const,
        category: "secrets" as const,
        description: "test",
        remediation: "none",
        autoFixable: false,
        check: () => ({
          id: "test.pass",
          passed: true,
          severity: "info" as const,
          category: "secrets" as const,
          message: "ok",
        }),
      },
      {
        id: "test.fail",
        severity: "high" as const,
        category: "webhook" as const,
        description: "test fail",
        remediation: "fix it",
        autoFixable: false,
        check: () => ({
          id: "test.fail",
          passed: false,
          severity: "high" as const,
          category: "webhook" as const,
          message: "bad",
        }),
      },
    ];

    const report = await runSecurityChecks(checks, makeContext(), false);
    expect(report.totalChecks).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.status).toBe("at_risk");
    expect(report.exitCode).toBe(1);
  });

  it("applies --fix for auto-fixable checks", async () => {
    const fixFn = vi.fn().mockResolvedValue(true);
    const checks = [
      {
        id: "test.fixable",
        severity: "critical" as const,
        category: "secrets" as const,
        description: "fixable check",
        remediation: "auto-fix",
        autoFixable: true,
        check: () => ({
          id: "test.fixable",
          passed: false,
          severity: "critical" as const,
          category: "secrets" as const,
          message: "bad perms",
        }),
        fix: fixFn,
      },
    ];

    const report = await runSecurityChecks(checks, makeContext(), true);
    expect(fixFn).toHaveBeenCalled();
    expect(report.results[0]!.passed).toBe(true);
    expect(report.results[0]!.message).toContain("auto-fixed");
  });

  it("does not call fix for non-fixable checks", async () => {
    const checks = [
      {
        id: "test.nonfixable",
        severity: "high" as const,
        category: "webhook" as const,
        description: "non-fixable",
        remediation: "manual",
        autoFixable: false,
        check: () => ({
          id: "test.nonfixable",
          passed: false,
          severity: "high" as const,
          category: "webhook" as const,
          message: "bad",
        }),
      },
    ];

    const report = await runSecurityChecks(checks, makeContext(), true);
    expect(report.results[0]!.passed).toBe(false);
  });

  it("handles empty check list", async () => {
    const report = await runSecurityChecks([], makeContext(), false);
    expect(report.totalChecks).toBe(0);
    expect(report.status).toBe("secure");
    expect(report.exitCode).toBe(0);
  });
});
