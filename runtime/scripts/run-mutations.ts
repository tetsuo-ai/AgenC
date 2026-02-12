#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MutationRunner,
  writeMutationArtifact,
  type MutationRegressionScenario,
} from '../src/eval/mutation-runner.js';
import { stableStringifyJson, type JsonValue } from '../src/eval/types.js';

interface CliOptions {
  manifestPath: string;
  outputPath: string;
  trendOutputPath: string;
  mutationSeed?: number;
  operatorIds: string[];
  maxMutationsPerScenario?: number;
  k?: number;
}

interface MutationTrendReport {
  schemaVersion: 1;
  generatedAtMs: number;
  runId: string;
  corpusVersion: string;
  aggregateDelta: {
    passRate: number;
    passAtK: number;
    passCaretK: number;
    riskWeightedSuccess: number;
    conformanceScore: number;
    costNormalizedUtility: number;
  };
  topRegressions: MutationRegressionScenario[];
  topRegressionScenarios: Array<{ scenarioId: string; passRateDelta: number; runCount: number }>;
  topRegressionOperators: Array<{ operatorId: string; passRateDelta: number; runCount: number }>;
}

function resolveDefaultManifestPath(): string {
  const local = path.resolve(process.cwd(), 'benchmarks/v1/manifest.json');
  if (existsSync(local)) return local;
  return path.resolve(process.cwd(), 'runtime/benchmarks/v1/manifest.json');
}

function resolveDefaultOutputPath(): string {
  const local = path.resolve(process.cwd(), 'benchmarks/artifacts/mutation.latest.json');
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(process.cwd(), 'runtime/benchmarks/artifacts/mutation.latest.json');
}

function resolveDefaultTrendOutputPath(): string {
  const local = path.resolve(process.cwd(), 'benchmarks/artifacts/mutation-trend.latest.json');
  if (existsSync(path.dirname(local))) return local;
  return path.resolve(process.cwd(), 'runtime/benchmarks/artifacts/mutation-trend.latest.json');
}

function parsePositiveInteger(input: string, flag: string): number {
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${input}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: resolveDefaultManifestPath(),
    outputPath: resolveDefaultOutputPath(),
    trendOutputPath: resolveDefaultTrendOutputPath(),
    operatorIds: [],
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
    if (arg === '--trend-output' && argv[i + 1]) {
      options.trendOutputPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === '--seed' && argv[i + 1]) {
      options.mutationSeed = parsePositiveInteger(argv[++i]!, '--seed');
      continue;
    }
    if (arg === '--max-mutations' && argv[i + 1]) {
      options.maxMutationsPerScenario = parsePositiveInteger(argv[++i]!, '--max-mutations');
      continue;
    }
    if (arg === '--k' && argv[i + 1]) {
      options.k = parsePositiveInteger(argv[++i]!, '--k');
      continue;
    }
    if (arg === '--operator' && argv[i + 1]) {
      options.operatorIds.push(argv[++i]!);
      continue;
    }
    if (arg === '--help') {
      console.log([
        'Usage: run-mutations [--manifest <path>] [--output <path>] [--trend-output <path>]',
        '                     [--seed <int>] [--max-mutations <int>] [--k <int>] [--operator <id> ...]',
        '',
        'Defaults:',
        `  manifest:     ${options.manifestPath}`,
        `  output:       ${options.outputPath}`,
        `  trend output: ${options.trendOutputPath}`,
      ].join('\n'));
      process.exit(0);
    }
  }

  return options;
}

async function writeTrendReport(outputPath: string, report: MutationTrendReport): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${stableStringifyJson(report as unknown as JsonValue)}\n`,
    'utf8',
  );
}

function createTrendReport(
  artifact: Awaited<ReturnType<MutationRunner['runFromFile']>>,
): MutationTrendReport {
  return {
    schemaVersion: 1,
    generatedAtMs: artifact.generatedAtMs,
    runId: artifact.runId,
    corpusVersion: artifact.corpusVersion,
    aggregateDelta: artifact.aggregate.deltasFromBaseline,
    topRegressions: artifact.topRegressions,
    topRegressionScenarios: [...artifact.scenarios]
      .sort((left, right) => left.deltasFromBaseline.passRate - right.deltasFromBaseline.passRate)
      .slice(0, 5)
      .map((scenario) => ({
        scenarioId: scenario.scenarioId,
        passRateDelta: scenario.deltasFromBaseline.passRate,
        runCount: scenario.runCount,
      })),
    topRegressionOperators: [...artifact.operators]
      .sort((left, right) => left.deltasFromBaseline.passRate - right.deltasFromBaseline.passRate)
      .slice(0, 5)
      .map((operator) => ({
        operatorId: operator.operatorId,
        passRateDelta: operator.deltasFromBaseline.passRate,
        runCount: operator.runCount,
      })),
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  const artifact = await new MutationRunner().runFromFile(options.manifestPath, {
    mutationSeed: options.mutationSeed,
    maxMutationsPerScenario: options.maxMutationsPerScenario,
    operatorIds: options.operatorIds.length > 0 ? options.operatorIds : undefined,
    k: options.k,
  });
  await writeMutationArtifact(options.outputPath, artifact);

  const trendReport = createTrendReport(artifact);
  await writeTrendReport(options.trendOutputPath, trendReport);

  console.log([
    `Mutation run complete: ${artifact.runId}`,
    `Corpus: ${artifact.corpusVersion}`,
    `Mutation seed: ${artifact.mutationSeed}`,
    `Runs: ${artifact.runs.length}`,
    `Aggregate pass-rate delta: ${artifact.aggregate.deltasFromBaseline.passRate.toFixed(4)}`,
    `Top regression: ${artifact.topRegressions[0]?.id ?? 'none'}`,
    `Output: ${options.outputPath}`,
    `Trend: ${options.trendOutputPath}`,
  ].join('\n'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Mutation run failed: ${message}`);
  process.exit(1);
});

