import type {
  NetworkAccessRule,
  ProcessBudgetRule,
  PolicyBudgetRule,
  PolicyClass,
  PolicyClassRule,
  PolicyEvaluationScope,
  RuntimeBudgetRule,
  RuntimePolicyBundleConfig,
  RuntimePolicyConfig,
  ScopedActionBudgetRules,
  ScopedProcessBudgetRules,
  ScopedRuntimeBudgetRules,
  ScopedTokenBudgetRules,
  ScopedSpendBudgetRules,
  SpendBudgetRule,
  TokenBudgetRule,
  WriteScopeRule,
} from "./types.js";

export interface ResolvedPolicyContext {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly policy: RuntimePolicyBundleConfig;
}

function cloneBudgetRule(
  rule: PolicyBudgetRule | undefined,
): PolicyBudgetRule | undefined {
  return rule ? { limit: rule.limit, windowMs: rule.windowMs } : undefined;
}

function cloneSpendBudgetRule(
  rule: SpendBudgetRule | undefined,
): SpendBudgetRule | undefined {
  return rule
    ? { limitLamports: rule.limitLamports, windowMs: rule.windowMs }
    : undefined;
}

function cloneTokenBudgetRule(
  rule: TokenBudgetRule | undefined,
): TokenBudgetRule | undefined {
  return rule ? { limitTokens: rule.limitTokens, windowMs: rule.windowMs } : undefined;
}

function cloneRuntimeBudgetRule(
  rule: RuntimeBudgetRule | undefined,
): RuntimeBudgetRule | undefined {
  return rule ? { maxElapsedMs: rule.maxElapsedMs } : undefined;
}

function cloneProcessBudgetRule(
  rule: ProcessBudgetRule | undefined,
): ProcessBudgetRule | undefined {
  return rule ? { maxConcurrent: rule.maxConcurrent } : undefined;
}

function intersectOptionalLists(
  current: readonly string[] | undefined,
  next: readonly string[] | undefined,
): string[] | undefined {
  if (!current || current.length === 0) {
    return next ? [...next] : undefined;
  }
  if (!next || next.length === 0) {
    return [...current];
  }
  const nextSet = new Set(next);
  return current.filter((value) => nextSet.has(value));
}

function unionOptionalLists(
  current: readonly string[] | undefined,
  next: readonly string[] | undefined,
): string[] | undefined {
  if (!current && !next) return undefined;
  return Array.from(new Set([...(current ?? []), ...(next ?? [])]));
}

function mergeNetworkAccess(
  current: NetworkAccessRule | undefined,
  next: NetworkAccessRule | undefined,
): NetworkAccessRule | undefined {
  if (!current && !next) return undefined;
  return {
    allowHosts: intersectOptionalLists(current?.allowHosts, next?.allowHosts),
    denyHosts: unionOptionalLists(current?.denyHosts, next?.denyHosts),
  };
}

function mergeWriteScope(
  current: WriteScopeRule | undefined,
  next: WriteScopeRule | undefined,
): WriteScopeRule | undefined {
  if (!current && !next) return undefined;
  return {
    allowRoots: intersectOptionalLists(current?.allowRoots, next?.allowRoots),
    denyRoots: unionOptionalLists(current?.denyRoots, next?.denyRoots),
  };
}

function mergeBudgetRule(
  current: PolicyBudgetRule | undefined,
  next: PolicyBudgetRule | undefined,
): PolicyBudgetRule | undefined {
  if (!current) return cloneBudgetRule(next);
  if (!next) return cloneBudgetRule(current);
  return {
    limit: Math.min(current.limit, next.limit),
    windowMs: Math.max(current.windowMs, next.windowMs),
  };
}

function mergeSpendBudgetRule(
  current: SpendBudgetRule | undefined,
  next: SpendBudgetRule | undefined,
): SpendBudgetRule | undefined {
  if (!current) return cloneSpendBudgetRule(next);
  if (!next) return cloneSpendBudgetRule(current);
  return {
    limitLamports:
      current.limitLamports < next.limitLamports
        ? current.limitLamports
        : next.limitLamports,
    windowMs: Math.max(current.windowMs, next.windowMs),
  };
}

function mergeTokenBudgetRule(
  current: TokenBudgetRule | undefined,
  next: TokenBudgetRule | undefined,
): TokenBudgetRule | undefined {
  if (!current) return cloneTokenBudgetRule(next);
  if (!next) return cloneTokenBudgetRule(current);
  return {
    limitTokens: Math.min(current.limitTokens, next.limitTokens),
    windowMs: Math.max(current.windowMs, next.windowMs),
  };
}

