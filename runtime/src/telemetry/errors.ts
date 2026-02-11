/**
 * Telemetry error types.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown for telemetry-related failures (sink errors, etc.).
 */
export class TelemetryError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.TELEMETRY_ERROR);
    this.name = 'TelemetryError';
  }
}
