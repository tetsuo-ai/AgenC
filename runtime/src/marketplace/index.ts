/**
 * Runtime marketplace module.
 *
 * @module
 */

export {
  MarketplaceValidationError,
  MarketplaceStateError,
  MarketplaceAuthorizationError,
  MarketplaceMatchingError,
} from './errors.js';

export {
  selectWinningBid,
  rankTaskBids,
  computeWeightedScore,
} from './scoring.js';

export {
  TaskBidMarketplace,
} from './engine.js';

export {
  ConservativeBidStrategy,
  BalancedBidStrategy,
  AutonomousBidder,
  type BidStrategy,
  type BidStrategyContext,
  type ConservativeBidStrategyConfig,
  type BalancedBidStrategyConfig,
  type AutonomousBidderConfig,
  type PlaceBidOptions,
} from './strategy.js';

export type {
  MarketplaceMutationInput,
  CreateTaskBidRequest,
  UpdateTaskBidRequest,
  CancelTaskBidRequest,
  SelectTaskBidRequest,
  ListTaskBidsRequest,
  AcceptTaskBidRequest,
  AutoMatchTaskBidRequest,
  SetTaskOwnerRequest,
  TaskBidMarketplaceConfig,
  TaskBidBookSnapshot,
  AcceptTaskBidResult,
  RankedTaskBid,
} from './types.js';

export type {
  BidStatus,
  MatchingPolicy,
  WeightedScoreWeights,
  MatchingPolicyConfig,
  BidRateLimitConfig,
  BidAntiSpamConfig,
  TaskBidInput,
  TaskBidUpdateInput,
  TaskBid,
  TaskBidBookState,
  WeightedScoringBreakdown,
  TaskBidSelection,
} from './types.js';
