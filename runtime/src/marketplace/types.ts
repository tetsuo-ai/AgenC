/**
 * Runtime marketplace types.
 *
 * @module
 */

import type {
  BidAntiSpamConfig,
  BidStatus,
  MatchingPolicyConfig,
  TaskBid,
  TaskBidBookState,
  TaskBidInput,
  TaskBidSelection,
  TaskBidUpdateInput,
  WeightedScoringBreakdown,
} from '@agenc/sdk';

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
} from '@agenc/sdk';

export interface MarketplaceMutationInput {
  actorId: string;
  expectedVersion?: number;
}

export interface CreateTaskBidRequest extends MarketplaceMutationInput {
  bid: TaskBidInput;
  taskOwnerId?: string;
}

export interface UpdateTaskBidRequest extends MarketplaceMutationInput {
  taskId: string;
  bidId: string;
  patch: TaskBidUpdateInput;
}

export interface CancelTaskBidRequest extends MarketplaceMutationInput {
  taskId: string;
  bidId: string;
  reason?: string;
}

export interface SelectTaskBidRequest {
  taskId: string;
  policy?: MatchingPolicyConfig;
}

export interface ListTaskBidsRequest {
  taskId: string;
  statuses?: readonly BidStatus[];
  includeExpiredProjection?: boolean;
}

export interface AcceptTaskBidRequest extends MarketplaceMutationInput {
  taskId: string;
  bidId: string;
}

export interface AutoMatchTaskBidRequest extends MarketplaceMutationInput {
  taskId: string;
  policy?: MatchingPolicyConfig;
}

export interface SetTaskOwnerRequest {
  taskId: string;
  ownerId: string;
  expectedVersion?: number;
}

export interface TaskBidMarketplaceConfig {
  antiSpam?: BidAntiSpamConfig;
  defaultPolicy?: MatchingPolicyConfig;
  now?: () => number;
  bidIdGenerator?: (taskId: string, bidderId: string, sequence: number) => string;
  authorizedSelectorIds?: string[];
}

export interface TaskBidBookSnapshot extends TaskBidBookState {
  ownerId: string | null;
}

export interface AcceptTaskBidResult {
  taskId: string;
  taskVersion: number;
  acceptedBid: TaskBid;
  rejectedBidIds: string[];
}

export interface RankedTaskBid extends TaskBidSelection {
  weightedBreakdown?: WeightedScoringBreakdown;
}
