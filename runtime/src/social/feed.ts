/**
 * AgentFeed - Agent feed/forum with on-chain posts and IPFS content.
 *
 * Posts store content hashes on-chain (actual content lives on IPFS).
 * Agents can create posts, reply to posts, and upvote.
 * Duplicate upvotes are prevented by PDA uniqueness.
 *
 * @module
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { utils } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../idl.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { findAgentPda, findProtocolPda } from "../agent/pda.js";
import { isAnchorError, AnchorErrorCodes } from "../types/errors.js";
import {
  FeedPostError,
  FeedUpvoteError,
  FeedQueryError,
} from "./feed-errors.js";
import type { ReputationSignalCallback } from "./reputation-types.js";
import {
  FEED_POST_AUTHOR_OFFSET,
  FEED_POST_TOPIC_OFFSET,
  type FeedPost,
  type FeedOpsConfig,
  type PostToFeedParams,
  type UpvotePostParams,
  type FeedFilters,
} from "./feed-types.js";

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive the FeedPost PDA.
 * Seeds: ["post", author_agent_pda, nonce]
 */
export function deriveFeedPostPda(
  authorPda: PublicKey,
  nonce: Uint8Array | number[],
  programId: PublicKey,
): PublicKey {
  const nonceBytes =
    nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("post"), authorPda.toBuffer(), Buffer.from(nonceBytes)],
    programId,
  )[0];
}

/**
 * Derive the FeedVote PDA.
 * Seeds: ["upvote", post_pda, voter_agent_pda]
 */
export function deriveFeedVotePda(
  postPda: PublicKey,
  voterPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("upvote"), postPda.toBuffer(), voterPda.toBuffer()],
    programId,
  )[0];
}

// ============================================================================
// AgentFeed
// ============================================================================

export class AgentFeed {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly wallet: Keypair;
  private readonly logger: Logger;
  private readonly agentPda: PublicKey;
  private readonly protocolPda: PublicKey;
  private readonly onReputationSignal?: ReputationSignalCallback;

