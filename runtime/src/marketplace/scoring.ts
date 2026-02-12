/**
 * Deterministic bid scoring and winner selection.
 *
 * @module
 */

import {
  BPS_BASE,
  DEFAULT_WEIGHTED_SCORE_WEIGHTS,
  isValidBps,
} from '@agenc/sdk';
import type {
  MatchingPolicyConfig,
  TaskBid,
  WeightedScoreWeights,
} from '@agenc/sdk';
import { MarketplaceValidationError } from './errors.js';
import type { RankedTaskBid } from './types.js';

const SCORE_SCALE = 1_000_000n;

export interface WeightedScoreComputation {
  priceScore: bigint;
  etaScore: bigint;
  confidenceScore: bigint;
  reliabilityScore: bigint;
  totalScore: bigint;
}

export function selectWinningBid(
  bids: readonly TaskBid[],
  policy: MatchingPolicyConfig,
): RankedTaskBid | null {
  const ranked = rankTaskBids(bids, policy);
  return ranked[0] ?? null;
}

export function rankTaskBids(
  bids: readonly TaskBid[],
  policy: MatchingPolicyConfig,
): RankedTaskBid[] {
  if (bids.length === 0) {
    return [];
  }

  switch (policy.policy) {
    case 'best_price':
      return [...bids]
        .sort(compareByBestPrice)
        .map((bid) => ({ bid, policy: 'best_price' }));

    case 'best_eta':
      return [...bids]
        .sort(compareByBestEta)
        .map((bid) => ({ bid, policy: 'best_eta' }));

    case 'weighted_score': {
      const weights = normalizeWeights(policy.weights);
      const scored = bids.map((bid) => ({
        bid,
        breakdown: computeWeightedScore(bid, bids, weights),
      }));

      scored.sort((a, b) => {
        if (a.breakdown.totalScore !== b.breakdown.totalScore) {
          return a.breakdown.totalScore > b.breakdown.totalScore ? -1 : 1;
        }
        return compareByTieBreak(a.bid, b.bid);
      });

      return scored.map(({ bid, breakdown }) => ({
        bid,
        policy: 'weighted_score',
        weightedBreakdown: breakdown,
      }));
    }
  }
}

export function computeWeightedScore(
  bid: TaskBid,
  candidates: readonly TaskBid[],
  weights: WeightedScoreWeights,
): WeightedScoreComputation {
  const rewardValues = candidates.map((candidate) => candidate.rewardLamports);
  const etaValues = candidates.map((candidate) => candidate.etaSeconds);
  const confidenceValues = candidates.map((candidate) => candidate.confidenceBps);
  const reliabilityValues = candidates.map((candidate) => candidate.reliabilityBps ?? candidate.confidenceBps);

  const priceScore = normalizeLowerBigint(
    bid.rewardLamports,
    minBigInt(rewardValues),
    maxBigInt(rewardValues),
  );
  const etaScore = normalizeLowerNumber(
    bid.etaSeconds,
    minNumber(etaValues),
    maxNumber(etaValues),
  );
  const confidenceScore = normalizeHigherNumber(
    bid.confidenceBps,
    minNumber(confidenceValues),
    maxNumber(confidenceValues),
  );
  const reliabilityScore = normalizeHigherNumber(
    bid.reliabilityBps ?? bid.confidenceBps,
    minNumber(reliabilityValues),
    maxNumber(reliabilityValues),
  );

  const weightedSum =
    priceScore * BigInt(weights.priceWeightBps) +
    etaScore * BigInt(weights.etaWeightBps) +
    confidenceScore * BigInt(weights.confidenceWeightBps) +
    reliabilityScore * BigInt(weights.reliabilityWeightBps);

  const totalScore = weightedSum / BigInt(BPS_BASE);

  return {
    priceScore,
    etaScore,
    confidenceScore,
    reliabilityScore,
    totalScore,
  };
}

function normalizeWeights(weights: WeightedScoreWeights | undefined): WeightedScoreWeights {
  const merged: WeightedScoreWeights = {
    ...DEFAULT_WEIGHTED_SCORE_WEIGHTS,
    ...(weights ?? {}),
  };

  for (const [key, value] of Object.entries(merged)) {
    if (!isValidBps(value)) {
      throw new MarketplaceValidationError(`invalid weighted score bps for "${key}"`);
    }
  }

  const total =
    merged.priceWeightBps +
    merged.etaWeightBps +
    merged.confidenceWeightBps +
    merged.reliabilityWeightBps;

  if (total !== BPS_BASE) {
    throw new MarketplaceValidationError(
      `weighted score bps must sum to ${BPS_BASE} (received ${total})`,
    );
  }

  return merged;
}

function compareByBestPrice(a: TaskBid, b: TaskBid): number {
  if (a.rewardLamports !== b.rewardLamports) {
    return a.rewardLamports < b.rewardLamports ? -1 : 1;
  }
  return compareByTieBreak(a, b);
}

function compareByBestEta(a: TaskBid, b: TaskBid): number {
  if (a.etaSeconds !== b.etaSeconds) {
    return a.etaSeconds - b.etaSeconds;
  }
  return compareByTieBreak(a, b);
}

function compareByTieBreak(a: TaskBid, b: TaskBid): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.bidId.localeCompare(b.bidId);
}

function normalizeLowerBigint(value: bigint, min: bigint, max: bigint): bigint {
  if (max === min) return SCORE_SCALE;
  return ((max - value) * SCORE_SCALE) / (max - min);
}

function normalizeLowerNumber(value: number, min: number, max: number): bigint {
  if (max === min) return SCORE_SCALE;
  return (BigInt(max - value) * SCORE_SCALE) / BigInt(max - min);
}

function normalizeHigherNumber(value: number, min: number, max: number): bigint {
  if (max === min) return SCORE_SCALE;
  return (BigInt(value - min) * SCORE_SCALE) / BigInt(max - min);
}

function minBigInt(values: readonly bigint[]): bigint {
  let min = values[0];
  for (const value of values) {
    if (value < min) min = value;
  }
  return min;
}

function maxBigInt(values: readonly bigint[]): bigint {
  let max = values[0];
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}

function minNumber(values: readonly number[]): number {
  let min = values[0];
  for (const value of values) {
    if (value < min) min = value;
  }
  return min;
}

function maxNumber(values: readonly number[]): number {
  let max = values[0];
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}
