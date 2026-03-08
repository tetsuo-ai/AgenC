import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  parseCliArgs,
  resolveProjectPath,
  validateManifestReferences,
} from "../../scripts/check-autonomy-rollout-gates.ts";
import { parseAutonomyRolloutManifest } from "./autonomy-rollout.js";

describe("autonomy rollout gate script", () => {
  const runtimeDir = path.resolve(import.meta.dirname, "../..");

  it("resolves repo-root style paths when invoked from the runtime package directory", () => {
    const resolvedArtifact = resolveProjectPath(
      runtimeDir,
      "runtime/benchmarks/artifacts/background-run-quality.ci.json",
    );
    const resolvedManifest = resolveProjectPath(
      runtimeDir,
      "docs/autonomy-runtime-rollout.manifest.json",
    );

    expect(resolvedArtifact).toBe(
      path.resolve(runtimeDir, "benchmarks/artifacts/background-run-quality.ci.json"),
    );
    expect(resolvedManifest).toBe(
      path.resolve(runtimeDir, "../docs/autonomy-runtime-rollout.manifest.json"),
    );
  });

  it("parses CLI arguments using project-aware path resolution", () => {
    const options = parseCliArgs(
      [
        "--config",
        "runtime/benchmarks/autonomy-gateway.ci.json",
        "--artifact",
        "runtime/benchmarks/artifacts/background-run-quality.ci.json",
        "--manifest",
        "docs/autonomy-runtime-rollout.manifest.json",
      ],
      runtimeDir,
    );

    expect(options.configPath).toBe(
      path.resolve(runtimeDir, "benchmarks/autonomy-gateway.ci.json"),
    );
    expect(options.artifactPath).toBe(
      path.resolve(runtimeDir, "benchmarks/artifacts/background-run-quality.ci.json"),
    );
    expect(options.manifestPath).toBe(
      path.resolve(runtimeDir, "../docs/autonomy-runtime-rollout.manifest.json"),
    );
  });

  it("validates rollout manifest doc paths and sections against the real docs", async () => {
    const manifestPath = path.resolve(
      runtimeDir,
      "../docs/autonomy-runtime-rollout.manifest.json",
    );
    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = parseAutonomyRolloutManifest(rawManifest);

    const validation = await validateManifestReferences(manifest, runtimeDir);

    expect(validation.missingDocs).toEqual([]);
    expect(validation.missingSections).toEqual([]);
  });
});
