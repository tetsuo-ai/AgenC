/**
 * Dispute-specific error classes for @agenc/runtime
 *
 * All dispute errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a dispute cannot be found by its PDA.
 */
export class DisputeNotFoundError extends RuntimeError {
  /** The PDA of the dispute that was not found (base58 string) */
  public readonly disputePda: string;

  constructor(disputePda: string) {
    super(
      `Dispute not found: ${disputePda}`,
      RuntimeErrorCodes.DISPUTE_NOT_FOUND
    );
    this.name = 'DisputeNotFoundError';
    this.disputePda = disputePda;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DisputeNotFoundError);
    }
  }
}

/**
 * Error thrown when a dispute vote operation fails.
 */
export class DisputeVoteError extends RuntimeError {
  /** The PDA of the dispute (base58 string) */
  public readonly disputePda: string;
  /** The reason the vote failed */
  public readonly reason: string;

  constructor(disputePda: string, reason: string) {
    super(
      `Dispute vote failed for ${disputePda}: ${reason}`,
      RuntimeErrorCodes.DISPUTE_VOTE_ERROR
    );
    this.name = 'DisputeVoteError';
    this.disputePda = disputePda;
    this.reason = reason;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DisputeVoteError);
    }
  }
}

/**
 * Error thrown when a dispute resolution operation fails.
 */
export class DisputeResolutionError extends RuntimeError {
  /** The PDA of the dispute (base58 string) */
  public readonly disputePda: string;
  /** The reason the resolution failed */
  public readonly reason: string;

  constructor(disputePda: string, reason: string) {
    super(
      `Dispute resolution failed for ${disputePda}: ${reason}`,
      RuntimeErrorCodes.DISPUTE_RESOLUTION_ERROR
    );
    this.name = 'DisputeResolutionError';
    this.disputePda = disputePda;
    this.reason = reason;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DisputeResolutionError);
    }
  }
}

/**
 * Error thrown when a dispute slash operation fails.
 */
export class DisputeSlashError extends RuntimeError {
  /** The PDA of the dispute (base58 string) */
  public readonly disputePda: string;
  /** The reason the slash failed */
  public readonly reason: string;

  constructor(disputePda: string, reason: string) {
    super(
      `Dispute slash failed for ${disputePda}: ${reason}`,
      RuntimeErrorCodes.DISPUTE_SLASH_ERROR
    );
    this.name = 'DisputeSlashError';
    this.disputePda = disputePda;
    this.reason = reason;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DisputeSlashError);
    }
  }
}
