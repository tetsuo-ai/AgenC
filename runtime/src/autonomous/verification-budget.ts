/**
 * Adaptive verification budget allocation primitives.
 *
 * @module
 */

import type {
  Task,
  VerifierLaneConfig,
  VerifierPolicyConfig,
  VerifierTaskTypePolicy,
} from './types.js';
import type { RiskTier, TaskRiskScoreResult } from './risk-scoring.js';

export interface BudgetGuardrail {
  readonly minBudgetLamports: bigint;
  readonly maxBudgetLamports: bigint;
  readonly adjustmentRate: number;
  readonly cooldownMs: number;
}

export interface BudgetAdjustmentInput {
  currentBudgetLamports: bigint;
  success: boolean;
  history: readonly boolean[];
  guardrail: BudgetGuardrail;
  lastAdjustmentTimestampMs: number;
  nowMs: number;
}

export interface BudgetAdjustmentResult {
  nextBudgetLamports: bigint;
  adjusted: boolean;
  adjustmentFraction: number;
  reason:
    | 'cooldown_active'
    | 'increased_on_success'
    | 'decreased_on_failure'
    | 'no_change';
  adjustedAtMs: number;
}

export interface BudgetAuditEntry {
  readonly seq: number;
  readonly timestampMs: number;
  readonly previousBudgetLamports: bigint;
  readonly nextBudgetLamports: bigint;
  readonly adjustmentFraction: number;
  readonly reason: BudgetAdjustmentResult['reason'];
  readonly riskTier: RiskTier;
  readonly success: boolean;
  readonly consecutiveStreak: number;
}

export interface VerificationBudgetDecision {
  enabled: boolean;
  adaptive: boolean;
  riskScore: number;
  riskTier: 'low' | 'medium' | 'high';
  maxVerificationRetries: number;
  maxVerificationDurationMs: number;
  minConfidence: number;
  maxAllowedSpendLamports: bigint;
  metadata: Record<string, string | number | boolean>;
}

export const DEFAULT_BUDGET_GUARDRAIL: BudgetGuardrail = {
  minBudgetLamports: 1_000n,
  maxBudgetLamports: 10_000_000_000n,
  adjustmentRate: 0.2,
  cooldownMs: 5_000,
};

export const DEFAULT_INITIAL_BUDGET_LAMPORTS = 1_000_000n;

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_VERIFICATION_RETRIES = 1;
const DEFAULT_MAX_VERIFICATION_DURATION_MS = 30_000;
const DECIMAL_SCALE = 1_000_000n;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function nonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function getTaskTypePolicy(policy: VerifierPolicyConfig | undefined, task: Task): VerifierTaskTypePolicy | undefined {
  if (!policy?.taskTypePolicies || task.taskType === undefined) {
    return undefined;
  }
  return policy.taskTypePolicies[task.taskType];
}

export function resolveBudgetGuardrail(override: Partial<BudgetGuardrail> = {}): BudgetGuardrail {
  const guardrail = {
    minBudgetLamports: override.minBudgetLamports ?? DEFAULT_BUDGET_GUARDRAIL.minBudgetLamports,
    maxBudgetLamports: override.maxBudgetLamports ?? DEFAULT_BUDGET_GUARDRAIL.maxBudgetLamports,
    adjustmentRate: override.adjustmentRate ?? DEFAULT_BUDGET_GUARDRAIL.adjustmentRate,
    cooldownMs: override.cooldownMs ?? DEFAULT_BUDGET_GUARDRAIL.cooldownMs,
  };
  validateBudgetGuardrail(guardrail);
  return guardrail;
}

export function validateBudgetGuardrail(guardrail: BudgetGuardrail): void {
  if (guardrail.minBudgetLamports < 0n) {
    throw new Error('minBudgetLamports must be non-negative');
  }
  if (guardrail.maxBudgetLamports < guardrail.minBudgetLamports) {
    throw new Error('maxBudgetLamports must be >= minBudgetLamports');
  }
  if (!Number.isFinite(guardrail.adjustmentRate) || guardrail.adjustmentRate < 0 || guardrail.adjustmentRate > 1) {
    throw new Error('adjustmentRate must be in [0, 1]');
  }
  if (!Number.isFinite(guardrail.cooldownMs) || guardrail.cooldownMs < 0) {
    throw new Error('cooldownMs must be non-negative');
  }
}

function resolveBasePolicy(task: Task, config: VerifierLaneConfig): {
  taskTypePolicy?: VerifierTaskTypePolicy;
  minConfidence: number;
  maxVerificationRetries: number;
  maxVerificationDurationMs: number;
} {
  const taskTypePolicy = getTaskTypePolicy(config.policy, task);

  return {
    taskTypePolicy,
    minConfidence: clamp01(
      taskTypePolicy?.minConfidence ?? config.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    ),
    maxVerificationRetries: nonNegativeInt(
      taskTypePolicy?.maxVerificationRetries ??
        config.maxVerificationRetries ??
        DEFAULT_MAX_VERIFICATION_RETRIES,
      DEFAULT_MAX_VERIFICATION_RETRIES,
    ),
    maxVerificationDurationMs: positiveInt(
      taskTypePolicy?.maxVerificationDurationMs ??
        config.maxVerificationDurationMs ??
        DEFAULT_MAX_VERIFICATION_DURATION_MS,
      DEFAULT_MAX_VERIFICATION_DURATION_MS,
    ),
  };
}

