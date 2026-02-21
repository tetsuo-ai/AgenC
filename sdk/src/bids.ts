/**
 * Canonical bid contracts for runtime and client integrations.
 *
 * @module
 */

export const BPS_BASE = 10_000;
export const BID_ID_MAX_LENGTH = 96;
export const MARKETPLACE_ID_PATTERN = /^[a-z0-9:_-]+$/;

export type BidStatus =
  | "active"
  | "accepted"
  | "cancelled"
  | "expired"
  | "rejected";

export type MatchingPolicy = "best_price" | "best_eta" | "weighted_score";

export interface WeightedScoreWeights {
  priceWeightBps: number;
  etaWeightBps: number;
  confidenceWeightBps: number;
  reliabilityWeightBps: number;
}

export const DEFAULT_WEIGHTED_SCORE_WEIGHTS: WeightedScoreWeights = {
  priceWeightBps: 4_000,
  etaWeightBps: 3_000,
  confidenceWeightBps: 2_000,
  reliabilityWeightBps: 1_000,
};

export interface MatchingPolicyConfig {
  policy: MatchingPolicy;
  weights?: WeightedScoreWeights;
}

export interface BidRateLimitConfig {
  maxCreates: number;
  windowMs: number;
}

export interface BidAntiSpamConfig {
  maxActiveBidsPerBidderPerTask?: number;
  createRateLimit?: BidRateLimitConfig;
  minBondLamports?: bigint;
  maxBidsPerTask?: number;
  maxTrackedBiddersPerTask?: number;
}

export interface TaskBidInput {
  taskId: string;
  bidderId: string;
  rewardLamports: bigint;
  etaSeconds: number;
  confidenceBps: number;
  reliabilityBps?: number;
  qualityGuarantee?: string;
  bondLamports?: bigint;
  expiresAtMs: number;
  metadata?: Record<string, unknown>;
}

export interface TaskBidUpdateInput {
  rewardLamports?: bigint;
  etaSeconds?: number;
  confidenceBps?: number;
  reliabilityBps?: number;
  qualityGuarantee?: string;
  bondLamports?: bigint;
  expiresAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskBid extends TaskBidInput {
  bidId: string;
  createdAtMs: number;
  updatedAtMs: number;
  status: BidStatus;
  rejectedReason?: string;
}

export interface TaskBidBookState {
  taskId: string;
  taskVersion: number;
  acceptedBidId: string | null;
  totalBids: number;
  activeBids: number;
}

export interface WeightedScoringBreakdown {
  priceScore: bigint;
  etaScore: bigint;
  confidenceScore: bigint;
  reliabilityScore: bigint;
  totalScore: bigint;
}

export interface TaskBidSelection {
  bid: TaskBid;
  policy: MatchingPolicy;
  weightedBreakdown?: WeightedScoringBreakdown;
}

export function canonicalizeMarketplaceId(value: string): string {
  return value.trim().toLowerCase();
}

export function validateMarketplaceId(
  value: string,
  maxLength = BID_ID_MAX_LENGTH,
): string | null {
  if (value.length === 0) {
    return "must not be empty";
  }
  if (value.length > maxLength) {
    return `must be <= ${maxLength} characters`;
  }
  if (!MARKETPLACE_ID_PATTERN.test(value)) {
    return "must match [a-z0-9:_-]";
  }
  return null;
}

export function isValidBps(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= BPS_BASE;
}
