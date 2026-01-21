/**
 * Encoding utilities for @agenc/runtime
 * Cross-platform utilities for ID generation, hex/byte conversion,
 * agent ID helpers, and SOL/lamports conversion.
 * @module
 */

/**
 * Generate a random 32-byte agent ID
 * Works in both Node.js and browser environments
 * @returns A random 32-byte Uint8Array
 * @example
 * ```typescript
 * const agentId = generateAgentId();
 * console.log(agentId.length); // 32
 * ```
 */
export function generateAgentId(): Uint8Array {
  const bytes = new Uint8Array(32);

  // Use Web Crypto API (works in browser and Node.js 19+)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  // Fallback for older Node.js versions
  try {
    // Dynamic import to avoid bundler issues in browser
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('crypto');
    return new Uint8Array(randomBytes(32));
  } catch {
    throw new Error(
      'No secure random number generator available. ' +
        'Use a modern browser or Node.js 19+.',
    );
  }
}

/**
 * Convert a hex string to Uint8Array
 * @param hex - Hex string (with or without 0x prefix)
 * @returns Byte array representation
 * @throws Error if hex string has invalid length (odd number of characters)
 * @throws Error if hex string contains invalid characters
 * @example
 * ```typescript
 * hexToBytes('0102030405'); // Uint8Array([1, 2, 3, 4, 5])
 * hexToBytes('0x0102030405'); // Uint8Array([1, 2, 3, 4, 5])
 * ```
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  if (cleanHex.length > 0 && !/^[0-9a-fA-F]+$/.test(cleanHex)) {
    throw new Error('Invalid hex string: contains non-hexadecimal characters');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 * @param bytes - Byte array to convert
 * @param prefix - Whether to include 0x prefix (default: false)
 * @returns Hex string representation
 * @example
 * ```typescript
 * bytesToHex(new Uint8Array([1, 2, 3])); // '010203'
 * bytesToHex(new Uint8Array([1, 2, 3]), true); // '0x010203'
 * ```
 */
export function bytesToHex(bytes: Uint8Array, prefix = false): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `0x${hex}` : hex;
}

/**
 * Convert a string to a 32-byte agent ID
 * Uses UTF-8 encoding, padded with zeros if short (≤32 bytes),
 * or hashed if long (>32 bytes) to avoid collisions.
 * @param str - String to convert
 * @returns 32-byte Uint8Array
 * @example
 * ```typescript
 * const id = agentIdFromString('my-agent');
 * console.log(id.length); // 32
 * ```
 */
export function agentIdFromString(str: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);

  if (encoded.length <= 32) {
    // Pad with zeros
    const result = new Uint8Array(32);
    result.set(encoded);
    return result;
  }

  // For longer strings, use SHA-256 hash (Node.js) or FNV-1a mixing (browser)
  // Try Node's crypto.createHash (sync)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(encoded).digest();
    return new Uint8Array(hash);
  } catch {
    // Fallback: FNV-1a style mixing algorithm for browser environments
    // This avoids the collision issues of simple XOR-folding
    const result = new Uint8Array(32);
    let h1 = 0x811c9dc5; // FNV offset basis
    let h2 = 0x1000193; // Secondary state

    for (let i = 0; i < encoded.length; i++) {
      // Mix byte into both state variables
      h1 ^= encoded[i];
      h1 = Math.imul(h1, 0x01000193); // FNV prime
      h2 ^= encoded[i];
      h2 = Math.imul(h2, 0x85ebca6b); // Different prime

      // Distribute state across result bytes
      const pos = i % 32;
      result[pos] ^= (h1 >>> 24) & 0xff;
      result[(pos + 8) % 32] ^= (h1 >>> 16) & 0xff;
      result[(pos + 16) % 32] ^= (h2 >>> 8) & 0xff;
      result[(pos + 24) % 32] ^= h2 & 0xff;
    }

    // Final mixing pass to ensure all bytes are influenced
    for (let i = 0; i < 32; i++) {
      h1 = Math.imul(h1 ^ result[i], 0x01000193);
      result[i] ^= (h1 >>> (i % 24)) & 0xff;
    }

    return result;
  }
}

/**
 * Convert agent ID to a readable string (hex format)
 * @param agentId - 32-byte agent ID
 * @returns Full hex representation of the agent ID
 * @example
 * ```typescript
 * const id = new Uint8Array(32).fill(0xab);
 * agentIdToString(id); // 'abababab...' (64 hex chars)
 * ```
 */
export function agentIdToString(agentId: Uint8Array): string {
  return bytesToHex(agentId);
}

/**
 * Convert agent ID to shortened display format
 * @param agentId - 32-byte agent ID
 * @param chars - Number of characters to show on each side (default: 6, max: 32)
 * @returns Shortened hex string with ellipsis
 * @example
 * ```typescript
 * agentIdToShortString(agentId); // 'abc123...def456'
 * agentIdToShortString(agentId, 4); // 'abcd...efgh'
 * ```
 */
export function agentIdToShortString(agentId: Uint8Array, chars = 6): string {
  const hex = bytesToHex(agentId);
  // Clamp chars to valid range: at least 1, at most half the hex length
  const maxChars = Math.floor(hex.length / 2);
  const safeChars = Math.max(1, Math.min(chars, maxChars));
  return `${hex.slice(0, safeChars)}...${hex.slice(-safeChars)}`;
}

/**
 * Compare two agent IDs for equality using constant-time comparison
 * This prevents timing side-channel attacks when comparing sensitive IDs.
 * @param a - First agent ID
 * @param b - Second agent ID
 * @returns true if the IDs are equal, false otherwise
 * @example
 * ```typescript
 * const id1 = new Uint8Array(32).fill(1);
 * const id2 = new Uint8Array(32).fill(1);
 * agentIdsEqual(id1, id2); // true
 * ```
 */
export function agentIdsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  // Constant-time comparison: always compare all bytes regardless of differences
  // This prevents timing attacks that could leak information about the ID
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Convert lamports to SOL with formatting
 * Removes trailing zeros for clean display
 * @param lamports - Amount in lamports (bigint)
 * @returns Formatted SOL amount as string
 * @example
 * ```typescript
 * lamportsToSol(1_000_000_000n); // '1'
 * lamportsToSol(1_500_000_000n); // '1.5'
 * lamportsToSol(100_000n); // '0.0001'
 * ```
 */
export function lamportsToSol(lamports: bigint): string {
  const sol = Number(lamports) / 1e9;
  return sol.toFixed(9).replace(/\.?0+$/, '');
}

/**
 * Convert SOL to lamports
 * @param sol - Amount in SOL (number or string), must be non-negative
 * @returns Amount in lamports as bigint
 * @throws Error if input is not a valid non-negative number
 * @example
 * ```typescript
 * solToLamports(1.5); // 1_500_000_000n
 * solToLamports('1.5'); // 1_500_000_000n
 * solToLamports(0.0001); // 100_000n
 * ```
 */
export function solToLamports(sol: number | string): bigint {
  const solNum = typeof sol === 'string' ? parseFloat(sol) : sol;
  if (!Number.isFinite(solNum) || solNum < 0) {
    throw new Error('Invalid SOL amount: must be a non-negative finite number');
  }
  return BigInt(Math.round(solNum * 1e9));
}
