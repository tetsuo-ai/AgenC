/**
 * Session-scoped tool failure circuit breaker.
 *
 * Tracks repeated tool failures per session and opens a circuit breaker
 * when a tool fails too many times within a time window. Prevents the
 * model from repeatedly calling tools that are known to be broken.
 *
 * Extracted from ChatExecutor (Gate 4 — first proven seam).
 */

import type {
  SessionToolFailureCircuitState,
  SessionToolFailurePattern,
  ToolFailureCircuitBreakerConfig,
} from "./chat-executor-types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 120_000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_TRACKED_SESSIONS = 256;

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export interface ToolFailureCircuitBreakerOptions {
  enabled: boolean;
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  maxTrackedSessions?: number;
}

export class ToolFailureCircuitBreaker {
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxTrackedSessions: number;
  private readonly circuits = new Map<string, SessionToolFailureCircuitState>();

  constructor(options: ToolFailureCircuitBreakerOptions) {
    this.enabled = options.enabled;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxTrackedSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
  }

  static fromConfig(config?: ToolFailureCircuitBreakerConfig): ToolFailureCircuitBreaker {
    return new ToolFailureCircuitBreaker({
      enabled: config?.enabled === true,
      windowMs: config?.windowMs,
      threshold: config?.threshold,
      cooldownMs: config?.cooldownMs,
    });
  }

  /**
   * Check if the circuit is open for a session (tool calls should be blocked).
   */
  getActiveCircuit(
    sessionId: string,
  ): { reason: string; retryAfterMs: number } | null {
    if (!this.enabled) return null;
    const state = this.circuits.get(sessionId);
    if (!state) return null;
    const now = Date.now();
    if (state.openUntil <= now) {
      state.openUntil = 0;
      state.reason = undefined;
      return null;
    }
    return {
      reason:
        state.reason ??
        "Session tool-failure circuit breaker is open after repeated failing tool patterns",
      retryAfterMs: Math.max(0, state.openUntil - now),
    };
  }

  /**
   * Record a tool failure. Returns the circuit-open reason if the breaker trips.
   */
  recordFailure(
    sessionId: string,
    semanticKey: string,
    toolName: string,
  ): string | undefined {
    if (!this.enabled || semanticKey.length === 0) return undefined;

    const state = this.getOrCreateState(sessionId);
    const now = Date.now();

    // Expire old patterns outside the window
    for (const [key, pattern] of state.patterns) {
      if (now - pattern.lastAt > this.windowMs) {
        state.patterns.delete(key);
      }
    }

    const existing = state.patterns.get(semanticKey);
    const next: SessionToolFailurePattern = existing
      ? { count: existing.count + 1, lastAt: now }
      : { count: 1, lastAt: now };
    state.patterns.set(semanticKey, next);

    if (next.count < this.threshold) return undefined;

    state.openUntil = now + this.cooldownMs;
    state.reason =
      `Session breaker opened after ${next.count} repeated failures for tool "${toolName}" ` +
      `within ${this.windowMs}ms`;
    return state.reason;
  }

  /**
   * Clear a failure pattern when a tool succeeds.
   */
  clearPattern(sessionId: string, semanticKey: string): void {
    if (!this.enabled || semanticKey.length === 0) return;
    const state = this.circuits.get(sessionId);
    if (!state) return;
    state.patterns.delete(semanticKey);
    if (state.patterns.size === 0 && state.openUntil <= Date.now()) {
      this.circuits.delete(sessionId);
    }
  }

  /**
   * Remove all tracked state for a session.
   */
  clearSession(sessionId: string): void {
    this.circuits.delete(sessionId);
  }

  /**
   * Remove all tracked state for every session.
   */
  clearAll(): void {
    this.circuits.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private getOrCreateState(sessionId: string): SessionToolFailureCircuitState {
    const existing = this.circuits.get(sessionId);
    if (existing) return existing;
    const created: SessionToolFailureCircuitState = {
      openUntil: 0,
      reason: undefined,
      patterns: new Map(),
    };
    this.circuits.set(sessionId, created);
    if (this.circuits.size > this.maxTrackedSessions) {
      const oldest = this.circuits.keys().next().value;
      if (oldest !== undefined) {
        this.circuits.delete(oldest);
      }
    }
    return created;
  }
}
