/**
 * Shared PDA normalization helpers for replay record construction.
 *
 * Used by backfill, bridge, and CLI replay summary to consistently
 * extract and normalize dispute PDAs from event payloads.
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "../utils/encoding.js";

/**
 * Try to convert a byte array to a base58 public key string.
 * Returns base58 for valid 32-byte keys, hex for other lengths.
 */
function bytesToPdaString(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  if (bytes.length === 32) {
    try {
      return new PublicKey(bytes).toBase58();
    } catch {
      return bytesToHex(bytes);
    }
  }
  return bytesToHex(bytes);
}

/**
 * Normalize a raw PDA value to a string identifier.
 *
 * Accepts:
 * - base58 strings (passed through)
 * - 32-byte hex strings with or without `0x` prefix (converted to base58)
 * - number arrays or Uint8Arrays (32-byte → base58, other lengths → hex)
 */
export function normalizePdaValue(value: unknown): string | undefined {
  if (value instanceof Uint8Array) {
    return bytesToPdaString(value);
  }

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "number" && v >= 0 && v <= 255)
  ) {
    return bytesToPdaString(new Uint8Array(value));
  }

  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  // Match 64 hex chars (32 bytes) with optional 0x prefix.
  // "0x" + 64 hex = 66 char input → hexToBytes strips prefix → 32 bytes.
  // Bare 64 hex = 64 char input → hexToBytes parses directly → 32 bytes.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    try {
      const bytes = hexToBytes(value);
      if (bytes.length === 32) {
        return new PublicKey(bytes).toBase58();
      }
    } catch {
      // ignore hex parse errors and fall through to returning the raw string
    }
  }

  return value;
}

/**
 * @deprecated Use {@link normalizePdaValue} which also handles byte arrays.
 */
export const normalizePdaString = normalizePdaValue;

/**
 * Extract a dispute PDA from an event payload.
 *
 * Checks `payload.disputeId` first, then falls back to
 * `payload.onchain.disputeId` for nested event data.
 */
export function extractDisputePdaFromPayload(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const direct = normalizePdaValue(payload.disputeId);
  if (direct) {
    return direct;
  }

  const onchain = payload.onchain;
  if (typeof onchain === "object" && onchain !== null) {
    const nested = normalizePdaValue(
      (onchain as Record<string, unknown>).disputeId,
    );
    if (nested) {
      return nested;
    }
  }

  return undefined;
}
