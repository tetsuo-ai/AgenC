/**
 * ReputationScorer — social signals feed into agent reputation scores.
 *
 * Combines on-chain reputation (u16, 0-10000) with off-chain social signal
 * scoring to produce composite scores for ranking posts, agents, and
 * recommendations.  Tracks on-chain ReputationChanged events for history.
 *
 * Pattern: follows AgentMessaging constructor / event subscription style.
 *
 * @module
 */

import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../idl.js';
import type { Logger } from '../utils/logger.js';
import type { EventSubscription, ReputationChangedEvent, EventCallback } from '../events/types.js';
import { subscribeToReputationChanged } from '../events/protocol.js';
import type { AgentProfile } from './types.js';
import type { FeedPost } from './feed-types.js';
import type {
  ReputationWeights,
  SocialSignals,
  ScoredAgent,
  ScoredPost,
  ReputationChangeRecord,
  ReputationScorerConfig,
  ReputationReasonValue,
} from './reputation-types.js';
import {
  REPUTATION_MAX,
  REPUTATION_MIN,
  DEFAULT_UPVOTE_WEIGHT,
  DEFAULT_POST_WEIGHT,
  DEFAULT_COLLABORATION_WEIGHT,
  DEFAULT_MESSAGE_WEIGHT,
  DEFAULT_SPAM_PENALTY,
  DEFAULT_ON_CHAIN_WEIGHT,
} from './reputation-types.js';
import { ReputationScoringError, ReputationTrackingError } from './reputation-errors.js';

/** Resolved weights with all defaults applied. */
interface ResolvedWeights {
  upvoteWeight: number;
  postWeight: number;
  collaborationWeight: number;
  messageWeight: number;
  spamPenaltyBase: number;
  onChainWeight: number;
}

/**
 * Computes reputation scores from social signals and ranks agents/posts.
 *
 * The scorer is **read-only** — it does not submit on-chain transactions.
 * It reads on-chain reputation from AgentProfile and enhances it with
 * off-chain social signal scoring.
 */
export class ReputationScorer {
  private readonly program: Program<AgencCoordination>;
  private readonly weights: ResolvedWeights;
  private readonly logger?: Logger;
  private readonly history: ReputationChangeRecord[] = [];
  private subscription: EventSubscription | null = null;

  constructor(config: ReputationScorerConfig) {
    this.program = config.program;
    this.logger = config.logger;
    this.weights = ReputationScorer.resolveWeights(config.weights);
  }

  // ==========================================================================
  // Individual Signal Scoring (matches docs ReputationScorer interface)
  // ==========================================================================

  /**
   * Score a post based on its upvote count.
   * @returns Reputation points earned by the post author.
   */
  scorePost(upvotes: number): number {
    if (upvotes < 0) {
      throw new ReputationScoringError('upvote count cannot be negative');
    }
    return upvotes * this.weights.upvoteWeight + this.weights.postWeight;
  }

  /**
   * Score a completed collaboration for each participant.
   * @param participantCount - Number of agents in the collaboration.
   * @returns Reputation points earned per participant.
   */
  scoreCollaboration(participantCount: number): number {
    if (participantCount < 1) {
      throw new ReputationScoringError('participant count must be >= 1');
    }
    return this.weights.collaborationWeight;
  }

  /**
   * Score a sent message.
   * @returns Reputation points earned.
   */
  scoreMessage(): number {
    return this.weights.messageWeight;
  }

  /**
   * Compute a spam penalty.
   * @param severity - Severity multiplier (1 = normal, higher = worse).
   * @returns Negative reputation delta.
   */
  penalizeSpam(severity: number): number {
    if (severity < 0) {
      throw new ReputationScoringError('severity cannot be negative');
    }
    return -(this.weights.spamPenaltyBase * severity);
  }

  // ==========================================================================
  // Aggregate Scoring
  // ==========================================================================

  /**
   * Compute an aggregate social score from signal counts.
   * Result is >= 0 (clamped).
   */
  computeSocialScore(signals: SocialSignals): number {
    const raw =
      signals.postsAuthored * this.weights.postWeight +
      signals.upvotesReceived * this.weights.upvoteWeight +
      signals.collaborationsCompleted * this.weights.collaborationWeight +
      signals.messagesSent * this.weights.messageWeight -
      signals.spamReports * this.weights.spamPenaltyBase;
    return Math.max(0, raw);
  }

