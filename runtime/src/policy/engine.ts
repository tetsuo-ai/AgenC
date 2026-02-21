/**
 * Deterministic runtime policy/safety engine with circuit breakers.
 *
 * @module
 */

import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import type {
  CircuitBreakerMode,
  PolicyAction,
  PolicyDecision,
  PolicyEngineConfig,
  PolicyEngineState,
  PolicyViolation,
  RuntimePolicyConfig,
} from "./types.js";
import { PolicyViolationError } from "./types.js";
import { silentLogger } from "../utils/logger.js";

const DEFAULT_POLICY: RuntimePolicyConfig = {
  enabled: false,
};

export class PolicyEngine {
  private policy: RuntimePolicyConfig;
  private mode: CircuitBreakerMode = "normal";
  private circuitBreakerReason?: string;
  private trippedAtMs?: number;

  private readonly logger;
  private readonly metrics;
  private readonly now: () => number;

  private readonly actionEvents = new Map<string, number[]>();
  private spendEvents: Array<{ atMs: number; amount: bigint }> = [];
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
    this.pruneViolations();
    const violations: PolicyViolation[] = [];

    const modeViolation = this.checkCircuitMode(action);
    if (modeViolation) {
      violations.push(modeViolation);
    }

    if (this.policy.enabled) {
      const toolViolation = this.checkToolRules(action);
      if (toolViolation) violations.push(toolViolation);

      const actionViolation = this.checkActionRules(action);
      if (actionViolation) violations.push(actionViolation);

      const riskViolation = this.checkRisk(action);
      if (riskViolation) violations.push(riskViolation);

      const actionBudgetViolation = this.checkAndConsumeActionBudget(action);
      if (actionBudgetViolation) violations.push(actionBudgetViolation);

      const spendViolation = this.checkAndConsumeSpendBudget(action);
      if (spendViolation) violations.push(spendViolation);
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

  private checkToolRules(action: PolicyAction): PolicyViolation | null {
    if (action.type !== "tool_call") {
      return null;
    }

    if (this.policy.toolDenyList?.includes(action.name)) {
      return this.buildViolation(
        "tool_denied",
        action,
        `Tool "${action.name}" is denied by policy`,
      );
    }

    const allowList = this.policy.toolAllowList;
    if (allowList && allowList.length > 0 && !allowList.includes(action.name)) {
      return this.buildViolation(
        "tool_denied",
        action,
        `Tool "${action.name}" is not in allow-list`,
      );
    }

    return null;
  }

  private checkActionRules(action: PolicyAction): PolicyViolation | null {
    if (this.policy.denyActions?.includes(action.name)) {
      return this.buildViolation(
        "action_denied",
        action,
        `Action "${action.name}" is denied by policy`,
      );
    }

    const allowActions = this.policy.allowActions;
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

  private checkRisk(action: PolicyAction): PolicyViolation | null {
    const maxRisk = this.policy.maxRiskScore;
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
  ): PolicyViolation | null {
    const budgets = this.policy.actionBudgets;
    if (!budgets) return null;

    const exactKey = `${action.type}:${action.name}`;
    const wildcardKey = `${action.type}:*`;
    const hasExact = budgets[exactKey] !== undefined;
    const budget = hasExact ? budgets[exactKey] : budgets[wildcardKey];
    if (!budget) return null;

    const now = this.now();
    const cutoff = now - budget.windowMs;
    const bucketKey = hasExact ? exactKey : wildcardKey;
    const bucket = this.actionEvents.get(bucketKey) ?? [];
    const recent = bucket.filter((timestamp) => timestamp >= cutoff);
    if (recent.length >= budget.limit) {
      this.actionEvents.set(bucketKey, recent);
      return this.buildViolation(
        "action_budget_exceeded",
        action,
        `Action budget exceeded for "${action.name}"`,
        {
          limit: budget.limit,
          windowMs: budget.windowMs,
          observed: recent.length,
        },
      );
    }
    recent.push(now);
    this.actionEvents.set(bucketKey, recent);
    return null;
  }

  private checkAndConsumeSpendBudget(
    action: PolicyAction,
  ): PolicyViolation | null {
    if (!this.policy.spendBudget || action.spendLamports === undefined) {
      return null;
    }

    const now = this.now();
    const cutoff = now - this.policy.spendBudget.windowMs;
    this.spendEvents = this.spendEvents.filter((event) => event.atMs >= cutoff);

    const currentSpend = this.spendEvents.reduce(
      (sum, event) => sum + event.amount,
      0n,
    );
    const projected = currentSpend + action.spendLamports;
    if (projected > this.policy.spendBudget.limitLamports) {
      return this.buildViolation(
        "spend_budget_exceeded",
        action,
        "Spend budget exceeded",
        {
          limitLamports: this.policy.spendBudget.limitLamports.toString(),
          currentLamports: currentSpend.toString(),
          attemptedLamports: action.spendLamports.toString(),
        },
      );
    }

    this.spendEvents.push({ atMs: now, amount: action.spendLamports });
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
