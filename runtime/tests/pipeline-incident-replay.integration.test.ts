import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTrajectoryTrace } from "../src/eval/types.js";
import { TrajectoryReplayEngine } from "../src/eval/replay.js";

const INCIDENT_FIXTURE_DIR = fileURLToPath(
  new URL("../benchmarks/v1/incidents", import.meta.url),
);

describe("pipeline incident replay integration", () => {
  it("replays sanitized incident traces deterministically offline", async () => {
    const entries = await readdir(INCIDENT_FIXTURE_DIR, { withFileTypes: true });
    const fixtureFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".trace.json"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    expect(fixtureFiles.length).toBeGreaterThan(0);

    for (const fixtureFile of fixtureFiles) {
      const fixturePath = path.join(INCIDENT_FIXTURE_DIR, fixtureFile);
      const parsed = parseTrajectoryTrace(
        JSON.parse(await readFile(fixturePath, "utf8")) as unknown,
      );

      const engine = new TrajectoryReplayEngine({ strictMode: true });
      const first = engine.replay(parsed);
      const second = engine.replay(parsed);

      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
      expect(first.deterministicHash).toBe(second.deterministicHash);
      expect(first.trace.traceId).toBe(parsed.traceId);
    }
  });
});
