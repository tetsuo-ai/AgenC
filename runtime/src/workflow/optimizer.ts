/**
 * Workflow optimizer: mutation candidate generation, scoring, and selection.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { WorkflowDefinition } from './types.js';
import { validateWorkflow } from './validation.js';
import {
  createDefaultWorkflowObjectiveSpec,
  scoreWorkflowObjective,
  validateWorkflowObjectiveSpec,
  type WorkflowFeatureVector,
  type WorkflowObjectiveOutcome,
  type WorkflowObjectiveSpec,
} from './optimizer-types.js';
import {
  generateWorkflowMutationCandidates,
  type WorkflowMutationCandidate,
  type WorkflowMutationConfig,
  type WorkflowMutationOperator,
} from './mutations.js';

export interface WorkflowOptimizerRuntimeConfig {
  enabled?: boolean;
  seed?: number;
  maxCandidates?: number;
  explorationWeight?: number;
  canaryPercent?: number;
  minCanarySamples?: number;
  stopLossThresholds?: {
    maxFailureRateDelta?: number;
    maxLatencyMsDelta?: number;
    maxCostUnitsDelta?: number;
  };
}

export interface WorkflowOptimizerConfig extends WorkflowOptimizerRuntimeConfig {
  objective?: WorkflowObjectiveSpec;
  mutationConfig?: WorkflowMutationConfig;
  logger?: Logger;
  now?: () => number;
}

export interface WorkflowOptimizationInput {
  baseline: WorkflowDefinition;
  history?: WorkflowFeatureVector[];
  objective?: WorkflowObjectiveSpec;
  mutationConfig?: WorkflowMutationConfig;
  seed?: number;
}

export interface WorkflowCandidateScore {
  candidateId: string;
  mutationOperators: WorkflowMutationOperator[];
  objectiveScore: number;
  predictedOutcome: WorkflowObjectiveOutcome;
  rationale: string[];
}

export interface WorkflowOptimizationAuditEntry {
  timestampMs: number;
  seed: number;
  objectiveId: string;
  baselineScore: number;
  selectedCandidateId: string;
  rationaleMetadata: {
    candidateCount: number;
    mutationOperators: Record<string, number>;
  };
}

export interface WorkflowOptimizationResult {
  selected: WorkflowMutationCandidate;
  candidates: WorkflowMutationCandidate[];
  scored: WorkflowCandidateScore[];
  audit: WorkflowOptimizationAuditEntry;
}

const DEFAULT_OUTCOME: WorkflowObjectiveOutcome = {
  successRate: 0.6,
  conformanceScore: 0.7,
  latencyMs: 60_000,
  costUnits: 1,
  rollbackRate: 0.05,
  verifierDisagreementRate: 0.05,
};

const DEFAULT_CONFIG: Required<Pick<WorkflowOptimizerRuntimeConfig, 'enabled' | 'seed' | 'maxCandidates' | 'explorationWeight'>> = {
  enabled: true,
  seed: 17,
  maxCandidates: 8,
  explorationWeight: 0.2,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

function hashString(input: string): number {
  let hash = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV-1a 32-bit prime
  }
  return hash >>> 0;
}

function jitterFromSeed(seed: number, candidateId: string, explorationWeight: number): number {
  const unit = hashString(`${seed}:${candidateId}`) / 0xffff_ffff;
  const normalized = (unit - 0.5) * 2;
  return normalized * 0.02 * Math.max(0, explorationWeight);
}

function deriveBaselineOutcome(history: WorkflowFeatureVector[] | undefined): WorkflowObjectiveOutcome {
  if (!history || history.length === 0) {
    return { ...DEFAULT_OUTCOME };
  }

  const count = history.length;
  const sums = history.reduce(
    (acc, feature) => {
      acc.successRate += feature.outcomes.success ? 1 : 0;
      acc.conformanceScore += feature.outcomes.conformanceScore;
      acc.latencyMs += feature.outcomes.elapsedMs;
      acc.costUnits += feature.outcomes.costUnits;
      acc.rollbackRate += feature.outcomes.rollbackRate;
      acc.verifierDisagreementRate += feature.outcomes.verifierDisagreementRate;
      return acc;
    },
    {
      successRate: 0,
      conformanceScore: 0,
      latencyMs: 0,
      costUnits: 0,
      rollbackRate: 0,
      verifierDisagreementRate: 0,
    },
  );

  return {
    successRate: clamp01(sums.successRate / count),
    conformanceScore: clamp01(sums.conformanceScore / count),
    latencyMs: nonNegative(sums.latencyMs / count),
    costUnits: nonNegative(sums.costUnits / count),
    rollbackRate: clamp01(sums.rollbackRate / count),
    verifierDisagreementRate: clamp01(sums.verifierDisagreementRate / count),
  };
}

function applyMutationHeuristic(
  outcome: WorkflowObjectiveOutcome,
  operator: WorkflowMutationOperator,
  metadata: Record<string, string | number | boolean>,
): { next: WorkflowObjectiveOutcome; rationale: string } {
  const next: WorkflowObjectiveOutcome = { ...outcome };

  if (operator === 'edge_rewire') {
    next.successRate = clamp01(next.successRate + 0.03);
    next.conformanceScore = clamp01(next.conformanceScore + 0.01);
    next.latencyMs = nonNegative(next.latencyMs + 500);
    return {
      next,
      rationale: 'edge_rewire: explores alternate parent routing for potential reliability lift',
    };
  }

  if (operator === 'task_type') {
    next.successRate = clamp01(next.successRate + 0.01);
    next.conformanceScore = clamp01(next.conformanceScore + 0.03);
    return {
      next,
      rationale: 'task_type: retunes execution mode for quality/conformance gains',
    };
  }

  if (operator === 'reward_policy') {
    const scaleBps = typeof metadata.scaleBps === 'number' ? metadata.scaleBps : 100;
    const delta = Math.abs(scaleBps - 100) / 100;

    if (scaleBps >= 100) {
      next.successRate = clamp01(next.successRate + Math.min(0.03, 0.03 * delta));
      next.costUnits = nonNegative(next.costUnits + 0.25 * delta);
    } else {
      next.successRate = clamp01(next.successRate - Math.min(0.02, 0.02 * delta));
      next.costUnits = nonNegative(next.costUnits - 0.15 * delta);
    }

    return {
      next,
      rationale: 'reward_policy: balances incentive pressure against cost efficiency',
    };
  }

  const offsetSeconds = typeof metadata.offsetSeconds === 'number' ? metadata.offsetSeconds : 0;
  if (offsetSeconds > 0) {
    next.successRate = clamp01(next.successRate + 0.015);
    next.latencyMs = nonNegative(next.latencyMs + Math.min(5_000, offsetSeconds * 0.5));
  } else {
    next.successRate = clamp01(next.successRate - 0.01);
    next.latencyMs = nonNegative(next.latencyMs + offsetSeconds * 0.5);
  }

  return {
    next,
    rationale: 'deadline_policy: shifts schedule slack to trade speed vs completion robustness',
  };
}

function toScoredCandidate(
  candidate: WorkflowMutationCandidate,
  baselineOutcome: WorkflowObjectiveOutcome,
  objective: WorkflowObjectiveSpec,
  seed: number,
  explorationWeight: number,
): WorkflowCandidateScore {
  let predicted = { ...baselineOutcome };
  const rationale: string[] = [];

  for (const mutation of candidate.mutations) {
    const result = applyMutationHeuristic(predicted, mutation.operator, mutation.metadata);
    predicted = result.next;
    rationale.push(result.rationale);
  }

  predicted.successRate = clamp01(predicted.successRate);
  predicted.conformanceScore = clamp01(predicted.conformanceScore);
  predicted.rollbackRate = clamp01(predicted.rollbackRate);
  predicted.verifierDisagreementRate = clamp01(predicted.verifierDisagreementRate);
  predicted.latencyMs = nonNegative(predicted.latencyMs);
  predicted.costUnits = nonNegative(predicted.costUnits);

  const baseScore = scoreWorkflowObjective(predicted, objective);
  const score = clamp01(baseScore + jitterFromSeed(seed, candidate.id, explorationWeight));

  return {
    candidateId: candidate.id,
    mutationOperators: candidate.mutations.map((mutation) => mutation.operator),
    objectiveScore: score,
    predictedOutcome: predicted,
    rationale,
  };
}

function summarizeOperators(scored: WorkflowCandidateScore[]): Record<string, number> {
  const counts = new Map<string, number>();

  for (const entry of scored) {
    if (entry.mutationOperators.length === 0) {
      counts.set('baseline', (counts.get('baseline') ?? 0) + 1);
      continue;
    }

    for (const operator of entry.mutationOperators) {
      counts.set(operator, (counts.get(operator) ?? 0) + 1);
    }
  }

  const output: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    output[key] = counts.get(key) ?? 0;
  }
  return output;
}

export class WorkflowOptimizer {
  private readonly config: WorkflowOptimizerConfig;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(config: WorkflowOptimizerConfig = {}) {
    this.config = config;
    this.logger = config.logger ?? silentLogger;
    this.now = config.now ?? Date.now;
  }

  optimize(input: WorkflowOptimizationInput): WorkflowOptimizationResult {
    validateWorkflow(input.baseline);

    const enabled = this.config.enabled ?? DEFAULT_CONFIG.enabled;
    const seed = input.seed ?? this.config.seed ?? DEFAULT_CONFIG.seed;
    const maxCandidates = this.config.maxCandidates ?? DEFAULT_CONFIG.maxCandidates;
    const explorationWeight =
      this.config.explorationWeight ?? DEFAULT_CONFIG.explorationWeight;

    const objective = input.objective ?? this.config.objective ?? createDefaultWorkflowObjectiveSpec();
    validateWorkflowObjectiveSpec(objective);

    const baselineOutcome = deriveBaselineOutcome(input.history);

    const baselineCandidate: WorkflowMutationCandidate = {
      id: 'baseline',
      definition: input.baseline,
      mutations: [],
    };

    const mutationCandidates = enabled
      ? generateWorkflowMutationCandidates(input.baseline, {
          ...(this.config.mutationConfig ?? {}),
          ...(input.mutationConfig ?? {}),
          seed,
          maxCandidates,
        })
      : [];

    const candidates = [baselineCandidate, ...mutationCandidates];

    for (const candidate of candidates) {
      validateWorkflow(candidate.definition);
    }

    const scored = candidates.map((candidate) =>
      toScoredCandidate(candidate, baselineOutcome, objective, seed, explorationWeight),
    );

    scored.sort((a, b) => {
      if (b.objectiveScore !== a.objectiveScore) {
        return b.objectiveScore - a.objectiveScore;
      }
      return a.candidateId.localeCompare(b.candidateId);
    });

    const selectedScore = scored[0];
    const selected =
      candidates.find((candidate) => candidate.id === selectedScore.candidateId) ?? baselineCandidate;

    const baselineScore = scored.find((entry) => entry.candidateId === 'baseline')?.objectiveScore ?? 0;

    const audit: WorkflowOptimizationAuditEntry = {
      timestampMs: this.now(),
      seed,
      objectiveId: objective.id,
      baselineScore,
      selectedCandidateId: selected.id,
      rationaleMetadata: {
        candidateCount: candidates.length,
        mutationOperators: summarizeOperators(scored),
      },
    };

    this.logger.info(
      `Workflow optimizer selected ${selected.id} (score=${selectedScore.objectiveScore.toFixed(4)} baseline=${baselineScore.toFixed(4)})`,
    );

    return {
      selected,
      candidates,
      scored,
      audit,
    };
  }
}
