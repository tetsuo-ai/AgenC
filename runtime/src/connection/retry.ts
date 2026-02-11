/**
 * Pure retry / error classification utilities for ConnectionManager.
 *
 * @module
 */

import type { RetryConfig } from './types.js';
import { bigintReplacer } from '../tools/types.js';

// ============================================================================
// Error classification
// ============================================================================

/** Non-retryable error patterns — checked FIRST and take priority. */
const NON_RETRYABLE_PATTERNS: readonly string[] = [
  'Account does not exist',
  'could not find',
  'custom program error',
  'insufficient funds',
  'Signature verification',
  'Transaction simulation failed',
];

/** Retryable error patterns — transient network / server issues. */
const RETRYABLE_PATTERNS: readonly string[] = [
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'socket hang up',
  'blockhash not found',
  'Node is behind',
  'node is unhealthy',
  'Too Many Requests',
];

/** HTTP status codes that are retryable. */
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/** Connection-level errors that indicate the endpoint is unreachable (used for write failover). */
const CONNECTION_LEVEL_PATTERNS: readonly string[] = [
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'socket hang up',
];

const CONNECTION_LEVEL_HTTP_STATUSES = new Set([502, 503, 504]);

/**
 * Extract HTTP status from an error, if present.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as Record<string, unknown>;

  // Fetch-style: error.status
  if (typeof err.status === 'number') return err.status;

  // Solana web3.js wraps HTTP errors in response
  if (typeof err.statusCode === 'number') return err.statusCode;

  // Nested response object
  if (err.response && typeof err.response === 'object') {
    const res = err.response as Record<string, unknown>;
    if (typeof res.status === 'number') return res.status;
    if (typeof res.statusCode === 'number') return res.statusCode;
  }

  return undefined;
}

/**
 * Get the error message string from an unknown error value.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function matchesPatterns(msg: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (msg.includes(p)) return true;
  }
  return false;
}

/**
 * Classify whether an error is retryable.
 *
 * Non-retryable patterns are checked first and take priority.
 */
export function isRetryableError(error: unknown): boolean {
  const msg = getErrorMessage(error);

  // Non-retryable takes priority
  if (matchesPatterns(msg, NON_RETRYABLE_PATTERNS)) return false;

  // Check HTTP status
  const status = extractHttpStatus(error);
  if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) return true;

  // Check message patterns
  return matchesPatterns(msg, RETRYABLE_PATTERNS);
}

/**
 * Classify whether an error indicates the endpoint itself is unreachable.
 *
 * Used to decide whether to failover on write operations (no retry, just failover).
 */
export function isConnectionLevelError(error: unknown): boolean {
  const msg = getErrorMessage(error);

  const status = extractHttpStatus(error);
  if (status !== undefined && CONNECTION_LEVEL_HTTP_STATUSES.has(status)) return true;

  return matchesPatterns(msg, CONNECTION_LEVEL_PATTERNS);
}

// ============================================================================
// Write method detection
// ============================================================================

const WRITE_METHODS = new Set(['sendTransaction', 'sendEncodedTransaction']);

/**
 * Check if an RPC method name is a write operation.
 */
export function isWriteMethod(methodName: string): boolean {
  return WRITE_METHODS.has(methodName);
}

// ============================================================================
// Backoff computation
// ============================================================================

/**
 * Compute exponential backoff delay with random jitter.
 *
 * Formula: `min(baseDelay * 2^attempt, maxDelay) * (1 + random * jitter)`
 */
export function computeBackoff(attempt: number, config: RetryConfig): number {
  const base = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
  const jitter = 1 + Math.random() * config.jitterFactor;
  return Math.round(base * jitter);
}

// ============================================================================
// Coalesce key derivation
// ============================================================================

/**
 * Derive a deterministic cache key for request coalescing.
 *
 * Normalizes Buffer/Uint8Array to hex strings and handles BigInt via bigintReplacer.
 */
export function deriveCoalesceKey(methodName: string, args: unknown[]): string {
  return methodName + ':' + JSON.stringify(args, coalesceReplacer);
}

function coalesceReplacer(key: string, value: unknown): unknown {
  // Buffer / Uint8Array → hex
  if (value instanceof Uint8Array) {
    return 'hex:' + bufferToHex(value);
  }
  // Buffer.toJSON returns { type: 'Buffer', data: number[] } — catch that
  if (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    (value as Record<string, unknown>).type === 'Buffer' &&
    'data' in value &&
    Array.isArray((value as Record<string, unknown>).data)
  ) {
    return 'hex:' + bufferToHex(new Uint8Array((value as { data: number[] }).data));
  }
  // BigInt
  return bigintReplacer(key, value);
}

function bufferToHex(buf: Uint8Array): string {
  let hex = '';
  for (const b of buf) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
