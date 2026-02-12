/**
 * Adaptive verifier scheduler for attempt planning and route selection.
 *
 * @module
 */

import type { VerifierAdaptiveRiskConfig } from './types.js';
import type { RiskTier } from './risk-scoring.js';

export type VerifierRouteStrategy = 'single_pass' | 'retry_execute' | 'revision_first';

export interface VerifierScheduleInput {
  adaptiveEnabled: boolean;
  riskTier: RiskTier;
  baseMaxAttempts: number;
  hasRevisionExecutor: boolean;
  reexecuteOnNeedsRevision: boolean;
  adaptiveRiskConfig?: VerifierAdaptiveRiskConfig;
}

export interface VerifierSchedulePlan {
  riskTier: RiskTier;
  route: VerifierRouteStrategy;
  maxAttempts: number;
  maxDisagreements: number;
  metadata: Record<string, string | number | boolean>;
}

function normalizeAttempts(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function resolveRoute(
  tier: RiskTier,
  adaptiveRiskConfig: VerifierAdaptiveRiskConfig | undefined,
): VerifierRouteStrategy {
  const routeByRisk = adaptiveRiskConfig?.routeByRisk;
  if (routeByRisk?.[tier]) {
    return routeByRisk[tier]!;
  }

  if (tier === 'low') return 'single_pass';
  if (tier === 'medium') return 'retry_execute';
  return 'revision_first';
}

function resolveMaxDisagreements(
  tier: RiskTier,
  adaptiveRiskConfig: VerifierAdaptiveRiskConfig | undefined,
): number {
  const configured = adaptiveRiskConfig?.maxDisagreementsByRisk?.[tier];
  if (configured !== undefined && Number.isFinite(configured)) {
    return Math.max(1, Math.floor(configured));
  }

  if (tier === 'low') return 1;
  if (tier === 'medium') return 2;
  return 3;
}

/**
 * Plan verifier route and attempt budget deterministically.
 */
export function planVerifierSchedule(input: VerifierScheduleInput): VerifierSchedulePlan {
  if (!input.adaptiveEnabled) {
    return {
      riskTier: input.riskTier,
      route: 'revision_first',
      maxAttempts: normalizeAttempts(input.baseMaxAttempts),
      maxDisagreements: Number.MAX_SAFE_INTEGER,
      metadata: {
        source: 'legacy',
      },
    };
  }

  const route = resolveRoute(input.riskTier, input.adaptiveRiskConfig);

  let maxAttempts = normalizeAttempts(input.baseMaxAttempts);
  if (route === 'single_pass') {
    maxAttempts = 1;
  } else if (route === 'retry_execute') {
    maxAttempts = Math.max(2, maxAttempts);
  }

  return {
    riskTier: input.riskTier,
    route,
    maxAttempts,
    maxDisagreements: resolveMaxDisagreements(input.riskTier, input.adaptiveRiskConfig),
    metadata: {
      source: 'adaptive',
    },
  };
}
