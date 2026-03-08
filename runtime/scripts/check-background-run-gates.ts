#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateBackgroundRunQualityGates,
  formatBackgroundRunGateEvaluation,
  parseBackgroundRunQualityArtifact,
  type BackgroundRunQualityGateThresholds,
} from "../src/eval/index.js";

interface CliOptions {
  artifactPath: string;
  dryRun: boolean;
  thresholds: Partial<BackgroundRunQualityGateThresholds>;
}

function defaultArtifactPath(): string {
  const local = path.resolve(
    process.cwd(),
    "benchmarks/artifacts/background-run-quality.ci.json",
  );
  if (existsSync(path.dirname(local))) {
    return local;
  }
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/background-run-quality.ci.json",
  );
}

function parseThreshold(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    artifactPath: defaultArtifactPath(),
    dryRun: false,
    thresholds: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact" && argv[index + 1]) {
      options.artifactPath = path.resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--max-mean-latency-ms" && argv[index + 1]) {
      options.thresholds.maxMeanLatencyMs = parseThreshold(argv[index + 1]!, arg);
      index += 1;
      continue;
    }
    if (arg === "--max-mean-time-to-first-ack-ms" && argv[index + 1]) {
      options.thresholds.maxMeanTimeToFirstAckMs = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-mean-time-to-first-verified-update-ms" && argv[index + 1]) {
      options.thresholds.maxMeanTimeToFirstVerifiedUpdateMs = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-false-completion-rate" && argv[index + 1]) {
      options.thresholds.maxFalseCompletionRate = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-blocked-without-notice-rate" && argv[index + 1]) {
      options.thresholds.maxBlockedWithoutNoticeRate = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-mean-stop-latency-ms" && argv[index + 1]) {
      options.thresholds.maxMeanStopLatencyMs = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-recovery-success-rate" && argv[index + 1]) {
      options.thresholds.minRecoverySuccessRate = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-verifier-accuracy-rate" && argv[index + 1]) {
      options.thresholds.minVerifierAccuracyRate = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-transcript-score" && argv[index + 1]) {
      options.thresholds.minTranscriptScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-tool-trajectory-score" && argv[index + 1]) {
      options.thresholds.minToolTrajectoryScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-end-state-correctness-score" && argv[index + 1]) {
      options.thresholds.minEndStateCorrectnessScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-verifier-correctness-score" && argv[index + 1]) {
      options.thresholds.minVerifierCorrectnessScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-restart-recovery-correctness-score" && argv[index + 1]) {
      options.thresholds.minRestartRecoveryCorrectnessScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--min-operator-ux-correctness-score" && argv[index + 1]) {
      options.thresholds.minOperatorUxCorrectnessScore = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-mean-tokens-per-run" && argv[index + 1]) {
      options.thresholds.maxMeanTokensPerRun = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-replay-inconsistencies" && argv[index + 1]) {
      options.thresholds.maxReplayInconsistencies = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--max-chaos-failures" && argv[index + 1]) {
      options.thresholds.maxChaosFailures = parseThreshold(
        argv[index + 1]!,
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: check-background-run-gates --artifact <path> [threshold overrides]",
          "",
          "Common thresholds:",
          "  --max-mean-latency-ms <float>",
          "  --max-false-completion-rate <float>",
          "  --max-blocked-without-notice-rate <float>",
          "  --min-recovery-success-rate <float>",
          "  --min-verifier-accuracy-rate <float>",
          "  --max-replay-inconsistencies <float>",
          "  --max-chaos-failures <float>",
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
  const artifact = parseBackgroundRunQualityArtifact(JSON.parse(raw));
  const evaluation = evaluateBackgroundRunQualityGates(artifact, options.thresholds);
  const message = formatBackgroundRunGateEvaluation(evaluation);
  if (evaluation.passed || options.dryRun) {
    console.log(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Background-run gate check failed: ${message}`);
  process.exit(1);
});
