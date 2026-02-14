import { describe, it, expect } from 'vitest';
import {
  applyProductionProfile,
  PRODUCTION_DELETION,
  PRODUCTION_EVIDENCE_RETENTION,
  PRODUCTION_ENDPOINT_EXPOSURE,
  PRODUCTION_POLICY,
  PRODUCTION_PROFILE,
  PRODUCTION_REDACTION,
  validateProductionReadiness,
} from './production-profile.js';

describe('production profile defaults', () => {
  it('exposes all required production defaults', () => {
    expect(PRODUCTION_PROFILE.policy.enabled).toBe(true);
    expect(PRODUCTION_PROFILE.policy.actionBudgets).toMatchObject({
      'tx_submission:*': { limit: 100, windowMs: 60_000 },
      'task_claim:*': { limit: 50, windowMs: 60_000 },
      'tool_call:*': { limit: 200, windowMs: 60_000 },
    });
    expect(PRODUCTION_PROFILE.policy.maxRiskScore).toBe(0.7);
    expect(PRODUCTION_PROFILE.endpointExposure).toEqual(PRODUCTION_ENDPOINT_EXPOSURE);
    expect(PRODUCTION_PROFILE.evidenceRetention).toEqual(PRODUCTION_EVIDENCE_RETENTION);
    expect(PRODUCTION_PROFILE.deletion).toEqual(PRODUCTION_DELETION);
  });
});

describe('applyProductionProfile', () => {
  it('uses production defaults when base is empty', () => {
    expect(applyProductionProfile({})).toEqual(PRODUCTION_PROFILE);
  });

  it('applies operator overrides', () => {
    const applied = applyProductionProfile({
      policy: {
        maxRiskScore: 0.5,
      },
    });

    expect(applied.policy.maxRiskScore).toBe(0.5);
  });

  it('prevents maxRiskScore from being weakened', () => {
    const applied = applyProductionProfile({
      policy: {
        maxRiskScore: 0.9,
      },
    });

    expect(applied.policy.maxRiskScore).toBe(0.7);
  });

  it('forces HTTPS when applying base config', () => {
    const applied = applyProductionProfile({
      endpointExposure: {
        maxPublicEndpoints: 3,
        requireHttps: false,
        allowedOrigins: ['https://example.com'],
        publicRateLimitPerMinute: 120,
      },
    });

    expect(applied.endpointExposure).toMatchObject({
      maxPublicEndpoints: 3,
      requireHttps: true,
      allowedOrigins: ['https://example.com'],
      publicRateLimitPerMinute: 120,
    });
  });

  it('merges redaction strip fields', () => {
    const applied = applyProductionProfile({
      redaction: {
        redactActors: true,
        alwaysStripFields: ['payload.apiKey', 'payload.secretKey'],
        redactPatterns: ['abc'],
      },
    });

    expect(applied.redaction.alwaysStripFields).toContain('payload.secretKey');
    expect(applied.redaction.alwaysStripFields).toContain('payload.privateKey');
    expect(applied.redaction.alwaysStripFields).toContain('payload.apiKey');
  });
});

describe('validateProductionReadiness', () => {
  it('passes for baseline production profile', () => {
    const checks = validateProductionReadiness(PRODUCTION_PROFILE);
    const failed = checks.find((check) => !check.passed);

    expect(failed).toBeUndefined();
    expect(checks).toHaveLength(6);
  });

  it('fails when policy is disabled', () => {
    const custom = {
      ...PRODUCTION_PROFILE,
      policy: {
        ...PRODUCTION_PROFILE.policy,
        enabled: false,
      },
    };
    const checks = validateProductionReadiness(custom);
    const enabledCheck = checks.find((check) => check.id === 'policy.enabled');

    expect(enabledCheck?.passed).toBe(false);
    expect(enabledCheck?.severity).toBe('critical');
  });

  it('fails when circuit breaker is disabled', () => {
    const custom = applyProductionProfile({
      policy: {
        circuitBreaker: {
          enabled: false,
          threshold: 10,
          windowMs: 300_000,
          mode: 'safe_mode',
        },
      },
    });

    const checks = validateProductionReadiness(custom);
    const cbCheck = checks.find((check) => check.id === 'policy.circuit_breaker');

    expect(cbCheck?.passed).toBe(false);
    expect(cbCheck?.severity).toBe('high');
  });

  it('fails when max risk is too high', () => {
    const custom = {
      ...PRODUCTION_PROFILE,
      policy: {
        ...PRODUCTION_PROFILE.policy,
        maxRiskScore: 0.95,
      },
    };

    const checks = validateProductionReadiness(custom);
    const riskCheck = checks.find((check) => check.id === 'policy.max_risk_score');

    expect(riskCheck?.passed).toBe(false);
    expect(riskCheck?.severity).toBe('high');
  });
});

describe('production defaults and budget values', () => {
  it('uses expected evidence retention defaults', () => {
    expect(PRODUCTION_EVIDENCE_RETENTION).toEqual({
      maxRetentionMs: 90 * 24 * 60 * 60 * 1_000,
      maxBundles: 1000,
      autoDelete: true,
      requireSealedExport: true,
    });
  });

  it('uses expected deletion defaults', () => {
    expect(PRODUCTION_DELETION).toEqual({
      replayEventTtlMs: 30 * 24 * 60 * 60 * 1_000,
      auditTrailTtlMs: 365 * 24 * 60 * 60 * 1_000,
      maxReplayEventsTotal: 1_000_000,
      deleteOnStartup: false,
    });
  });

  it('pins production action budgets', () => {
    expect(PRODUCTION_POLICY.actionBudgets?.['tx_submission:*']).toEqual({
      limit: 100,
      windowMs: 60_000,
    });
    expect(PRODUCTION_POLICY.actionBudgets?.['task_claim:*']).toEqual({
      limit: 50,
      windowMs: 60_000,
    });
  });

  it('requires redaction in production profile', () => {
    expect(PRODUCTION_REDACTION.redactActors).toBe(true);
    expect(PRODUCTION_REDACTION.redactPatterns).toContain('[1-9A-HJ-NP-Za-km-z]{44,}');
  });
});

describe('smoke', () => {
  it('accepts baseline produced config after applying profile', () => {
    const profile = applyProductionProfile({});
    const checks = validateProductionReadiness(profile);
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});
