/**
 * Proof-specific error types for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when ZK proof generation fails.
 */
export class ProofGenerationError extends RuntimeError {
  public readonly cause: string;

  constructor(cause: string) {
    super(
      `Proof generation failed: ${cause}`,
      RuntimeErrorCodes.PROOF_GENERATION_ERROR,
    );
    this.name = 'ProofGenerationError';
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProofGenerationError);
    }
  }
}

/**
 * Error thrown when ZK proof verification fails.
 */
export class ProofVerificationError extends RuntimeError {
  constructor(message: string) {
    super(
      `Proof verification failed: ${message}`,
      RuntimeErrorCodes.PROOF_VERIFICATION_ERROR,
    );
    this.name = 'ProofVerificationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProofVerificationError);
    }
  }
}

/**
 * Error thrown when a proof cache operation fails.
 */
export class ProofCacheError extends RuntimeError {
  constructor(message: string) {
    super(
      `Proof cache error: ${message}`,
      RuntimeErrorCodes.PROOF_CACHE_ERROR,
    );
    this.name = 'ProofCacheError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProofCacheError);
    }
  }
}
