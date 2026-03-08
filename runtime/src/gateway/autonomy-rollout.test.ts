import { describe, expect, it } from "vitest";
import { buildBackgroundRunQualityArtifact } from "../eval/background-run-quality.js";
import type { DelegationBenchmarkSummary } from "../eval/delegation-benchmark.js";
import {
  evaluateAutonomyCanaryAdmission,
  evaluateAutonomyRolloutReadiness,
  parseAutonomyRolloutManifest,
} from "./autonomy-rollout.js";
import type { GatewayAutonomyConfig } from "./types.js";

function makeHealthyAutonomyConfig(): GatewayAutonomyConfig {
  return {
    enabled: true,
    featureFlags: {
      backgroundRuns: true,
      multiAgent: true,
      notifications: true,
      replayGates: true,
      canaryRollout: true,
    },
    killSwitches: {
      backgroundRuns: false,
      multiAgent: false,
      notifications: false,
      replayGates: false,
      canaryRollout: false,
    },
    slo: {
      runStartLatencyMs: 1_000,
      updateCadenceMs: 10_000,
      completionAccuracyRate: 0.95,
      recoverySuccessRate: 0.9,
      stopLatencyMs: 2_000,
      eventLossRate: 0,
    },
    canary: {
      enabled: true,
      tenantAllowList: ["tenant-a"],
      featureAllowList: ["backgroundRuns", "multiAgent"],
      domainAllowList: ["generic", "research"],
      percentage: 1,
    },
  };
}

function makeHealthyBackgroundRunArtifact() {
  return buildBackgroundRunQualityArtifact({
    runId: "quality-pass",
    generatedAtMs: 1,
    scenarios: [
      {
        scenarioId: "canary_completion",
        category: "canary",
        ok: true,
        finalState: "completed",
        latencyMs: 250,
        timeToFirstAckMs: 100,
        timeToFirstVerifiedUpdateMs: 500,
        stopLatencyMs: 250,
        falseCompletion: false,
        blockedWithoutNotice: false,
        recoverySucceeded: true,
        verifierAccurate: true,
        replayConsistent: true,
        transcriptScore: 1,
        toolTrajectoryScore: 1,
        endStateCorrectnessScore: 1,
        verifierCorrectnessScore: 1,
        restartRecoveryCorrectnessScore: 1,
        operatorUxCorrectnessScore: 1,
        tokenCount: 100,
        eventCount: 4,
      },
    ],
  });
}

function makeHealthyDelegationBenchmark(): DelegationBenchmarkSummary {
  return {
    totalCases: 10,
    delegatedCases: 6,
    usefulDelegations: 7,
    harmfulDelegations: 1,
    plannerExecutionMismatches: 0,
    childTimeouts: 0,
    childFailures: 0,
    synthesisConflicts: 0,
    depthCapHits: 0,
    fanoutCapHits: 0,
    delegationAttemptRate: 0.6,
    usefulDelegationRate: 0.7,
    harmfulDelegationRate: 0.1,
    plannerToExecutionMismatchRate: 0,
    childTimeoutRate: 0,
    childFailureRate: 0,
    synthesisConflictRate: 0,
    depthCapHitRate: 0,
    fanoutCapHitRate: 0,
    costDeltaVsBaseline: 0.05,
    latencyDeltaVsBaseline: 0.02,
    qualityDeltaVsBaseline: 0.15,
    passAtKDeltaVsBaseline: 0.10,
    passCaretKDeltaVsBaseline: 0.08,
    baselineScenarioId: "baseline_no_delegation",
    k: 2,
    scenarioSummaries: [],
  };
}

function makeManifest(overrides: Record<string, unknown> = {}) {
  return parseAutonomyRolloutManifest({
    schemaVersion: 1,
    migration: {
      playbook: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Schema Migration and Backward Compatibility",
      },
      backwardCompatibilityGuarantee:
        "Persisted autonomy records are backward-compatible across one schema generation.",
      rollbackWindow: "One release train",
    },
    canary: {
      strategy: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Canary Rollout Strategy",
      },
      successCriteria: [
        "Background-run quality gates stay green.",
        "No autonomy SLO regression during the canary window.",
      ],
      automatedGate: "npm --prefix runtime run autonomy:rollout:gates",
    },
    runbooks: {
      stuck_run: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Stuck Runs",
      },
      split_brain: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Split-Brain",
      },
      bad_compaction: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Bad Compaction",
      },
      webhook_failure: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Webhook Failure",
      },
      policy_regression: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Policy Regressions",
      },
    },
    drills: {
      stuck_run: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
      split_brain: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
      bad_compaction: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
      webhook_failure: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
      policy_regression: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
      rollback: {
        validated: true,
        testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
      },
    },
    rollback: {
      tested: true,
      strategy: {
        path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
        section: "Rollback and Kill Switches",
      },
      testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
    },
    externalReview: {
      security: false,
      privacy: false,
      compliance: false,
    },
    ...overrides,
  });
}

