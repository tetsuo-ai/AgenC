#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DelegationBenchmarkSummary } from "../src/eval/delegation-benchmark.js";
import { parseBackgroundRunQualityArtifact } from "../src/eval/background-run-quality.js";
import {
  evaluateAutonomyRolloutReadiness,
  parseAutonomyRolloutManifest,
} from "../src/gateway/autonomy-rollout.js";
import type { GatewayAutonomyConfig } from "../src/gateway/types.js";

interface CliOptions {
  readonly configPath: string;
  readonly artifactPath: string;
  readonly delegationArtifactPath?: string;
  readonly manifestPath: string;
  readonly mode: "limited" | "broad";
  readonly dryRun: boolean;
}

export function resolveExistingPath(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export function resolveProjectPathCandidates(
  baseDir: string,
  inputPath: string,
): readonly string[] {
  if (path.isAbsolute(inputPath)) {
    return [inputPath];
  }
  const repoRoot = path.resolve(baseDir, "..");
  return [
    path.resolve(baseDir, inputPath),
    path.resolve(repoRoot, inputPath),
  ];
}

export function resolveProjectPath(baseDir: string, inputPath: string): string {
  return resolveExistingPath(resolveProjectPathCandidates(baseDir, inputPath));
}

export function parseCliArgs(
  argv: readonly string[],
  baseDir = process.cwd(),
): CliOptions {
  const options: CliOptions = {
    configPath: resolveProjectPath(baseDir, "runtime/benchmarks/autonomy-gateway.ci.json"),
    artifactPath: resolveProjectPath(
      baseDir,
      "runtime/benchmarks/artifacts/background-run-quality.ci.json",
    ),
    delegationArtifactPath: resolveProjectPath(
      baseDir,
      "runtime/benchmarks/artifacts/delegation-benchmark.latest.json",
    ),
    manifestPath: resolveProjectPath(baseDir, "docs/autonomy-runtime-rollout.manifest.json"),
    mode: "limited",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" && argv[index + 1]) {
      options.configPath = resolveProjectPath(baseDir, argv[++index]!);
      continue;
    }
    if (arg === "--artifact" && argv[index + 1]) {
      options.artifactPath = resolveProjectPath(baseDir, argv[++index]!);
      continue;
    }
    if (arg === "--delegation-artifact" && argv[index + 1]) {
      options.delegationArtifactPath = resolveProjectPath(baseDir, argv[++index]!);
      continue;
    }
    if (arg === "--manifest" && argv[index + 1]) {
      options.manifestPath = resolveProjectPath(baseDir, argv[++index]!);
      continue;
    }
    if (arg === "--mode" && argv[index + 1]) {
      const mode = argv[++index]!;
      if (mode !== "limited" && mode !== "broad") {
        throw new Error(`invalid --mode "${mode}" (expected limited|broad)`);
      }
      options.mode = mode;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: check-autonomy-rollout-gates [options]",
          "",
          "Options:",
          "  --config <path>               Gateway autonomy config JSON or full gateway config",
          "  --artifact <path>             Background-run quality artifact",
          "  --delegation-artifact <path>  Delegation benchmark artifact",
          "  --manifest <path>             Autonomy rollout manifest JSON",
          "  --mode <limited|broad>        Rollout gate mode (default: limited)",
          "  --dry-run                     Print failures but always exit 0",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function extractAutonomyConfig(value: unknown): GatewayAutonomyConfig | undefined {
  if (typeof value !== "object" || value === null) {
    throw new Error("config must be a JSON object");
  }
  if ("autonomy" in value) {
    return (value as { autonomy?: GatewayAutonomyConfig }).autonomy;
  }
  return value as GatewayAutonomyConfig;
}

function extractDelegationSummary(value: unknown): DelegationBenchmarkSummary {
  if (typeof value !== "object" || value === null) {
    throw new Error("delegation benchmark artifact must be an object");
  }
  const summary = (value as { summary?: unknown }).summary ?? value;
  if (typeof summary !== "object" || summary === null) {
    throw new Error("delegation benchmark summary is missing");
  }
  return summary as DelegationBenchmarkSummary;
}

export async function validateManifestReferences(
  manifest: ReturnType<typeof parseAutonomyRolloutManifest>,
  baseDir = process.cwd(),
): Promise<{
  readonly missingDocs: readonly string[];
  readonly missingSections: readonly string[];
}> {
  const docRefs = [
    manifest.migration.playbook,
    manifest.canary.strategy,
    manifest.rollback.strategy,
    ...Object.values(manifest.runbooks),
  ];
  const missingDocs: string[] = [];
  const missingSections: string[] = [];
  const seen = new Set<string>();
  for (const ref of docRefs) {
    const key = `${ref.path}#${ref.section}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const resolvedPath = resolveProjectPath(baseDir, ref.path);
    if (!existsSync(resolvedPath)) {
      missingDocs.push(ref.path);
      continue;
    }
    const contents = await readFile(resolvedPath, "utf8");
    const headingNeedle = `## ${ref.section}`;
    const topLevelNeedle = `# ${ref.section}`;
    if (!contents.includes(headingNeedle) && !contents.includes(topLevelNeedle)) {
      missingSections.push(`${ref.path}#${ref.section}`);
    }
  }
  return {
    missingDocs,
    missingSections,
  };
}

function formatEvaluation(params: {
  readonly mode: "limited" | "broad";
  readonly passed: boolean;
  readonly evaluation: ReturnType<typeof evaluateAutonomyRolloutReadiness>;
}): string {
  const lines = [
    `Autonomy rollout gates ${params.passed ? "passed" : "failed"} (${params.mode}).`,
  ];
  if (params.evaluation.observed) {
    lines.push(
      `Observed SLOs: start=${params.evaluation.observed.runStartLatencyMs}ms update=${params.evaluation.observed.updateCadenceMs}ms completion=${params.evaluation.observed.completionAccuracyRate.toFixed(3)} recovery=${params.evaluation.observed.recoverySuccessRate.toFixed(3)} stop=${params.evaluation.observed.stopLatencyMs}ms eventLoss=${params.evaluation.observed.eventLossRate.toFixed(3)}`,
    );
  }
  if (params.evaluation.violations.length > 0) {
    lines.push("Violations:");
    for (const violation of params.evaluation.violations) {
      lines.push(
        `- [${violation.severity}] ${violation.code}: ${violation.message}`,
      );
    }
  }
  if (params.evaluation.externalGates.length > 0) {
    lines.push("External gates:");
    for (const gate of params.evaluation.externalGates) {
      lines.push(`- ${gate.code}: ${gate.message}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const [configRaw, artifactRaw, manifestRaw, delegationRaw] = await Promise.all([
    readJson(options.configPath),
    readJson(options.artifactPath),
    readJson(options.manifestPath),
    options.delegationArtifactPath && existsSync(options.delegationArtifactPath)
      ? readJson(options.delegationArtifactPath)
      : Promise.resolve(undefined),
  ]);

  const manifest = parseAutonomyRolloutManifest(manifestRaw);
  const { missingDocs, missingSections } = await validateManifestReferences(manifest);
  const evaluation = evaluateAutonomyRolloutReadiness({
    autonomy: extractAutonomyConfig(configRaw),
    backgroundRunQualityArtifact: parseBackgroundRunQualityArtifact(artifactRaw),
    delegationBenchmark:
      delegationRaw === undefined ? undefined : extractDelegationSummary(delegationRaw),
    manifest,
  });

  const passed =
    options.mode === "broad"
      ? evaluation.broadRolloutReady
      : evaluation.limitedRolloutReady;
  const message = [
    formatEvaluation({
      mode: options.mode,
      passed,
      evaluation,
    }),
    missingDocs.length > 0
      ? ["Missing manifest docs:", ...missingDocs.map((docPath) => `- ${docPath}`)].join("\n")
      : undefined,
    missingSections.length > 0
      ? [
          "Missing manifest sections:",
          ...missingSections.map((sectionRef) => `- ${sectionRef}`),
        ].join("\n")
      : undefined,
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");

  if (
    (passed && missingDocs.length === 0 && missingSections.length === 0) ||
    options.dryRun
  ) {
    console.log(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Autonomy rollout gate check failed: ${message}`);
    process.exit(1);
  });
}