function mergeRuntimeBudgetRule(
  current: RuntimeBudgetRule | undefined,
  next: RuntimeBudgetRule | undefined,
): RuntimeBudgetRule | undefined {
  if (!current) return cloneRuntimeBudgetRule(next);
  if (!next) return cloneRuntimeBudgetRule(current);
  return {
    maxElapsedMs: Math.min(current.maxElapsedMs, next.maxElapsedMs),
  };
}

function mergeProcessBudgetRule(
  current: ProcessBudgetRule | undefined,
  next: ProcessBudgetRule | undefined,
): ProcessBudgetRule | undefined {
  if (!current) return cloneProcessBudgetRule(next);
  if (!next) return cloneProcessBudgetRule(current);
  return {
    maxConcurrent: Math.min(current.maxConcurrent, next.maxConcurrent),
  };
}

function mergeBudgetMaps(
  current: Record<string, PolicyBudgetRule> | undefined,
  next: Record<string, PolicyBudgetRule> | undefined,
): Record<string, PolicyBudgetRule> | undefined {
  if (!current && !next) return undefined;
  const merged = new Map<string, PolicyBudgetRule>();
  for (const [key, rule] of Object.entries(current ?? {})) {
    merged.set(key, { limit: rule.limit, windowMs: rule.windowMs });
  }
  for (const [key, rule] of Object.entries(next ?? {})) {
    merged.set(key, mergeBudgetRule(merged.get(key), rule)!);
  }
  return Object.fromEntries(merged);
}

function mergePolicyClassRules(
  current:
    | Partial<Record<PolicyClass, PolicyClassRule>>
    | undefined,
  next:
    | Partial<Record<PolicyClass, PolicyClassRule>>
    | undefined,
): Partial<Record<PolicyClass, PolicyClassRule>> | undefined {
  if (!current && !next) return undefined;
  const merged: Partial<Record<PolicyClass, PolicyClassRule>> = {};
  const keys = new Set<PolicyClass>([
    ...((current ? Object.keys(current) : []) as PolicyClass[]),
    ...((next ? Object.keys(next) : []) as PolicyClass[]),
  ]);
  for (const key of keys) {
    const existing = current?.[key];
    const incoming = next?.[key];
    if (!existing && !incoming) continue;
    merged[key] = {
      deny: Boolean(existing?.deny) || Boolean(incoming?.deny),
      maxRiskScore:
        existing?.maxRiskScore === undefined
          ? incoming?.maxRiskScore
          : incoming?.maxRiskScore === undefined
            ? existing.maxRiskScore
            : Math.min(existing.maxRiskScore, incoming.maxRiskScore),
    };
  }
  return merged;
}

function mergeScopedActionBudgets(
  current: ScopedActionBudgetRules | undefined,
  next: ScopedActionBudgetRules | undefined,
): ScopedActionBudgetRules | undefined {
  if (!current && !next) return undefined;
  return {
    tenant: mergeBudgetMaps(current?.tenant, next?.tenant),
    project: mergeBudgetMaps(current?.project, next?.project),
    run: mergeBudgetMaps(current?.run, next?.run),
  };
}

function mergeScopedSpendBudgets(
  current: ScopedSpendBudgetRules | undefined,
  next: ScopedSpendBudgetRules | undefined,
): ScopedSpendBudgetRules | undefined {
  if (!current && !next) return undefined;
  return {
    tenant: mergeSpendBudgetRule(current?.tenant, next?.tenant),
    project: mergeSpendBudgetRule(current?.project, next?.project),
    run: mergeSpendBudgetRule(current?.run, next?.run),
  };
}

function mergeScopedTokenBudgets(
  current: ScopedTokenBudgetRules | undefined,
  next: ScopedTokenBudgetRules | undefined,
): ScopedTokenBudgetRules | undefined {
  if (!current && !next) return undefined;
  return {
    tenant: mergeTokenBudgetRule(current?.tenant, next?.tenant),
    project: mergeTokenBudgetRule(current?.project, next?.project),
    run: mergeTokenBudgetRule(current?.run, next?.run),
  };
}

function mergeScopedRuntimeBudgets(
  current: ScopedRuntimeBudgetRules | undefined,
  next: ScopedRuntimeBudgetRules | undefined,
): ScopedRuntimeBudgetRules | undefined {
  if (!current && !next) return undefined;
  return {
    tenant: mergeRuntimeBudgetRule(current?.tenant, next?.tenant),
    project: mergeRuntimeBudgetRule(current?.project, next?.project),
    run: mergeRuntimeBudgetRule(current?.run, next?.run),
  };
}

