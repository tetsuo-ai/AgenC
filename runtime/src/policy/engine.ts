/**
 * Deterministic runtime policy/safety engine with circuit breakers.
 *
 * @module
 */

import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import type {
  CircuitBreakerMode,
  NetworkAccessRule,
  ProcessBudgetRule,
  PolicyAction,
  PolicyDecision,
  PolicyEngineConfig,
  PolicyEngineState,
  PolicyViolation,
  PolicyBudgetRule,
  RuntimeBudgetRule,
  RuntimePolicyBundleConfig,
  RuntimePolicyConfig,
  SpendBudgetRule,
  TokenBudgetRule,
  WriteScopeRule,
} from "./types.js";
import { PolicyViolationError } from "./types.js";
import { silentLogger } from "../utils/logger.js";
import { resolvePolicyContext } from "./bundles.js";

const DEFAULT_POLICY: RuntimePolicyConfig = {
  enabled: false,
};

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === normalizedValue;
  }
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue);
}

function pathMatchesRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = resolvePath(candidate);
  const normalizedRoot = resolvePath(root);
  const rel = relativePath(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../"));
}

type ScopedActionBudgetCandidate = {
  scopeKey: string;
  budget?: PolicyBudgetRule;
  scopeLabel: "global" | "tenant" | "project" | "run";
  scopeValue?: string;
};

type ScopedSpendBudgetCandidate = {
  scopeKey: string;
  budget?: SpendBudgetRule;
  scopeLabel: "global" | "tenant" | "project" | "run";
  scopeValue?: string;
};

type ScopedTokenBudgetCandidate = {
  scopeKey: string;
  budget?: TokenBudgetRule;
  scopeLabel: "global" | "tenant" | "project" | "run";
  scopeValue?: string;
};

type ScopedRuntimeBudgetCandidate = {
  scopeKey: string;
  budget?: RuntimeBudgetRule;
  scopeLabel: "global" | "tenant" | "project" | "run";
  scopeValue?: string;
};

type ScopedProcessBudgetCandidate = {
  scopeKey: string;
  budget?: ProcessBudgetRule;
  scopeLabel: "global" | "tenant" | "project" | "run";
  scopeValue?: string;
};

function resolveScopedNumericValue(
  baseValue: number | undefined,
  scopedValues:
    | Partial<Record<"global" | "tenant" | "project" | "run", number>>
    | undefined,
  scopeLabel: "global" | "tenant" | "project" | "run",
): number | undefined {
  const scoped = scopedValues?.[scopeLabel];
  return typeof scoped === "number" && Number.isFinite(scoped)
    ? scoped
    : baseValue;
}

export class PolicyEngine {
  private policy: RuntimePolicyConfig;
  private mode: CircuitBreakerMode = "normal";
  private circuitBreakerReason?: string;
  private trippedAtMs?: number;

  private readonly logger;
  private readonly metrics;
  private readonly now: () => number;

  private readonly actionEvents = new Map<string, number[]>();
  private readonly spendEvents = new Map<
    string,
    Array<{ atMs: number; amount: bigint }>
  >();
  private readonly tokenEvents = new Map<
    string,
    Array<{ atMs: number; amount: number }>
  >();
  private violationEvents: number[] = [];

  onViolation?: (violation: PolicyViolation) => void;

  constructor(config: PolicyEngineConfig = {}) {
    this.policy = { ...DEFAULT_POLICY, ...(config.policy ?? {}) };
    this.logger = config.logger ?? silentLogger;
    this.metrics = config.metrics;
    this.now = config.now ?? Date.now;
  }

  getPolicy(): RuntimePolicyConfig {
    return { ...this.policy };
  }

