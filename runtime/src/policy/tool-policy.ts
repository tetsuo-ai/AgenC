/**
 * Granular, condition-based tool permission policy evaluator.
 *
 * Designed to be composed alongside PolicyEngine (called from Gateway's
 * `tool:before` hook). Does NOT modify PolicyEngine internals.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolPermissionPolicy {
  readonly tool: string;
  readonly effect: 'allow' | 'deny';
  readonly conditions?: ToolPolicyConditions;
}

export interface ToolPolicyConditions {
  readonly heartbeatOnly?: boolean;
  readonly sessionIds?: readonly string[];
  readonly channels?: readonly string[];
  readonly rateLimit?: number; // calls per minute
  readonly sandboxOnly?: boolean;
}

export interface ToolPolicyContext {
  readonly toolName: string;
  readonly sessionId: string;
  readonly channel: string;
  readonly isHeartbeat: boolean;
  readonly isSandboxed: boolean;
}

export interface ToolPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly matchedRule?: ToolPermissionPolicy;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;

export class ToolPolicyEvaluator {
  private policies: readonly ToolPermissionPolicy[];
  private readonly now: () => number;

  /** Sliding-window timestamps per tool name for rate limiting. */
  private rateCounts = new Map<string, number[]>();

  constructor(policies: readonly ToolPermissionPolicy[], now?: () => number) {
    this.policies = policies;
    this.now = now ?? Date.now;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether a tool call is permitted.
   *
   * Deny-first, default-deny:
   * 1. Iterate policies in order.
   * 2. Matching deny rule whose conditions are met → deny immediately.
   * 3. First matching allow rule whose conditions are met → candidate.
   * 4. If candidate exists, check rate limit → allow (auto-records call).
   * 5. No matching allow → deny.
   */
  evaluate(context: ToolPolicyContext): ToolPolicyDecision {
    let candidateAllow: ToolPermissionPolicy | undefined;

    for (const policy of this.policies) {
      if (!this.matchesPattern(context.toolName, policy.tool)) {
        continue;
      }

      const { met, reason } = this.checkConditions(policy, context);

      if (policy.effect === 'deny' && met) {
        return { allowed: false, reason: reason ?? `Denied by rule: ${policy.tool}`, matchedRule: policy };
      }

      if (policy.effect === 'allow' && met && !candidateAllow) {
        candidateAllow = policy;
      }
    }

    if (!candidateAllow) {
      return { allowed: false, reason: 'No matching allow rule' };
    }

    // Rate limit check (applied after condition matching, before final allow)
    if (candidateAllow.conditions?.rateLimit !== undefined) {
      const limit = candidateAllow.conditions.rateLimit;
      const now = this.now();
      const cutoff = now - RATE_LIMIT_WINDOW_MS;
      const bucket = this.rateCounts.get(context.toolName) ?? [];
      const recent = bucket.filter((t) => t >= cutoff);

      if (recent.length >= limit) {
        this.rateCounts.set(context.toolName, recent);
        return {
          allowed: false,
          reason: `Rate limit exceeded: ${limit} calls/min for "${context.toolName}"`,
          matchedRule: candidateAllow,
        };
      }

      recent.push(now);
      this.rateCounts.set(context.toolName, recent);
    }

    return { allowed: true, matchedRule: candidateAllow };
  }

  /** Record a tool call for rate-limit tracking. Called internally for rate-limited allows. */
  recordCall(toolName: string): void {
    const bucket = this.rateCounts.get(toolName) ?? [];
    bucket.push(this.now());
    this.rateCounts.set(toolName, bucket);
  }

  /** Hot-reload policies, clearing rate counters. */
  updatePolicies(policies: readonly ToolPermissionPolicy[]): void {
    this.policies = policies;
    this.rateCounts.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Simple glob matching with `*` wildcard.
   *
   * - `*` alone matches everything.
   * - `system.*` matches `system.bash` but not `systemd`.
   * - Exact names match exactly.
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;

    if (!pattern.includes('*')) {
      return toolName === pattern;
    }

    // Convert glob pattern to regex: escape dots, replace * with [^.]*
    const escaped = pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]*');
    return new RegExp(`^${escaped}$`).test(toolName);
  }

  /**
   * Check all non-rate-limit conditions (AND logic).
   *
   * Conditions describe *when* a rule activates. If any condition is not
   * satisfied, the rule does not match (regardless of deny/allow effect).
   */
  private checkConditions(
    policy: ToolPermissionPolicy,
    context: ToolPolicyContext,
  ): { met: boolean; reason?: string } {
    const cond = policy.conditions;
    if (!cond) return { met: true };

    if (cond.heartbeatOnly && !context.isHeartbeat) {
      return { met: false, reason: 'Restricted to heartbeat-initiated calls' };
    }

    if (cond.sessionIds && cond.sessionIds.length > 0) {
      if (!cond.sessionIds.includes(context.sessionId)) {
        return { met: false, reason: `Session "${context.sessionId}" not in allowed sessions` };
      }
    }

    if (cond.channels && cond.channels.length > 0) {
      if (!cond.channels.includes(context.channel)) {
        return { met: false, reason: `Channel "${context.channel}" not in allowed channels` };
      }
    }

    if (cond.sandboxOnly && !context.isSandboxed) {
      return { met: false, reason: 'Restricted to sandboxed execution' };
    }

    return { met: true };
  }
}
