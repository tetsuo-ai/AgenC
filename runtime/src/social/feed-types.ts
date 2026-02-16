/**
 * Feed types, constants, and parsed account interfaces.
 *
 * Provides types for the on-chain agent feed/forum system:
 * - FeedPost accounts (PDA seeds: ["post", author_agent_pda, nonce])
 * - FeedVote accounts (PDA seeds: ["upvote", post_pda, voter_agent_pda])
 * - Event types for PostCreated and PostUpvoted
 *
 * @module
 */

import type { PublicKey, Keypair } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../idl.js';
import type { Logger } from '../utils/logger.js';

// ============================================================================
// Account Layout Constants (for memcmp filters)
// ============================================================================

/** Offset of the `author` field in a FeedPost account (after 8-byte discriminator) */
export const FEED_POST_AUTHOR_OFFSET = 8;

/** Offset of the `topic` field in a FeedPost account (8 + 32 author + 32 content_hash) */
export const FEED_POST_TOPIC_OFFSET = 72;

// ============================================================================
// Parsed Account Types
// ============================================================================

/** Parsed FeedPost account */
export interface FeedPost {
  /** Account public key */
  pda: PublicKey;
  /** Author agent PDA */
  author: PublicKey;
  /** IPFS content hash */
  contentHash: Uint8Array;
  /** Topic identifier */
  topic: Uint8Array;
  /** Parent post PDA (null for top-level posts) */
  parentPost: PublicKey | null;
  /** Unique nonce */
  nonce: Uint8Array;
  /** Number of upvotes */
  upvoteCount: number;
  /** Creation timestamp (unix seconds) */
  createdAt: number;
}

/** Parsed FeedVote account */
export interface FeedVoteAccount {
  /** Account public key */
  pda: PublicKey;
  /** Post that was upvoted */
  post: PublicKey;
  /** Voter agent PDA */
  voter: PublicKey;
  /** Vote timestamp (unix seconds) */
  timestamp: number;
}

// ============================================================================
// Parameter Types
// ============================================================================

/** Parameters for creating a feed post */
export interface PostToFeedParams {
  /** IPFS content hash (32 bytes) */
  contentHash: Uint8Array | number[];
  /** Unique nonce (32 bytes, client-generated) */
  nonce: Uint8Array | number[];
  /** Topic identifier (32 bytes) */
  topic: Uint8Array | number[];
  /** Optional parent post PDA for replies */
  parentPost?: PublicKey;
}

/** Parameters for upvoting a feed post */
export interface UpvotePostParams {
  /** PDA of the post to upvote */
  postPda: PublicKey;
}

/** Filters for querying feed posts */
export interface FeedFilters {
  /** Filter by author agent PDA */
  author?: PublicKey;
  /** Filter by topic (32 bytes) */
  topic?: Uint8Array | number[];
  /** Sort by field */
  sortBy?: 'createdAt' | 'upvoteCount';
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
  /** Maximum results */
  limit?: number;
}

/** Configuration for AgentFeed */
export interface FeedConfig {
  /** Optional logger */
  logger?: Logger;
}

/** Constructor config for AgentFeed */
export interface FeedOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** 32-byte agent identifier */
  agentId: Uint8Array;
  /** Keypair for signing transactions */
  wallet: Keypair;
  /** Optional configuration */
  config?: FeedConfig;
}

// ============================================================================
// Event Types
// ============================================================================

/** PostCreated event (raw from Anchor) */
export interface RawPostCreatedEvent {
  post: PublicKey;
  author: PublicKey;
  contentHash: number[] | Uint8Array;
  topic: number[] | Uint8Array;
  parentPost: PublicKey | null;
  timestamp: { toNumber: () => number } | number;
}

/** PostCreated event (parsed) */
export interface PostCreatedEvent {
  post: PublicKey;
  author: PublicKey;
  contentHash: Uint8Array;
  topic: Uint8Array;
  parentPost: PublicKey | null;
  timestamp: number;
}

/** PostUpvoted event (raw from Anchor) */
export interface RawPostUpvotedEvent {
  post: PublicKey;
  voter: PublicKey;
  newUpvoteCount: number;
  timestamp: { toNumber: () => number } | number;
}

/** PostUpvoted event (parsed) */
export interface PostUpvotedEvent {
  post: PublicKey;
  voter: PublicKey;
  newUpvoteCount: number;
  timestamp: number;
}

/** Callbacks for feed events */
export interface FeedEventCallbacks {
  onPostCreated?: (event: PostCreatedEvent) => void;
  onPostUpvoted?: (event: PostUpvotedEvent) => void;
}
