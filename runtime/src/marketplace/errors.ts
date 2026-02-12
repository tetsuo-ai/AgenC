/**
 * Marketplace error types.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class MarketplaceValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.MARKETPLACE_VALIDATION_ERROR);
    this.name = 'MarketplaceValidationError';
  }
}

export class MarketplaceStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.MARKETPLACE_STATE_ERROR);
    this.name = 'MarketplaceStateError';
  }
}

export class MarketplaceAuthorizationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.MARKETPLACE_AUTHORIZATION_ERROR);
    this.name = 'MarketplaceAuthorizationError';
  }
}

export class MarketplaceMatchingError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.MARKETPLACE_MATCHING_ERROR);
    this.name = 'MarketplaceMatchingError';
  }
}
