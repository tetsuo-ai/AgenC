/**
 * Production deployment policy presets and validation.
 *
 * @module
 */

import type {
  CircuitBreakerConfig,
  DeletionDefaults,
  EndpointExposureConfig,
  EvidenceRetentionPolicy,
  PolicyBudgetRule,
  ProductionRedactionPolicy,
  RuntimePolicyConfig,
  SpendBudgetRule,
} from './types.js';

export interface ProductionReadinessCheck {
  /** Unique identifier for the readiness check. */
  id: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Human-readable status message. */
  message: string;
  /** Check severity. */
  severity: 'critical' | 'high' | 'medium';
}

export interface ProductionProfileConfig {
  /** Runtime policy controls for production environments. */
  policy: RuntimePolicyConfig;
  /** Endpoint exposure hardening. */
  endpointExposure: EndpointExposureConfig;
  /** Evidence retention policy. */
  evidenceRetention: EvidenceRetentionPolicy;
  /** Evidence redaction policy. */
  redaction: ProductionRedactionPolicy;
  /** Background deletion defaults. */
  deletion: DeletionDefaults;
}

const PRODUCTION_ACTION_BUDGETS: Record<string, PolicyBudgetRule> = {
  'tx_submission:*': {
    limit: 100,
    windowMs: 60_000,
  },
  'task_claim:*': {
    limit: 50,
    windowMs: 60_000,
  },
  'tool_call:*': {
    limit: 200,
    windowMs: 60_000,
  },
};

const PRODUCTION_SPEND_BUDGET: SpendBudgetRule = {
  limitLamports: 10_000_000_000n,
  windowMs: 3_600_000,
};

const PRODUCTION_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  enabled: true,
  threshold: 10,
  windowMs: 300_000,
  mode: 'safe_mode',
};

/** Default production policy configuration. */
export const PRODUCTION_POLICY: RuntimePolicyConfig = {
  enabled: true,
  actionBudgets: {
    ...PRODUCTION_ACTION_BUDGETS,
  },
  spendBudget: PRODUCTION_SPEND_BUDGET,
  maxRiskScore: 0.7,
  circuitBreaker: {
    ...PRODUCTION_CIRCUIT_BREAKER,
  },
};

/** Default endpoint exposure hardening. */
export const PRODUCTION_ENDPOINT_EXPOSURE: EndpointExposureConfig = {
  maxPublicEndpoints: 1,
  requireHttps: true,
  allowedOrigins: [],
  publicRateLimitPerMinute: 60,
};

/** Default evidence retention policy. */
export const PRODUCTION_EVIDENCE_RETENTION: EvidenceRetentionPolicy = {
  maxRetentionMs: 90 * 24 * 60 * 60 * 1_000,
  maxBundles: 1000,
  autoDelete: true,
  requireSealedExport: true,
};

/** Default production redaction policy. */
export const PRODUCTION_REDACTION: ProductionRedactionPolicy = {
  redactActors: true,
  alwaysStripFields: [
    'payload.onchain.trace',
    'payload.secretKey',
    'payload.privateKey',
  ],
  redactPatterns: ['[1-9A-HJ-NP-Za-km-z]{44,}'],
};

/** Default deletion defaults for production. */
export const PRODUCTION_DELETION: DeletionDefaults = {
  replayEventTtlMs: 30 * 24 * 60 * 60 * 1_000,
  auditTrailTtlMs: 365 * 24 * 60 * 60 * 1_000,
  maxReplayEventsTotal: 1_000_000,
  deleteOnStartup: false,
};

/** Complete production profile preset. */
export const PRODUCTION_PROFILE: ProductionProfileConfig = {
  policy: PRODUCTION_POLICY,
  endpointExposure: PRODUCTION_ENDPOINT_EXPOSURE,
  evidenceRetention: PRODUCTION_EVIDENCE_RETENTION,
  redaction: PRODUCTION_REDACTION,
  deletion: PRODUCTION_DELETION,
};

export function applyProductionProfile(
  base: Partial<ProductionProfileConfig> = {},
): ProductionProfileConfig {
  return {
    policy: {
      ...PRODUCTION_POLICY,
      ...(base.policy ?? {}),
      enabled: true,
      actionBudgets: {
        ...PRODUCTION_POLICY.actionBudgets,
        ...(base.policy?.actionBudgets ?? {}),
      },
      maxRiskScore: Math.min(
        base.policy?.maxRiskScore ?? PRODUCTION_POLICY.maxRiskScore ?? 0,
        PRODUCTION_POLICY.maxRiskScore ?? 0,
      ),
    },
    endpointExposure: {
      ...PRODUCTION_ENDPOINT_EXPOSURE,
      ...(base.endpointExposure ?? {}),
      requireHttps: true,
    },
    evidenceRetention: {
      ...PRODUCTION_EVIDENCE_RETENTION,
      ...(base.evidenceRetention ?? {}),
    },
    redaction: {
      ...PRODUCTION_REDACTION,
      ...(base.redaction ?? {}),
      alwaysStripFields: Array.from(
        new Set([
          ...PRODUCTION_REDACTION.alwaysStripFields,
          ...(base.redaction?.alwaysStripFields ?? []),
        ]),
      ),
    },
    deletion: {
      ...PRODUCTION_DELETION,
      ...(base.deletion ?? {}),
    },
  };
}

export function validateProductionReadiness(
  config: ProductionProfileConfig,
): ProductionReadinessCheck[] {
  return [
    {
      id: 'policy.enabled',
      passed: config.policy.enabled === true,
      message:
        config.policy.enabled === true
          ? 'Policy engine is enabled'
          : 'Policy engine must be enabled in production',
      severity: 'critical',
    },
    {
      id: 'policy.max_risk_score',
      passed: typeof config.policy.maxRiskScore === 'number' && config.policy.maxRiskScore <= 0.8,
      message:
        config.policy.maxRiskScore === undefined
          ? 'Max risk score is unset'
          : `Max risk score: ${config.policy.maxRiskScore}`,
      severity: 'high',
    },
    {
      id: 'policy.circuit_breaker',
      passed: config.policy.circuitBreaker?.enabled === true,
      message:
        config.policy.circuitBreaker?.enabled === true
          ? 'Circuit breaker is enabled'
          : 'Circuit breaker should be enabled',
      severity: 'high',
    },
    {
      id: 'endpoint.require_https',
      passed: config.endpointExposure.requireHttps === true,
      message:
        config.endpointExposure.requireHttps === true
          ? 'HTTPS required'
          : 'HTTPS is not required',
      severity: 'critical',
    },
    {
      id: 'evidence.sealed_export',
      passed: config.evidenceRetention.requireSealedExport === true,
      message:
        config.evidenceRetention.requireSealedExport === true
          ? 'Sealed evidence export required'
          : 'Sealed evidence export is not required',
      severity: 'medium',
    },
    {
      id: 'redaction.actors',
      passed: config.redaction.redactActors === true,
      message:
        config.redaction.redactActors === true
          ? 'Actor redaction enabled'
          : 'Actor redaction disabled',
      severity: 'medium',
    },
  ];
}
