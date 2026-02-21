import { describe, expect, it } from "vitest";
import {
  BENCHMARK_MANIFEST_SCHEMA_VERSION,
  hashBenchmarkManifest,
  parseBenchmarkManifest,
} from "./benchmark-manifest.js";

function makeManifest() {
  return {
    schemaVersion: BENCHMARK_MANIFEST_SCHEMA_VERSION,
    corpusVersion: "v1.0.0",
    baselineScenarioId: "baseline",
    k: 2,
    scenarios: [
      {
        id: "regression",
        title: "Regression",
        taskClass: "qa",
        riskTier: "high",
        expectedConstraints: ["guardrail", "verifier"],
        seeds: [22, 21, 21],
        fixtureTrace: "scenarios/regression.json",
      },
      {
        id: "baseline",
        title: "Baseline",
        taskClass: "qa",
        riskTier: "medium",
        expectedConstraints: ["verifier", "deterministic"],
        seeds: [12, 11],
        fixtureTrace: "scenarios/baseline.json",
      },
    ],
  } as const;
}

describe("benchmark manifest", () => {
  it("parses and canonicalizes scenarios deterministically", () => {
    const parsed = parseBenchmarkManifest(makeManifest());

    expect(parsed.scenarios.map((scenario) => scenario.id)).toEqual([
      "baseline",
      "regression",
    ]);
    expect(parsed.scenarios[0]!.seeds).toEqual([11, 12]);
    expect(parsed.scenarios[1]!.seeds).toEqual([21, 22]);
    expect(parsed.scenarios[0]!.expectedConstraints).toEqual([
      "deterministic",
      "verifier",
    ]);
  });

  it("rejects duplicate scenario ids and missing baseline references", () => {
    const duplicate = makeManifest();
    const duplicateMutable = duplicate as any;
    duplicateMutable.scenarios[1].id = "regression";
    expect(() => parseBenchmarkManifest(duplicateMutable)).toThrow(
      "duplicate scenario id",
    );

    const missingBaseline = makeManifest();
    const missingBaselineMutable = missingBaseline as any;
    missingBaselineMutable.baselineScenarioId = "does-not-exist";
    expect(() => parseBenchmarkManifest(missingBaselineMutable)).toThrow(
      "baselineScenarioId not found",
    );
  });

  it("produces stable hashes independent of scenario ordering in input", () => {
    const first = parseBenchmarkManifest(makeManifest());
    const secondInput = makeManifest();
    const secondMutable = secondInput as any;
    secondMutable.scenarios.reverse();
    const second = parseBenchmarkManifest(secondMutable);

    expect(hashBenchmarkManifest(first)).toBe(hashBenchmarkManifest(second));
  });
});