function clampVerificationSpend(taskRewardLamports: bigint, maxAllowedSpendLamports: bigint): bigint {
  let spend = maxAllowedSpendLamports;
  if (spend < 0n) {
    spend = 0n;
  }
  const absoluteCap = taskRewardLamports * 10n;
  if (absoluteCap > 0n && spend > absoluteCap) {
    spend = absoluteCap;
  }
  return spend;
}

export function calculateNextBudget(input: BudgetAdjustmentInput): BudgetAdjustmentResult {
  const guardrail = resolveBudgetGuardrail(input.guardrail);
  const currentBudgetLamports = clampBudget(input.currentBudgetLamports, guardrail);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const sinceLast = nowMs - input.lastAdjustmentTimestampMs;

  if (sinceLast < guardrail.cooldownMs) {
    return {
      nextBudgetLamports: currentBudgetLamports,
      adjusted: false,
      adjustmentFraction: 0,
      reason: 'cooldown_active',
      adjustedAtMs: input.lastAdjustmentTimestampMs,
    };
  }

  const consecutiveCount = countConsecutiveFromEnd(input.history, input.success) + 1;
  let adjustmentFraction = 0;
  let reason: BudgetAdjustmentResult['reason'];
  if (input.success) {
    const streakFactor = Math.min(1, consecutiveCount / 5);
    adjustmentFraction = guardrail.adjustmentRate * streakFactor;
    reason = 'increased_on_success';
  } else {
    const streakFactor = Math.min(1, consecutiveCount / 3);
    adjustmentFraction = -guardrail.adjustmentRate * streakFactor;
    reason = 'decreased_on_failure';
  }

  if (!Number.isFinite(adjustmentFraction) || adjustmentFraction === 0) {
    return {
      nextBudgetLamports: currentBudgetLamports,
      adjusted: false,
      adjustmentFraction: 0,
      reason: 'no_change',
      adjustedAtMs: input.lastAdjustmentTimestampMs,
    };
  }

  const fractionAbs = Math.max(0, Math.min(1, Math.abs(adjustmentFraction)));
  const scaledFraction = BigInt(Math.floor(fractionAbs * Number(DECIMAL_SCALE)));
  const rawDelta = (currentBudgetLamports * scaledFraction) / DECIMAL_SCALE;
  const delta = rawDelta < 0n ? 0n : rawDelta;

  let nextBudget = currentBudgetLamports;
  if (adjustmentFraction > 0) {
    const increased = nextBudget + delta;
    nextBudget = increased >= nextBudget ? increased : guardrail.maxBudgetLamports;
  } else {
    nextBudget = delta > nextBudget ? 0n : nextBudget - delta;
  }

  return {
    nextBudgetLamports: clampBudget(nextBudget, guardrail),
    adjusted: true,
    adjustmentFraction,
    reason,
    adjustedAtMs: nowMs,
  };
}

export function countConsecutiveFromEnd(history: readonly boolean[], matchValue: boolean): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] !== matchValue) {
      break;
    }
    count += 1;
  }
  return count;
}

export function clampBudget(value: bigint, guardrail: BudgetGuardrail): bigint {
  if (value < guardrail.minBudgetLamports) return guardrail.minBudgetLamports;
  if (value > guardrail.maxBudgetLamports) return guardrail.maxBudgetLamports;
  return value;
}

export class BudgetAuditTrail {
  private readonly entries: BudgetAuditEntry[] = [];
  private readonly maxEntries: number;
  private seq = 0;

  constructor(maxEntries = 1000) {
    const sanitized = Number.isFinite(maxEntries) ? Math.floor(maxEntries) : 1000;
    this.maxEntries = Math.max(1, sanitized);
  }

  record(entry: Omit<BudgetAuditEntry, 'seq'>): void {
    this.entries.push({ ...entry, seq: this.seq++ });
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  getEntries(): readonly BudgetAuditEntry[] {
    return [...this.entries];
  }

  getLastN(n: number): readonly BudgetAuditEntry[] {
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    return this.entries.slice(-count);
  }