  setPolicy(policy: RuntimePolicyConfig): void {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  setMode(
    mode: Exclude<CircuitBreakerMode, "normal">,
    reason = "manual",
  ): void {
    this.mode = mode;
    this.circuitBreakerReason = reason;
    this.trippedAtMs = this.now();
  }

  clearMode(): void {
    this.mode = "normal";
    this.circuitBreakerReason = undefined;
    this.trippedAtMs = undefined;
  }

  getState(): PolicyEngineState {
    this.pruneViolations();
    return {
      mode: this.mode,
      circuitBreakerReason: this.circuitBreakerReason,
      trippedAtMs: this.trippedAtMs,
      recentViolations: this.violationEvents.length,
    };
  }

  evaluate(action: PolicyAction): PolicyDecision {
    return this.evaluateInternal(action, true);
  }

  simulate(action: PolicyAction): PolicyDecision {
    return this.evaluateInternal(action, false);
  }

  private evaluateInternal(
    action: PolicyAction,
    consumeBudgets: boolean,
  ): PolicyDecision {
    this.pruneViolations();
    const violations: PolicyViolation[] = [];
    const resolved = resolvePolicyContext(this.policy, action.scope);
    const activePolicy = resolved.policy;

    const modeViolation = this.checkCircuitMode(action);
    if (modeViolation) {
      violations.push(modeViolation);
    }

    if (activePolicy.enabled) {
      const toolViolation = this.checkToolRules(action, activePolicy);
      if (toolViolation) violations.push(toolViolation);

      const actionViolation = this.checkActionRules(action, activePolicy);
      if (actionViolation) violations.push(actionViolation);

      const classViolation = this.checkPolicyClass(action, activePolicy);
      if (classViolation) violations.push(classViolation);

      const riskViolation = this.checkRisk(action, activePolicy);
      if (riskViolation) violations.push(riskViolation);

      const networkViolation = this.checkNetworkAccess(action, activePolicy);
      if (networkViolation) violations.push(networkViolation);

      const writeScopeViolation = this.checkWriteScope(action, activePolicy);
      if (writeScopeViolation) violations.push(writeScopeViolation);

      const actionBudgetViolation = this.checkAndConsumeActionBudget(
        action,
        activePolicy,
        resolved,
        consumeBudgets,
      );
      if (actionBudgetViolation) violations.push(actionBudgetViolation);

      const spendViolation = this.checkAndConsumeSpendBudget(
        action,
        activePolicy,
        resolved,
        consumeBudgets,
      );
      if (spendViolation) violations.push(spendViolation);

      const tokenViolation = this.checkAndConsumeTokenBudget(
        action,
        activePolicy,
        resolved,
        consumeBudgets,
      );
      if (tokenViolation) violations.push(tokenViolation);

      const runtimeViolation = this.checkRuntimeBudget(
        action,
        activePolicy,
        resolved,
      );
      if (runtimeViolation) violations.push(runtimeViolation);

      const processViolation = this.checkProcessBudget(
        action,
        activePolicy,
        resolved,
      );
      if (processViolation) violations.push(processViolation);
    }

    const allowed = violations.length === 0;
    if (!allowed) {
      this.recordViolation(violations[0]);
      this.maybeAutoTripCircuitBreaker();
    } else {
      this.metrics?.counter(TELEMETRY_METRIC_NAMES.POLICY_DECISIONS_TOTAL, 1, {
        outcome: "allow",
        action_type: action.type,
      });
    }

    return {
      allowed,
      mode: this.mode,
      violations,
    };
  }

  evaluateOrThrow(action: PolicyAction): void {
    const decision = this.evaluate(action);
    if (!decision.allowed) {
      throw new PolicyViolationError(action, decision);
    }
  }

  private checkCircuitMode(action: PolicyAction): PolicyViolation | null {
    if (this.mode === "normal") {
      return null;
    }

    if (this.mode === "pause_discovery" && action.type === "task_discovery") {
      return this.buildViolation(
        "circuit_breaker_active",
        action,
        "Discovery is paused by circuit breaker",
      );
    }

    if (this.mode === "halt_submissions" && action.type === "tx_submission") {
      return this.buildViolation(
        "circuit_breaker_active",
        action,
        "Submissions are halted by circuit breaker",
      );
    }

    if (this.mode === "safe_mode" && action.access === "write") {
      return this.buildViolation(
        "circuit_breaker_active",
        action,
        "Safe mode blocks write actions",
      );
    }

    return null;
  }

  private checkToolRules(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    if (action.type !== "tool_call") {
      return null;
    }

    if (policy.toolDenyList?.includes(action.name)) {
      return this.buildViolation(
        "tool_denied",
        action,
        `Tool "${action.name}" is denied by policy`,
      );
    }

    const allowList = policy.toolAllowList;
    if (allowList && allowList.length > 0 && !allowList.includes(action.name)) {
      return this.buildViolation(
        "tool_denied",
        action,
        `Tool "${action.name}" is not in allow-list`,
      );
    }

    return null;
  }

  private checkActionRules(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    if (policy.denyActions?.includes(action.name)) {
      return this.buildViolation(
        "action_denied",
        action,
        `Action "${action.name}" is denied by policy`,
      );
    }

    const allowActions = policy.allowActions;
    if (
      allowActions &&
      allowActions.length > 0 &&
      !allowActions.includes(action.name)
    ) {
      return this.buildViolation(
        "action_denied",
        action,
        `Action "${action.name}" is not in allow-list`,
      );
    }

    return null;
  }

  private checkPolicyClass(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    if (!action.policyClass) {
      return null;
    }
    const rule = policy.policyClassRules?.[action.policyClass];
    if (!rule) {
      return null;
    }
    if (rule.deny) {
      return this.buildViolation(
        "policy_class_denied",
        action,
        `Policy class "${action.policyClass}" is denied by policy`,
        { policyClass: action.policyClass },
      );
    }
    if (
      rule.maxRiskScore !== undefined &&
      action.riskScore !== undefined &&
      action.riskScore > rule.maxRiskScore
    ) {
      return this.buildViolation(
        "policy_class_risk_exceeded",
        action,
        `Policy class "${action.policyClass}" risk ${action.riskScore.toFixed(3)} exceeds max ${rule.maxRiskScore.toFixed(3)}`,
        {
          policyClass: action.policyClass,
          maxRiskScore: rule.maxRiskScore,
          riskScore: action.riskScore,
        },
      );
    }
    return null;
  }

  private checkRisk(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    const maxRisk = policy.maxRiskScore;
    if (maxRisk === undefined || action.riskScore === undefined) {
      return null;
    }
    if (action.riskScore <= maxRisk) {
      return null;
    }
    return this.buildViolation(
      "risk_threshold_exceeded",
      action,
      `Risk score ${action.riskScore.toFixed(3)} exceeds max ${maxRisk.toFixed(3)}`,
      {
        maxRiskScore: maxRisk,
        riskScore: action.riskScore,
      },
    );
  }

  private checkAndConsumeActionBudget(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
    resolvedScope: ReturnType<typeof resolvePolicyContext>,
    consume: boolean,
  ): PolicyViolation | null {
    const exactKey = `${action.type}:${action.name}`;
    const wildcardKey = `${action.type}:*`;
    const budgetSets: ScopedActionBudgetCandidate[] = [
      {
        scopeKey: `global:${exactKey}`,
        budget:
          policy.actionBudgets?.[exactKey] ?? policy.actionBudgets?.[wildcardKey],
        scopeLabel: "global",
      },
    ];
    if (resolvedScope.tenantId) {
      budgetSets.push({
        scopeKey: `tenant:${resolvedScope.tenantId}:${exactKey}`,
        budget:
          policy.scopedActionBudgets?.tenant?.[exactKey] ??
          policy.scopedActionBudgets?.tenant?.[wildcardKey],
        scopeLabel: "tenant",
        scopeValue: resolvedScope.tenantId,
      });
    }
    if (resolvedScope.projectId) {
      budgetSets.push({
        scopeKey: `project:${resolvedScope.projectId}:${exactKey}`,
        budget:
          policy.scopedActionBudgets?.project?.[exactKey] ??
          policy.scopedActionBudgets?.project?.[wildcardKey],
        scopeLabel: "project",
        scopeValue: resolvedScope.projectId,
      });
    }
    if (action.scope?.runId) {
      budgetSets.push({
        scopeKey: `run:${action.scope.runId}:${exactKey}`,
        budget:
          policy.scopedActionBudgets?.run?.[exactKey] ??
          policy.scopedActionBudgets?.run?.[wildcardKey],
        scopeLabel: "run",
        scopeValue: action.scope.runId,
      });
    }

    for (const budgetSet of budgetSets) {
      const violation = this.consumeActionBudget(
        action,
        budgetSet.scopeKey,
        budgetSet.budget,
        consume,
        {
          scope: budgetSet.scopeLabel,
          scopeValue: budgetSet.scopeValue,
        },
      );
      if (violation) return violation;
    }
    return null;
  }

  private checkNetworkAccess(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    const rule = policy.networkAccess;
    if (!rule) return null;
    const networkHosts = Array.isArray(action.metadata?.networkHosts)
      ? action.metadata?.networkHosts.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    if (networkHosts.length === 0) {
      return null;
    }
    const deniedHost = this.findDeniedHost(networkHosts, rule);
    if (deniedHost) {
      return this.buildViolation(
        "network_access_denied",
        action,
        `Network access to host "${deniedHost}" is denied by policy`,
        { host: deniedHost },
      );
    }
    const allowHosts = rule.allowHosts?.filter((entry) => entry.trim().length > 0);
    if (allowHosts && allowHosts.length > 0) {
      const disallowedHost = networkHosts.find(
        (host) => !allowHosts.some((pattern) => globMatch(pattern, host)),
      );
      if (disallowedHost) {
        return this.buildViolation(
          "network_access_denied",
          action,
          `Network access to host "${disallowedHost}" is outside the allowed host set`,
          { host: disallowedHost },
        );
      }
    }
    return null;
  }

  private findDeniedHost(
    networkHosts: readonly string[],
    rule: NetworkAccessRule,
  ): string | null {
    const denyHosts = rule.denyHosts?.filter((entry) => entry.trim().length > 0);
    if (!denyHosts || denyHosts.length === 0) {
      return null;
    }
    for (const host of networkHosts) {
      if (denyHosts.some((pattern) => globMatch(pattern, host))) {
        return host;
      }
    }
    return null;
  }

  private checkWriteScope(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
  ): PolicyViolation | null {
    const rule = policy.writeScope;
    if (!rule) return null;
    const writePaths = Array.isArray(action.metadata?.writePaths)
      ? action.metadata?.writePaths.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
    if (writePaths.length === 0) {
      return null;
    }
    const denied = this.findWriteScopeViolation(writePaths, rule);
    if (!denied) {
      return null;
    }
    return this.buildViolation(
      "write_scope_denied",
      action,
      denied.message,
      denied.details,
    );
  }

  private findWriteScopeViolation(
    writePaths: readonly string[],
    rule: WriteScopeRule,
  ): { message: string; details: Record<string, unknown> } | null {
    const allowRoots = rule.allowRoots?.filter((entry) => entry.trim().length > 0);
    const denyRoots = rule.denyRoots?.filter((entry) => entry.trim().length > 0);

    for (const candidate of writePaths) {
      if (!isAbsolute(candidate)) {
        return {
          message: `Write path "${candidate}" is relative and cannot be validated against policy.writeScope`,
          details: { path: candidate },
        };
      }
      if (denyRoots?.some((root) => pathMatchesRoot(candidate, root))) {
        return {
          message: `Write path "${candidate}" is denied by policy.writeScope`,
          details: { path: candidate },
        };
      }
      if (
        allowRoots &&
        allowRoots.length > 0 &&
        !allowRoots.some((root) => pathMatchesRoot(candidate, root))
      ) {
        return {
          message: `Write path "${candidate}" is outside the allowed write roots`,
          details: { path: candidate },
        };
      }
    }
    return null;
  }

  private consumeActionBudget(
    action: PolicyAction,
    eventKey: string,
    budget: PolicyBudgetRule | undefined,
    consume: boolean,
    details: Record<string, unknown>,
  ): PolicyViolation | null {
    if (!budget) return null;
    const now = this.now();
    const cutoff = now - budget.windowMs;
    const bucket = this.actionEvents.get(eventKey) ?? [];
    const recent = bucket.filter((timestamp) => timestamp >= cutoff);
    if (recent.length >= budget.limit) {
      if (consume) {
        this.actionEvents.set(eventKey, recent);
      }
      return this.buildViolation(
        "action_budget_exceeded",
        action,
        `Action budget exceeded for "${action.name}"`,
        {
          ...details,
          limit: budget.limit,
          windowMs: budget.windowMs,
          observed: recent.length,
        },
      );
    }
    if (consume) {
      recent.push(now);
      this.actionEvents.set(eventKey, recent);
    }
    return null;
  }

  private checkAndConsumeSpendBudget(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
    resolvedScope: ReturnType<typeof resolvePolicyContext>,
    consume: boolean,
  ): PolicyViolation | null {
    if (action.spendLamports === undefined) {
      return null;
    }
    const budgets: ScopedSpendBudgetCandidate[] = [
      { scopeKey: "global", budget: policy.spendBudget, scopeLabel: "global" },
    ];
    if (resolvedScope.tenantId) {
      budgets.push({
        scopeKey: `tenant:${resolvedScope.tenantId}`,
        budget: policy.scopedSpendBudgets?.tenant,
        scopeLabel: "tenant",
        scopeValue: resolvedScope.tenantId,
      });
    }
    if (resolvedScope.projectId) {
      budgets.push({
        scopeKey: `project:${resolvedScope.projectId}`,
        budget: policy.scopedSpendBudgets?.project,
        scopeLabel: "project",
        scopeValue: resolvedScope.projectId,
      });
    }
    if (action.scope?.runId) {
      budgets.push({
        scopeKey: `run:${action.scope.runId}`,
        budget: policy.scopedSpendBudgets?.run,
        scopeLabel: "run",
        scopeValue: action.scope.runId,
      });
    }

    for (const scoped of budgets) {
      const violation = this.consumeSpendBudget(
        action,
        scoped.scopeKey,
        scoped.budget,
        consume,
        {
          scope: scoped.scopeLabel,
          scopeValue: scoped.scopeValue,
        },
      );
      if (violation) return violation;
    }
    return null;
  }

  private checkAndConsumeTokenBudget(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
    resolvedScope: ReturnType<typeof resolvePolicyContext>,
    consume: boolean,
  ): PolicyViolation | null {
    if (action.tokenCount === undefined) {
      return null;
    }
    const budgets: ScopedTokenBudgetCandidate[] = [
      { scopeKey: "global", budget: policy.tokenBudget, scopeLabel: "global" },
    ];
    if (resolvedScope.tenantId) {
      budgets.push({
        scopeKey: `tenant:${resolvedScope.tenantId}`,
        budget: policy.scopedTokenBudgets?.tenant,
        scopeLabel: "tenant",
        scopeValue: resolvedScope.tenantId,
      });
    }
    if (resolvedScope.projectId) {
      budgets.push({
        scopeKey: `project:${resolvedScope.projectId}`,
        budget: policy.scopedTokenBudgets?.project,
        scopeLabel: "project",
        scopeValue: resolvedScope.projectId,
      });
    }
    if (action.scope?.runId) {
      budgets.push({
        scopeKey: `run:${action.scope.runId}`,
        budget: policy.scopedTokenBudgets?.run,
        scopeLabel: "run",
        scopeValue: action.scope.runId,
      });
    }

    for (const scoped of budgets) {
      const violation = this.consumeTokenBudget(
        action,
        scoped.scopeKey,
        scoped.budget,
        consume,
        {
          scope: scoped.scopeLabel,
          scopeValue: scoped.scopeValue,
        },
      );
      if (violation) return violation;
    }
    return null;
  }

  private consumeTokenBudget(
    action: PolicyAction,
    eventKey: string,
    budget: TokenBudgetRule | undefined,
    consume: boolean,
    details: Record<string, unknown>,
  ): PolicyViolation | null {
    if (!budget || action.tokenCount === undefined) {
      return null;
    }
    const now = this.now();
    const cutoff = now - budget.windowMs;
    const bucket = (this.tokenEvents.get(eventKey) ?? []).filter(
      (event) => event.atMs >= cutoff,
    );
    const currentTokens = bucket.reduce((sum, event) => sum + event.amount, 0);
    const projected = currentTokens + action.tokenCount;
    if (projected > budget.limitTokens) {
      if (consume) {
        if (action.budgetConsumptionMode === "post_hoc_actual") {
          bucket.push({ atMs: now, amount: action.tokenCount });
        }
        this.tokenEvents.set(eventKey, bucket);
      }
      return this.buildViolation(
        "token_budget_exceeded",
        action,
        "Token budget exceeded",
        {
          ...details,
          limitTokens: budget.limitTokens,
          currentTokens,
          attemptedTokens: action.tokenCount,
        },
      );
    }
    if (consume) {
      bucket.push({ atMs: now, amount: action.tokenCount });
      this.tokenEvents.set(eventKey, bucket);
    }
    return null;
  }

  private checkRuntimeBudget(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
    resolvedScope: ReturnType<typeof resolvePolicyContext>,
  ): PolicyViolation | null {
    if (action.elapsedRuntimeMs === undefined) {
      return null;
    }
    const budgets: ScopedRuntimeBudgetCandidate[] = [
      { scopeKey: "global", budget: policy.runtimeBudget, scopeLabel: "global" },
    ];
    if (resolvedScope.tenantId) {
      budgets.push({
        scopeKey: `tenant:${resolvedScope.tenantId}`,
        budget: policy.scopedRuntimeBudgets?.tenant,
        scopeLabel: "tenant",
        scopeValue: resolvedScope.tenantId,
      });
    }
    if (resolvedScope.projectId) {
      budgets.push({
        scopeKey: `project:${resolvedScope.projectId}`,
        budget: policy.scopedRuntimeBudgets?.project,
        scopeLabel: "project",
        scopeValue: resolvedScope.projectId,
      });
    }
    if (action.scope?.runId) {
      budgets.push({
        scopeKey: `run:${action.scope.runId}`,
        budget: policy.scopedRuntimeBudgets?.run,
        scopeLabel: "run",
        scopeValue: action.scope.runId,
      });
    }

    for (const scoped of budgets) {
      const violation = this.enforceRuntimeBudget(
        action,
        scoped.scopeKey,
        scoped.budget,
        {
          scope: scoped.scopeLabel,
          scopeValue: scoped.scopeValue,
        },
      );
      if (violation) return violation;
    }
    return null;
  }

  private enforceRuntimeBudget(
    action: PolicyAction,
    _scopeKey: string,
    budget: RuntimeBudgetRule | undefined,
    details: Record<string, unknown> & {
      scope: "global" | "tenant" | "project" | "run";
    },
  ): PolicyViolation | null {
    const observedElapsedMs = resolveScopedNumericValue(
      action.elapsedRuntimeMs,
      action.elapsedRuntimeMsByScope,
      details.scope,
    );
    if (!budget || observedElapsedMs === undefined) {
      return null;
    }
    if (observedElapsedMs <= budget.maxElapsedMs) {
      return null;
    }
    return this.buildViolation(
      "runtime_budget_exceeded",
      action,
      "Runtime budget exceeded",
      {
        ...details,
        maxElapsedMs: budget.maxElapsedMs,
        observedElapsedMs,
      },
    );
  }

  private checkProcessBudget(
    action: PolicyAction,
    policy: RuntimePolicyBundleConfig,
    resolvedScope: ReturnType<typeof resolvePolicyContext>,
  ): PolicyViolation | null {
    if (action.processCount === undefined) {
      return null;
    }
    const budgets: ScopedProcessBudgetCandidate[] = [
      { scopeKey: "global", budget: policy.processBudget, scopeLabel: "global" },
    ];
    if (resolvedScope.tenantId) {
      budgets.push({
        scopeKey: `tenant:${resolvedScope.tenantId}`,
        budget: policy.scopedProcessBudgets?.tenant,
        scopeLabel: "tenant",
        scopeValue: resolvedScope.tenantId,
      });
    }
    if (resolvedScope.projectId) {
      budgets.push({
        scopeKey: `project:${resolvedScope.projectId}`,
        budget: policy.scopedProcessBudgets?.project,
        scopeLabel: "project",
        scopeValue: resolvedScope.projectId,
      });
    }
    if (action.scope?.runId) {
      budgets.push({
        scopeKey: `run:${action.scope.runId}`,
        budget: policy.scopedProcessBudgets?.run,
        scopeLabel: "run",
        scopeValue: action.scope.runId,
      });
    }

    for (const scoped of budgets) {
      const violation = this.enforceProcessBudget(
        action,
        scoped.scopeKey,
        scoped.budget,
        {
          scope: scoped.scopeLabel,
          scopeValue: scoped.scopeValue,
        },
      );
      if (violation) return violation;
    }
    return null;
  }

  private enforceProcessBudget(
    action: PolicyAction,
    _scopeKey: string,
    budget: ProcessBudgetRule | undefined,
    details: Record<string, unknown> & {
      scope: "global" | "tenant" | "project" | "run";
    },
  ): PolicyViolation | null {
    const observedConcurrent = resolveScopedNumericValue(
      action.processCount,
      action.processCountByScope,
      details.scope,
    );
    if (!budget || observedConcurrent === undefined) {
      return null;
    }
    if (observedConcurrent <= budget.maxConcurrent) {
      return null;
    }
    return this.buildViolation(
      "process_budget_exceeded",
      action,
      "Managed-process budget exceeded",
      {
        ...details,
        maxConcurrent: budget.maxConcurrent,
        observedConcurrent,
      },
    );
  }

  private consumeSpendBudget(
    action: PolicyAction,
    eventKey: string,
    budget: SpendBudgetRule | undefined,
    consume: boolean,
    details: Record<string, unknown>,
  ): PolicyViolation | null {
    if (!budget || action.spendLamports === undefined) {
      return null;
    }

    const now = this.now();
    const cutoff = now - budget.windowMs;
    const bucket = (this.spendEvents.get(eventKey) ?? []).filter(
      (event) => event.atMs >= cutoff,
    );

    const currentSpend = bucket.reduce((sum, event) => sum + event.amount, 0n);
    const projected = currentSpend + action.spendLamports;
    if (projected > budget.limitLamports) {
      if (consume) {
        this.spendEvents.set(eventKey, bucket);
      }
      return this.buildViolation(
        "spend_budget_exceeded",
        action,
        "Spend budget exceeded",
        {
          ...details,
          limitLamports: budget.limitLamports.toString(),
          currentLamports: currentSpend.toString(),
          attemptedLamports: action.spendLamports.toString(),
        },
      );
    }

    if (consume) {
      bucket.push({ atMs: now, amount: action.spendLamports });
      this.spendEvents.set(eventKey, bucket);
    }
    return null;
  }

  private maybeAutoTripCircuitBreaker(): void {
    const cfg = this.policy.circuitBreaker;
    if (!cfg?.enabled) return;
    if (this.mode !== "normal") return;

    this.pruneViolations();
    if (this.violationEvents.length < cfg.threshold) return;

    this.mode = cfg.mode;
    this.circuitBreakerReason = "auto_threshold";
    this.trippedAtMs = this.now();

    this.logger.warn(`Policy circuit breaker tripped: mode=${cfg.mode}`);
  }

  private recordViolation(violation: PolicyViolation): void {
    this.violationEvents.push(this.now());
    this.onViolation?.(violation);
    this.metrics?.counter(TELEMETRY_METRIC_NAMES.POLICY_VIOLATIONS_TOTAL, 1, {
      code: violation.code,
      action_type: violation.actionType,
    });
    this.metrics?.counter(TELEMETRY_METRIC_NAMES.POLICY_DECISIONS_TOTAL, 1, {
      outcome: "deny",
      action_type: violation.actionType,
    });
  }

  private pruneViolations(): void {
    const cfg = this.policy.circuitBreaker;
    if (!cfg) {
      this.violationEvents = [];
      return;
    }
    const cutoff = this.now() - cfg.windowMs;
    this.violationEvents = this.violationEvents.filter(
      (timestamp) => timestamp >= cutoff,
    );
  }

  private buildViolation(
    code: PolicyViolation["code"],
    action: PolicyAction,
    message: string,
    details?: Record<string, unknown>,
  ): PolicyViolation {
    return {
      code,
      message,
      actionType: action.type,
      actionName: action.name,
      details,
    };
  }
}