  /**
   * Combine on-chain reputation with a social score into a composite value
   * in the range [0, REPUTATION_MAX].
   *
   * `composite = onChainWeight * onChainRep + (1-onChainWeight) * normalizedSocial`
   *
   * Social score is normalized to [0, REPUTATION_MAX] via `min(social, REPUTATION_MAX)`.
   */
  computeCompositeScore(onChainReputation: number, socialScore: number): number {
    const clampedOnChain = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, onChainReputation));
    const normalizedSocial = Math.min(socialScore, REPUTATION_MAX);
    const w = this.weights.onChainWeight;
    const composite = w * clampedOnChain + (1 - w) * normalizedSocial;
    return Math.round(Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, composite)));
  }

  // ==========================================================================
  // Ranking Helpers
  // ==========================================================================

  /**
   * Rank feed posts by a reputation-weighted score.
   *
   * Score formula: `upvoteCount * (1 + authorReputation / REPUTATION_MAX)`
   *
   * Posts from higher-reputation agents are ranked higher when upvote counts
   * are similar.
   *
   * @param posts - Feed posts to rank.
   * @param reputationMap - Map of agent PDA (base58) → on-chain reputation.
   * @returns Posts sorted descending by score.
   */
  rankPosts(
    posts: FeedPost[],
    reputationMap: Map<string, number>,
  ): ScoredPost[] {
    return posts
      .map((post) => {
        const authorKey = post.author.toBase58();
        const authorReputation = reputationMap.get(authorKey) ?? 0;
        const repMultiplier = 1 + authorReputation / REPUTATION_MAX;
        const weightedUpvotes = post.upvoteCount * repMultiplier;
        // Base score includes a small boost for having any reputation
        const score = weightedUpvotes + (authorReputation / REPUTATION_MAX) * this.weights.postWeight;
        return { post, authorReputation, weightedUpvotes, score };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Rank agents by composite reputation score.
   *
   * @param agents - Agent profiles to rank.
   * @param signalsMap - Optional map of agent PDA (base58) → SocialSignals.
   *   Agents not in the map are scored with zero social signals.
   * @returns Agents sorted descending by composite score.
   */
  rankAgents(
    agents: AgentProfile[],
    signalsMap?: Map<string, SocialSignals>,
  ): ScoredAgent[] {
    return agents
      .map((profile) => {
        const key = profile.pda.toBase58();
        const signals = signalsMap?.get(key);
        const socialScore = signals ? this.computeSocialScore(signals) : 0;
        const compositeScore = this.computeCompositeScore(profile.reputation, socialScore);
        return {
          profile,
          onChainReputation: profile.reputation,
          socialScore,
          compositeScore,
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  // ==========================================================================
  // Event Tracking
  // ==========================================================================

  /**
   * Start tracking on-chain ReputationChanged events.
   * Stores events in local history for later querying.
   *
   * @returns Subscription handle.
   * @throws ReputationTrackingError if already tracking.
   */
  startTracking(): EventSubscription {
    if (this.subscription) {
      throw new ReputationTrackingError('already tracking reputation events');
    }

    const callback: EventCallback<ReputationChangedEvent> = (event) => {
      this.history.push({
        agentId: event.agentId,
        oldReputation: event.oldReputation,
        newReputation: event.newReputation,
        reason: event.reason as ReputationReasonValue,
        timestamp: event.timestamp,
      });
      this.logger?.debug?.(
        `ReputationChanged: rep ${event.oldReputation} → ${event.newReputation} (reason=${event.reason})`,
      );
    };

    this.subscription = subscribeToReputationChanged(this.program, callback);
    this.logger?.info?.('Reputation event tracking started');
    return this.subscription;
  }

  /**
   * Stop tracking reputation events.
   */
  async stopTracking(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
      this.logger?.info?.('Reputation event tracking stopped');
    }
  }

  /**
   * Get recorded reputation change history.
   *
   * @param agentId - Optional filter by agent ID (32 bytes). If omitted, returns all.
   * @returns Reputation change records, newest first.
   */
  getHistory(agentId?: Uint8Array): ReputationChangeRecord[] {
    let records = this.history;
    if (agentId) {
      records = records.filter((r) => {
        if (r.agentId.length !== agentId.length) return false;
        for (let i = 0; i < agentId.length; i++) {
          if (r.agentId[i] !== agentId[i]) return false;
        }
        return true;
      });
    }
    return [...records].reverse();
  }

  /** Whether event tracking is currently active. */
  get isTracking(): boolean {
    return this.subscription !== null;
  }

  /** Number of recorded reputation change events. */
  get historySize(): number {
    return this.history.length;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Stop tracking and release resources.
   */
  async dispose(): Promise<void> {
    await this.stopTracking();
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /** Resolve user-provided weights with defaults. */
  private static resolveWeights(weights?: ReputationWeights): ResolvedWeights {
    return {
      upvoteWeight: weights?.upvoteWeight ?? DEFAULT_UPVOTE_WEIGHT,
      postWeight: weights?.postWeight ?? DEFAULT_POST_WEIGHT,
      collaborationWeight: weights?.collaborationWeight ?? DEFAULT_COLLABORATION_WEIGHT,
      messageWeight: weights?.messageWeight ?? DEFAULT_MESSAGE_WEIGHT,
      spamPenaltyBase: weights?.spamPenaltyBase ?? DEFAULT_SPAM_PENALTY,
      onChainWeight: Math.max(0, Math.min(1, weights?.onChainWeight ?? DEFAULT_ON_CHAIN_WEIGHT)),
    };
  }
}
