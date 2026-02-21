/**
 * Shared query helpers for memcmp-filtered operations.
 * @module
 */

import { utils } from "@coral-xyz/anchor";
import type { Logger } from "./logger.js";

/**
 * Encode a single status byte as base58 for memcmp filter.
 *
 * @param status - Status byte value (0-255)
 * @returns Base58-encoded string
 */
export function encodeStatusByte(status: number): string {
  return utils.bytes.bs58.encode(Buffer.from([status]));
}

/**
 * Execute a memcmp-filtered query with fallback to full-scan + client filter.
 *
 * @param query - Primary memcmp-filtered query function
 * @param fallback - Fallback function (full scan + client-side filter)
 * @param logger - Logger instance for warnings
 * @param label - Label for warning message (e.g. "fetchClaimableTasks")
 * @returns Query result of type T
 */
export async function queryWithFallback<T>(
  query: () => Promise<T>,
  fallback: () => Promise<T>,
  logger: Logger,
  label: string,
): Promise<T> {
  try {
    return await query();
  } catch (err) {
    logger.warn(
      `${label} memcmp-filtered fetch failed, falling back to full scan: ${err}`,
    );
    return fallback();
  }
}
