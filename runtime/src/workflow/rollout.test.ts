import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../policy/engine.js';
import { WorkflowCanaryRollout } from './rollout.js';

describe('WorkflowCanaryRollout', () => {
  it('routes deterministically by request key while canarying', () => {
    const rollout = new WorkflowCanaryRollout('baseline', 'candidate', {
      enabled: true,
      canaryPercent: 0.4,
      seed: 42,
      minCanarySamples: 2,
    });

    const firstPass = Array.from({ length: 200 }, (_, i) => rollout.route(`req-${i}`));
    const secondPass = Array.from({ length: 200 }, (_, i) => rollout.route(`req-${i}`));

    expect(firstPass).toEqual(secondPass);
    expect(firstPass).toContain('baseline');
    expect(firstPass).toContain('candidate');
  });

  it('automatically rolls back on stop-loss regression and keeps rollback idempotent', () => {
    const rollout = new WorkflowCanaryRollout('baseline', 'candidate', {
      enabled: true,
      canaryPercent: 0.5,
      minCanarySamples: 4,
      stopLoss: {
        maxFailureRateDelta: 0.1,
        maxLatencyMsDelta: 300,
        maxCostUnitsDelta: 0.3,
      },
      seed: 7,
    });

    // Baseline healthy samples.
    for (let i = 0; i < 8; i++) {
      rollout.recordSample('baseline', { success: true, latencyMs: 500, costUnits: 1 });
    }

    // Canary regresses on all tracked stop-loss dimensions.
    for (let i = 0; i < 4; i++) {
      rollout.recordSample('candidate', { success: false, latencyMs: 1_500, costUnits: 2 });
    }

    const first = rollout.evaluate();
    const second = rollout.evaluate();

    expect(first.action).toBe('rollback');
    expect(first.reason).toBe('stop_loss_exceeded');
    expect(second.action).toBe('rollback');
    expect(second.reason).toBe('stop_loss_exceeded');
    expect(rollout.getStatus()).toBe('rolled_back');
    expect(rollout.route('post-rollback')).toBe('baseline');
  });

  it('uses policy hooks to deny promotion and trigger rollback', () => {
    const policy = new PolicyEngine({
      policy: {
        enabled: true,
        denyActions: ['workflow.rollout.promote'],
      },
    });

    const rollout = new WorkflowCanaryRollout('baseline', 'candidate', {
      enabled: true,
      canaryPercent: 0.5,
      minCanarySamples: 2,
      stopLoss: {
        maxFailureRateDelta: 0.5,
        maxLatencyMsDelta: 10_000,
        maxCostUnitsDelta: 10,
      },
      policyEngine: policy,
      seed: 13,
    });

    // Good canary metrics would normally promote.
    for (let i = 0; i < 4; i++) {
      rollout.recordSample('baseline', { success: true, latencyMs: 800, costUnits: 1.2 });
      rollout.recordSample('candidate', { success: true, latencyMs: 700, costUnits: 1.1 });
    }

    const decision = rollout.evaluate();

    expect(decision.action).toBe('rollback');
    expect(decision.reason).toBe('policy_denied');
    expect(rollout.getStatus()).toBe('rolled_back');
  });
});
