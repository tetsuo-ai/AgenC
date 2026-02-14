#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateMutationRegressionGates,
  formatMutationGateEvaluation,
  type MutationGateThresholds,
} from '../src/eval/mutation-gates.js';
import { parseMutationArtifact } from '../src/eval/mutation-runner.js';

interface CliOptions {
  artifactPath: string;
  dryRun: boolean;
  thresholds: Partial<MutationGateThresholds>;
}

function defaultArtifactPath(): string {
  return path.resolve(process.cwd(), 'runtime/benchmarks/artifacts/mutation.ci.json');
}

function parseThreshold(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    artifactPath: defaultArtifactPath(),
    dryRun: false,
    thresholds: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--artifact' && argv[i + 1]) {
      options.artifactPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--max-aggregate-pass-rate-drop' && argv[i + 1]) {
      options.thresholds.maxAggregatePassRateDrop = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--max-aggregate-conformance-drop' && argv[i + 1]) {
      options.thresholds.maxAggregateConformanceDrop = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--max-aggregate-cost-utility-drop' && argv[i + 1]) {
      options.thresholds.maxAggregateCostUtilityDrop = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--max-scenario-pass-rate-drop' && argv[i + 1]) {
      options.thresholds.maxScenarioPassRateDrop = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--max-operator-pass-rate-drop' && argv[i + 1]) {
      options.thresholds.maxOperatorPassRateDrop = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--max-chaos-scenario-fail-rate' && argv[i + 1]) {
      options.thresholds.maxChaosScenarioFailRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === '--help') {
      console.log([
        'Usage: check-mutation-gates --artifact <path> [threshold overrides]',
        '',
        'Threshold flags:',
        '  --max-aggregate-pass-rate-drop <float>',
        '  --max-aggregate-conformance-drop <float>',
        '  --max-aggregate-cost-utility-drop <float>',
        '  --max-scenario-pass-rate-drop <float>',
        '  --max-operator-pass-rate-drop <float>',
        '  --max-chaos-scenario-fail-rate <float>',
        '',
        'Options:',
        '  --dry-run   Always exit 0, but print failures',
      ].join('\n'));
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const raw = await readFile(options.artifactPath, 'utf8');
  const artifact = parseMutationArtifact(JSON.parse(raw) as unknown);

  const evaluation = evaluateMutationRegressionGates(artifact, options.thresholds);
  console.log(formatMutationGateEvaluation(evaluation));

  if (!evaluation.passed && !options.dryRun) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Mutation gate evaluation failed: ${message}`);
  process.exit(1);
});
