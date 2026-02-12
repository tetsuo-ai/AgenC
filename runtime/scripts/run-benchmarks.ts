#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  BenchmarkRunner,
  writeBenchmarkArtifact,
} from '../src/eval/benchmark-runner.js';

interface CliOptions {
  manifestPath: string;
  outputPath: string;
  k?: number;
}

function resolveDefaultManifestPath(): string {
  const local = path.resolve(process.cwd(), 'benchmarks/v1/manifest.json');
  if (existsSync(local)) return local;
  return path.resolve(process.cwd(), 'runtime/benchmarks/v1/manifest.json');
}

function resolveDefaultOutputPath(): string {
  const local = path.resolve(process.cwd(), 'benchmarks/artifacts/latest.json');
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(process.cwd(), 'runtime/benchmarks/artifacts/latest.json');
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: resolveDefaultManifestPath(),
    outputPath: resolveDefaultOutputPath(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest' && argv[i + 1]) {
      options.manifestPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      options.outputPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === '--k' && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`invalid --k value: ${String(argv[i])}`);
      }
      options.k = parsed;
      continue;
    }
    if (arg === '--help') {
      console.log([
        'Usage: run-benchmarks [--manifest <path>] [--output <path>] [--k <int>]',
        '',
        'Defaults:',
        `  manifest: ${options.manifestPath}`,
        `  output:   ${options.outputPath}`,
      ].join('\n'));
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  const runner = new BenchmarkRunner();
  const artifact = await runner.runFromFile(options.manifestPath, { k: options.k });
  await writeBenchmarkArtifact(options.outputPath, artifact);

  console.log([
    `Benchmark run complete: ${artifact.runId}`,
    `Corpus: ${artifact.corpusVersion}`,
    `Manifest hash: ${artifact.manifestHash}`,
    `Scenarios: ${artifact.scenarios.length}`,
    `Aggregate pass rate: ${artifact.aggregate.scorecard.aggregate.passRate.toFixed(4)}`,
    `Output: ${options.outputPath}`,
  ].join('\n'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark run failed: ${message}`);
  process.exit(1);
});
