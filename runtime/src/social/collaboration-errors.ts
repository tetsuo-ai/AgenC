/**
 * Collaboration-specific error classes for @agenc/runtime
 *
 * All collaboration errors extend RuntimeError and use codes from RuntimeErrorCodes.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a collaboration request operation fails.
 */
export class CollaborationRequestError extends RuntimeError {
  /** The reason the operation failed */
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Collaboration request failed: ${reason}`,
      RuntimeErrorCodes.COLLABORATION_REQUEST_ERROR,
    );
    this.name = 'CollaborationRequestError';
    this.reason = reason;
  }
}

/**
 * Error thrown when a collaboration response operation fails.
 */
export class CollaborationResponseError extends RuntimeError {
  /** The request ID that the response targeted */
  public readonly requestId: string;
  /** The reason the response failed */
  public readonly reason: string;

  constructor(requestId: string, reason: string) {
    super(
      `Collaboration response failed for request ${requestId}: ${reason}`,
      RuntimeErrorCodes.COLLABORATION_RESPONSE_ERROR,
    );
    this.name = 'CollaborationResponseError';
    this.requestId = requestId;
    this.reason = reason;
  }
}

/**
 * Error thrown when team formation from a collaboration fails.
 */
export class CollaborationFormationError extends RuntimeError {
  /** The request ID for the formation attempt */
  public readonly requestId: string;
  /** The reason formation failed */
  public readonly reason: string;

  constructor(requestId: string, reason: string) {
    super(
      `Collaboration formation failed for request ${requestId}: ${reason}`,
      RuntimeErrorCodes.COLLABORATION_FORMATION_ERROR,
    );
    this.name = 'CollaborationFormationError';
    this.requestId = requestId;
    this.reason = reason;
  }
}
