/**
 * Bounded multi-candidate generation for autonomous execution.
 *
 * @module
 */

import type { MultiCandidateConfig, Task } from "./types.js";

export interface GeneratedExecutionCandidate {
  id: string;
  attempt: number;
  output: bigint[];
  fingerprint: string;
  noveltyScore: number;
  tokenEstimate: number;
  cumulativeCostLamports: bigint;
}

export interface CandidateGenerationAttemptContext {
  attempt: number;
  accepted: number;
  projectedCostLamports: bigint;
  projectedTokenUnits: number;
}

export interface CandidateGenerationResult {
  candidates: GeneratedExecutionCandidate[];
  budget: {
    maxCandidates: number;
    maxExecutionCostLamports: bigint;
    maxTokenBudget: number;
    attempts: number;
    accepted: number;
    consumedCostLamports: bigint;
    consumedTokenUnits: number;
    stoppedReason:
      | "target_reached"
      | "attempt_budget_reached"
      | "cost_budget_reached"
      | "token_budget_reached";
  };
}

export interface CandidateGenerationInput {
  task: Task;
  config?: MultiCandidateConfig;
  executeCandidate: (task: Task) => Promise<bigint[]>;
  estimateTokenUnits?: (output: bigint[]) => number;
  onBeforeAttempt?: (
    context: CandidateGenerationAttemptContext,
  ) => Promise<void> | void;
}

interface ResolvedGenerationPolicy {
  maxCandidates: number;
  maxGenerationAttempts: number;
  minDiversityScore: number;
  maxExecutionCostLamports: bigint;
  maxTokenBudget: number;
}

const DEFAULT_MAX_CANDIDATES = 3;

function clampInteger(
  value: number | undefined,
  fallback: number,
  min = 1,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintOutput(output: readonly bigint[]): string {
  return hashString(output.map((value) => value.toString(16)).join("|"));
}

function outputDistance(a: readonly bigint[], b: readonly bigint[]): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 0;

  let mismatches = Math.abs(a.length - b.length);
  const overlap = Math.min(a.length, b.length);
  for (let i = 0; i < overlap; i++) {
    if (a[i] !== b[i]) mismatches++;
  }

  return mismatches / maxLength;
}

function computeNovelty(
  output: readonly bigint[],
  accepted: readonly GeneratedExecutionCandidate[],
): number {
  if (accepted.length === 0) return 1;
  let minDistance = 1;
  for (const candidate of accepted) {
    const distance = outputDistance(output, candidate.output);
    if (distance < minDistance) minDistance = distance;
  }
  return minDistance;
}

function resolvePolicy(
  task: Task,
  config: MultiCandidateConfig | undefined,
): ResolvedGenerationPolicy {
  const requestedCandidates = clampInteger(
    config?.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
  );
  const policyCandidates = clampInteger(
    config?.policyBudget?.maxCandidates,
    requestedCandidates,
  );
  const maxCandidates = Math.min(requestedCandidates, policyCandidates);

  const requestedAttempts = clampInteger(
    config?.maxGenerationAttempts,
    maxCandidates,
  );
  const maxGenerationAttempts = Math.max(maxCandidates, requestedAttempts);

  const defaultCostBudget = task.reward * BigInt(maxGenerationAttempts);
  const policyCostBudget =
    config?.policyBudget?.maxExecutionCostLamports ?? defaultCostBudget;
  const maxExecutionCostLamports =
    policyCostBudget < defaultCostBudget ? policyCostBudget : defaultCostBudget;

  const requestedTokenBudget = clampInteger(
    config?.policyBudget?.maxTokenBudget,
    Number.MAX_SAFE_INTEGER,
  );

  return {
    maxCandidates,
    maxGenerationAttempts,
    minDiversityScore: clampRatio(config?.minDiversityScore, 0),
    maxExecutionCostLamports:
      maxExecutionCostLamports < 0n ? 0n : maxExecutionCostLamports,
    maxTokenBudget: requestedTokenBudget,
  };
}

/**
 * Generate bounded execution candidates with diversity-aware filtering.
 */
export async function generateExecutionCandidates(
  input: CandidateGenerationInput,
): Promise<CandidateGenerationResult> {
  const policy = resolvePolicy(input.task, input.config);
  const estimateTokenUnits =
    input.estimateTokenUnits ??
    ((output: bigint[]) => Math.max(1, output.length * 16));

  const candidates: GeneratedExecutionCandidate[] = [];
  let attempts = 0;
  let consumedCostLamports = 0n;
  let consumedTokenUnits = 0;
  let stoppedReason: CandidateGenerationResult["budget"]["stoppedReason"] =
    "attempt_budget_reached";

  while (
    attempts < policy.maxGenerationAttempts &&
    candidates.length < policy.maxCandidates
  ) {
    const attempt = attempts + 1;
    const projectedCostLamports = consumedCostLamports + input.task.reward;
    if (projectedCostLamports > policy.maxExecutionCostLamports) {
      stoppedReason = "cost_budget_reached";
      break;
    }

    await input.onBeforeAttempt?.({
      attempt,
      accepted: candidates.length,
      projectedCostLamports,
      projectedTokenUnits: consumedTokenUnits,
    });

    const output = await input.executeCandidate(input.task);
    attempts = attempt;
    consumedCostLamports = projectedCostLamports;

    const tokenEstimate = Math.max(1, Math.floor(estimateTokenUnits(output)));
    const projectedTokenUnits = consumedTokenUnits + tokenEstimate;
    if (projectedTokenUnits > policy.maxTokenBudget) {
      stoppedReason = "token_budget_reached";
      break;
    }
    consumedTokenUnits = projectedTokenUnits;

    const noveltyScore = computeNovelty(output, candidates);
    if (candidates.length > 0 && noveltyScore < policy.minDiversityScore) {
      continue;
    }

    const fingerprint = fingerprintOutput(output);
    candidates.push({
      id: `candidate-${candidates.length + 1}-a${attempt}`,
      attempt,
      output,
      fingerprint,
      noveltyScore,
      tokenEstimate,
      cumulativeCostLamports: consumedCostLamports,
    });
  }

  if (candidates.length >= policy.maxCandidates) {
    stoppedReason = "target_reached";
  } else if (attempts >= policy.maxGenerationAttempts) {
    stoppedReason = "attempt_budget_reached";
  }

  return {
    candidates,
    budget: {
      maxCandidates: policy.maxCandidates,
      maxExecutionCostLamports: policy.maxExecutionCostLamports,
      maxTokenBudget: policy.maxTokenBudget,
      attempts,
      accepted: candidates.length,
      consumedCostLamports,
      consumedTokenUnits,
      stoppedReason,
    },
  };
}
