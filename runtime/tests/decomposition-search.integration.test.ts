import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/utils/process.js";
import {
  searchDecompositionPolicies,
  type DecompositionDagVariant,
  type DecompositionReplayFixture,
} from "../src/eval/decomposition-search.js";

function fixture(
  id: string,
  completed: boolean,
  latencyMs: number,
): DecompositionReplayFixture {
  return {
    fixtureId: id,
    trace: {
      schemaVersion: 1,
      traceId: `${id}:trace`,
      seed: 17,
      createdAtMs: 1,
      events: [
        { seq: 1, type: "discovered", taskPda: `${id}:task`, timestampMs: 10, payload: {} },
        { seq: 2, type: "claimed", taskPda: `${id}:task`, timestampMs: 20, payload: {} },
        { seq: 3, type: "executed", taskPda: `${id}:task`, timestampMs: 30, payload: {} },
        {
          seq: 4,
          type: completed ? "completed" : "failed",
          taskPda: `${id}:task`,
          timestampMs: 30 + latencyMs,
          payload: completed ? { completionTx: `${id}:done` } : { error: "fail" },
        },
      ],
    },
  };
}

describe("decomposition-search integration", () => {
  it("searches replay fixtures and returns pareto-ranked variants", () => {
    const fixtures = [
      fixture("fx-1", true, 550),
      fixture("fx-2", true, 620),
      fixture("fx-3", false, 780),
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
    ];

    const result = searchDecompositionPolicies({ fixtures, variants });

    expect(result.variantScores.length).toBe(2);
    expect(result.paretoFrontierIds.length).toBeGreaterThan(0);
    expect(result.promotedVariantIds.every((id) =>
      result.paretoFrontierIds.includes(id)
    )).toBe(true);
  });

  it("runs CLI harness and writes artifact", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-decomposition-search-"));
    const outputPath = path.join(tempDir, "decomposition-search.json");

    const scriptPath = fileURLToPath(
      new URL("../scripts/run-decomposition-search.ts", import.meta.url),
    );

    const run = await runCommand(
      process.execPath,
      ["--import", "tsx", scriptPath, "--output", outputPath],
      {
        cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      },
    );

    expect(run.exitCode).toBe(0);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as {
      fixtureCount: number;
      variantCount: number;
      paretoFrontierIds: string[];
      promotedVariantIds: string[];
    };

    expect(parsed.fixtureCount).toBeGreaterThan(0);
    expect(parsed.variantCount).toBeGreaterThan(0);
    expect(parsed.paretoFrontierIds.length).toBeGreaterThan(0);
    expect(parsed.promotedVariantIds.length).toBeGreaterThanOrEqual(0);
  });
});
