import { describe, expect, it } from "vitest";
import {
  DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
  runDelegationBenchmarkSuite,
  serializeDelegationBenchmarkSuiteResult,
} from "./delegation-benchmark.js";

describe("delegation benchmark suite", () => {
  it("is deterministic under fixed time/run configuration", async () => {
    const config = {
      now: () => 1_700_000_300_000,
      runId: "delegation-suite-deterministic",
      k: 2,
    } as const;

    const first = await runDelegationBenchmarkSuite(config);
    const second = await runDelegationBenchmarkSuite(config);

    expect(serializeDelegationBenchmarkSuiteResult(first)).toBe(
      serializeDelegationBenchmarkSuiteResult(second),
    );
  });

  it("covers decomposition modes and computes baseline deltas", async () => {
    const result = await runDelegationBenchmarkSuite({
      now: () => 1_700_000_300_100,
      runId: "delegation-suite-coverage",
      k: 2,
    });

    expect(result.summary.baselineScenarioId).toBe(
      DELEGATION_BENCHMARK_BASELINE_SCENARIO_ID,
    );
    expect(result.summary.totalCases).toBeGreaterThan(0);
    expect(result.summary.delegatedCases).toBeGreaterThan(0);
    expect(result.summary.delegationAttemptRate).toBeGreaterThan(0);

    const modes = new Set(
      result.summary.scenarioSummaries.map((entry) => entry.mode),
    );
    expect(modes.has("no_delegation")).toBe(true);
    expect(modes.has("single_child")).toBe(true);
    expect(modes.has("parallel_children")).toBe(true);
    expect(modes.has("handoff")).toBe(true);
    expect(modes.has("verifier_retry")).toBe(true);

    expect(result.summary.passAtKDeltaVsBaseline).toBeGreaterThan(0);
    expect(result.summary.passCaretKDeltaVsBaseline).toBeGreaterThan(0);
    expect(result.summary.qualityDeltaVsBaseline).toBeGreaterThan(0);
  });
});
