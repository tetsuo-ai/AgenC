import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runPipelineQualitySuite,
  type PipelineDesktopRunner,
} from "./pipeline-quality-runner.js";
import { serializePipelineQualityArtifact } from "./pipeline-quality.js";

const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../../benchmarks/v1/incidents", import.meta.url),
);

describe("pipeline-quality runner", () => {
  it("runs suite with deterministic context/tool metrics and injected desktop runner", async () => {
    const desktopRunner: PipelineDesktopRunner = async ({ runIndex }) => ({
      runId: `desktop-${runIndex + 1}`,
      ok: runIndex === 0,
      timedOut: runIndex === 1,
      durationMs: runIndex === 0 ? 2000 : 3000,
      failedStep: runIndex === 1 ? 4 : undefined,
      preview: runIndex === 1 ? "timeout" : "ok",
    });

    const artifact = await runPipelineQualitySuite({
      now: () => 1_700_000_100_000,
      runId: "phase9-runner-test",
      turns: 4,
      desktopRuns: 2,
      desktopRunner,
      incidentFixtureDir: INCIDENT_FIXTURE_DIR,
    });

    expect(artifact.runId).toBe("phase9-runner-test");
    expect(artifact.contextGrowth.turns).toBe(4);
    expect(artifact.contextGrowth.promptTokenSeries.length).toBe(4);
    expect(artifact.toolTurn.validCases).toBeGreaterThan(0);
    expect(artifact.toolTurn.malformedCases).toBeGreaterThan(0);
    expect(artifact.desktopStability.runs).toBe(2);
    expect(artifact.desktopStability.failedRuns).toBe(1);
    expect(artifact.desktopStability.timedOutRuns).toBe(1);
    expect(artifact.tokenEfficiency.completedTasks).toBe(4);
    expect(artifact.offlineReplay.fixtureCount).toBeGreaterThanOrEqual(2);
    expect(artifact.offlineReplay.parseFailures).toBe(0);
    expect(artifact.offlineReplay.replayFailures).toBe(0);
  });

  it("is deterministic under fixed runId/time/inputs", async () => {
    const desktopRunner: PipelineDesktopRunner = async ({ runIndex }) => ({
      runId: `desktop-${runIndex + 1}`,
      ok: true,
      timedOut: false,
      durationMs: 1500,
      preview: "ok",
    });

    const config = {
      now: () => 1_700_000_200_000,
      runId: "phase9-runner-deterministic",
      turns: 3,
      desktopRuns: 1,
      desktopRunner,
      incidentFixtureDir: INCIDENT_FIXTURE_DIR,
    } as const;

    const first = await runPipelineQualitySuite(config);
    const second = await runPipelineQualitySuite(config);

    expect(serializePipelineQualityArtifact(first)).toBe(
      serializePipelineQualityArtifact(second),
    );
  });
});