describe("autonomy-rollout", () => {
  it("treats pending external review as a broad-rollout blocker but not a limited-rollout blocker", () => {
    const evaluation = evaluateAutonomyRolloutReadiness({
      autonomy: makeHealthyAutonomyConfig(),
      backgroundRunQualityArtifact: makeHealthyBackgroundRunArtifact(),
      delegationBenchmark: makeHealthyDelegationBenchmark(),
      manifest: makeManifest(),
    });

    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.limitedRolloutReady).toBe(true);
    expect(evaluation.broadRolloutReady).toBe(false);
    expect(evaluation.externalGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "autonomy.external_review.security" }),
        expect.objectContaining({ code: "autonomy.external_review.privacy" }),
        expect.objectContaining({ code: "autonomy.external_review.compliance" }),
      ]),
    );
  });

  it("flags missing switches, SLO regressions, and unhealthy multi-agent evidence", () => {
    const autonomy = makeHealthyAutonomyConfig();
    const degradedArtifact = buildBackgroundRunQualityArtifact({
      runId: "quality-fail",
      generatedAtMs: 1,
      scenarios: [
        {
          scenarioId: "failed_canary",
          category: "canary",
          ok: false,
          finalState: "failed",
          latencyMs: 9_000,
          timeToFirstAckMs: 4_000,
          timeToFirstVerifiedUpdateMs: 20_000,
          stopLatencyMs: 4_500,
          falseCompletion: true,
          blockedWithoutNotice: true,
          recoverySucceeded: false,
          verifierAccurate: false,
          replayConsistent: false,
          transcriptScore: 0.2,
          toolTrajectoryScore: 0.2,
          endStateCorrectnessScore: 0.2,
          verifierCorrectnessScore: 0.2,
          restartRecoveryCorrectnessScore: 0.2,
          operatorUxCorrectnessScore: 0.2,
          tokenCount: 4_000,
          eventCount: 3,
        },
      ],
    });
    const harmfulDelegation: DelegationBenchmarkSummary = {
      ...makeHealthyDelegationBenchmark(),
      usefulDelegationRate: 0.25,
      harmfulDelegationRate: 0.6,
      qualityDeltaVsBaseline: -0.1,
      passAtKDeltaVsBaseline: -0.1,
      passCaretKDeltaVsBaseline: -0.05,
    };

    const evaluation = evaluateAutonomyRolloutReadiness({
      autonomy: {
        ...autonomy,
        killSwitches: {
          ...autonomy.killSwitches,
          canaryRollout: undefined,
        },
      },
      backgroundRunQualityArtifact: degradedArtifact,
      delegationBenchmark: harmfulDelegation,
      manifest: makeManifest(),
    });

    expect(evaluation.limitedRolloutReady).toBe(false);
    expect(evaluation.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "autonomy.kill_switch.canaryRollout" }),
        expect.objectContaining({ code: "autonomy.slo.run_start_latency" }),
        expect.objectContaining({ code: "autonomy.quality_gate.false_completion_rate" }),
        expect.objectContaining({ code: "autonomy.multi_agent.harmful_rate" }),
        expect.objectContaining({ code: "autonomy.multi_agent.quality_delta" }),
      ]),
    );
  });

  it("requires rollback validation and drill coverage before rollout is marked ready", () => {
    const manifest = makeManifest({
      drills: {
        stuck_run: {
          validated: true,
          testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
        },
        split_brain: {
          validated: false,
          testRefs: [],
        },
        bad_compaction: {
          validated: true,
          testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
        },
        webhook_failure: {
          validated: true,
          testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
        },
        policy_regression: {
          validated: true,
          testRefs: ["runtime/src/gateway/autonomy-rollout.test.ts"],
        },
        rollback: {
          validated: false,
          testRefs: [],
        },
      },
      rollback: {
        tested: false,
        strategy: {
          path: "docs/AUTONOMY_RUNTIME_ROLLOUT.md",
          section: "Rollback and Kill Switches",
        },
        testRefs: [],
      },
    });

    const evaluation = evaluateAutonomyRolloutReadiness({
      autonomy: makeHealthyAutonomyConfig(),
      backgroundRunQualityArtifact: makeHealthyBackgroundRunArtifact(),
      delegationBenchmark: makeHealthyDelegationBenchmark(),
      manifest,
    });

    expect(evaluation.limitedRolloutReady).toBe(false);
    expect(evaluation.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "autonomy.rollback.untested" }),
        expect.objectContaining({ code: "autonomy.drill.split_brain" }),
        expect.objectContaining({ code: "autonomy.drill.rollback" }),
      ]),
    );
  });

  it("evaluates canary admission by tenant, feature, domain, and cohort percentage", () => {
    const autonomy = makeHealthyAutonomyConfig();

    expect(
      evaluateAutonomyCanaryAdmission({
        autonomy,
        tenantId: "tenant-a",
        feature: "backgroundRuns",
        domain: "generic",
        stableKey: "session-1",
      }),
    ).toMatchObject({
      allowed: true,
      cohort: "canary",
    });

    expect(
      evaluateAutonomyCanaryAdmission({
        autonomy,
        tenantId: "tenant-b",
        feature: "backgroundRuns",
        domain: "generic",
        stableKey: "session-1",
      }),
    ).toMatchObject({
      allowed: false,
      cohort: "holdback",
      reason: "Tenant tenant-b is outside the canary allow-list.",
    });

    expect(
      evaluateAutonomyCanaryAdmission({
        autonomy: {
          ...autonomy,
          canary: {
            ...autonomy.canary,
            percentage: 0,
          },
        },
        tenantId: "tenant-a",
        feature: "backgroundRuns",
        domain: "generic",
        stableKey: "session-1",
      }),
    ).toMatchObject({
      allowed: false,
      cohort: "holdback",
    });
  });
});
