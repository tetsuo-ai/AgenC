#!/usr/bin/env node
/**
 * Run offline decomposition search harness and write JSON artifact.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  searchDecompositionPolicies,
  type DecompositionDagVariant,
  type DecompositionReplayFixture,
} from "../src/eval/decomposition-search.js";

interface CliOptions {
  outputPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let outputPath = "runtime/benchmarks/v1/decomposition-search.json";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--output" && argv[i + 1]) {
      outputPath = argv[i + 1]!;
      i += 1;
    }
  }
  return { outputPath };
}

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
      seed: 11,
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
          payload: completed
            ? { completionTx: `${fixtureId}:done` }
            : { error: "delegation_failure" },
        },
      ],
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixtures: DecompositionReplayFixture[] = [
    fixture("baseline-1", true, 600),
    fixture("baseline-2", true, 780),
    fixture("baseline-3", false, 900),
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

  const result = searchDecompositionPolicies({ fixtures, variants });
  const output = {
    runId: `decomposition-search-${Date.now()}`,
    generatedAtMs: Date.now(),
    fixtureCount: fixtures.length,
    variantCount: variants.length,
    ...result,
  };

  const resolvedOutputPath = path.resolve(options.outputPath);
  await writeFile(resolvedOutputPath, JSON.stringify(output, null, 2));

  process.stdout.write(
    `Wrote decomposition search artifact to ${resolvedOutputPath}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to run decomposition search: ${message}\n`);
  process.exitCode = 1;
});
