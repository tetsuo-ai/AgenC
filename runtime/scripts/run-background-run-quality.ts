#!/usr/bin/env node

import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  runBackgroundRunQualitySuite,
  serializeBackgroundRunQualityArtifact,
} from "../src/eval/index.js";

interface CliOptions {
  outputPath: string;
}

function resolveDefaultOutputPath(): string {
  const local = path.resolve(
    process.cwd(),
    "benchmarks/artifacts/background-run-quality.latest.json",
  );
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/background-run-quality.latest.json",
  );
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    outputPath: resolveDefaultOutputPath(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output" && argv[index + 1]) {
      options.outputPath = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: run-background-run-quality [options]",
          "",
          "Options:",
          "  --output <path>   Output artifact path",
          "",
          `Default output: ${options.outputPath}`,
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const artifact = await runBackgroundRunQualitySuite();
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${serializeBackgroundRunQualityArtifact(artifact)}\n`,
    "utf8",
  );
  console.log(
    [
      `Background-run quality run complete: ${artifact.runId}`,
      `Runs: ${artifact.runCount}`,
      `Mean latency: ${artifact.meanLatencyMs.toFixed(2)}ms`,
      `False completion rate: ${artifact.falseCompletionRate.toFixed(4)}`,
      `Blocked without notice rate: ${artifact.blockedWithoutNoticeRate.toFixed(4)}`,
      `Recovery success rate: ${artifact.recoverySuccessRate.toFixed(4)}`,
      `Verifier accuracy rate: ${artifact.verifierAccuracyRate.toFixed(4)}`,
      `Output: ${options.outputPath}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Background-run quality run failed: ${message}`);
  process.exit(1);
});
