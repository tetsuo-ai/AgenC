import { describe, expect, it } from "vitest";
import {
  searchDecompositionPolicies,
  type DecompositionDagVariant,
  type DecompositionReplayFixture,
} from "./decomposition-search.js";

function fixture(
  fixtureId: string,
  completed: boolean,
  latencyMs: number,
): DecompositionReplayFixture {
  return {
    fixtureId,
    trace: {
      schemaVersion: 1,
      traceId: `${fixtureId}:trace`,
      seed: 7,
      createdAtMs: 1,
      events: [
        {
          seq: 1,
          type: "discovered",
          taskPda: `${fixtureId}:task`,
          timestampMs: 10,
          payload: {},
        },
        {
          seq: 2,
          type: "claimed",
          taskPda: `${fixtureId}:task`,
          timestampMs: 20,
          payload: {},
        },
        {
          seq: 3,
          type: "executed",
          taskPda: `${fixtureId}:task`,
          timestampMs: 30,
          payload: {},
        },
        {
          seq: 4,
          type: completed ? "completed" : "failed",
          taskPda: `${fixtureId}:task`,
          timestampMs: 30 + latencyMs,
          payload: completed ? { completionTx: `${fixtureId}:done` } : { error: "boom" },
        },
      ],
    },
  };
}

describe("decomposition-search", () => {
  it("evaluates variants deterministically over replay fixtures", () => {
    const fixtures = [
      fixture("fx-a", true, 500),
      fixture("fx-b", true, 900),
      fixture("fx-c", false, 700),
    ];
    const variants: DecompositionDagVariant[] = [
      {
        variantId: "balanced-v1",
        nodeCount: 3,
        edgeCount: 2,
        maxDepth: 2,
        maxParallelism: 2,
        strategyArmId: "balanced",
      },
      {
        variantId: "aggressive-v2",
        nodeCount: 4,
        edgeCount: 4,
        maxDepth: 2,
        maxParallelism: 3,
        strategyArmId: "aggressive",
      },
      {
        variantId: "conservative-v1",
        nodeCount: 2,
        edgeCount: 1,
        maxDepth: 1,
        maxParallelism: 1,
        strategyArmId: "conservative",
      },
    ];

    const first = searchDecompositionPolicies({ fixtures, variants });
    const second = searchDecompositionPolicies({ fixtures, variants });

    expect(first).toEqual(second);
    expect(first.variantScores).toHaveLength(3);
    expect(first.paretoFrontierIds.length).toBeGreaterThan(0);
  });

  it("promotes only pareto-frontier variants that satisfy quality/cost gates", () => {
    const fixtures = [
      fixture("fx-1", true, 600),
      fixture("fx-2", true, 650),
      fixture("fx-3", true, 700),
    ];
    const variants: DecompositionDagVariant[] = [
      {
        variantId: "frontier-good",
        nodeCount: 3,
        edgeCount: 2,
        maxDepth: 2,
        maxParallelism: 2,
        strategyArmId: "balanced",
      },
      {
        variantId: "quality-but-expensive",
        nodeCount: 10,
        edgeCount: 12,
        maxDepth: 5,
        maxParallelism: 5,
        strategyArmId: "aggressive",
      },
    ];

    const result = searchDecompositionPolicies({
      fixtures,
      variants,
      config: {
        minQualityGain: 0,
        maxCostIncreaseRatio: 0.15,
        maxLatencyIncreaseRatio: 0.15,
      },
    });

    expect(result.promotedVariantIds).toContain("frontier-good");
    expect(result.promotedVariantIds).not.toContain("quality-but-expensive");

    const expensive = result.variantScores.find((entry) =>
      entry.variantId === "quality-but-expensive"
    );
    expect(expensive).toBeDefined();
    expect(expensive!.costUnits).toBeGreaterThan(result.baseline.costUnits);
  });
});
