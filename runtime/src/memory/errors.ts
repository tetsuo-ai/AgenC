/**
 * Memory-specific error types for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a memory backend operation fails.
 */
export class MemoryBackendError extends RuntimeError {
  public readonly backendName: string;

  constructor(backendName: string, message: string) {
    super(
      `${backendName} error: ${message}`,
      RuntimeErrorCodes.MEMORY_BACKEND_ERROR,
    );
    this.name = 'MemoryBackendError';
    this.backendName = backendName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MemoryBackendError);
    }
  }
}

/**
 * Error thrown when a memory backend cannot connect or its optional dependency is missing.
 */
export class MemoryConnectionError extends RuntimeError {
  public readonly backendName: string;

  constructor(backendName: string, message: string) {
    super(
      `${backendName} connection error: ${message}`,
      RuntimeErrorCodes.MEMORY_CONNECTION_ERROR,
    );
    this.name = 'MemoryConnectionError';
    this.backendName = backendName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MemoryConnectionError);
    }
  }
}

/**
 * Error thrown when serialization or deserialization of memory data fails.
 */
export class MemorySerializationError extends RuntimeError {
  public readonly backendName: string;

  constructor(backendName: string, message: string) {
    super(
      `${backendName} serialization error: ${message}`,
      RuntimeErrorCodes.MEMORY_SERIALIZATION_ERROR,
    );
    this.name = 'MemorySerializationError';
    this.backendName = backendName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MemorySerializationError);
    }
  }
}
