/**
 * Adaptive verifier risk scoring primitives.
 *
 * @module
 */

import type {
  Task,
  VerifierAdaptiveRiskConfig,
  VerifierAdaptiveRiskWeights,
} from './types.js';

export type RiskTier = 'low' | 'medium' | 'high';

export interface RiskFeatureVector {
  rewardSignal: number;
  deadlineSignal: number;
  claimPressureSignal: number;
  taskTypeSignal: number;
  verifierDisagreementSignal: number;
  rollbackSignal: number;
}

export interface RiskContribution {
  feature: keyof RiskFeatureVector;
  value: number;
  weight: number;
  contribution: number;
}

export interface TaskRiskScoringContext {
  nowMs?: number;
  verifierDisagreementRate?: number;
  rollbackRate?: number;
  taskTypeRiskMultiplier?: number;
}

export interface TaskRiskScoringConfig {
  mediumRiskThreshold?: number;
  highRiskThreshold?: number;
  weights?: VerifierAdaptiveRiskWeights;
  taskTypeRiskMultipliers?: Record<number, number>;
}

export interface TaskRiskScoreResult {
  score: number;
  tier: RiskTier;
  features: RiskFeatureVector;
  contributions: RiskContribution[];
  metadata: {
    mediumRiskThreshold: number;
    highRiskThreshold: number;
  };
}

const DEFAULT_WEIGHTS: Required<VerifierAdaptiveRiskWeights> = {
  rewardWeight: 0.22,
  deadlineWeight: 0.18,
  claimPressureWeight: 0.15,
  taskTypeWeight: 0.2,
  verifierDisagreementWeight: 0.15,
  rollbackWeight: 0.1,
};

const DEFAULT_MEDIUM_THRESHOLD = 0.35;
const DEFAULT_HIGH_THRESHOLD = 0.7;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toSafeNumber(value: bigint): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maxSafe) return Number.MAX_SAFE_INTEGER;
  if (value < 0n) return 0;
  return Number(value);
}

function resolveWeights(
  adaptiveRisk: VerifierAdaptiveRiskConfig | undefined,
  scoringConfig: TaskRiskScoringConfig | undefined,
): Required<VerifierAdaptiveRiskWeights> {
  return {
    ...DEFAULT_WEIGHTS,
    ...(adaptiveRisk?.weights ?? {}),
    ...(scoringConfig?.weights ?? {}),
  };
}

function riskTier(score: number, medium: number, high: number): RiskTier {
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  return 'low';
}

/**
 * Extract normalized risk features from task/runtime context.
 */
export function extractTaskRiskFeatures(
  task: Task,
  context: TaskRiskScoringContext = {},
  config: TaskRiskScoringConfig = {},
): RiskFeatureVector {
  const rewardLamports = toSafeNumber(task.reward);
  const rewardSignal = clamp01(Math.log10(rewardLamports + 1) / 9);

  let deadlineSignal = 0;
  if (task.deadline > 0) {
    const nowSeconds = Math.floor((context.nowMs ?? Date.now()) / 1000);
    const remaining = task.deadline - nowSeconds;
    if (remaining <= 0) {
      deadlineSignal = 1;
    } else {
      const horizonSeconds = 24 * 60 * 60;
      deadlineSignal = clamp01(1 - remaining / horizonSeconds);
    }
  }

  const claimPressureSignal = clamp01(task.currentClaims / Math.max(1, task.maxWorkers));

  const taskTypeMultipliers = config.taskTypeRiskMultipliers ?? {};
  const taskTypeMultiplier =
    context.taskTypeRiskMultiplier ??
    (task.taskType !== undefined ? taskTypeMultipliers[task.taskType] : undefined) ??
    (task.taskType === 2 ? 0.75 : task.taskType === 1 ? 0.5 : 0.3);

  return {
    rewardSignal,
    deadlineSignal,
    claimPressureSignal,
    taskTypeSignal: clamp01(taskTypeMultiplier),
    verifierDisagreementSignal: clamp01(context.verifierDisagreementRate ?? 0),
    rollbackSignal: clamp01(context.rollbackRate ?? 0),
  };
}

/**
 * Compute explainable task risk score used by adaptive verification budgets.
 */
export function scoreTaskRisk(
  task: Task,
  context: TaskRiskScoringContext = {},
  adaptiveRisk: VerifierAdaptiveRiskConfig | undefined = undefined,
  scoringConfig: TaskRiskScoringConfig = {},
): TaskRiskScoreResult {
  const features = extractTaskRiskFeatures(task, context, scoringConfig);
  const weights = resolveWeights(adaptiveRisk, scoringConfig);

  const entries: Array<[keyof RiskFeatureVector, number, number]> = [
    ['rewardSignal', features.rewardSignal, weights.rewardWeight],
    ['deadlineSignal', features.deadlineSignal, weights.deadlineWeight],
    ['claimPressureSignal', features.claimPressureSignal, weights.claimPressureWeight],
    ['taskTypeSignal', features.taskTypeSignal, weights.taskTypeWeight],
    ['verifierDisagreementSignal', features.verifierDisagreementSignal, weights.verifierDisagreementWeight],
    ['rollbackSignal', features.rollbackSignal, weights.rollbackWeight],
  ];

  const totalWeight = entries.reduce((sum, [, , weight]) => sum + Math.max(0, weight), 0);
  const normalizedWeight = totalWeight > 0 ? totalWeight : 1;

  let weightedScore = 0;
  const contributions: RiskContribution[] = [];

  for (const [feature, value, weight] of entries) {
    const safeWeight = Math.max(0, weight);
    const contribution = value * safeWeight;
    weightedScore += contribution;

    contributions.push({
      feature,
      value,
      weight: safeWeight,
      contribution,
    });
  }

  const score = clamp01(weightedScore / normalizedWeight);
  const mediumThreshold = clamp01(
    adaptiveRisk?.mediumRiskThreshold ?? scoringConfig.mediumRiskThreshold ?? DEFAULT_MEDIUM_THRESHOLD,
  );
  const highThreshold = clamp01(
    adaptiveRisk?.highRiskThreshold ?? scoringConfig.highRiskThreshold ?? DEFAULT_HIGH_THRESHOLD,
  );

  return {
    score,
    tier: riskTier(score, mediumThreshold, highThreshold),
    features,
    contributions,
    metadata: {
      mediumRiskThreshold: mediumThreshold,
      highRiskThreshold: highThreshold,
    },
  };
}
