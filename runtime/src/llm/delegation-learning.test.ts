import { describe, expect, it } from "vitest";
import {
  InMemoryDelegationTrajectorySink,
  computeDelegationFinalReward,
  computeUsefulDelegationProxy,
  deriveDelegationContextClusterId,
  DelegationBanditPolicyTuner,
} from "./delegation-learning.js";

describe("delegation-learning", () => {
  it("computes bounded final reward components", () => {
    const reward = computeDelegationFinalReward({
      qualityProxy: 0.9,
      tokenCost: 30_000,
      latencyMs: 15_000,
      errorCount: 0,
    });

    expect(reward.value).toBeGreaterThan(0);
    expect(reward.qualityComponent).toBeCloseTo(0.9, 3);
    expect(reward.costPenalty).toBeGreaterThan(0);
    expect(reward.latencyPenalty).toBeGreaterThan(0);
    expect(reward.errorPenalty).toBe(0);
  });

  it("derives stable context cluster ids from planning features", () => {
    const cluster = deriveDelegationContextClusterId({
      complexityScore: 8,
      subagentStepCount: 3,
      hasHistory: true,
      highRiskPlan: false,
    });

    expect(cluster).toBe("high:fanout:history:normal");
  });

  it("stores bounded trajectory records in memory sink", () => {
    const sink = new InMemoryDelegationTrajectorySink({ maxRecords: 2 });

    sink.record({
      schemaVersion: 1,
      traceId: "trace-1",
      turnId: "turn-1",
      turnType: "parent",
      timestampMs: 1,
      stateFeatures: {
        sessionId: "s-1",
        contextClusterId: "low:none:fresh:normal",
        complexityScore: 1,
        plannerStepCount: 0,
        subagentStepCount: 0,
        deterministicStepCount: 0,
        synthesisStepCount: 0,
        dependencyDepth: 0,
        fanout: 0,
      },
      action: {
        delegated: false,
        strategyArmId: "balanced",
        threshold: 0.6,
        selectedTools: [],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 1,
        tokenCost: 10,
        latencyMs: 5,
        errorCount: 0,
      },
      finalReward: {
        value: 0.95,
        qualityComponent: 1,
        costPenalty: 0,
        latencyPenalty: 0,
        errorPenalty: 0,
      },
    });
    sink.record({
      schemaVersion: 1,
      traceId: "trace-2",
      turnId: "turn-2",
      turnType: "child",
      timestampMs: 2,
      stateFeatures: {
        sessionId: "s-2",
        contextClusterId: "medium:single:history:normal",
        complexityScore: 5,
        plannerStepCount: 2,
        subagentStepCount: 1,
        deterministicStepCount: 1,
        synthesisStepCount: 0,
        dependencyDepth: 1,
        fanout: 1,
      },
      action: {
        delegated: true,
        strategyArmId: "balanced",
        threshold: 0.6,
        selectedTools: ["system.readFile"],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 0.8,
        tokenCost: 100,
        latencyMs: 20,
        errorCount: 0,
      },
      finalReward: {
        value: 0.7,
        qualityComponent: 0.8,
        costPenalty: 0.001,
        latencyPenalty: 0.001,
        errorPenalty: 0,
      },
    });
    sink.record({
      schemaVersion: 1,
      traceId: "trace-3",
      turnId: "turn-3",
      turnType: "parent",
      timestampMs: 3,
      stateFeatures: {
        sessionId: "s-3",
        contextClusterId: "critical:fanout:history:highrisk",
        complexityScore: 10,
        plannerStepCount: 4,
        subagentStepCount: 3,
        deterministicStepCount: 1,
        synthesisStepCount: 1,
        dependencyDepth: 2,
        fanout: 3,
      },
      action: {
        delegated: true,
        strategyArmId: "aggressive",
        threshold: 0.5,
        selectedTools: ["system.readFile", "system.searchFiles"],
        childConfig: {
          maxDepth: 4,
          maxFanoutPerTurn: 8,
          timeoutMs: 120_000,
        },
      },
      immediateOutcome: {
        qualityProxy: 0.5,
        tokenCost: 50_000,
        latencyMs: 8_000,
        errorCount: 1,
      },
      finalReward: {
        value: -0.1,
        qualityComponent: 0.5,
        costPenalty: 0.4,
        latencyPenalty: 0.08,
        errorPenalty: 1,
      },
    });

    const snapshot = sink.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.turnId).toBe("turn-2");
    expect(snapshot[1]?.turnId).toBe("turn-3");
  });

  it("tracks contextual arm rewards and favors higher-value arms", () => {
    const tuner = new DelegationBanditPolicyTuner({
      enabled: true,
      epsilon: 0,
      minSamplesPerArm: 1,
      random: () => 0.99,
      explorationBudget: 0,
      arms: [
        { id: "conservative", thresholdOffset: 0.1 },
        { id: "balanced", thresholdOffset: 0 },
        { id: "aggressive", thresholdOffset: -0.1 },
      ],
    });

    const clusterId = "high:fanout:history:normal";

    // Initial rounds force one sample per arm.
    const first = tuner.selectArm({ contextClusterId: clusterId });
    tuner.recordOutcome({
      contextClusterId: clusterId,
      armId: first.armId,
      reward: -0.4,
    });

    const second = tuner.selectArm({ contextClusterId: clusterId });
    tuner.recordOutcome({
      contextClusterId: clusterId,
      armId: second.armId,
      reward: 0.8,
    });

    const third = tuner.selectArm({ contextClusterId: clusterId });
    tuner.recordOutcome({
      contextClusterId: clusterId,
      armId: third.armId,
      reward: 0.2,
    });

    const selected = tuner.selectArm({ contextClusterId: clusterId });
    const stats = tuner.snapshot({ contextClusterId: clusterId })[clusterId] ?? [];

    expect(stats).toHaveLength(3);
    expect(selected.reason).toBe("ucb_exploitation");

    const top = stats[0];
    expect(top?.meanReward).toBeGreaterThanOrEqual(
      (stats[1]?.meanReward ?? Number.NEGATIVE_INFINITY),
    );
    expect(top?.meanReward).toBeGreaterThanOrEqual(
      (stats[2]?.meanReward ?? Number.NEGATIVE_INFINITY),
    );
  });

  it("applies threshold offsets from selected arms", () => {
    const tuner = new DelegationBanditPolicyTuner({
      arms: [{ id: "aggressive", thresholdOffset: -0.2 }],
      enabled: true,
    });

    expect(tuner.applyThresholdOffset(0.7, "aggressive")).toBeCloseTo(0.5, 6);
    expect(tuner.applyThresholdOffset(0.05, "aggressive")).toBe(0);
  });

  it("derives useful delegation proxy for production without ground truth", () => {
    const reward = computeDelegationFinalReward({
      qualityProxy: 0.9,
      tokenCost: 8_000,
      latencyMs: 4_000,
      errorCount: 0,
    });
    const proxy = computeUsefulDelegationProxy({
      delegated: true,
      stopReason: "completed",
      failedToolCalls: 0,
      estimatedRecallsAvoided: 3,
      verifier: {
        performed: true,
        overall: "pass",
        confidence: 0.92,
      },
      reward,
    });

    expect(proxy.score).toBeGreaterThan(0.62);
    expect(proxy.useful).toBe(true);
  });

  it("marks non-completed delegated turns as not useful", () => {
    const reward = computeDelegationFinalReward({
      qualityProxy: 0.7,
      tokenCost: 15_000,
      latencyMs: 12_000,
      errorCount: 1,
    });
    const proxy = computeUsefulDelegationProxy({
      delegated: true,
      stopReason: "tool_error",
      failedToolCalls: 2,
      estimatedRecallsAvoided: 1,
      verifier: {
        performed: true,
        overall: "retry",
        confidence: 0.4,
      },
      reward,
    });

    expect(proxy.useful).toBe(false);
    expect(proxy.score).toBeLessThan(0.62);
  });
});
