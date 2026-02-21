/**
 * Discovery-specific error classes for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when an agent discovery query fails.
 */
export class AgentDiscoveryError extends RuntimeError {
  /** The reason the discovery query failed */
  public readonly reason: string;

  constructor(reason: string) {
    super(
      `Agent discovery failed: ${reason}`,
      RuntimeErrorCodes.DISCOVERY_ERROR,
    );
    this.name = "AgentDiscoveryError";
    this.reason = reason;
  }
}
