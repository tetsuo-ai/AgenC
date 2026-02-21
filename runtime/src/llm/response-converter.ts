/**
 * Converts LLM text responses to the 4-bigint output format
 * required by the ZK proof system.
 *
 * Uses SHA-256 to hash the response, then splits the 32-byte digest
 * into 4 x 8-byte little-endian chunks, each converted to a bigint.
 * Values are 64-bit (max ~1.8e19), well within the BN254 field (~2^254).
 *
 * @module
 */

import { createHash } from "crypto";
import { proofHashToBigints } from "../utils/encoding.js";

/**
 * Convert an LLM text response to 4 bigints via SHA-256 hashing.
 *
 * Deterministic: same input always produces the same output.
 *
 * @param response - The text response from the LLM
 * @returns Array of exactly 4 bigints
 */
export function responseToOutput(response: string): bigint[] {
  const hash = createHash("sha256").update(response, "utf-8").digest();
  return proofHashToBigints(new Uint8Array(hash));
}
