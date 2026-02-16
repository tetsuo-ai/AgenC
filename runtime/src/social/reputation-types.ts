/**
 * Reputation scoring types, constants, and interfaces.
 *
 * Provides the type system for Phase 8.4 — social signals feed into
 * agent reputation scores.  The on-chain reputation (u16, 0-10000) is
 * combined with off-chain social signal scoring to produce composite
 * scores used for ranking posts, agents, and recommendations.
 *
 * @module
 */

import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../idl.js';
import type { Logger } from '../utils/logger.js';
import type { FeedPost } from './feed-types.js';
import type { AgentProfile } from './types.js';

// ============================================================================
// On-chain Reputation Constants
// ============================================================================

/**
 * Reason codes for on-chain reputation changes.
 * Mirrors `reputation_reason` constants in events.rs.
 */
export const ReputationReason = {
  /** Reputation increased from task completion */
  COMPLETION: 0,
  /** Reputation decreased from losing a dispute */
  DISPUTE_SLASH: 1,
  /** Reputation decreased from inactivity decay */
  DECAY: 2,
} as const;

export type ReputationReasonValue =
  (typeof ReputationReason)[keyof typeof ReputationReason];

/** Maximum on-chain reputation value (u16) */
export const REPUTATION_MAX = 10_000;

/** Minimum on-chain reputation value */
export const REPUTATION_MIN = 0;

// ============================================================================
// Scoring Weight Defaults
// ============================================================================

/** Default points per upvote received on a post */
export const DEFAULT_UPVOTE_WEIGHT = 5;

/** Default points per post authored */
export const DEFAULT_POST_WEIGHT = 2;

/** Default points per collaboration (multi-agent task) completed */
export const DEFAULT_COLLABORATION_WEIGHT = 10;

/** Default points per message sent */
export const DEFAULT_MESSAGE_WEIGHT = 1;

/** Default base penalty per spam report */
export const DEFAULT_SPAM_PENALTY = 50;

/**
 * Default weight (0-1) given to on-chain reputation when computing
 * the composite score.  Social score receives `1 - ON_CHAIN_WEIGHT`.
 */
export const DEFAULT_ON_CHAIN_WEIGHT = 0.7;

// ============================================================================
// Scoring Configuration
// ============================================================================

/** Configurable weights for social signal scoring. */
export interface ReputationWeights {
  /** Points per upvote received (default: 5) */
  upvoteWeight?: number;
  /** Points per post authored (default: 2) */
  postWeight?: number;
  /** Points per collaboration completed (default: 10) */
  collaborationWeight?: number;
  /** Points per message sent (default: 1) */
  messageWeight?: number;
  /** Base penalty per spam report (default: 50) */
  spamPenaltyBase?: number;
  /** Weight of on-chain reputation in composite score, 0-1 (default: 0.7) */
  onChainWeight?: number;
}

// ============================================================================
// Social Signal Aggregates
// ============================================================================

/** Aggregated social signal counts for a single agent. */
export interface SocialSignals {
  /** Number of top-level posts authored */
  postsAuthored: number;
  /** Total upvotes received across all posts */
  upvotesReceived: number;
  /** Number of collaborative tasks completed */
  collaborationsCompleted: number;
  /** Number of messages sent */
  messagesSent: number;
  /** Number of spam reports received */
  spamReports: number;
}

// ============================================================================
// Scored Results
// ============================================================================

/** An agent with computed reputation scores. */
export interface ScoredAgent {
  /** Agent profile */
  profile: AgentProfile;
  /** On-chain reputation (0-10000) */
  onChainReputation: number;
  /** Social signal score (unbounded, >= 0) */
  socialScore: number;
  /** Composite score combining on-chain + social (0-10000) */
  compositeScore: number;
}

/** A feed post with reputation-weighted score. */
export interface ScoredPost {
  /** The feed post */
  post: FeedPost;
  /** Author's on-chain reputation (0-10000, or 0 if unknown) */
  authorReputation: number;
  /** Reputation-weighted upvote score */
  weightedUpvotes: number;
  /** Final composite post score (higher = more relevant) */
  score: number;
}

// ============================================================================
// Reputation History
// ============================================================================

/** A single reputation change record from on-chain events. */
export interface ReputationChangeRecord {
  /** Agent identifier */
  agentId: Uint8Array;
  /** Reputation before the change */
  oldReputation: number;
  /** Reputation after the change */
  newReputation: number;
  /** Reason code (see ReputationReason) */
  reason: ReputationReasonValue;
  /** Unix timestamp of the change */
  timestamp: number;
}

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for ReputationScorer. */
export interface ReputationScorerConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Scoring weight overrides */
  weights?: ReputationWeights;
  /** Optional logger */
  logger?: Logger;
}
