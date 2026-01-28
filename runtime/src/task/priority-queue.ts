/**
 * Generic priority queue backed by a binary max-heap.
 *
 * Items are ordered by score (highest first). Supports push, pop, peek,
 * re-scoring, capacity limits, and top-N retrieval for observability.
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Internal heap entry storing the item alongside its computed score.
 */
interface HeapEntry<T> {
  item: T;
  score: number;
}

// ============================================================================
// PriorityQueue
// ============================================================================

/**
 * A max-heap priority queue where items with higher scores are dequeued first.
 *
 * @typeParam T - The type of items stored in the queue
 *
 * @example
 * ```typescript
 * const pq = new PriorityQueue<string>();
 * pq.push('low', 1);
 * pq.push('high', 10);
 * pq.pop(); // 'high'
 * ```
 */
export class PriorityQueue<T> {
  private heap: HeapEntry<T>[] = [];
  private readonly capacity: number;

  /**
   * @param capacity - Maximum number of items. When exceeded, the lowest-scored
   *   item is dropped on push. Pass `Infinity` (default) for unbounded.
   */
  constructor(capacity: number = Infinity) {
    this.capacity = capacity;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Insert an item with a given priority score.
   *
   * If the queue is at capacity, the item is only inserted when its score
   * exceeds the current minimum. The lowest-scored item is evicted.
   *
   * Complexity: O(log n)
   */
  push(item: T, score: number): void {
    if (this.heap.length >= this.capacity) {
      // Find the minimum-scored entry and evict it if the new score is higher
      const minIdx = this.findMinIndex();
      if (score <= this.heap[minIdx].score) {
        return; // New item doesn't beat the weakest entry; drop it
      }
      // Replace the min entry with the new item, then fix heap
      this.heap[minIdx] = { item, score };
      // The replaced position might violate heap property in either direction
      this.siftUp(minIdx);
      this.siftDown(minIdx);
      return;
    }

    this.heap.push({ item, score });
    this.siftUp(this.heap.length - 1);
  }

  /**
   * Remove and return the highest-scored item, or `undefined` if empty.
   *
   * Complexity: O(log n)
   */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;

    const top = this.heap[0];

    if (this.heap.length === 1) {
      this.heap.length = 0;
      return top.item;
    }

    this.heap[0] = this.heap[this.heap.length - 1];
    this.heap.length--;
    this.siftDown(0);

    return top.item;
  }

  /**
   * Return the highest-scored item without removing it, or `undefined` if empty.
   *
   * Complexity: O(1)
   */
  peek(): T | undefined {
    return this.heap.length > 0 ? this.heap[0].item : undefined;
  }

  /**
   * Current number of items in the queue.
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Remove all items from the queue.
   */
  clear(): void {
    this.heap.length = 0;
  }

  /**
   * Return the top N items (highest-scored first) without modifying the queue.
   *
   * Useful for observability / status endpoints.
   *
   * @param n - Number of items to return (clamped to queue size)
   * @returns Array of `{ item, score }` ordered by descending score
   */
  getTopN(n: number): Array<{ item: T; score: number }> {
    // Copy and sort — acceptable for observability calls that are infrequent
    const sorted = [...this.heap].sort((a, b) => b.score - a.score);
    return sorted.slice(0, n).map((e) => ({ item: e.item, score: e.score }));
  }

  /**
   * Re-score every item in the queue using the provided scoring function
   * and rebuild the heap. Use this for periodic urgency recalculation
   * (e.g. deadline-based tasks becoming more urgent over time).
   *
   * Complexity: O(n) for rescoring + O(n) for heapify = O(n)
   *
   * @param scorer - Function that computes a new score for each item
   */
  rescore(scorer: (item: T) => number): void {
    for (let i = 0; i < this.heap.length; i++) {
      this.heap[i].score = scorer(this.heap[i].item);
    }
    this.heapify();
  }

  /**
   * Return all scores in the queue (unordered). Useful for metrics/logging.
   */
  getScores(): number[] {
    return this.heap.map((e) => e.score);
  }

  // --------------------------------------------------------------------------
  // Heap internals
  // --------------------------------------------------------------------------

  /**
   * Build a valid max-heap from an arbitrary array (Floyd's algorithm).
   * Complexity: O(n)
   */
  private heapify(): void {
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[index].score <= this.heap[parent].score) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < length && this.heap[left].score > this.heap[largest].score) {
        largest = left;
      }
      if (right < length && this.heap[right].score > this.heap[largest].score) {
        largest = right;
      }

      if (largest === index) break;
      this.swap(index, largest);
      index = largest;
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = tmp;
  }

  /**
   * Find the index of the minimum-scored entry. In a max-heap the minimum
   * is guaranteed to be a leaf node (second half of the array).
   */
  private findMinIndex(): number {
    const start = Math.floor(this.heap.length / 2);
    let minIdx = start;
    for (let i = start + 1; i < this.heap.length; i++) {
      if (this.heap[i].score < this.heap[minIdx].score) {
        minIdx = i;
      }
    }
    return minIdx;
  }
}
