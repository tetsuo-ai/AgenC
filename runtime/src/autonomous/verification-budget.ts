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
import type { TaskRiskScoreResult } from './risk-scoring.js';

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

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_VERIFICATION_RETRIES = 1;
const DEFAULT_MAX_VERIFICATION_DURATION_MS = 30_000;

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

/**
 * Allocate dynamic verifier budget from risk score + policy constraints.
 */
export function allocateVerificationBudget(
  task: Task,
  risk: TaskRiskScoreResult,
  config: VerifierLaneConfig,
): VerificationBudgetDecision {
  const { taskTypePolicy, minConfidence: baseMinConfidence, maxVerificationRetries: baseRetries, maxVerificationDurationMs: baseDuration } = resolveBasePolicy(task, config);

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
    maxAllowedSpendLamports:
      taskTypePolicy?.maxVerificationCostLamports ??
      adaptiveRisk?.hardMaxVerificationCostLamports ??
      task.reward * BigInt(baseRetries + 1),
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
    maxAllowedSpendLamports,
    metadata: {
      source: 'adaptive_risk',
      minRiskScoreToVerify,
    },
  };
}
