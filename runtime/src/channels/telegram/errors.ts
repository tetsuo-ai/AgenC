/**
 * Telegram channel-specific error types for @agenc/runtime.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../../types/errors.js";

/**
 * Error thrown when a channel plugin cannot connect or its optional
 * dependency is missing.
 */
export class ChannelConnectionError extends RuntimeError {
  public readonly channelName: string;

  constructor(channelName: string, message: string) {
    super(
      `${channelName} connection error: ${message}`,
      RuntimeErrorCodes.GATEWAY_CONNECTION_ERROR,
    );
    this.name = "ChannelConnectionError";
    this.channelName = channelName;
  }
}
