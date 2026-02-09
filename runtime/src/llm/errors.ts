/**
 * LLM-specific error types for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when an LLM provider returns an error response.
 */
export class LLMProviderError extends RuntimeError {
  public readonly providerName: string;
  public readonly statusCode?: number;

  constructor(providerName: string, message: string, statusCode?: number) {
    super(
      `${providerName} error: ${message}`,
      RuntimeErrorCodes.LLM_PROVIDER_ERROR,
    );
    this.name = 'LLMProviderError';
    this.providerName = providerName;
    this.statusCode = statusCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMProviderError);
    }
  }
}

/**
 * Error thrown when an LLM provider rate limits the request.
 */
export class LLMRateLimitError extends RuntimeError {
  public readonly providerName: string;
  public readonly retryAfterMs?: number;

  constructor(providerName: string, retryAfterMs?: number) {
    const msg = retryAfterMs
      ? `${providerName} rate limited, retry after ${retryAfterMs}ms`
      : `${providerName} rate limited`;
    super(msg, RuntimeErrorCodes.LLM_RATE_LIMIT);
    this.name = 'LLMRateLimitError';
    this.providerName = providerName;
    this.retryAfterMs = retryAfterMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMRateLimitError);
    }
  }
}

/**
 * Error thrown when converting an LLM response to the 4-bigint output format fails.
 */
export class LLMResponseConversionError extends RuntimeError {
  public readonly response: string;

  constructor(message: string, response: string) {
    super(`Response conversion failed: ${message}`, RuntimeErrorCodes.LLM_RESPONSE_CONVERSION);
    this.name = 'LLMResponseConversionError';
    this.response = response;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMResponseConversionError);
    }
  }
}

/**
 * Error thrown when an LLM tool call fails.
 */
export class LLMToolCallError extends RuntimeError {
  public readonly toolName: string;
  public readonly toolCallId: string;

  constructor(toolName: string, toolCallId: string, message: string) {
    super(
      `Tool call "${toolName}" (${toolCallId}) failed: ${message}`,
      RuntimeErrorCodes.LLM_TOOL_CALL_ERROR,
    );
    this.name = 'LLMToolCallError';
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMToolCallError);
    }
  }
}

/**
 * Error thrown when an LLM request times out.
 */
export class LLMTimeoutError extends RuntimeError {
  public readonly providerName: string;
  public readonly timeoutMs: number;

  constructor(providerName: string, timeoutMs: number) {
    super(
      `${providerName} request timed out after ${timeoutMs}ms`,
      RuntimeErrorCodes.LLM_TIMEOUT,
    );
    this.name = 'LLMTimeoutError';
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LLMTimeoutError);
    }
  }
}
