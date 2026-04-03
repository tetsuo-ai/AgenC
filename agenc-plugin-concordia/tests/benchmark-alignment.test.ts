import { describe, expect, it } from "vitest";
import {
  MEMORY_ARENA_INSPIRED_SCENARIOS,
  summarizeConcordiaBenchmarkResults,
} from "../src/benchmark-alignment.js";

describe("benchmark alignment", () => {
  it("defines MemoryArena-inspired scenarios for continuity, replay, and isolation", () => {
    expect(MEMORY_ARENA_INSPIRED_SCENARIOS.map((scenario) => scenario.scenario_id)).toEqual([
      "multi-run-market-town",
      "checkpoint-lineage-resume",
      "hydrate-then-stream-reconnect",
    ]);
    expect(
      MEMORY_ARENA_INSPIRED_SCENARIOS.every(
        (scenario) => scenario.source === "memoryarena-inspired" && scenario.expected_assertions.length > 0,
      ),
    ).toBe(true);
  });

  it("summarizes governance-oriented benchmark dimensions", () => {
    const summary = summarizeConcordiaBenchmarkResults([
      {
        scenario_id: "multi-run-market-town",
        correctness: 1,
        continuity_governance: 0.8,
        replay_correctness: 0.9,
        selective_carry_over: 0.75,
        cross_run_isolation: 1,
      },
      {
        scenario_id: "checkpoint-lineage-resume",
        correctness: 0.95,
        continuity_governance: 0.9,
        replay_correctness: 0.85,
        selective_carry_over: 0.7,
        cross_run_isolation: 0.95,
      },
    ], 0.8);

    expect(summary.scenario_count).toBe(2);
    expect(summary.averages.correctness).toBe(0.975);
    expect(summary.averages.selective_carry_over).toBe(0.725);
    expect(summary.below_threshold).toEqual([
      {
        scenario_id: "multi-run-market-town",
        dimension: "selective_carry_over",
        score: 0.75,
      },
      {
        scenario_id: "checkpoint-lineage-resume",
        dimension: "selective_carry_over",
        score: 0.7,
      },
    ]);
  });
});
