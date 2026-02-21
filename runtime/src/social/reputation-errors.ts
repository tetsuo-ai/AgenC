/**
 * Reputation-specific error classes for @agenc/runtime.
 *
 * All reputation errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when reputation scoring fails (invalid input, overflow, etc.).
 */
export class ReputationScoringError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation scoring failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_SCORING_ERROR,
    );
    this.name = "ReputationScoringError";
    this.reason = reason;
  }
}

/**
 * Error thrown when reputation event tracking fails (subscription, history query).
 */
export class ReputationTrackingError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation tracking failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_TRACKING_ERROR,
    );
    this.name = "ReputationTrackingError";
    this.reason = reason;
  }
}
