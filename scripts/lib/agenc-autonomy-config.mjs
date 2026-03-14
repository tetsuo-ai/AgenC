import { readFile } from "node:fs/promises";

const BACKGROUND_RUN_STAGE_IDS = new Set([
  "4",
  "5",
  "6",
  "7",
  "8",
  "srv1",
  "srv2",
  "srv3",
  "srv4",
  "srv5",
]);

const MULTI_AGENT_STAGE_IDS = new Set([
  "del1",
]);

export function stagesRequireBackgroundRuns(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return false;
  }
  return stages.some((stage) => BACKGROUND_RUN_STAGE_IDS.has(String(stage?.id ?? "")));
}

export function stagesRequireMultiAgent(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return false;
  }
  return stages.some((stage) => MULTI_AGENT_STAGE_IDS.has(String(stage?.id ?? "")));
}

export async function readAutonomyConfigFlags(configPath) {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const autonomy = parsed?.autonomy ?? {};
  const featureFlags = autonomy?.featureFlags ?? {};
  const killSwitches = autonomy?.killSwitches ?? {};
  return {
    autonomyEnabled: autonomy?.enabled !== false,
    backgroundRunsEnabled:
      autonomy?.enabled !== false &&
      featureFlags?.backgroundRuns !== false &&
      killSwitches?.backgroundRuns !== true,
    multiAgentEnabled:
      autonomy?.enabled !== false &&
      featureFlags?.multiAgent !== false &&
      killSwitches?.multiAgent !== true,
  };
}

export async function validateAutonomyRunnerConfig(configPath, stages) {
  const flags = await readAutonomyConfigFlags(configPath);
  if (stagesRequireBackgroundRuns(stages) && !flags.backgroundRunsEnabled) {
    throw new Error(
      `Selected autonomy stages require \`autonomy.featureFlags.backgroundRuns=true\` in ${configPath}`,
    );
  }
  if (stagesRequireMultiAgent(stages) && !flags.multiAgentEnabled) {
    throw new Error(
      `Selected autonomy stages require \`autonomy.featureFlags.multiAgent=true\` in ${configPath}`,
    );
  }
  return flags;
}
