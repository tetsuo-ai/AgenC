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
} from "@agenc/sdk";

import type { TaskBidMarketplace } from "./engine.js";

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
} from "@agenc/sdk";

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
  bidIdGenerator?: (
    taskId: string,
    bidderId: string,
    sequence: number,
  ) => string;
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

// ---------------------------------------------------------------------------
// Service Marketplace (Issue #1109)
// ---------------------------------------------------------------------------

export type ServiceRequestStatus =
  | "open"
  | "bidding"
  | "awarded"
  | "active"
  | "completed"
  | "cancelled"
  | "disputed"
  | "resolved";

export interface ServiceRequest {
  title: string;
  description: string;
  requiredCapabilities: bigint;
  budget: bigint;
  budgetMint?: string;
  deadline?: number;
  deliverables: string[];
}

export interface ServiceBid {
  price: bigint;
  deliveryTime: number;
  proposal: string;
  portfolioLinks?: string[];
}

export interface ServiceRequestRecord {
  serviceId: string;
  request: ServiceRequest;
  requesterId: string;
  status: ServiceRequestStatus;
  acceptedBidId: string | null;
  awardedAgentId: string | null;
  completionProof: string | null;
  disputeReason: string | null;
  disputeOutcome: "refund" | "pay_agent" | "split" | null;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
}

export interface ServiceRequestSnapshot {
  serviceId: string;
  request: ServiceRequest;
  requesterId: string;
  status: ServiceRequestStatus;
  acceptedBidId: string | null;
  awardedAgentId: string | null;
  completionProof: string | null;
  disputeReason: string | null;
  disputeOutcome: "refund" | "pay_agent" | "split" | null;
  activeBids: number;
  totalBids: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateServiceRequestInput {
  actorId: string;
  serviceId: string;
  request: ServiceRequest;
}

export interface BidOnServiceInput {
  actorId: string;
  serviceId: string;
  bid: ServiceBid;
}

export interface AcceptServiceBidInput {
  actorId: string;
  serviceId: string;
  bidId: string;
  expectedVersion?: number;
}

export interface StartServiceInput {
  actorId: string;
  serviceId: string;
}

export interface CompleteServiceInput {
  actorId: string;
  serviceId: string;
  proof: string;
}

export interface CancelServiceInput {
  actorId: string;
  serviceId: string;
}

export interface DisputeServiceInput {
  actorId: string;
  serviceId: string;
  reason: string;
}

export interface ResolveServiceDisputeInput {
  actorId: string;
  serviceId: string;
  outcome: "refund" | "pay_agent" | "split";
}

export interface ListServiceRequestsInput {
  status?: ServiceRequestStatus;
  requesterId?: string;
  requiredCapabilities?: bigint;
  minBudget?: bigint;
  maxBudget?: bigint;
}

export interface ServiceMarketplaceConfig {
  now?: () => number;
  bidMarketplace?: TaskBidMarketplace;
  authorizedDisputeResolverIds?: string[];
  maxTitleLength?: number;
  maxDescriptionLength?: number;
  maxDeliverables?: number;
  maxDeliverableLength?: number;
}
