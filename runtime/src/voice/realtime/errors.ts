/**
 * Error types for the xAI Realtime Voice client.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../../types/errors.js';

/**
 * Error thrown when a realtime voice session operation fails.
 */
export class VoiceRealtimeError extends RuntimeError {
  /** Optional xAI error type (e.g. 'invalid_request_error', 'server_error'). */
  public readonly xaiType?: string;
  /** Optional xAI error code from the server. */
  public readonly xaiCode?: string;

  constructor(message: string, xaiType?: string, xaiCode?: string) {
    super(message, RuntimeErrorCodes.VOICE_REALTIME_ERROR);
    this.name = 'VoiceRealtimeError';
    this.xaiType = xaiType;
    this.xaiCode = xaiCode;
  }
}