function mergeScopedProcessBudgets(
  current: ScopedProcessBudgetRules | undefined,
  next: ScopedProcessBudgetRules | undefined,
): ScopedProcessBudgetRules | undefined {
  if (!current && !next) return undefined;
  return {
    tenant: mergeProcessBudgetRule(current?.tenant, next?.tenant),
    project: mergeProcessBudgetRule(current?.project, next?.project),
    run: mergeProcessBudgetRule(current?.run, next?.run),
  };
}

export function mergePolicyBundles(
  base: RuntimePolicyBundleConfig | undefined,
  overlay: RuntimePolicyBundleConfig | undefined,
): RuntimePolicyBundleConfig {
  const resolvedBase = base ?? {};
  const resolvedOverlay = overlay ?? {};
  const maxRiskScore =
    resolvedBase.maxRiskScore === undefined
      ? resolvedOverlay.maxRiskScore
      : resolvedOverlay.maxRiskScore === undefined
        ? resolvedBase.maxRiskScore
        : Math.min(resolvedBase.maxRiskScore, resolvedOverlay.maxRiskScore);

  return {
    enabled:
      Boolean(resolvedBase.enabled) || Boolean(resolvedOverlay.enabled),
    allowActions: intersectOptionalLists(
      resolvedBase.allowActions,
      resolvedOverlay.allowActions,
    ),
    denyActions: unionOptionalLists(
      resolvedBase.denyActions,
      resolvedOverlay.denyActions,
    ),
    toolAllowList: intersectOptionalLists(
      resolvedBase.toolAllowList,
      resolvedOverlay.toolAllowList,
    ),
    toolDenyList: unionOptionalLists(
      resolvedBase.toolDenyList,
      resolvedOverlay.toolDenyList,
    ),
    credentialAllowList: intersectOptionalLists(
      resolvedBase.credentialAllowList,
      resolvedOverlay.credentialAllowList,
    ),
    networkAccess: mergeNetworkAccess(
      resolvedBase.networkAccess,
      resolvedOverlay.networkAccess,
    ),
    writeScope: mergeWriteScope(
      resolvedBase.writeScope,
      resolvedOverlay.writeScope,
    ),
    actionBudgets: mergeBudgetMaps(
      resolvedBase.actionBudgets,
      resolvedOverlay.actionBudgets,
    ),
    spendBudget: mergeSpendBudgetRule(
      resolvedBase.spendBudget,
      resolvedOverlay.spendBudget,
    ),
    tokenBudget: mergeTokenBudgetRule(
      resolvedBase.tokenBudget,
      resolvedOverlay.tokenBudget,
    ),
    runtimeBudget: mergeRuntimeBudgetRule(
      resolvedBase.runtimeBudget,
      resolvedOverlay.runtimeBudget,
    ),
    processBudget: mergeProcessBudgetRule(
      resolvedBase.processBudget,
      resolvedOverlay.processBudget,
    ),
    scopedActionBudgets: mergeScopedActionBudgets(
      resolvedBase.scopedActionBudgets,
      resolvedOverlay.scopedActionBudgets,
    ),
    scopedSpendBudgets: mergeScopedSpendBudgets(
      resolvedBase.scopedSpendBudgets,
      resolvedOverlay.scopedSpendBudgets,
    ),
    scopedTokenBudgets: mergeScopedTokenBudgets(
      resolvedBase.scopedTokenBudgets,
      resolvedOverlay.scopedTokenBudgets,
    ),
    scopedRuntimeBudgets: mergeScopedRuntimeBudgets(
      resolvedBase.scopedRuntimeBudgets,
      resolvedOverlay.scopedRuntimeBudgets,
    ),
    scopedProcessBudgets: mergeScopedProcessBudgets(
      resolvedBase.scopedProcessBudgets,
      resolvedOverlay.scopedProcessBudgets,
    ),
    maxRiskScore,
    policyClassRules: mergePolicyClassRules(
      resolvedBase.policyClassRules,
      resolvedOverlay.policyClassRules,
    ),
    circuitBreaker: resolvedOverlay.circuitBreaker ?? resolvedBase.circuitBreaker,
  };
}

export function resolvePolicyContext(
  policy: RuntimePolicyConfig | undefined,
  scope: PolicyEvaluationScope | undefined,
): ResolvedPolicyContext {
  const tenantId = scope?.tenantId ?? policy?.defaultTenantId;
  const projectId = scope?.projectId ?? policy?.defaultProjectId;
  let resolved = mergePolicyBundles(policy, undefined);
  if (tenantId) {
    resolved = mergePolicyBundles(resolved, policy?.tenantBundles?.[tenantId]);
  }
  if (projectId) {
    resolved = mergePolicyBundles(resolved, policy?.projectBundles?.[projectId]);
  }
  return { tenantId, projectId, policy: resolved };
}
