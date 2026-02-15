/**
 * Gateway error classes.
 *
 * @module
 */

import { RuntimeError, type RuntimeErrorCode } from '../types/errors.js';

const GATEWAY_VALIDATION_ERROR = 'GATEWAY_VALIDATION_ERROR' as RuntimeErrorCode;
const GATEWAY_CONNECTION_ERROR = 'GATEWAY_CONNECTION_ERROR' as RuntimeErrorCode;
const GATEWAY_STATE_ERROR = 'GATEWAY_STATE_ERROR' as RuntimeErrorCode;
const GATEWAY_LIFECYCLE_ERROR = 'GATEWAY_LIFECYCLE_ERROR' as RuntimeErrorCode;

export class GatewayValidationError extends RuntimeError {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Gateway config validation failed: ${field} — ${reason}`, GATEWAY_VALIDATION_ERROR);
    this.name = 'GatewayValidationError';
    this.field = field;
    this.reason = reason;
  }
}

export class GatewayConnectionError extends RuntimeError {
  constructor(message: string) {
    super(message, GATEWAY_CONNECTION_ERROR);
    this.name = 'GatewayConnectionError';
  }
}

export class GatewayStateError extends RuntimeError {
  constructor(message: string) {
    super(message, GATEWAY_STATE_ERROR);
    this.name = 'GatewayStateError';
  }
}

export class GatewayLifecycleError extends RuntimeError {
  constructor(message: string) {
    super(message, GATEWAY_LIFECYCLE_ERROR);
    this.name = 'GatewayLifecycleError';
  }
}
