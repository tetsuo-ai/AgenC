/**
 * In-memory usage analytics tracker for skill invocations.
 *
 * Tracks per-skill usage events and computes aggregated analytics
 * on demand. Uses FIFO eviction when event count exceeds the per-skill
 * maximum to bound memory usage.
 *
 * @module
 */

import {
  MAX_ANALYTICS_ENTRIES_PER_SKILL,
  type SkillUsageEvent,
  type SkillAnalytics,
  type AgentUsageSummary,
} from './types.js';

interface SkillData {
  events: SkillUsageEvent[];
  revenue: bigint;
}

export class SkillUsageTracker {
  private readonly data = new Map<string, SkillData>();
  private readonly maxEntriesPerSkill: number;

  constructor(maxEntriesPerSkill = MAX_ANALYTICS_ENTRIES_PER_SKILL) {
    this.maxEntriesPerSkill = maxEntriesPerSkill;
  }

  /** Record a single usage event. FIFO-evicts oldest events when at capacity. */
  record(event: SkillUsageEvent): void {
    let entry = this.data.get(event.skillId);
    if (!entry) {
      entry = { events: [], revenue: 0n };
      this.data.set(event.skillId, entry);
    }
    entry.events.push(event);
    // FIFO eviction
    while (entry.events.length > this.maxEntriesPerSkill) {
      entry.events.shift();
    }
  }

  /** Compute aggregated analytics for a skill, or null if unknown. */
  getAnalytics(skillId: string): SkillAnalytics | null {
    const entry = this.data.get(skillId);
    if (!entry || entry.events.length === 0) return null;

    const events = entry.events;
    let successCount = 0;
    let failureCount = 0;
    let totalDurationMs = 0;
    const agents = new Set<string>();
    let firstUsedAt = Infinity;
    let lastUsedAt = -Infinity;

    for (const ev of events) {
      if (ev.success) {
        successCount++;
      } else {
        failureCount++;
      }
      totalDurationMs += ev.durationMs;
      agents.add(ev.agentId);
      if (ev.timestamp < firstUsedAt) firstUsedAt = ev.timestamp;
      if (ev.timestamp > lastUsedAt) lastUsedAt = ev.timestamp;
    }

    const totalInvocations = events.length;

    return {
      totalInvocations,
      successCount,
      failureCount,
      successRate: totalInvocations > 0 ? successCount / totalInvocations : 0,
      uniqueAgents: agents.size,
      avgDurationMs: totalInvocations > 0 ? totalDurationMs / totalInvocations : 0,
      firstUsedAt,
      lastUsedAt,
      revenueGenerated: entry.revenue,
    };
  }

  /** Get per-agent usage summary for a skill, or null if unknown. */
  getAgentUsage(skillId: string, agentId: string): AgentUsageSummary | null {
    const entry = this.data.get(skillId);
    if (!entry) return null;

    const agentEvents = entry.events.filter((ev) => ev.agentId === agentId);
    if (agentEvents.length === 0) return null;

    let successCount = 0;
    let failureCount = 0;
    let lastUsedAt = -Infinity;

    for (const ev of agentEvents) {
      if (ev.success) {
        successCount++;
      } else {
        failureCount++;
      }
      if (ev.timestamp > lastUsedAt) lastUsedAt = ev.timestamp;
    }

    return {
      agentId,
      invocations: agentEvents.length,
      successCount,
      failureCount,
      lastUsedAt,
    };
  }

  /** List all agents that have used a skill. */
  listAgents(skillId: string): string[] {
    const entry = this.data.get(skillId);
    if (!entry) return [];
    const agents = new Set<string>();
    for (const ev of entry.events) {
      agents.add(ev.agentId);
    }
    return [...agents];
  }

  /** Get top skills by invocation count. */
  getTopSkills(limit = 10): Array<{ skillId: string; invocations: number }> {
    const skills: Array<{ skillId: string; invocations: number }> = [];
    for (const [skillId, entry] of this.data.entries()) {
      if (entry.events.length > 0) {
        skills.push({ skillId, invocations: entry.events.length });
      }
    }
    skills.sort((a, b) => b.invocations - a.invocations);
    return skills.slice(0, limit);
  }

  /** Accumulate revenue for a skill. */
  addRevenue(skillId: string, lamports: bigint): void {
    let entry = this.data.get(skillId);
    if (!entry) {
      entry = { events: [], revenue: 0n };
      this.data.set(skillId, entry);
    }
    entry.revenue += lamports;
  }

  /** Reset analytics for a single skill. */
  reset(skillId: string): void {
    this.data.delete(skillId);
  }

  /** Reset all analytics. */
  resetAll(): void {
    this.data.clear();
  }
}
