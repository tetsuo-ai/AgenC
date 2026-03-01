#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluatePipelineQualityGates,
  formatPipelineQualityGateEvaluation,
  parsePipelineQualityArtifact,
  type PipelineQualityGateThresholds,
} from "../src/eval/index.js";

interface CliOptions {
  artifactPath: string;
  dryRun: boolean;
  thresholds: Partial<PipelineQualityGateThresholds>;
}

function defaultArtifactPath(): string {
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/pipeline-quality.ci.json",
  );
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
    if (arg === "--artifact" && argv[i + 1]) {
      options.artifactPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--max-context-growth-slope" && argv[i + 1]) {
      options.thresholds.maxContextGrowthSlope = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-context-growth-delta" && argv[i + 1]) {
      options.thresholds.maxContextGrowthDelta = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-tokens-per-completed-task" && argv[i + 1]) {
      options.thresholds.maxTokensPerCompletedTask = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-malformed-tool-turn-forwarded" && argv[i + 1]) {
      options.thresholds.maxMalformedToolTurnForwarded = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-malformed-tool-turn-rejected-rate" && argv[i + 1]) {
      options.thresholds.minMalformedToolTurnRejectedRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--max-desktop-failed-runs" && argv[i + 1]) {
      options.thresholds.maxDesktopFailedRuns = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-desktop-timeout-runs" && argv[i + 1]) {
      options.thresholds.maxDesktopTimeoutRuns = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-offline-replay-failures" && argv[i + 1]) {
      options.thresholds.maxOfflineReplayFailures = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: check-pipeline-gates --artifact <path> [threshold overrides]",
          "",
          "Threshold flags:",
          "  --max-context-growth-slope <float>",
          "  --max-context-growth-delta <float>",
          "  --max-tokens-per-completed-task <float>",
          "  --max-malformed-tool-turn-forwarded <float>",
          "  --min-malformed-tool-turn-rejected-rate <float>",
          "  --max-desktop-failed-runs <float>",
          "  --max-desktop-timeout-runs <float>",
          "  --max-offline-replay-failures <float>",
          "",
          "Options:",
          "  --dry-run   Always exit 0, but print failures",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const raw = await readFile(options.artifactPath, "utf8");
  const artifact = parsePipelineQualityArtifact(JSON.parse(raw) as unknown);
  const evaluation = evaluatePipelineQualityGates(artifact, options.thresholds);

  console.log(formatPipelineQualityGateEvaluation(evaluation));

  if (!evaluation.passed && !options.dryRun) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pipeline gate evaluation failed: ${message}`);
  process.exit(1);
});
