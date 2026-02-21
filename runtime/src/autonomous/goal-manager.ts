/**
 * GoalManager — Central goal lifecycle controller.
 *
 * Manages a queue of goals backed by MemoryBackend KV storage.
 * Provides CRUD, priority ordering, deduplication, retry logic,
 * and history tracking.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { MemoryBackend } from "../memory/types.js";

// ============================================================================
// Types
// ============================================================================

export interface ManagedGoal {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  source: "meta-planner" | "awareness" | "user" | "curiosity";
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxAttempts: number;
  result?: { success: boolean; summary: string; durationMs: number };
  rationale?: string;
}

export interface GoalManagerConfig {
  memory: MemoryBackend;
  maxActiveGoals?: number;
  maxHistoryGoals?: number;
  deduplicationWindowMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ACTIVE_GOALS = 10;
const DEFAULT_MAX_HISTORY_GOALS = 50;
const DEFAULT_DEDUP_WINDOW_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_ATTEMPTS = 2;

const KEY_ACTIVE = "goals:active";
const KEY_HISTORY = "goals:history";

const PRIORITY_ORDER: Record<ManagedGoal["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ============================================================================
// GoalManager
// ============================================================================

export class GoalManager {
  private readonly memory: MemoryBackend;
  private readonly maxActiveGoals: number;
  private readonly maxHistoryGoals: number;
  private readonly deduplicationWindowMs: number;

  constructor(config: GoalManagerConfig) {
    this.memory = config.memory;
    this.maxActiveGoals = config.maxActiveGoals ?? DEFAULT_MAX_ACTIVE_GOALS;
    this.maxHistoryGoals = config.maxHistoryGoals ?? DEFAULT_MAX_HISTORY_GOALS;
    this.deduplicationWindowMs =
      config.deduplicationWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  async addGoal(
    goal: Omit<
      ManagedGoal,
      "id" | "createdAt" | "updatedAt" | "attempts" | "status"
    >,
  ): Promise<ManagedGoal> {
    const active = await this.getActiveGoals();

    if (active.length >= this.maxActiveGoals) {
      // Drop the lowest-priority goal to make room
      const sorted = [...active].sort(
        (a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority],
      );
      const toDrop = sorted[0]!;
      await this.cancelGoal(toDrop.id);
      // Re-read after cancel
      const refreshed = await this.getActiveGoals();
      return this._insertGoal(goal, refreshed);
    }

    return this._insertGoal(goal, active);
  }

  private async _insertGoal(
    goal: Omit<
      ManagedGoal,
      "id" | "createdAt" | "updatedAt" | "attempts" | "status"
    >,
    active: ManagedGoal[],
  ): Promise<ManagedGoal> {
    const now = Date.now();
    const managed: ManagedGoal = {
      ...goal,
      id: randomUUID(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      maxAttempts: goal.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };

    active.push(managed);
    await this.memory.set(KEY_ACTIVE, active);
    return managed;
  }

  async getActiveGoals(): Promise<ManagedGoal[]> {
    return (await this.memory.get<ManagedGoal[]>(KEY_ACTIVE)) ?? [];
  }

  async getNextGoal(
    filter?: (goal: ManagedGoal) => boolean,
  ): Promise<ManagedGoal | undefined> {
    const active = await this.getActiveGoals();
    let pending = active.filter((g) => g.status === "pending");
    if (filter) pending = pending.filter(filter);
    if (pending.length === 0) return undefined;

    // Sort by priority (critical first), then FIFO (oldest first)
    pending.sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pd !== 0) return pd;
      return a.createdAt - b.createdAt;
    });

    return pending[0];
  }

  async markExecuting(goalId: string): Promise<void> {
    const active = await this.getActiveGoals();
    const goal = active.find((g) => g.id === goalId);
    if (!goal) return;

    goal.status = "executing";
    goal.attempts += 1;
    goal.updatedAt = Date.now();
    await this.memory.set(KEY_ACTIVE, active);
  }

  async markCompleted(
    goalId: string,
    result: ManagedGoal["result"],
  ): Promise<void> {
    const active = await this.getActiveGoals();
    const idx = active.findIndex((g) => g.id === goalId);
    if (idx === -1) return;

    const goal = active[idx]!;
    goal.status = "completed";
    goal.result = result;
    goal.updatedAt = Date.now();

    // Move to history
    active.splice(idx, 1);
    await this.memory.set(KEY_ACTIVE, active);
    await this._addToHistory(goal);
  }

  async markFailed(
    goalId: string,
    result: ManagedGoal["result"],
  ): Promise<void> {
    const active = await this.getActiveGoals();
    const idx = active.findIndex((g) => g.id === goalId);
    if (idx === -1) return;

    const goal = active[idx]!;
    goal.result = result;
    goal.updatedAt = Date.now();

    if (goal.attempts < goal.maxAttempts) {
      // Retry — reset to pending
      goal.status = "pending";
      await this.memory.set(KEY_ACTIVE, active);
    } else {
      // Exhausted — move to history
      goal.status = "failed";
      active.splice(idx, 1);
      await this.memory.set(KEY_ACTIVE, active);
      await this._addToHistory(goal);
    }
  }

  async cancelGoal(goalId: string): Promise<void> {
    const active = await this.getActiveGoals();
    const idx = active.findIndex((g) => g.id === goalId);
    if (idx === -1) return;

    const goal = active[idx]!;
    goal.status = "cancelled";
    goal.updatedAt = Date.now();

    active.splice(idx, 1);
    await this.memory.set(KEY_ACTIVE, active);
    await this._addToHistory(goal);
  }

  // --------------------------------------------------------------------------
  // History
  // --------------------------------------------------------------------------

  async getHistory(limit?: number): Promise<ManagedGoal[]> {
    const history =
      (await this.memory.get<ManagedGoal[]>(KEY_HISTORY)) ?? [];
    // Sorted by updatedAt desc
    history.sort((a, b) => b.updatedAt - a.updatedAt);
    return limit ? history.slice(0, limit) : history;
  }

  private async _addToHistory(goal: ManagedGoal): Promise<void> {
    const history =
      (await this.memory.get<ManagedGoal[]>(KEY_HISTORY)) ?? [];
    history.push(goal);
    // Sort desc and cap
    history.sort((a, b) => b.updatedAt - a.updatedAt);
    const capped = history.slice(0, this.maxHistoryGoals);
    await this.memory.set(KEY_HISTORY, capped);
  }

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  isDuplicate(description: string, existingGoals: ManagedGoal[]): boolean {
    const now = Date.now();
    const candidateWords = normalizeToWords(description);
    if (candidateWords.size === 0) return false;

    for (const goal of existingGoals) {
      // Only check within dedup window
      if (now - goal.createdAt > this.deduplicationWindowMs) continue;

      const existingWords = normalizeToWords(goal.description);
      if (existingWords.size === 0) continue;

      const intersection = new Set(
        [...candidateWords].filter((w) => existingWords.has(w)),
      );
      const union = new Set([...candidateWords, ...existingWords]);
      const overlap = intersection.size / union.size;

      if (overlap > 0.8) return true;
    }

    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeToWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}
