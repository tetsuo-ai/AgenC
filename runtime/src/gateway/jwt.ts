/**
 * Minimal HS256 JWT implementation using Node.js crypto.
 *
 * No external dependencies — uses `crypto.createHmac('sha256', secret)`.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JWTPayload } from './remote-types.js';

// ============================================================================
// Base64url helpers
// ============================================================================

function base64urlEncode(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  // Restore standard base64 chars
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  const padLen = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLen);
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// ============================================================================
// HMAC-SHA256 signing
// ============================================================================

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(input)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ============================================================================
// Public API
// ============================================================================

const DEFAULT_EXPIRY_SECONDS = 3600;
const MIN_SECRET_LENGTH = 32;

/**
 * Create an HS256 JWT token.
 *
 * @param secret - HMAC shared secret
 * @param subject - Token subject (e.g. agent ID)
 * @param expirySeconds - Token lifetime in seconds (default: 3600)
 * @returns Encoded JWT string
 */
export function createToken(
  secret: string,
  subject: string,
  expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64urlEncode(
    JSON.stringify({
      sub: subject,
      iat: now,
      exp: now + expirySeconds,
    }),
  );

  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify an HS256 JWT token.
 *
 * @param secret - HMAC shared secret
 * @param token - JWT string to verify
 * @returns Decoded payload if valid and not expired, `null` otherwise
 */
export function verifyToken(secret: string, token: string): JWTPayload | null {
  if (secret.length < MIN_SECRET_LENGTH) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  // Verify signature with constant-time comparison to prevent timing attacks
  const expected = sign(`${header}.${payload}`, secret);
  if (signature.length !== expected.length) return null;
  const sigBuf = Buffer.from(signature, 'utf-8');
  const expBuf = Buffer.from(expected, 'utf-8');
  if (!timingSafeEqual(sigBuf, expBuf)) return null;

  // Decode and parse payload
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64urlDecode(payload));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded !== 'object') return null;

  const jwt = decoded as Record<string, unknown>;
  if (typeof jwt.sub !== 'string') return null;
  if (typeof jwt.iat !== 'number') return null;
  if (typeof jwt.exp !== 'number') return null;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (jwt.exp <= now) return null;

  return {
    sub: jwt.sub,
    iat: jwt.iat,
    exp: jwt.exp,
    scope: typeof jwt.scope === 'string' ? jwt.scope : undefined,
  };
}
