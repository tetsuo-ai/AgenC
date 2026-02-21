/**
 * Feed-specific error classes for @agenc/runtime
 *
 * All feed errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when a feed post operation fails (creation or retrieval).
 */
export class FeedPostError extends RuntimeError {
  /** The reason the operation failed */
  public readonly reason: string;

  constructor(reason: string) {
    super(`Feed post failed: ${reason}`, RuntimeErrorCodes.FEED_POST_ERROR);
    this.name = "FeedPostError";
    this.reason = reason;
  }
}

/**
 * Error thrown when a feed upvote operation fails.
 */
export class FeedUpvoteError extends RuntimeError {
  /** The post PDA (base58 string) */
  public readonly postPda: string;
  /** The reason the upvote failed */
  public readonly reason: string;

  constructor(postPda: string, reason: string) {
    super(
      `Feed upvote failed for post ${postPda}: ${reason}`,
      RuntimeErrorCodes.FEED_UPVOTE_ERROR,
    );
    this.name = "FeedUpvoteError";
    this.postPda = postPda;
    this.reason = reason;
  }
}

/**
 * Error thrown when a feed query operation fails.
 */
export class FeedQueryError extends RuntimeError {
  /** The reason the query failed */
  public readonly reason: string;

  constructor(reason: string) {
    super(`Feed query failed: ${reason}`, RuntimeErrorCodes.FEED_QUERY_ERROR);
    this.name = "FeedQueryError";
    this.reason = reason;
  }
}
