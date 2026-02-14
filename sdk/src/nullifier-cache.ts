/**
 * Session-scoped nullifier usage tracking with LRU eviction.
 */
export class NullifierCache {
  private readonly used = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize: number = 10_000) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error('maxSize must be a positive integer');
    }
    this.maxSize = maxSize;
  }

  private toKey(nullifier: Uint8Array | Buffer): string {
    return Buffer.from(nullifier).toString('hex');
  }

  isUsed(nullifier: Uint8Array | Buffer): boolean {
    const key = this.toKey(nullifier);
    const exists = this.used.has(key);
    if (!exists) return false;

    this.used.delete(key);
    this.used.set(key, true);
    return true;
  }

  markUsed(nullifier: Uint8Array | Buffer): void {
    const key = this.toKey(nullifier);

    if (this.used.has(key)) {
      this.used.delete(key);
    }

    this.used.set(key, true);

    if (this.used.size > this.maxSize) {
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) {
        this.used.delete(oldest);
      }
    }
  }

  clear(): void {
    this.used.clear();
  }

  get size(): number {
    return this.used.size;
  }
}
