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

export class SubAgentSpawnError extends RuntimeError {
  public readonly parentSessionId: string;

  constructor(parentSessionId: string, reason: string) {
    super(
      `Failed to spawn sub-agent for session "${parentSessionId}": ${reason}`,
      RuntimeErrorCodes.SUB_AGENT_SPAWN_ERROR,
    );
    this.name = 'SubAgentSpawnError';
    this.parentSessionId = parentSessionId;
  }
}

export class SubAgentTimeoutError extends RuntimeError {
  public readonly sessionId: string;
  public readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(
      `Sub-agent "${sessionId}" timed out after ${timeoutMs}ms`,
      RuntimeErrorCodes.SUB_AGENT_TIMEOUT,
    );
    this.name = 'SubAgentTimeoutError';
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}

export class SubAgentNotFoundError extends RuntimeError {
  public readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Sub-agent "${sessionId}" not found`,
      RuntimeErrorCodes.SUB_AGENT_NOT_FOUND,
    );
    this.name = 'SubAgentNotFoundError';
    this.sessionId = sessionId;
  }
}

export class GatewayAuthError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.REMOTE_AUTH_ERROR);
    this.name = 'GatewayAuthError';
  }
}
