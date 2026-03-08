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

export type PolicyClass =
  | "read_only"
  | "reversible_side_effect"
  | "destructive_side_effect"
  | "irreversible_financial_action"
  | "credential_secret_access";

export type PolicySimulationMode = "off" | "shadow";
export type GovernanceAuditRetentionMode = "delete" | "archive";

export type CircuitBreakerMode =
  | "normal"
  | "pause_discovery"
  | "halt_submissions"
  | "safe_mode";

export interface PolicyAction {
  type: PolicyActionType;
  name: string;
  access: PolicyAccess;
  /** Optional high-level policy class for differentiated governance. */
  policyClass?: PolicyClass;
  /** Optional risk score in [0, 1]. */
  riskScore?: number;
  /** Optional spend value for budget tracking. */
  spendLamports?: bigint;
  /** Optional token spend for rolling token-budget tracking. */
  tokenCount?: number;
  /** Optional elapsed-runtime sample for max-runtime enforcement. */
  elapsedRuntimeMs?: number;
  /** Optional scope-specific elapsed-runtime samples for stricter overlays. */
  elapsedRuntimeMsByScope?: Partial<
    Record<"global" | "tenant" | "project" | "run", number>
  >;
  /** Optional concurrent managed-process count for ceiling enforcement. */
  processCount?: number;
  /** Optional scope-specific managed-process counts for scope overlays. */
  processCountByScope?: Partial<
    Record<"global" | "tenant" | "project" | "run", number>
  >;
  /** Optional evaluation scope for tenant/project/run budgets. */
  scope?: PolicyEvaluationScope;
  /** Whether budget accounting is a preflight check or post-hoc actual usage sample. */
  budgetConsumptionMode?: "preflight" | "post_hoc_actual";
  metadata?: Record<string, unknown>;
}

export interface PolicyEvaluationScope {
  tenantId?: string;
  projectId?: string;
  runId?: string;
  sessionId?: string;
  channel?: string;
}

export interface PolicyBudgetRule {
  /** Max allowed actions in the rolling window. */
  limit: number;
  /** Rolling window size in ms. */
  windowMs: number;
}

export interface RuntimeSessionCredentialConfig {
  /** Environment variable providing the underlying secret value. */
  sourceEnvVar: string;
  /** Domains eligible for injection. */
  domains: string[];
  /** Headers emitted when the credential is leased. `${secret}` is replaced at runtime. */
  headerTemplates?: Record<string, string>;
  /** Structured tools allowed to consume this credential. */
  allowedTools?: string[];
  /** Lease lifetime in milliseconds. Default: 300000 (5 minutes). */
  ttlMs?: number;
}

export interface NetworkAccessRule {
  /** Explicit allow-list of remote hosts. Empty/undefined means allow all unless denyHosts matches. */
  allowHosts?: string[];
  /** Explicit deny-list of remote hosts. */
  denyHosts?: string[];
}

