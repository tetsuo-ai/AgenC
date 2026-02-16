/**
 * Gateway error classes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class GatewayValidationError extends RuntimeError {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Gateway config validation failed: ${field} — ${reason}`, RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR);
    this.name = 'GatewayValidationError';
    this.field = field;
    this.reason = reason;
  }
}

export class GatewayConnectionError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.GATEWAY_CONNECTION_ERROR);
    this.name = 'GatewayConnectionError';
  }
}

export class GatewayStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.GATEWAY_STATE_ERROR);
    this.name = 'GatewayStateError';
  }
}

export class GatewayLifecycleError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.GATEWAY_LIFECYCLE_ERROR);
    this.name = 'GatewayLifecycleError';
  }
}

export class WorkspaceValidationError extends RuntimeError {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(
      `Workspace validation failed: ${field} — ${reason}`,
      RuntimeErrorCodes.WORKSPACE_VALIDATION_ERROR,
    );
    this.name = 'WorkspaceValidationError';
    this.field = field;
    this.reason = reason;
  }
}
