import { describe, expect, it } from "vitest";
import { extractTaskRiskFeatures, scoreTaskRisk } from "./risk-scoring.js";
import { createTask as makeTask } from "./test-utils.js";

describe("risk scoring", () => {
  it("extracts bounded feature values", () => {
    const nowMs = 1_700_000_000_000;
    const task = makeTask({
      reward: 500_000_000n,
      deadline: Math.floor(nowMs / 1000) + 300,
      maxWorkers: 4,
      currentClaims: 3,
      taskType: 2,
    });

    const features = extractTaskRiskFeatures(
      task,
      {
        nowMs,
        verifierDisagreementRate: 0.7,
        rollbackRate: 0.2,
      },
      {
        taskTypeRiskMultipliers: { 2: 0.9 },
      },
    );

    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("scores high-risk tasks above low-risk tasks with explainable contributions", () => {
    const nowMs = 1_700_000_000_000;

    const lowRiskTask = makeTask({
      reward: 1_000n,
      deadline: Math.floor(nowMs / 1000) + 86_400,
      currentClaims: 0,
      maxWorkers: 4,
      taskType: 0,
    });

    const highRiskTask = makeTask({
      reward: 5_000_000_000n,
      deadline: Math.floor(nowMs / 1000) + 60,
      currentClaims: 4,
      maxWorkers: 4,
      taskType: 2,
    });

    const low = scoreTaskRisk(lowRiskTask, {
      nowMs,
      verifierDisagreementRate: 0.05,
      rollbackRate: 0.02,
    });

    const high = scoreTaskRisk(highRiskTask, {
      nowMs,
      verifierDisagreementRate: 0.7,
      rollbackRate: 0.4,
    });

    expect(high.score).toBeGreaterThan(low.score);
    expect(high.contributions).toHaveLength(6);
    expect(high.contributions[0]).toHaveProperty("feature");
    expect(high.contributions[0]).toHaveProperty("contribution");
  });

  it("respects configured tier thresholds", () => {
    const task = makeTask({ reward: 100_000_000n, taskType: 1 });

    const result = scoreTaskRisk(
      task,
      {
        verifierDisagreementRate: 0.35,
        rollbackRate: 0.2,
      },
      {
        enabled: true,
        mediumRiskThreshold: 0.2,
        highRiskThreshold: 0.4,
      },
    );

    expect(["low", "medium", "high"]).toContain(result.tier);
    expect(result.metadata.mediumRiskThreshold).toBe(0.2);
    expect(result.metadata.highRiskThreshold).toBe(0.4);
  });
});
