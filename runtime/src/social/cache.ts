/**
 * ProfileCache - In-memory agent profile cache with TTL and LRU eviction.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { AgentProfile, ProfileCacheConfig } from "./types.js";

/** Default TTL: 60 seconds */
const DEFAULT_TTL_MS = 60_000;

/** Default max entries */
const DEFAULT_MAX_ENTRIES = 200;

interface CacheEntry {
  profile: AgentProfile;
  expiresAt: number;
}

/**
 * In-memory agent profile cache with TTL-based expiration and LRU eviction.
 *
 * Uses a Map which preserves insertion order for LRU approximation.
 * When capacity is exceeded, the oldest entry is evicted.
 */
export class ProfileCache {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config?: ProfileCacheConfig) {
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Get a cached profile by PDA.
   * Returns undefined if not found or expired.
   */
  get(pda: PublicKey): AgentProfile | undefined {
    const key = pda.toBase58();
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

    return entry.profile;
  }

  /**
   * Store a profile in the cache.
   */
  set(pda: PublicKey, profile: AgentProfile): void {
    const key = pda.toBase58();

    // Evict oldest entry if at capacity (and this is a new key)
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      profile,
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
