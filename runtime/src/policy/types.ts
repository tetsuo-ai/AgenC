/**
 * Core policy/safety engine types.
 *
 * @module
 */

import type { MetricsProvider } from "../task/types.js";
import type { Logger } from "../utils/logger.js";

export type PolicyActionType =
  | "tool_call"
  | "task_discovery"
  | "task_claim"
  | "task_execution"
  | "tx_submission"
  | "custom";

export type PolicyAccess = "read" | "write";

export type CircuitBreakerMode =
  | "normal"
  | "pause_discovery"
  | "halt_submissions"
  | "safe_mode";

export interface PolicyAction {
  type: PolicyActionType;
  name: string;
  access: PolicyAccess;
  /** Optional risk score in [0, 1]. */
  riskScore?: number;
  /** Optional spend value for budget tracking. */
  spendLamports?: bigint;
  metadata?: Record<string, unknown>;
}

export interface PolicyBudgetRule {
  /** Max allowed actions in the rolling window. */
  limit: number;
  /** Rolling window size in ms. */
  windowMs: number;
}

export interface EndpointExposureConfig {
  /** Maximum number of RPC endpoints exposed publicly. */
  maxPublicEndpoints: number;
  /** Require HTTPS for all public endpoints. */
  requireHttps: boolean;
  /** Allowed origin patterns for CORS (empty means no CORS). */
  allowedOrigins: string[];
  /** Rate limit for public endpoint requests per minute. */
  publicRateLimitPerMinute: number;
}

export interface EvidenceRetentionPolicy {
  /** Maximum retention period for incident evidence bundles in milliseconds. */
  maxRetentionMs: number;
  /** Maximum number of evidence bundles to retain. */
  maxBundles: number;
  /** Auto-delete evidence older than retention period. */
  autoDelete: boolean;
  /** Require sealed (redacted) mode for evidence exports. */
  requireSealedExport: boolean;
}

export interface ProductionRedactionPolicy {
  /** Always redact actor pubkeys in evidence exports. */
  redactActors: boolean;
  /** Fields to always strip from evidence payloads. */
  alwaysStripFields: string[];
  /** Patterns to redact in all evidence output. */
  redactPatterns: string[];
}

export interface DeletionDefaults {
  /** Auto-delete replay events older than this TTL in milliseconds. */
  replayEventTtlMs: number;
  /** Auto-delete audit trail entries older than this TTL in milliseconds. */
  auditTrailTtlMs: number;
  /** Maximum total replay events before triggering compaction. */
  maxReplayEventsTotal: number;
  /** Run deletion on startup. */
  deleteOnStartup: boolean;
}

export interface SpendBudgetRule {
  /** Max allowed spend in lamports for the rolling window. */
  limitLamports: bigint;
  /** Rolling window size in ms. */
  windowMs: number;
}

export interface CircuitBreakerConfig {
  enabled?: boolean;
  /** Violations required before auto-trip. */
  threshold: number;
  /** Violation counting window in ms. */
  windowMs: number;
  /** Mode entered when auto-tripped. */
  mode: Exclude<CircuitBreakerMode, "normal">;
}

export interface RuntimePolicyConfig {
  /** Default-safe: disabled unless explicitly enabled. */
  enabled?: boolean;
  /** Explicit allow-list for action names. Empty/undefined means allow all. */
  allowActions?: string[];
  /** Explicit deny-list for action names. */
  denyActions?: string[];
  /** Tool-specific allow-list. Empty/undefined means allow all tools. */
  toolAllowList?: string[];
  /** Tool-specific deny-list. */
  toolDenyList?: string[];
  /**
   * Action budget rules keyed by:
   * - `${type}:*` for all actions of a type
   * - `${type}:${name}` for exact action name
   */
  actionBudgets?: Record<string, PolicyBudgetRule>;
  /** Optional rolling spend budget. */
  spendBudget?: SpendBudgetRule;
  /** Block actions with risk score above this threshold. */
  maxRiskScore?: number;
  /** Auto-trip configuration on repeated policy violations. */
  circuitBreaker?: CircuitBreakerConfig;
}

export interface ProductionRuntimeExtensions {
  endpointExposure?: EndpointExposureConfig;
  evidenceRetention?: EvidenceRetentionPolicy;
  redaction?: ProductionRedactionPolicy;
  deletion?: DeletionDefaults;
}

export interface PolicyViolation {
  code:
    | "circuit_breaker_active"
    | "tool_denied"
    | "action_denied"
    | "action_budget_exceeded"
    | "spend_budget_exceeded"
    | "risk_threshold_exceeded";
  message: string;
  actionType: PolicyActionType;
  actionName: string;
  details?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  mode: CircuitBreakerMode;
  violations: PolicyViolation[];
}

export interface PolicyEngineState {
  mode: CircuitBreakerMode;
  circuitBreakerReason?: string;
  trippedAtMs?: number;
  recentViolations: number;
}

export interface PolicyEngineConfig {
  policy?: RuntimePolicyConfig;
  logger?: Logger;
  metrics?: MetricsProvider;
  now?: () => number;
}

export class PolicyViolationError extends Error {
  readonly action: PolicyAction;
  readonly decision: PolicyDecision;

  constructor(action: PolicyAction, decision: PolicyDecision) {
    const reason = decision.violations[0]?.message ?? "Policy blocked action";
    super(reason);
    this.name = "PolicyViolationError";
    this.action = action;
    this.decision = decision;
  }
}