export interface WriteScopeRule {
  /** Absolute filesystem roots allowed for write operations. Empty/undefined means allow all unless denyRoots matches. */
  allowRoots?: string[];
  /** Absolute filesystem roots denied for write operations. */
  denyRoots?: string[];
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

export interface TokenBudgetRule {
  /** Max allowed token spend in the rolling window. */
  limitTokens: number;
  /** Rolling window size in ms. */
  windowMs: number;
}

export interface RuntimeBudgetRule {
  /** Maximum elapsed runtime in milliseconds. */
  maxElapsedMs: number;
}

export interface ProcessBudgetRule {
  /** Maximum concurrent managed processes. */
  maxConcurrent: number;
}

export interface PolicyClassRule {
  /** Deny this class entirely when true. */
  deny?: boolean;
  /** Optional stricter max risk ceiling for this class. */
  maxRiskScore?: number;
}

export interface ScopedActionBudgetRules {
  tenant?: Record<string, PolicyBudgetRule>;
  project?: Record<string, PolicyBudgetRule>;
  run?: Record<string, PolicyBudgetRule>;
}

export interface ScopedSpendBudgetRules {
  tenant?: SpendBudgetRule;
  project?: SpendBudgetRule;
  run?: SpendBudgetRule;
}

export interface ScopedTokenBudgetRules {
  tenant?: TokenBudgetRule;
  project?: TokenBudgetRule;
  run?: TokenBudgetRule;
}

export interface ScopedRuntimeBudgetRules {
  tenant?: RuntimeBudgetRule;
  project?: RuntimeBudgetRule;
  run?: RuntimeBudgetRule;
}

export interface ScopedProcessBudgetRules {
  tenant?: ProcessBudgetRule;
  project?: ProcessBudgetRule;
  run?: ProcessBudgetRule;
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

export interface RuntimePolicyBundleConfig {
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
  /** Session credential IDs that may be leased under this bundle. */
  credentialAllowList?: string[];
  /** Optional network egress restrictions for open-world tools. */
  networkAccess?: NetworkAccessRule;
  /** Optional filesystem write-root restrictions. */
  writeScope?: WriteScopeRule;
  /**
   * Action budget rules keyed by:
   * - `${type}:*` for all actions of a type
   * - `${type}:${name}` for exact action name
   */
  actionBudgets?: Record<string, PolicyBudgetRule>;
  /** Optional rolling spend budget. */
  spendBudget?: SpendBudgetRule;
  /** Optional rolling token budget. */
  tokenBudget?: TokenBudgetRule;
  /** Optional maximum elapsed runtime budget. */
  runtimeBudget?: RuntimeBudgetRule;
  /** Optional concurrent managed-process budget. */
  processBudget?: ProcessBudgetRule;
  /** Optional scoped action budgets keyed by tenant/project/run. */
  scopedActionBudgets?: ScopedActionBudgetRules;
  /** Optional scoped spend budgets keyed by tenant/project/run. */
  scopedSpendBudgets?: ScopedSpendBudgetRules;
  /** Optional scoped token budgets keyed by tenant/project/run. */
  scopedTokenBudgets?: ScopedTokenBudgetRules;
  /** Optional scoped elapsed-runtime budgets keyed by tenant/project/run. */
  scopedRuntimeBudgets?: ScopedRuntimeBudgetRules;
  /** Optional scoped managed-process budgets keyed by tenant/project/run. */
  scopedProcessBudgets?: ScopedProcessBudgetRules;
  /** Block actions with risk score above this threshold. */
  maxRiskScore?: number;
  /** Optional policy-class-specific deny/risk rules. */
  policyClassRules?: Partial<Record<PolicyClass, PolicyClassRule>>;
  /** Auto-trip configuration on repeated policy violations. */
  circuitBreaker?: CircuitBreakerConfig;
}

export interface RuntimePolicyConfig extends RuntimePolicyBundleConfig {
  /** Optional default scope identifiers for live runtime evaluation. */
  defaultTenantId?: string;
  defaultProjectId?: string;
  /** Optional live simulation mode for policy evaluation. */
  simulationMode?: PolicySimulationMode;
  /** Optional governance audit log configuration. */
  audit?: GovernanceAuditConfig;
  /** Restrictive overlays applied after the global bundle. */
  tenantBundles?: Record<string, RuntimePolicyBundleConfig>;
  projectBundles?: Record<string, RuntimePolicyBundleConfig>;
  /** Session credential catalog keyed by stable credential ID. */
  credentialCatalog?: Record<string, RuntimeSessionCredentialConfig>;
}

export interface GovernanceAuditRedactionConfig {
  /** Redact actor identifiers before persistence. */
  redactActors?: boolean;
  /** Dot-path fields to strip from payloads before persistence. */
  stripFields?: string[];
  /** Regex string patterns to redact across string payloads. */
  redactPatterns?: string[];
}

export interface GovernanceAuditConfig {
  /** Enable governance audit logging. */
  enabled?: boolean;
  /** HMAC signing key for record signatures. */
  signingKey?: string;
  /** Maximum record retention horizon in milliseconds. */
  retentionMs?: number;
  /** Maximum retained records after pruning. */
  maxEntries?: number;
  /** Whether pruned records are deleted or retained in an archive set. */
  retentionMode?: GovernanceAuditRetentionMode;
  /** Prevent any retention downgrade or destructive pruning for this log. */
  legalHold?: boolean;
  /** Redaction rules applied before hashing and persistence. */
  redaction?: GovernanceAuditRedactionConfig;
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
    | "token_budget_exceeded"
    | "runtime_budget_exceeded"
    | "process_budget_exceeded"
    | "risk_threshold_exceeded"
    | "policy_class_denied"
    | "policy_class_risk_exceeded"
    | "network_access_denied"
    | "write_scope_denied";
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
