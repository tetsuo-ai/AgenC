import { describe, it, expect } from 'vitest';
import { PriorityQueue } from './priority-queue.js';

// ============================================================================
// PriorityQueue Tests
// ============================================================================

describe('PriorityQueue', () => {
  // --------------------------------------------------------------------------
  // Basic operations
  // --------------------------------------------------------------------------

  describe('push and pop', () => {
    it('pops items in descending score order', () => {
      const pq = new PriorityQueue<string>();
      pq.push('low', 1);
      pq.push('high', 10);
      pq.push('mid', 5);

      expect(pq.pop()).toBe('high');
      expect(pq.pop()).toBe('mid');
      expect(pq.pop()).toBe('low');
    });

    it('returns undefined when popping an empty queue', () => {
      const pq = new PriorityQueue<number>();
      expect(pq.pop()).toBeUndefined();
    });

    it('handles single element', () => {
      const pq = new PriorityQueue<string>();
      pq.push('only', 42);
      expect(pq.pop()).toBe('only');
      expect(pq.pop()).toBeUndefined();
    });

    it('handles duplicate scores', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 5);
      pq.push('b', 5);
      pq.push('c', 5);

      const results = [pq.pop(), pq.pop(), pq.pop()];
      expect(results).toHaveLength(3);
      expect(results.sort()).toEqual(['a', 'b', 'c']);
    });

    it('handles many items correctly', () => {
      const pq = new PriorityQueue<number>();
      const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
      for (const v of values) {
        pq.push(v, v);
      }

      const popped: number[] = [];
      while (pq.size > 0) {
        popped.push(pq.pop()!);
      }

      // Should come out in descending order
      for (let i = 1; i < popped.length; i++) {
        expect(popped[i]).toBeLessThanOrEqual(popped[i - 1]);
      }
      expect(popped.length).toBe(values.length);
    });
  });

  // --------------------------------------------------------------------------
  // peek
  // --------------------------------------------------------------------------

  describe('peek', () => {
    it('returns the highest-scored item without removing it', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 1);
      pq.push('b', 10);

      expect(pq.peek()).toBe('b');
      expect(pq.size).toBe(2);
    });

    it('returns undefined for an empty queue', () => {
      const pq = new PriorityQueue<string>();
      expect(pq.peek()).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // size
  // --------------------------------------------------------------------------

  describe('size', () => {
    it('returns 0 for new queue', () => {
      const pq = new PriorityQueue<string>();
      expect(pq.size).toBe(0);
    });

    it('tracks push and pop', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 1);
      pq.push('b', 2);
      expect(pq.size).toBe(2);

      pq.pop();
      expect(pq.size).toBe(1);

      pq.pop();
      expect(pq.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // clear
  // --------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all items', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 1);
      pq.push('b', 2);

      pq.clear();
      expect(pq.size).toBe(0);
      expect(pq.pop()).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getTopN
  // --------------------------------------------------------------------------

  describe('getTopN', () => {
    it('returns top N items sorted by descending score', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 1);
      pq.push('b', 10);
      pq.push('c', 5);
      pq.push('d', 7);

      const top2 = pq.getTopN(2);
      expect(top2).toEqual([
        { item: 'b', score: 10 },
        { item: 'd', score: 7 },
      ]);
    });

    it('returns all items if n exceeds size', () => {
      const pq = new PriorityQueue<string>();
      pq.push('x', 3);
      pq.push('y', 1);

      const result = pq.getTopN(100);
      expect(result).toHaveLength(2);
      expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
    });

    it('returns empty array for empty queue', () => {
      const pq = new PriorityQueue<string>();
      expect(pq.getTopN(5)).toEqual([]);
    });

    it('does not modify the queue', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 1);
      pq.push('b', 2);

      pq.getTopN(1);
      expect(pq.size).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // rescore
  // --------------------------------------------------------------------------

  describe('rescore', () => {
    it('reorders items based on new scores', () => {
      const pq = new PriorityQueue<{ name: string; urgency: number }>();
      pq.push({ name: 'low-urgency', urgency: 1 }, 1);
      pq.push({ name: 'high-urgency', urgency: 100 }, 100);

      // Reverse urgency: low becomes high
      pq.rescore((item) => 1 / item.urgency);

      const top = pq.pop()!;
      expect(top.name).toBe('low-urgency');
    });

    it('handles empty queue gracefully', () => {
      const pq = new PriorityQueue<string>();
      pq.rescore(() => 0); // should not throw
      expect(pq.size).toBe(0);
    });

    it('maintains correct ordering after rescore', () => {
      const pq = new PriorityQueue<number>();
      pq.push(10, 10);
      pq.push(20, 20);
      pq.push(30, 30);
      pq.push(40, 40);
      pq.push(50, 50);

      // Invert scores
      pq.rescore((item) => -item);

      const popped: number[] = [];
      while (pq.size > 0) {
        popped.push(pq.pop()!);
      }
      // After inverting, 10 has highest score (-10 > -20 > ...)
      expect(popped).toEqual([10, 20, 30, 40, 50]);
    });
  });

  // --------------------------------------------------------------------------
  // Capacity
  // --------------------------------------------------------------------------

  describe('capacity', () => {
    it('evicts lowest-scored item when at capacity', () => {
      const pq = new PriorityQueue<string>(3);
      pq.push('a', 1);
      pq.push('b', 2);
      pq.push('c', 3);

      // At capacity — push item with higher score than min (1)
      pq.push('d', 10);
      expect(pq.size).toBe(3);

      const items: string[] = [];
      while (pq.size > 0) {
        items.push(pq.pop()!);
      }
      // 'a' (score=1) should have been evicted
      expect(items).not.toContain('a');
      expect(items).toContain('d');
    });

    it('drops new item if its score does not exceed min', () => {
      const pq = new PriorityQueue<string>(2);
      pq.push('a', 5);
      pq.push('b', 10);

      pq.push('c', 3); // score 3 <= min(5), should be dropped
      expect(pq.size).toBe(2);

      const items: string[] = [];
      while (pq.size > 0) {
        items.push(pq.pop()!);
      }
      expect(items).toEqual(['b', 'a']);
    });

    it('allows unbounded queue by default', () => {
      const pq = new PriorityQueue<number>();
      for (let i = 0; i < 1000; i++) {
        pq.push(i, i);
      }
      expect(pq.size).toBe(1000);
    });
  });

  // --------------------------------------------------------------------------
  // getScores
  // --------------------------------------------------------------------------

  describe('getScores', () => {
    it('returns all scores', () => {
      const pq = new PriorityQueue<string>();
      pq.push('a', 5);
      pq.push('b', 10);
      pq.push('c', 1);

      const scores = pq.getScores();
      expect(scores.sort((a, b) => a - b)).toEqual([1, 5, 10]);
    });

    it('returns empty array for empty queue', () => {
      const pq = new PriorityQueue<string>();
      expect(pq.getScores()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles negative scores', () => {
      const pq = new PriorityQueue<string>();
      pq.push('neg', -10);
      pq.push('more-neg', -20);
      pq.push('zero', 0);

      expect(pq.pop()).toBe('zero');
      expect(pq.pop()).toBe('neg');
      expect(pq.pop()).toBe('more-neg');
    });

    it('handles interleaved push and pop', () => {
      const pq = new PriorityQueue<number>();
      pq.push(1, 1);
      pq.push(5, 5);
      expect(pq.pop()).toBe(5);

      pq.push(3, 3);
      pq.push(10, 10);
      expect(pq.pop()).toBe(10);
      expect(pq.pop()).toBe(3);
      expect(pq.pop()).toBe(1);
    });

    it('push after clear works correctly', () => {
      const pq = new PriorityQueue<string>();
      pq.push('old', 1);
      pq.clear();
      pq.push('new', 2);
      expect(pq.pop()).toBe('new');
      expect(pq.size).toBe(0);
    });
  });
});
