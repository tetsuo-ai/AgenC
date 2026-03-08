/**
 * Delegation runtime dependencies shared across gateway/tool-handler wiring.
 *
 * Provides policy checks, verifier toggles, and lifecycle event emission for
 * sub-agent orchestration.
 *
 * @module
 */

import {
  SUB_AGENT_SESSION_PREFIX,
  type SubAgentManager,
} from "./sub-agent.js";
import type { GatewaySubagentFallbackBehavior } from "./types.js";

export interface DelegationPolicyRuntimeConfig {
  readonly enabled: boolean;
  readonly spawnDecisionThreshold: number;
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior: GatewaySubagentFallbackBehavior;
}

export interface DelegationPolicyInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly isSubAgentSession: boolean;
}

export interface DelegationPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly matchedRule?:
    | "not_delegation_tool"
    | "delegation_disabled"
    | "subagent_delegation_blocked"
    | "forbidden_tool"
    | "tool_not_allowlisted"
    | "score_below_threshold"
    | "allowed";
  readonly threshold: number;
}

export function isSubAgentSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SUB_AGENT_SESSION_PREFIX);
}

export function isDelegationToolName(toolName: string): boolean {
  return (
    toolName === "execute_with_agent" ||
    toolName.startsWith("subagent.") ||
    toolName.startsWith("agenc.subagent.")
  );
}

export class DelegationPolicyEngine {
  private config: DelegationPolicyRuntimeConfig;

  constructor(config: DelegationPolicyRuntimeConfig) {
    this.config = {
      ...config,
      allowedParentTools: config.allowedParentTools
        ? [...config.allowedParentTools]
        : undefined,
      forbiddenParentTools: config.forbiddenParentTools
        ? [...config.forbiddenParentTools]
        : undefined,
    };
  }

  updateConfig(config: DelegationPolicyRuntimeConfig): void {
    this.config = {
      ...config,
      allowedParentTools: config.allowedParentTools
        ? [...config.allowedParentTools]
        : undefined,
      forbiddenParentTools: config.forbiddenParentTools
        ? [...config.forbiddenParentTools]
        : undefined,
    };
  }

  snapshot(): DelegationPolicyRuntimeConfig {
    return {
      ...this.config,
      allowedParentTools: this.config.allowedParentTools
        ? [...this.config.allowedParentTools]
        : undefined,
      forbiddenParentTools: this.config.forbiddenParentTools
        ? [...this.config.forbiddenParentTools]
        : undefined,
    };
  }

  isDelegationTool(toolName: string): boolean {
    return isDelegationToolName(toolName);
  }

  evaluate(input: DelegationPolicyInput): DelegationPolicyDecision {
    if (!isDelegationToolName(input.toolName)) {
      return {
        allowed: true,
        matchedRule: "not_delegation_tool",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    if (!this.config.enabled) {
      return {
        allowed: false,
        reason:
          this.config.fallbackBehavior === "fail_request"
            ? "Delegation is disabled by configuration"
            : "Delegation disabled; continue without delegation",
        matchedRule: "delegation_disabled",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    if (input.isSubAgentSession) {
      return {
        allowed: false,
        reason: "Sub-agent sessions cannot invoke delegation tools",
        matchedRule: "subagent_delegation_blocked",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    // Parent sessions may be constrained by explicit allow/deny lists.
    const forbidden = new Set(this.config.forbiddenParentTools ?? []);
    if (forbidden.has(input.toolName)) {
      return {
        allowed: false,
        reason: `Delegation blocked by forbiddenParentTools for "${input.toolName}"`,
        matchedRule: "forbidden_tool",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    const allowlist = this.config.allowedParentTools;
    if (allowlist && allowlist.length > 0 && !allowlist.includes(input.toolName)) {
      return {
        allowed: false,
        reason: `Delegation tool "${input.toolName}" is not allowlisted`,
        matchedRule: "tool_not_allowlisted",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    return {
      allowed: true,
      matchedRule: "allowed",
      threshold: this.config.spawnDecisionThreshold,
    };
  }
}

export interface DelegationVerifierRuntimeConfig {
  readonly enabled: boolean;
  readonly forceVerifier: boolean;
}

export class DelegationVerifierService {
  private config: DelegationVerifierRuntimeConfig;

  constructor(config: DelegationVerifierRuntimeConfig) {
    this.config = { ...config };
  }

  updateConfig(config: DelegationVerifierRuntimeConfig): void {
    this.config = { ...config };
  }

  snapshot(): DelegationVerifierRuntimeConfig {
    return { ...this.config };
  }

  shouldVerifySubAgentResult(
    requested = false,
  ): boolean {
    if (!this.config.enabled) return false;
    return this.config.forceVerifier || requested;
  }
}

export type SubAgentLifecycleEventType =
  | "subagents.planned"
  | "subagents.spawned"
  | "subagents.started"
  | "subagents.progress"
  | "subagents.tool.executing"
  | "subagents.tool.result"
  | "subagents.completed"
  | "subagents.failed"
  | "subagents.cancelled"
  | "subagents.synthesized";

export interface SubAgentLifecycleEvent {
  readonly type: SubAgentLifecycleEventType;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly toolName?: string;
  readonly payload?: Record<string, unknown>;
}

type SubAgentLifecycleListener = (event: SubAgentLifecycleEvent) => void;

export class SubAgentLifecycleEmitter {
  private readonly listeners = new Set<SubAgentLifecycleListener>();

  on(listener: SubAgentLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SubAgentLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let listener exceptions break the caller.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface DelegationToolCompositionContext {
  readonly subAgentManager: SubAgentManager | null;
  readonly policyEngine: DelegationPolicyEngine | null;
  readonly verifier: DelegationVerifierService | null;
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
}

export type DelegationToolCompositionResolver =
  () => DelegationToolCompositionContext | undefined;
