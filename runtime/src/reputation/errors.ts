/**
 * Reputation economy error classes for @agenc/runtime
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a reputation staking operation fails.
 */
export class ReputationStakeError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation stake failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_STAKE_ERROR
    );
    this.name = 'ReputationStakeError';
    this.reason = reason;
  }
}

/**
 * Error thrown when a reputation delegation operation fails.
 */
export class ReputationDelegationError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation delegation failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_DELEGATION_ERROR
    );
    this.name = 'ReputationDelegationError';
    this.reason = reason;
  }
}

/**
 * Error thrown when a reputation withdrawal operation fails.
 */
export class ReputationWithdrawError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation withdrawal failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_WITHDRAW_ERROR
    );
    this.name = 'ReputationWithdrawError';
    this.reason = reason;
  }
}

/**
 * Error thrown when a portable reputation proof operation fails.
 */
export class ReputationPortabilityError extends RuntimeError {
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Reputation portability failed: ${reason}`,
      RuntimeErrorCodes.REPUTATION_PORTABILITY_ERROR
    );
    this.name = 'ReputationPortabilityError';
    this.reason = reason;
  }
}
