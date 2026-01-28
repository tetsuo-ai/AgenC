/**
 * Estimates proof generation time based on historical data
 */
export class ProofTimeEstimator {
  private history: number[] = [];
  private maxHistory = 100;

  record(durationMs: number): void {
    this.history.push(durationMs);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  estimateP90(): number {
    if (this.history.length === 0) return 30000; // default 30s
    const sorted = [...this.history].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.9);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  getStats() {
    return {
      samples: this.history.length,
      p90: this.estimateP90(),
      min: this.history.length ? Math.min(...this.history) : 0,
      max: this.history.length ? Math.max(...this.history) : 0,
    };
  }
}
