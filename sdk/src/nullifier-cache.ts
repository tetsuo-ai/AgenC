/**
 * Session-scoped nullifier usage tracking with LRU eviction and
 * unconfirmed-entry timeout.
 *
 * Entries start as unconfirmed when `markUsed()` is called. They become
 * confirmed when `confirmUsed()` is called after a successful on-chain
 * transaction. Unconfirmed entries older than `timeoutMs` are treated as
 * unused by `isUsed()`, preventing stale entries from blocking retries
 * after network timeouts (TOCTOU fix).
 */

interface CacheEntry {
  markedAt: number;
  confirmed: boolean;
}

/** Default timeout for unconfirmed entries (2 minutes). */
const DEFAULT_UNCONFIRMED_TIMEOUT_MS = 120_000;

export class NullifierCache {
  private readonly used = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly timeoutMs: number;

  constructor(
    maxSize: number = 10_000,
    timeoutMs: number = DEFAULT_UNCONFIRMED_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error("maxSize must be a positive integer");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive number");
    }
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
  }

  private toKey(nullifier: Uint8Array | Buffer): string {
    return Buffer.from(nullifier).toString("hex");
  }

  isUsed(nullifier: Uint8Array | Buffer): boolean {
    const key = this.toKey(nullifier);
    const entry = this.used.get(key);
    if (!entry) return false;

    // Unconfirmed entries expire after timeoutMs
    if (!entry.confirmed && Date.now() - entry.markedAt > this.timeoutMs) {
      this.used.delete(key);
      return false;
    }

    // LRU promotion
    this.used.delete(key);
    this.used.set(key, entry);
    return true;
  }

  markUsed(nullifier: Uint8Array | Buffer): void {
    const key = this.toKey(nullifier);

    if (this.used.has(key)) {
      this.used.delete(key);
    }

    this.used.set(key, { markedAt: Date.now(), confirmed: false });

    if (this.used.size > this.maxSize) {
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) {
        this.used.delete(oldest);
      }
    }
  }

  /**
   * Confirm that a nullifier was successfully used on-chain.
   * Confirmed entries never expire from the timeout mechanism.
   */
  confirmUsed(nullifier: Uint8Array | Buffer): void {
    const key = this.toKey(nullifier);
    const entry = this.used.get(key);
    if (entry) {
      entry.confirmed = true;
    }
  }

  /**
   * Remove a nullifier from the cache (e.g., on transaction failure rollback).
   */
  remove(nullifier: Uint8Array | Buffer): void {
    const key = this.toKey(nullifier);
    this.used.delete(key);
  }

  clear(): void {
    this.used.clear();
  }

  get size(): number {
    return this.used.size;
  }
}
