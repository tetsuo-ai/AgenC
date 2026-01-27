import { describe, it, expect } from 'vitest';
import {
  TaskType,
  ResolutionType,
  RateLimitActionType,
  RateLimitType,
} from './types.js';

describe('Event Type Enums', () => {
  describe('TaskType', () => {
    it('should have correct values', () => {
      expect(TaskType.Exclusive).toBe(0);
      expect(TaskType.Collaborative).toBe(1);
      expect(TaskType.Competitive).toBe(2);
    });
  });

  describe('ResolutionType', () => {
    it('should have correct values', () => {
      expect(ResolutionType.Refund).toBe(0);
      expect(ResolutionType.Complete).toBe(1);
      expect(ResolutionType.Split).toBe(2);
    });
  });

  describe('RateLimitActionType', () => {
    it('should have correct values', () => {
      expect(RateLimitActionType.TaskCreation).toBe(0);
      expect(RateLimitActionType.DisputeInitiation).toBe(1);
    });
  });

  describe('RateLimitType', () => {
    it('should have correct values', () => {
      expect(RateLimitType.Cooldown).toBe(0);
      expect(RateLimitType.Window24h).toBe(1);
    });
  });
});
