import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runDelegationBenchmarkSuite,
  serializeDelegationBenchmarkSuiteResult,
} from "../src/eval/delegation-benchmark.js";
import { runCommand } from "../src/utils/process.js";

describe("delegation benchmark integration", () => {
  it("runs deterministic decomposition suite with baseline deltas", async () => {
    const config = {
      now: () => 1_700_000_500_000,
      runId: "delegation-integration",
      k: 2,
    } as const;

    const first = await runDelegationBenchmarkSuite(config);
    const second = await runDelegationBenchmarkSuite(config);

    expect(serializeDelegationBenchmarkSuiteResult(first)).toBe(
      serializeDelegationBenchmarkSuiteResult(second),
    );
    expect(first.summary.scenarioSummaries.length).toBeGreaterThanOrEqual(5);
    expect(first.summary.passAtKDeltaVsBaseline).toBeGreaterThan(0);
    expect(first.summary.passCaretKDeltaVsBaseline).toBeGreaterThan(0);
  });

  it("supports CLI artifact generation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-delegation-bench-"));
    const outputPath = path.join(tempDir, "delegation-benchmark.json");

    const scriptPath = fileURLToPath(
      new URL("../scripts/run-delegation-benchmarks.ts", import.meta.url),
    );

    const cliRun = await runCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--output",
        outputPath,
        "--k",
        "2",
      ],
      {
        cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      },
    );

    expect(cliRun.exitCode).toBe(0);

    const raw = await readFile(outputPath, "utf8");
    const artifact = JSON.parse(raw) as {
      summary: {
        delegationAttemptRate: number;
        passAtKDeltaVsBaseline: number;
      };
      benchmarkArtifact: {
        scenarios: Array<{ scenarioId: string }>;
      };
    };

    expect(artifact.summary.delegationAttemptRate).toBeGreaterThan(0);
    expect(artifact.summary.passAtKDeltaVsBaseline).toBeGreaterThan(0);
    expect(artifact.benchmarkArtifact.scenarios.length).toBeGreaterThanOrEqual(5);
  });
});
