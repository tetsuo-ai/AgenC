import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAutonomyConfigFlags,
  stagesRequireBackgroundRuns,
  stagesRequireMultiAgent,
  validateAutonomyRunnerConfig,
} from "./lib/agenc-autonomy-config.mjs";

test("stagesRequireBackgroundRuns detects baseline and server supervised stages", () => {
  assert.equal(stagesRequireBackgroundRuns([{ id: "0" }, { id: "1" }]), false);
  assert.equal(stagesRequireBackgroundRuns([{ id: "4" }]), true);
  assert.equal(stagesRequireBackgroundRuns([{ id: "srv3" }]), true);
});

test("stagesRequireMultiAgent detects delegated-child stages", () => {
  assert.equal(stagesRequireMultiAgent([{ id: "0" }, { id: "1" }]), false);
  assert.equal(stagesRequireMultiAgent([{ id: "del1" }]), true);
});

test("readAutonomyConfigFlags respects enabled, feature flags, and kill switches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-autonomy-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        autonomy: {
          enabled: true,
          featureFlags: { backgroundRuns: false, multiAgent: true },
          killSwitches: { backgroundRuns: false, multiAgent: false },
        },
      },
      null,
      2,
    ),
  );

  const flags = await readAutonomyConfigFlags(configPath);
  assert.deepEqual(flags, {
    autonomyEnabled: true,
    backgroundRunsEnabled: false,
    multiAgentEnabled: true,
  });
});

test("validateAutonomyRunnerConfig rejects background-run stages when the feature is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-autonomy-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        autonomy: {
          enabled: true,
          featureFlags: { backgroundRuns: false },
        },
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => validateAutonomyRunnerConfig(configPath, [{ id: "4" }]),
    /backgroundRuns=true/,
  );
});

test("validateAutonomyRunnerConfig rejects delegated-child stages when multi-agent is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-autonomy-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        autonomy: {
          enabled: true,
          featureFlags: { multiAgent: false },
        },
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => validateAutonomyRunnerConfig(configPath, [{ id: "del1" }]),
    /multiAgent=true/,
  );
});

test("validateAutonomyRunnerConfig allows supervised stages when background runs are enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-autonomy-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        autonomy: {
          enabled: true,
          featureFlags: { backgroundRuns: true },
        },
      },
      null,
      2,
    ),
  );

  const flags = await validateAutonomyRunnerConfig(configPath, [{ id: "4" }]);
  assert.equal(flags.backgroundRunsEnabled, true);
});

test("validateAutonomyRunnerConfig allows delegated-child stages when multi-agent is enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-autonomy-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        autonomy: {
          enabled: true,
          featureFlags: { multiAgent: true },
        },
      },
      null,
      2,
    ),
  );

  const flags = await validateAutonomyRunnerConfig(configPath, [{ id: "del1" }]);
  assert.equal(flags.multiAgentEnabled, true);
});