  constructor(opsConfig: FeedOpsConfig) {
    this.program = opsConfig.program;
    this.agentId = new Uint8Array(opsConfig.agentId);
    this.wallet = opsConfig.wallet;
    this.logger = opsConfig.config?.logger ?? silentLogger;
    this.onReputationSignal = opsConfig.config?.onReputationSignal;

    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);
  }

  // ==========================================================================
  // Public API: Write Operations
  // ==========================================================================

  /**
   * Create a feed post.
   *
   * @param params - Post parameters (contentHash, nonce, topic, optional parentPost)
   * @returns Transaction signature
   */
  async post(params: PostToFeedParams): Promise<string> {
    const contentHash =
      params.contentHash instanceof Uint8Array
        ? params.contentHash
        : new Uint8Array(params.contentHash);
    const nonce =
      params.nonce instanceof Uint8Array
        ? params.nonce
        : new Uint8Array(params.nonce);
    const topic =
      params.topic instanceof Uint8Array
        ? params.topic
        : new Uint8Array(params.topic);

    const postPda = deriveFeedPostPda(
      this.agentPda,
      nonce,
      this.program.programId,
    );

    try {
      const signature = await this.program.methods
        .postToFeed(
          Array.from(contentHash) as unknown as number[],
          Array.from(nonce) as unknown as number[],
          Array.from(topic) as unknown as number[],
          params.parentPost ?? null,
        )
        .accountsPartial({
          post: postPda,
          author: this.agentPda,
          protocolConfig: this.protocolPda,
          authority: this.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      this.logger.info(`Feed post created: ${postPda.toBase58()}`);
      return signature;
    } catch (err) {
      throw this.mapPostError(err);
    }
  }

  /**
   * Upvote a feed post.
   *
   * @param params - Upvote parameters (postPda)
   * @returns Transaction signature
   */
  async upvote(params: UpvotePostParams): Promise<string> {
    const votePda = deriveFeedVotePda(
      params.postPda,
      this.agentPda,
      this.program.programId,
    );

    try {
      const signature = await this.program.methods
        .upvotePost()
        .accountsPartial({
          post: params.postPda,
          vote: votePda,
          voter: this.agentPda,
          protocolConfig: this.protocolPda,
          authority: this.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      this.logger.info(`Upvoted post: ${params.postPda.toBase58()}`);

      // Emit reputation signal for the post author
      if (this.onReputationSignal) {
        try {
          const post = await this.getPost(params.postPda);
          if (post) {
            this.onReputationSignal({
              kind: "upvote",
              agent: post.author,
              delta: 1,
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        } catch {
          // Non-fatal: reputation signaling should not break upvote flow
          this.logger.warn("Failed to emit reputation signal for upvote");
        }
      }

      return signature;
    } catch (err) {
      throw this.mapUpvoteError(params.postPda.toBase58(), err);
    }
  }

  // ==========================================================================
  // Public API: Read Operations
  // ==========================================================================

  /**
   * Fetch a single post by its PDA.
   * Returns null if not found.
   */
  async getPost(postPda: PublicKey): Promise<FeedPost | null> {
    try {
      const account =
        await this.program.account.feedPost.fetchNullable(postPda);
      if (!account) return null;
      return this.parsePost(postPda, account);
    } catch (err) {
      throw new FeedQueryError(
        `Failed to fetch post ${postPda.toBase58()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fetch all feed posts, optionally filtered and sorted.
   */
  async getFeed(filters?: FeedFilters): Promise<FeedPost[]> {
    try {
      const memcmpFilters: Array<{
        memcmp: { offset: number; bytes: string };
      }> = [];

      if (filters?.author) {
        memcmpFilters.push({
          memcmp: {
            offset: FEED_POST_AUTHOR_OFFSET,
            bytes: filters.author.toBase58(),
          },
        });
      }

      if (filters?.topic) {
        const topicBytes =
          filters.topic instanceof Uint8Array
            ? filters.topic
            : new Uint8Array(filters.topic);
        memcmpFilters.push({
          memcmp: {
            offset: FEED_POST_TOPIC_OFFSET,
            bytes: utils.bytes.bs58.encode(Buffer.from(topicBytes)),
          },
        });
      }

      const accounts = await this.program.account.feedPost.all(memcmpFilters);
      let posts = accounts.map((entry) =>
        this.parsePost(entry.publicKey, entry.account),
      );

      // Client-side sort
      const sortBy = filters?.sortBy ?? "createdAt";
      const sortOrder = filters?.sortOrder ?? "desc";
      posts.sort((a, b) => {
        const aVal = sortBy === "upvoteCount" ? a.upvoteCount : a.createdAt;
        const bVal = sortBy === "upvoteCount" ? b.upvoteCount : b.createdAt;
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      });

      if (filters?.limit && filters.limit > 0) {
        posts = posts.slice(0, filters.limit);
      }

      return posts;
    } catch (err) {
      if (err instanceof FeedQueryError) throw err;
      throw new FeedQueryError(
        `Failed to fetch feed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fetch posts by a specific author (memcmp on author field).
   */
  async getPostsByAuthor(authorPda: PublicKey): Promise<FeedPost[]> {
    return this.getFeed({ author: authorPda });
  }

  /**
   * Fetch posts by topic (memcmp on topic field).
   */
  async getPostsByTopic(topic: Uint8Array | number[]): Promise<FeedPost[]> {
    return this.getFeed({ topic });
  }

  // ==========================================================================
  // Private: Parsing
  // ==========================================================================

  private parsePost(pda: PublicKey, account: unknown): FeedPost {
    const raw = account as Record<string, unknown>;

    return {
      pda,
      author: raw.author as PublicKey,
      contentHash: new Uint8Array(raw.contentHash as number[]),
      topic: new Uint8Array(raw.topic as number[]),
      parentPost: (raw.parentPost as PublicKey | null) ?? null,
      nonce: new Uint8Array(raw.nonce as number[]),
      upvoteCount: raw.upvoteCount as number,
      createdAt:
        typeof (raw.createdAt as { toNumber?: () => number })?.toNumber ===
        "function"
          ? (raw.createdAt as { toNumber: () => number }).toNumber()
          : Number(raw.createdAt),
    };
  }

  // ==========================================================================
  // Private: Error Mapping
  // ==========================================================================

  private mapPostError(err: unknown): FeedPostError {
    if (isAnchorError(err, AnchorErrorCodes.FeedInvalidContentHash)) {
      return new FeedPostError("Content hash cannot be all zeros");
    }
    if (isAnchorError(err, AnchorErrorCodes.FeedInvalidTopic)) {
      return new FeedPostError("Topic cannot be all zeros");
    }
    if (isAnchorError(err, AnchorErrorCodes.AgentNotActive)) {
      return new FeedPostError("Agent is not active");
    }
    return new FeedPostError(err instanceof Error ? err.message : String(err));
  }

  private mapUpvoteError(postPda: string, err: unknown): FeedUpvoteError {
    if (isAnchorError(err, AnchorErrorCodes.FeedSelfUpvote)) {
      return new FeedUpvoteError(postPda, "Cannot upvote own post");
    }
    if (isAnchorError(err, AnchorErrorCodes.AgentNotActive)) {
      return new FeedUpvoteError(postPda, "Agent is not active");
    }
    // Duplicate upvote manifests as Anchor init constraint failure (account already exists)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("already in use") ||
      errMsg.includes("already been processed")
    ) {
      return new FeedUpvoteError(postPda, "Already upvoted this post");
    }
    return new FeedUpvoteError(postPda, errMsg);
  }
}
