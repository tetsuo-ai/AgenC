import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeScorecardMetricDelta,
  readBenchmarkFixtureTrace,
  riskTierToScore,
  toRewardString,
} from "./runner-shared.js";
import type { BenchmarkScenarioManifest } from "./benchmark-manifest.js";

describe("runner-shared utilities", () => {
  it("maps risk tiers to deterministic numeric scores", () => {
    expect(riskTierToScore("low")).toBe(0.2);
    expect(riskTierToScore("medium")).toBe(0.5);
    expect(riskTierToScore("high")).toBe(0.85);
  });

  it("computes scorecard deltas field-by-field", () => {
    const delta = computeScorecardMetricDelta(
      {
        passRate: 0.8,
        passAtK: 0.9,
        passCaretK: 0.85,
        riskWeightedSuccess: 0.7,
        conformanceScore: 0.6,
        costNormalizedUtility: 0.5,
      },
      {
        passRate: 0.5,
        passAtK: 0.7,
        passCaretK: 0.65,
        riskWeightedSuccess: 0.4,
        conformanceScore: 0.3,
        costNormalizedUtility: 0.25,
      },
    );
    expect(delta.passRate).toBeCloseTo(0.3, 10);
    expect(delta.passAtK).toBeCloseTo(0.2, 10);
    expect(delta.passCaretK).toBeCloseTo(0.2, 10);
    expect(delta.riskWeightedSuccess).toBeCloseTo(0.3, 10);
    expect(delta.conformanceScore).toBeCloseTo(0.3, 10);
    expect(delta.costNormalizedUtility).toBeCloseTo(0.25, 10);
  });

  it("normalizes reward values to strings", () => {
    expect(toRewardString(undefined)).toBeUndefined();
    expect(toRewardString(42n)).toBe("42");
    expect(toRewardString("1234")).toBe("1234");
  });

  it("loads and normalizes fixture traces", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "runner-shared-test-"));
    const fixturePath = path.join(tempDir, "fixture-trace.json");
    await writeFile(
      fixturePath,
      JSON.stringify({
        schemaVersion: 1,
        traceId: "fixture-trace",
        seed: 0,
        createdAtMs: 1,
        events: [],
      }),
      "utf8",
    );
    const scenario = {
      id: "scenario-a",
      title: "Fixture Scenario",
      taskClass: "qa",
      riskTier: "low",
      expectedConstraints: ["deterministic_replay"],
      seeds: [1],
      fixtureTrace: fixturePath,
      verifierGated: false,
    } as BenchmarkScenarioManifest;

    const trace = await readBenchmarkFixtureTrace(scenario, 9, undefined);
    expect(trace).toMatchObject({
      traceId: "scenario-a:seed-9",
      seed: 9,
    });
  });
});
