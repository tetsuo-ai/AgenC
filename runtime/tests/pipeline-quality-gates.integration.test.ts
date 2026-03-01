import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPipelineQualityArtifact,
  serializePipelineQualityArtifact,
} from "../src/eval/pipeline-quality.js";
import { runCommand } from "../src/utils/process.js";

describe("pipeline quality gate integration", () => {
  it("supports strict failure + dry-run modes via CLI", async () => {
    const artifact = buildPipelineQualityArtifact({
      runId: "pipeline-gate-fixture",
      generatedAtMs: 1700000000000,
      contextGrowth: {
        promptTokenSeries: [100, 300, 700],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 2,
        malformedRejected: 1,
        malformedForwarded: 1,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-1",
            ok: false,
            timedOut: true,
            durationMs: 5000,
            failedStep: 4,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 1200,
        totalCompletionTokens: 100,
        totalTokens: 1300,
      },
      offlineReplay: {
        fixtures: [
          {
            fixtureId: "incident-a",
            ok: false,
            replayError: "mismatch",
          },
        ],
      },
    });

    const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-pipeline-gates-"));
    const artifactPath = path.join(tempDir, "pipeline-quality-artifact.json");
    await writeFile(
      artifactPath,
      `${serializePipelineQualityArtifact(artifact)}\n`,
      "utf8",
    );

    const scriptPath = fileURLToPath(
      new URL("../scripts/check-pipeline-gates.ts", import.meta.url),
    );
    const strictArgs = [
      "--import",
      "tsx",
      scriptPath,
      "--artifact",
      artifactPath,
      "--max-context-growth-slope",
      "10",
      "--max-context-growth-delta",
      "20",
      "--max-tokens-per-completed-task",
      "50",
      "--max-malformed-tool-turn-forwarded",
      "0",
      "--min-malformed-tool-turn-rejected-rate",
      "1",
      "--max-desktop-failed-runs",
      "0",
      "--max-desktop-timeout-runs",
      "0",
      "--max-offline-replay-failures",
      "0",
    ];

    const failRun = await runCommand(process.execPath, strictArgs, {
      cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    });
    expect(failRun.exitCode).toBe(1);
    const failOutput = `${failRun.stdout}\n${failRun.stderr}`.trim();
    if (failOutput.length > 0) {
      expect(failOutput).toContain("Pipeline quality gates: FAIL");
    }

    const dryRun = await runCommand(
      process.execPath,
      [...strictArgs, "--dry-run"],
      {
        cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      },
    );
    expect(dryRun.exitCode).toBe(0);
    const dryOutput = `${dryRun.stdout}\n${dryRun.stderr}`.trim();
    if (dryOutput.length > 0) {
      expect(dryOutput).toContain("Pipeline quality gates: FAIL");
    }
  });
});
