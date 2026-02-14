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
  }
}

/**
 * Error thrown when an LLM provider rejects authentication.
 */
export class LLMAuthenticationError extends RuntimeError {
  public readonly providerName: string;
  public readonly statusCode: number;

  constructor(providerName: string, statusCode: number) {
    super(
      `${providerName} authentication failed (HTTP ${statusCode})`,
      RuntimeErrorCodes.LLM_PROVIDER_ERROR,
    );
    this.name = 'LLMAuthenticationError';
    this.providerName = providerName;
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when an LLM provider returns a 5xx response.
 */
export class LLMServerError extends RuntimeError {
  public readonly providerName: string;
  public readonly statusCode: number;

  constructor(providerName: string, statusCode: number, message: string) {
    super(
      `${providerName} server error (HTTP ${statusCode}): ${message}`,
      RuntimeErrorCodes.LLM_PROVIDER_ERROR,
    );
    this.name = 'LLMServerError';
    this.providerName = providerName;
    this.statusCode = statusCode;
  }
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  if (!headers) return undefined;

  let raw: string | undefined;
  if (typeof (headers as any).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get('retry-after');
    raw = value ?? undefined;
  } else if (typeof headers === 'object' && headers !== null) {
    const record = headers as Record<string, unknown>;
    const value = record['retry-after'] ?? record['Retry-After'];
    if (typeof value === 'string' || typeof value === 'number') {
      raw = String(value);
    }
  }

  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Map an unknown error from an LLM SDK call into a typed LLM error.
 *
 * Handles typed errors, auth/rate-limit/server status codes, timeout/abort
 * semantics, and generic provider errors.
 */
export function mapLLMError(
  providerName: string,
  err: unknown,
  timeoutMs: number,
): Error {
  if (
    err instanceof LLMProviderError ||
    err instanceof LLMRateLimitError ||
    err instanceof LLMTimeoutError ||
    err instanceof LLMAuthenticationError ||
    err instanceof LLMServerError
  ) {
    return err;
  }

  const e = err as any;
  const rawStatus = e?.status ?? e?.statusCode;
  const parsedStatus =
    typeof rawStatus === 'number'
      ? rawStatus
      : Number.parseInt(String(rawStatus ?? ''), 10);
  const status = Number.isFinite(parsedStatus) ? parsedStatus : undefined;
  const message = e?.message ?? String(err);

  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
    return new LLMTimeoutError(providerName, timeoutMs);
  }

  if (status === 401 || status === 403) {
    return new LLMAuthenticationError(providerName, status);
  }

  if (status === 429) {
    return new LLMRateLimitError(providerName, parseRetryAfterMs(e?.headers));
  }

  if (
    e?.code === 'ETIMEDOUT' ||
    e?.code === 'ECONNABORTED' ||
    /timeout/i.test(message)
  ) {
    return new LLMTimeoutError(providerName, timeoutMs);
  }

  if (status !== undefined && status >= 500) {
    return new LLMServerError(providerName, status, message);
  }

  return new LLMProviderError(providerName, message, status);
}
