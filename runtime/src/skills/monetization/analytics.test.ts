import { describe, it, expect } from 'vitest';
import { SkillUsageTracker } from './analytics.js';
import type { SkillUsageEvent } from './types.js';

function makeEvent(overrides: Partial<SkillUsageEvent> = {}): SkillUsageEvent {
  return {
    skillId: 'skill-1',
    agentId: 'agent-1',
    action: 'execute',
    timestamp: 1700000000,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

describe('SkillUsageTracker', () => {
  describe('record + getAnalytics', () => {
    it('returns null for unknown skill', () => {
      const tracker = new SkillUsageTracker();
      expect(tracker.getAnalytics('unknown')).toBeNull();
    });

    it('records a single event and computes analytics', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent());

      const analytics = tracker.getAnalytics('skill-1');
      expect(analytics).not.toBeNull();
      expect(analytics!.totalInvocations).toBe(1);
      expect(analytics!.successCount).toBe(1);
      expect(analytics!.failureCount).toBe(0);
      expect(analytics!.successRate).toBe(1);
      expect(analytics!.uniqueAgents).toBe(1);
      expect(analytics!.avgDurationMs).toBe(100);
      expect(analytics!.firstUsedAt).toBe(1700000000);
      expect(analytics!.lastUsedAt).toBe(1700000000);
      expect(analytics!.revenueGenerated).toBe(0n);
    });

    it('aggregates multiple events', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ timestamp: 1000, durationMs: 50, success: true }));
      tracker.record(makeEvent({ timestamp: 2000, durationMs: 150, success: false, errorCode: 'ERR' }));
      tracker.record(makeEvent({ timestamp: 3000, durationMs: 100, success: true, agentId: 'agent-2' }));

      const analytics = tracker.getAnalytics('skill-1')!;
      expect(analytics.totalInvocations).toBe(3);
      expect(analytics.successCount).toBe(2);
      expect(analytics.failureCount).toBe(1);
      expect(analytics.successRate).toBeCloseTo(2 / 3);
      expect(analytics.uniqueAgents).toBe(2);
      expect(analytics.avgDurationMs).toBe(100);
      expect(analytics.firstUsedAt).toBe(1000);
      expect(analytics.lastUsedAt).toBe(3000);
    });

    it('FIFO eviction at max entries', () => {
      const tracker = new SkillUsageTracker(3);
      tracker.record(makeEvent({ timestamp: 1 }));
      tracker.record(makeEvent({ timestamp: 2 }));
      tracker.record(makeEvent({ timestamp: 3 }));
      tracker.record(makeEvent({ timestamp: 4 }));

      const analytics = tracker.getAnalytics('skill-1')!;
      expect(analytics.totalInvocations).toBe(3);
      // Oldest (timestamp=1) should be evicted
      expect(analytics.firstUsedAt).toBe(2);
      expect(analytics.lastUsedAt).toBe(4);
    });
  });

  describe('getAgentUsage', () => {
    it('returns null for unknown skill', () => {
      const tracker = new SkillUsageTracker();
      expect(tracker.getAgentUsage('unknown', 'agent-1')).toBeNull();
    });

    it('returns null for unknown agent', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent());
      expect(tracker.getAgentUsage('skill-1', 'unknown-agent')).toBeNull();
    });

    it('returns per-agent summary', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ agentId: 'agent-1', timestamp: 1000, success: true }));
      tracker.record(makeEvent({ agentId: 'agent-1', timestamp: 2000, success: false }));
      tracker.record(makeEvent({ agentId: 'agent-2', timestamp: 3000, success: true }));

      const summary = tracker.getAgentUsage('skill-1', 'agent-1')!;
      expect(summary.agentId).toBe('agent-1');
      expect(summary.invocations).toBe(2);
      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(1);
      expect(summary.lastUsedAt).toBe(2000);
    });
  });

  describe('listAgents', () => {
    it('returns empty array for unknown skill', () => {
      const tracker = new SkillUsageTracker();
      expect(tracker.listAgents('unknown')).toEqual([]);
    });

    it('returns unique agent IDs', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ agentId: 'agent-1' }));
      tracker.record(makeEvent({ agentId: 'agent-2' }));
      tracker.record(makeEvent({ agentId: 'agent-1' }));

      const agents = tracker.listAgents('skill-1');
      expect(agents).toHaveLength(2);
      expect(agents).toContain('agent-1');
      expect(agents).toContain('agent-2');
    });
  });

  describe('getTopSkills', () => {
    it('returns skills sorted by invocation count', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ skillId: 'skill-a' }));
      tracker.record(makeEvent({ skillId: 'skill-b' }));
      tracker.record(makeEvent({ skillId: 'skill-b' }));
      tracker.record(makeEvent({ skillId: 'skill-c' }));
      tracker.record(makeEvent({ skillId: 'skill-c' }));
      tracker.record(makeEvent({ skillId: 'skill-c' }));

      const top = tracker.getTopSkills(2);
      expect(top).toHaveLength(2);
      expect(top[0].skillId).toBe('skill-c');
      expect(top[0].invocations).toBe(3);
      expect(top[1].skillId).toBe('skill-b');
      expect(top[1].invocations).toBe(2);
    });

    it('defaults to limit of 10', () => {
      const tracker = new SkillUsageTracker();
      for (let i = 0; i < 15; i++) {
        tracker.record(makeEvent({ skillId: `skill-${i}` }));
      }
      expect(tracker.getTopSkills()).toHaveLength(10);
    });
  });

  describe('addRevenue', () => {
    it('accumulates revenue for a skill', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent());
      tracker.addRevenue('skill-1', 1_000_000n);
      tracker.addRevenue('skill-1', 500_000n);

      const analytics = tracker.getAnalytics('skill-1')!;
      expect(analytics.revenueGenerated).toBe(1_500_000n);
    });

    it('creates entry if skill not yet tracked', () => {
      const tracker = new SkillUsageTracker();
      tracker.addRevenue('new-skill', 100n);

      // Analytics should still be null since no events recorded
      expect(tracker.getAnalytics('new-skill')).toBeNull();
    });
  });

  describe('reset', () => {
    it('clears data for a single skill', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ skillId: 'skill-1' }));
      tracker.record(makeEvent({ skillId: 'skill-2' }));

      tracker.reset('skill-1');

      expect(tracker.getAnalytics('skill-1')).toBeNull();
      expect(tracker.getAnalytics('skill-2')).not.toBeNull();
    });
  });

  describe('resetAll', () => {
    it('clears all data', () => {
      const tracker = new SkillUsageTracker();
      tracker.record(makeEvent({ skillId: 'skill-1' }));
      tracker.record(makeEvent({ skillId: 'skill-2' }));

      tracker.resetAll();

      expect(tracker.getAnalytics('skill-1')).toBeNull();
      expect(tracker.getAnalytics('skill-2')).toBeNull();
    });
  });
});
