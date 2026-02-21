/**
 * ProofCache - In-memory proof cache with TTL and LRU eviction.
 *
 * @module
 */

import { createHash } from "crypto";
import type {
  EngineProofResult,
  ProofCacheConfig,
  ProofInputs,
} from "./types.js";

/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 300_000;

/** Default max entries */
const DEFAULT_MAX_ENTRIES = 100;

interface CacheEntry {
  result: EngineProofResult;
  expiresAt: number;
}

/**
 * Derive a deterministic cache key from proof inputs.
 *
 * SECURITY: Uses SHA-256 hash of inputs instead of plaintext concatenation
 * to avoid leaking secret output values and salt in memory-inspectable strings.
 */
export function deriveCacheKey(inputs: ProofInputs): string {
  const hasher = createHash("sha256");
  hasher.update(inputs.taskPda.toBytes());
  hasher.update(inputs.agentPubkey.toBytes());
  for (const o of inputs.output) {
    hasher.update(o.toString());
  }
  hasher.update(inputs.salt.toString());
  return hasher.digest("hex");
}

/**
 * In-memory proof cache with TTL-based expiration and LRU eviction.
 *
 * Uses a Map which preserves insertion order for LRU approximation.
 * When capacity is exceeded, the oldest entry is evicted.
 */
export class ProofCache {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config?: ProofCacheConfig) {
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Get a cached proof result by inputs.
   * Returns undefined if not found or expired.
   */
  get(inputs: ProofInputs): EngineProofResult | undefined {
    const key = deriveCacheKey(inputs);
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check TTL expiry
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end for LRU (delete + re-set preserves insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  /**
   * Store a proof result in the cache.
   */
  set(inputs: ProofInputs, result: EngineProofResult): void {
    const key = deriveCacheKey(inputs);

    // Evict oldest entry if at capacity (and this is a new key)
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current number of cached entries (including expired).
   */
  get size(): number {
    return this.cache.size;
  }
}
