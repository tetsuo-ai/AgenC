/**
 * Tool-specific error types for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a tool cannot be found by name.
 */
export class ToolNotFoundError extends RuntimeError {
  /** The name of the tool that was not found */
  public readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool not found: "${toolName}"`, RuntimeErrorCodes.VALIDATION_ERROR);
    this.name = 'ToolNotFoundError';
    this.toolName = toolName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ToolNotFoundError);
    }
  }
}

/**
 * Error thrown when a tool with the same name is already registered.
 */
export class ToolAlreadyRegisteredError extends RuntimeError {
  /** The name of the duplicate tool */
  public readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is already registered`,
      RuntimeErrorCodes.VALIDATION_ERROR,
    );
    this.name = 'ToolAlreadyRegisteredError';
    this.toolName = toolName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ToolAlreadyRegisteredError);
    }
  }
}

/**
 * Error thrown when tool execution fails.
 */
export class ToolExecutionError extends RuntimeError {
  /** The name of the tool that failed */
  public readonly toolName: string;
  /** The cause of the failure */
  public readonly cause: string;

  constructor(toolName: string, cause: string) {
    super(
      `Tool "${toolName}" execution failed: ${cause}`,
      RuntimeErrorCodes.LLM_TOOL_CALL_ERROR,
    );
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ToolExecutionError);
    }
  }
}
