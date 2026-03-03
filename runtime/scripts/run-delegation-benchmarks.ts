#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  loadBenchmarkManifest,
  runDelegationBenchmarkSuite,
  serializeDelegationBenchmarkSuiteResult,
} from "../src/eval/index.js";

interface CliOptions {
  outputPath: string;
  manifestPath?: string;
  k?: number;
}

function resolveDefaultOutputPath(): string {
  const local = path.resolve(
    process.cwd(),
    "benchmarks/artifacts/delegation-benchmark.latest.json",
  );
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/delegation-benchmark.latest.json",
  );
}

function resolveDefaultManifestPath(): string | undefined {
  const local = path.resolve(process.cwd(), "benchmarks/v1/delegation-manifest.json");
  if (existsSync(local)) return local;
  const runtimePath = path.resolve(
    process.cwd(),
    "runtime/benchmarks/v1/delegation-manifest.json",
  );
  if (existsSync(runtimePath)) return runtimePath;
  return undefined;
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
    manifestPath: resolveDefaultManifestPath(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" && argv[i + 1]) {
      options.outputPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--manifest" && argv[i + 1]) {
      options.manifestPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--k" && argv[i + 1]) {
      options.k = parsePositiveInt(argv[++i]!, arg);
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: run-delegation-benchmarks [options]",
          "",
          "Options:",
          "  --output <path>                 Output artifact path",
          "  --manifest <path>               Optional benchmark manifest path",
          "  --k <int>                       pass@k/pass^k depth",
          "",
          "Defaults:",
          `  output:   ${options.outputPath}`,
          `  manifest: ${options.manifestPath ?? "<built-in manifest>"}`,
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const manifest = options.manifestPath
    ? await loadBenchmarkManifest(options.manifestPath)
    : undefined;

  const result = await runDelegationBenchmarkSuite({
    k: options.k,
    manifest,
  });

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${serializeDelegationBenchmarkSuiteResult(result)}\n`,
    "utf8",
  );

  console.log(
    [
      `Delegation benchmark run complete: ${result.runId}`,
      `Delegation attempt/useful/harmful: ${result.summary.delegationAttemptRate.toFixed(4)}/${result.summary.usefulDelegationRate.toFixed(4)}/${result.summary.harmfulDelegationRate.toFixed(4)}`,
      `Deltas (quality/pass@k/pass^k): ${result.summary.qualityDeltaVsBaseline.toFixed(4)}/${result.summary.passAtKDeltaVsBaseline.toFixed(4)}/${result.summary.passCaretKDeltaVsBaseline.toFixed(4)}`,
      `Output: ${options.outputPath}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Delegation benchmark run failed: ${message}`);
  process.exit(1);
});
