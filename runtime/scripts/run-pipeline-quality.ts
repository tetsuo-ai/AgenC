#!/usr/bin/env node

import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  runPipelineQualitySuite,
  serializePipelineQualityArtifact,
} from "../src/eval/index.js";

interface CliOptions {
  outputPath: string;
  turns?: number;
  desktopRuns?: number;
  desktopTimeoutMs?: number;
  incidentFixtureDir?: string;
}

function resolveDefaultOutputPath(): string {
  const local = path.resolve(
    process.cwd(),
    "benchmarks/artifacts/pipeline-quality.latest.json",
  );
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/pipeline-quality.latest.json",
  );
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outputPath: resolveDefaultOutputPath(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" && argv[i + 1]) {
      options.outputPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--turns" && argv[i + 1]) {
      options.turns = parsePositiveInt(argv[++i]!, arg);
      continue;
    }
    if (arg === "--desktop-runs" && argv[i + 1]) {
      options.desktopRuns = parsePositiveInt(argv[++i]!, arg);
      continue;
    }
    if (arg === "--desktop-timeout-ms" && argv[i + 1]) {
      options.desktopTimeoutMs = parsePositiveInt(argv[++i]!, arg);
      continue;
    }
    if (arg === "--incident-fixture-dir" && argv[i + 1]) {
      options.incidentFixtureDir = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: run-pipeline-quality [options]",
          "",
          "Options:",
          "  --output <path>                 Output artifact path",
          "  --turns <int>                   Context/token benchmark turns",
          "  --desktop-runs <int>            Number of desktop repro runs",
          "  --desktop-timeout-ms <int>      Timeout per desktop repro run",
          "  --incident-fixture-dir <path>   Offline replay fixture directory",
          "",
          "Defaults:",
          `  output: ${options.outputPath}`,
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const artifact = await runPipelineQualitySuite({
    turns: options.turns,
    desktopRuns: options.desktopRuns,
    desktopTimeoutMs: options.desktopTimeoutMs,
    incidentFixtureDir: options.incidentFixtureDir,
  });

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${serializePipelineQualityArtifact(artifact)}\n`,
    "utf8",
  );

  const offlineFailures =
    artifact.offlineReplay.parseFailures +
    artifact.offlineReplay.replayFailures +
    artifact.offlineReplay.deterministicMismatches;
  console.log(
    [
      `Pipeline quality run complete: ${artifact.runId}`,
      `Context slope: ${artifact.contextGrowth.slope.toFixed(4)}`,
      `Context max delta: ${artifact.contextGrowth.maxDelta.toFixed(4)}`,
      `Malformed forwarded: ${artifact.toolTurn.malformedForwarded}`,
      `Desktop failed/timeouts: ${artifact.desktopStability.failedRuns}/${artifact.desktopStability.timedOutRuns}`,
      `Tokens/completed task: ${artifact.tokenEfficiency.tokensPerCompletedTask.toFixed(4)}`,
      `Offline replay failures: ${offlineFailures}`,
      `Output: ${options.outputPath}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pipeline quality run failed: ${message}`);
  process.exit(1);
});