  clear(): void {
    this.entries.length = 0;
    this.seq = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * Allocate dynamic verifier budget from risk score + policy constraints.
 */
export function allocateVerificationBudget(
  task: Task,
  risk: TaskRiskScoreResult,
  config: VerifierLaneConfig,
): VerificationBudgetDecision {
  const {
    taskTypePolicy,
    minConfidence: baseMinConfidence,
    maxVerificationRetries: baseRetries,
    maxVerificationDurationMs: baseDuration,
  } = resolveBasePolicy(task, config);

  const adaptiveRisk = config.policy?.adaptiveRisk;
  const adaptiveEnabled = adaptiveRisk?.enabled === true;

  const defaultBudget: VerificationBudgetDecision = {
    enabled: true,
    adaptive: false,
    riskScore: risk.score,
    riskTier: risk.tier,
    maxVerificationRetries: baseRetries,
    maxVerificationDurationMs: baseDuration,
    minConfidence: baseMinConfidence,
    maxAllowedSpendLamports: clampVerificationSpend(
      task.reward,
      taskTypePolicy?.maxVerificationCostLamports ??
        adaptiveRisk?.hardMaxVerificationCostLamports ??
        task.reward * BigInt(baseRetries + 1),
    ),
    metadata: {
      source: 'static_policy',
    },
  };

  if (!adaptiveEnabled) {
    return defaultBudget;
  }

  const minRiskScoreToVerify =
    taskTypePolicy?.minRiskScoreToVerify ??
    adaptiveRisk?.minRiskScoreToVerify ??
    0;

  if (risk.score < minRiskScoreToVerify) {
    return {
      ...defaultBudget,
      enabled: false,
      adaptive: true,
      metadata: {
        source: 'adaptive_risk',
        minRiskScoreToVerify,
        reason: 'below_risk_threshold',
      },
    };
  }

  const tier = risk.tier;
  const retryDefaults: Record<typeof tier, number> = {
    low: Math.max(0, baseRetries - 1),
    medium: baseRetries,
    high: baseRetries + 1,
  };

  const durationDefaults: Record<typeof tier, number> = {
    low: Math.max(1_000, Math.floor(baseDuration * 0.75)),
    medium: baseDuration,
    high: Math.floor(baseDuration * 1.5),
  };

  const confidenceDefaults: Record<typeof tier, number> = {
    low: clamp01(baseMinConfidence - 0.05),
    medium: baseMinConfidence,
    high: clamp01(baseMinConfidence + 0.05),
  };

  let maxVerificationRetries = nonNegativeInt(
    adaptiveRisk?.maxVerificationRetriesByRisk?.[tier] ?? retryDefaults[tier],
    retryDefaults[tier],
  );
  let maxVerificationDurationMs = positiveInt(
    adaptiveRisk?.maxVerificationDurationMsByRisk?.[tier] ?? durationDefaults[tier],
    durationDefaults[tier],
  );
  let minConfidence = clamp01(
    adaptiveRisk?.minConfidenceByRisk?.[tier] ?? confidenceDefaults[tier],
  );

  if (taskTypePolicy?.adaptiveMaxVerificationRetries !== undefined) {
    maxVerificationRetries = nonNegativeInt(taskTypePolicy.adaptiveMaxVerificationRetries, maxVerificationRetries);
  }
  if (taskTypePolicy?.adaptiveMaxVerificationDurationMs !== undefined) {
    maxVerificationDurationMs = positiveInt(taskTypePolicy.adaptiveMaxVerificationDurationMs, maxVerificationDurationMs);
  }
  if (taskTypePolicy?.adaptiveMinConfidence !== undefined) {
    minConfidence = clamp01(taskTypePolicy.adaptiveMinConfidence);
  }

  if (adaptiveRisk?.hardMaxVerificationRetries !== undefined) {
    maxVerificationRetries = Math.min(
      maxVerificationRetries,
      nonNegativeInt(adaptiveRisk.hardMaxVerificationRetries, maxVerificationRetries),
    );
  }

  if (adaptiveRisk?.hardMaxVerificationDurationMs !== undefined) {
    maxVerificationDurationMs = Math.min(
      maxVerificationDurationMs,
      positiveInt(adaptiveRisk.hardMaxVerificationDurationMs, maxVerificationDurationMs),
    );
  }

  const tierSpendCap = task.reward * BigInt(maxVerificationRetries + 1);
  let maxAllowedSpendLamports =
    taskTypePolicy?.maxVerificationCostLamports ??
    adaptiveRisk?.hardMaxVerificationCostLamports ??
    tierSpendCap;

  if (adaptiveRisk?.hardMaxVerificationCostLamports !== undefined) {
    maxAllowedSpendLamports = maxAllowedSpendLamports < adaptiveRisk.hardMaxVerificationCostLamports
      ? maxAllowedSpendLamports
      : adaptiveRisk.hardMaxVerificationCostLamports;
  }

  return {
    enabled: true,
    adaptive: true,
    riskScore: risk.score,
    riskTier: tier,
    maxVerificationRetries,
    maxVerificationDurationMs,
    minConfidence,
    maxAllowedSpendLamports: clampVerificationSpend(task.reward, maxAllowedSpendLamports),
    metadata: {
      source: 'adaptive_risk',
      minRiskScoreToVerify,
    },
  };
}
