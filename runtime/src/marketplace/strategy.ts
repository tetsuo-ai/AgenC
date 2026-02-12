/**
 * Marketplace autonomous bidding strategies.
 *
 * @module
 */

import { BPS_BASE, isValidBps } from '@agenc/sdk';
import type { TaskBid, TaskBidInput } from '@agenc/sdk';
import { MarketplaceValidationError } from './errors.js';
import { TaskBidMarketplace } from './engine.js';

export interface BidStrategyContext {
  taskId: string;
  bidderId: string;
  maxRewardLamports: bigint;
  etaSeconds: number;
  confidenceBps: number;
  reliabilityBps?: number;
  expiresAtMs: number;
  qualityGuarantee?: string;
  bondLamports?: bigint;
  metadata?: Record<string, unknown>;
}

export interface BidStrategy {
  buildBid(context: BidStrategyContext): TaskBidInput;
}

interface StrategyTuning {
  rewardFractionBps: number;
  etaMultiplierBps: number;
  confidenceBpsFloor: number;
  reliabilityBpsFloor: number;
}

export interface ConservativeBidStrategyConfig {
  rewardFractionBps?: number;
  etaMultiplierBps?: number;
  confidenceBpsFloor?: number;
  reliabilityBpsFloor?: number;
}

export interface BalancedBidStrategyConfig {
  rewardFractionBps?: number;
  etaMultiplierBps?: number;
  confidenceBpsFloor?: number;
  reliabilityBpsFloor?: number;
}

export class ConservativeBidStrategy implements BidStrategy {
  private readonly tuning: StrategyTuning;

  constructor(config: ConservativeBidStrategyConfig = {}) {
    this.tuning = normalizeTuning({
      rewardFractionBps: config.rewardFractionBps ?? 9_500,
      etaMultiplierBps: config.etaMultiplierBps ?? 11_000,
      confidenceBpsFloor: config.confidenceBpsFloor ?? 8_000,
      reliabilityBpsFloor: config.reliabilityBpsFloor ?? 8_000,
    });
  }

  buildBid(context: BidStrategyContext): TaskBidInput {
    return buildBidFromTuning(context, this.tuning);
  }
}

export class BalancedBidStrategy implements BidStrategy {
  private readonly tuning: StrategyTuning;

  constructor(config: BalancedBidStrategyConfig = {}) {
    this.tuning = normalizeTuning({
      rewardFractionBps: config.rewardFractionBps ?? 8_500,
      etaMultiplierBps: config.etaMultiplierBps ?? 10_000,
      confidenceBpsFloor: config.confidenceBpsFloor ?? 7_000,
      reliabilityBpsFloor: config.reliabilityBpsFloor ?? 7_000,
    });
  }

  buildBid(context: BidStrategyContext): TaskBidInput {
    return buildBidFromTuning(context, this.tuning);
  }
}

export interface AutonomousBidderConfig {
  actorId: string;
  marketplace: TaskBidMarketplace;
  strategy: BidStrategy;
}

export interface PlaceBidOptions {
  expectedVersion?: number;
  taskOwnerId?: string;
}

export class AutonomousBidder {
  private readonly actorId: string;
  private readonly marketplace: TaskBidMarketplace;
  private readonly strategy: BidStrategy;

  constructor(config: AutonomousBidderConfig) {
    this.actorId = config.actorId;
    this.marketplace = config.marketplace;
    this.strategy = config.strategy;
  }

  placeBid(context: BidStrategyContext, options: PlaceBidOptions = {}): TaskBid {
    const bid = this.strategy.buildBid(context);
    return this.marketplace.createBid({
      actorId: this.actorId,
      expectedVersion: options.expectedVersion,
      taskOwnerId: options.taskOwnerId,
      bid,
    });
  }
}

function buildBidFromTuning(
  context: BidStrategyContext,
  tuning: StrategyTuning,
): TaskBidInput {
  if (context.maxRewardLamports < 0n) {
    throw new MarketplaceValidationError('maxRewardLamports must be non-negative');
  }

  if (!Number.isInteger(context.etaSeconds) || context.etaSeconds < 0) {
    throw new MarketplaceValidationError('etaSeconds must be a non-negative integer');
  }

  const rewardLamports = (context.maxRewardLamports * BigInt(tuning.rewardFractionBps)) / BigInt(BPS_BASE);
  const etaSeconds = Math.floor((context.etaSeconds * tuning.etaMultiplierBps) / BPS_BASE);
  const confidenceBps = Math.max(context.confidenceBps, tuning.confidenceBpsFloor);
  const reliabilityBps = Math.max(
    context.reliabilityBps ?? context.confidenceBps,
    tuning.reliabilityBpsFloor,
  );

  if (!isValidBps(confidenceBps) || !isValidBps(reliabilityBps)) {
    throw new MarketplaceValidationError('confidence/reliability must be valid bps values');
  }

  return {
    taskId: context.taskId,
    bidderId: context.bidderId,
    rewardLamports,
    etaSeconds,
    confidenceBps,
    reliabilityBps,
    qualityGuarantee: context.qualityGuarantee,
    bondLamports: context.bondLamports,
    expiresAtMs: context.expiresAtMs,
    metadata: context.metadata,
  };
}

function normalizeTuning(input: StrategyTuning): StrategyTuning {
  if (!isValidBps(input.rewardFractionBps) || input.rewardFractionBps === 0) {
    throw new MarketplaceValidationError('rewardFractionBps must be between 1 and 10000');
  }

  if (!Number.isInteger(input.etaMultiplierBps) || input.etaMultiplierBps < 1) {
    throw new MarketplaceValidationError('etaMultiplierBps must be a positive integer');
  }

  if (!isValidBps(input.confidenceBpsFloor)) {
    throw new MarketplaceValidationError('confidenceBpsFloor must be between 0 and 10000');
  }

  if (!isValidBps(input.reliabilityBpsFloor)) {
    throw new MarketplaceValidationError('reliabilityBpsFloor must be between 0 and 10000');
  }

  return input;
}
