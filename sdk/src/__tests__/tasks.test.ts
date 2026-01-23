/**
 * Unit tests for TaskState enum and task helper functions.
 *
 * These tests verify:
 * 1. TaskState enum values match on-chain TaskStatus
 * 2. formatTaskState() returns correct human-readable strings
 * 3. Edge cases are handled correctly
 */

import { describe, it, expect } from 'vitest';
import { TaskState, formatTaskState } from '../tasks';

describe('TaskState enum', () => {
  describe('enum values match on-chain TaskStatus', () => {
    // Values MUST match programs/agenc-coordination/src/state.rs:TaskStatus
    it('Open equals 0', () => {
      expect(TaskState.Open).toBe(0);
    });

    it('InProgress equals 1', () => {
      expect(TaskState.InProgress).toBe(1);
    });

    it('PendingValidation equals 2', () => {
      expect(TaskState.PendingValidation).toBe(2);
    });

    it('Completed equals 3', () => {
      expect(TaskState.Completed).toBe(3);
    });

    it('Cancelled equals 4', () => {
      expect(TaskState.Cancelled).toBe(4);
    });

    it('Disputed equals 5', () => {
      expect(TaskState.Disputed).toBe(5);
    });
  });

  describe('enum completeness', () => {
    it('has exactly 6 states', () => {
      // Get numeric enum values (filter out reverse mappings)
      const numericValues = Object.values(TaskState).filter(
        (v): v is number => typeof v === 'number'
      );
      expect(numericValues).toHaveLength(6);
    });

    it('has all expected state names', () => {
      const expectedNames = [
        'Open',
        'InProgress',
        'PendingValidation',
        'Completed',
        'Cancelled',
        'Disputed',
      ];

      for (const name of expectedNames) {
        expect(TaskState[name as keyof typeof TaskState]).toBeDefined();
      }
    });

    it('values are sequential from 0 to 5', () => {
      const numericValues = Object.values(TaskState)
        .filter((v): v is number => typeof v === 'number')
        .sort((a, b) => a - b);

      expect(numericValues).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  describe('on-chain compatibility', () => {
    it('numeric values work with on-chain data (simulated)', () => {
      // Simulate reading state from on-chain account
      const onChainState = 1; // InProgress
      const taskState = onChainState as TaskState;

      expect(taskState).toBe(TaskState.InProgress);
    });

    it('handles all on-chain values correctly', () => {
      const onChainToExpected: Array<[number, TaskState]> = [
        [0, TaskState.Open],
        [1, TaskState.InProgress],
        [2, TaskState.PendingValidation],
        [3, TaskState.Completed],
        [4, TaskState.Cancelled],
        [5, TaskState.Disputed],
      ];

      for (const [onChain, expected] of onChainToExpected) {
        expect(onChain as TaskState).toBe(expected);
      }
    });
  });
});

describe('formatTaskState', () => {
  describe('returns correct strings for all states', () => {
    it('formats Open correctly', () => {
      expect(formatTaskState(TaskState.Open)).toBe('Open');
    });

    it('formats InProgress correctly', () => {
      expect(formatTaskState(TaskState.InProgress)).toBe('In Progress');
    });

    it('formats PendingValidation correctly', () => {
      expect(formatTaskState(TaskState.PendingValidation)).toBe('Pending Validation');
    });

    it('formats Completed correctly', () => {
      expect(formatTaskState(TaskState.Completed)).toBe('Completed');
    });

    it('formats Cancelled correctly', () => {
      expect(formatTaskState(TaskState.Cancelled)).toBe('Cancelled');
    });

    it('formats Disputed correctly', () => {
      expect(formatTaskState(TaskState.Disputed)).toBe('Disputed');
    });
  });

  describe('edge cases', () => {
    it('returns Unknown for invalid state value', () => {
      expect(formatTaskState(99 as TaskState)).toBe('Unknown');
    });

    it('returns Unknown for negative state value', () => {
      expect(formatTaskState(-1 as TaskState)).toBe('Unknown');
    });

    it('handles numeric zero correctly (Open)', () => {
      expect(formatTaskState(0 as TaskState)).toBe('Open');
    });
  });

  describe('type safety', () => {
    it('accepts TaskState enum values', () => {
      // This verifies TypeScript type compatibility at compile time
      const state: TaskState = TaskState.Completed;
      const formatted: string = formatTaskState(state);
      expect(formatted).toBe('Completed');
    });

    it('formats all states without throwing', () => {
      const allStates = [
        TaskState.Open,
        TaskState.InProgress,
        TaskState.PendingValidation,
        TaskState.Completed,
        TaskState.Cancelled,
        TaskState.Disputed,
      ];

      for (const state of allStates) {
        expect(() => formatTaskState(state)).not.toThrow();
        expect(formatTaskState(state)).not.toBe('Unknown');
      }
    });
  });
});
