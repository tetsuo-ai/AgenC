/**
 * Policy configuration mapping helpers for the daemon.
 *
 * Extracted from daemon.ts to reduce file size.
 * Contains pure mapping functions that convert gateway policy config
 * to the runtime policy engine format.
 *
 * @module
 */

import type { GatewayPolicyConfig } from "./types.js";
import type { RuntimeSessionCredentialConfig } from "../policy/index.js";

export function mapScopedActionBudgets(
  value: GatewayPolicyConfig["scopedActionBudgets"],
): {
  tenant?: Record<string, { limit: number; windowMs: number }>;
  project?: Record<string, { limit: number; windowMs: number }>;
  run?: Record<string, { limit: number; windowMs: number }>;
} {
  return {
    tenant: value?.tenant ? { ...value.tenant } : undefined,
    project: value?.project ? { ...value.project } : undefined,
    run: value?.run ? { ...value.run } : undefined,
  };
}

export function mapScopedSpendBudgets(
  value: GatewayPolicyConfig["scopedSpendBudgets"],
): {
  tenant?: { limitLamports: bigint; windowMs: number };
  project?: { limitLamports: bigint; windowMs: number };
  run?: { limitLamports: bigint; windowMs: number };
} {
  const mapRule = (
    rule: { limitLamports: string; windowMs: number } | undefined,
  ) =>
    rule
      ? {
          limitLamports: BigInt(rule.limitLamports),
          windowMs: rule.windowMs,
        }
      : undefined;
  return {
    tenant: mapRule(value?.tenant),
    project: mapRule(value?.project),
    run: mapRule(value?.run),
  };
}

export function mapScopedTokenBudgets(
  value: GatewayPolicyConfig["scopedTokenBudgets"],
): {
  tenant?: { limitTokens: number; windowMs: number };
  project?: { limitTokens: number; windowMs: number };
  run?: { limitTokens: number; windowMs: number };
} {
  const mapRule = (
    rule: { limitTokens: number; windowMs: number } | undefined,
  ) =>
    rule
      ? {
          limitTokens: rule.limitTokens,
          windowMs: rule.windowMs,
        }
      : undefined;
  return {
    tenant: mapRule(value?.tenant),
    project: mapRule(value?.project),
    run: mapRule(value?.run),
  };
}

export function mapScopedRuntimeBudgets(
  value: GatewayPolicyConfig["scopedRuntimeBudgets"],
): {
  tenant?: { maxElapsedMs: number };
  project?: { maxElapsedMs: number };
  run?: { maxElapsedMs: number };
} {
  const mapRule = (rule: { maxElapsedMs: number } | undefined) =>
    rule
      ? {
          maxElapsedMs: rule.maxElapsedMs,
        }
      : undefined;
  return {
    tenant: mapRule(value?.tenant),
    project: mapRule(value?.project),
    run: mapRule(value?.run),
  };
}

export function mapScopedProcessBudgets(
  value: GatewayPolicyConfig["scopedProcessBudgets"],
): {
  tenant?: { maxConcurrent: number };
  project?: { maxConcurrent: number };
  run?: { maxConcurrent: number };
} {
  const mapRule = (rule: { maxConcurrent: number } | undefined) =>
    rule
      ? {
          maxConcurrent: rule.maxConcurrent,
        }
      : undefined;
  return {
    tenant: mapRule(value?.tenant),
    project: mapRule(value?.project),
    run: mapRule(value?.run),
  };
}

export function mapPolicyBundles(
  bundles:
    | GatewayPolicyConfig["tenantBundles"]
    | GatewayPolicyConfig["projectBundles"],
):
  | Record<string, import("../policy/types.js").RuntimePolicyBundleConfig>
  | undefined {
  if (!bundles) return undefined;
  return Object.fromEntries(
    Object.entries(bundles).map(([key, bundle]) => [
      key,
      {
        ...bundle,
        credentialAllowList: bundle.credentialAllowList
          ? [...bundle.credentialAllowList]
          : undefined,
        actionBudgets: bundle.actionBudgets
          ? { ...bundle.actionBudgets }
          : undefined,
        spendBudget: bundle.spendBudget
          ? {
              limitLamports: BigInt(bundle.spendBudget.limitLamports),
              windowMs: bundle.spendBudget.windowMs,
            }
          : undefined,
        tokenBudget: bundle.tokenBudget
          ? {
              limitTokens: bundle.tokenBudget.limitTokens,
              windowMs: bundle.tokenBudget.windowMs,
            }
          : undefined,
        runtimeBudget: bundle.runtimeBudget
          ? {
              maxElapsedMs: bundle.runtimeBudget.maxElapsedMs,
            }
          : undefined,
        processBudget: bundle.processBudget
          ? {
              maxConcurrent: bundle.processBudget.maxConcurrent,
            }
          : undefined,
        scopedActionBudgets: bundle.scopedActionBudgets
          ? mapScopedActionBudgets(bundle.scopedActionBudgets)
          : undefined,
        scopedSpendBudgets: bundle.scopedSpendBudgets
          ? mapScopedSpendBudgets(bundle.scopedSpendBudgets)
          : undefined,
        scopedTokenBudgets: bundle.scopedTokenBudgets
          ? mapScopedTokenBudgets(bundle.scopedTokenBudgets)
          : undefined,
        scopedRuntimeBudgets: bundle.scopedRuntimeBudgets
          ? mapScopedRuntimeBudgets(bundle.scopedRuntimeBudgets)
          : undefined,
        scopedProcessBudgets: bundle.scopedProcessBudgets
          ? mapScopedProcessBudgets(bundle.scopedProcessBudgets)
          : undefined,
        policyClassRules: bundle.policyClassRules,
      },
    ]),
  );
}

export function mapCredentialCatalog(
  catalog: GatewayPolicyConfig["credentialCatalog"],
): Record<string, RuntimeSessionCredentialConfig> | undefined {
  if (!catalog) return undefined;
  return Object.fromEntries(
    Object.entries(catalog).map(([credentialId, value]) => [
      credentialId,
      {
        sourceEnvVar: value.sourceEnvVar,
        domains: [...value.domains],
        headerTemplates: value.headerTemplates
          ? { ...value.headerTemplates }
          : undefined,
        allowedTools: value.allowedTools ? [...value.allowedTools] : undefined,
        ttlMs: value.ttlMs,
      },
    ]),
  );
}
