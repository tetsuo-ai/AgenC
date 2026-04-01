import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAdapterLogger } from "@tetsuo-ai/plugin-kit";
import type { ConcordiaChannelConfig, LaunchRequest } from "./types.js";

export interface SpawnedSimulationRunner {
  readonly child: ChildProcess;
  readonly tempDir: string;
}

export async function launchSimulationRunner(params: {
  readonly request: LaunchRequest;
  readonly config: Readonly<ConcordiaChannelConfig>;
  readonly logger: ChannelAdapterLogger;
}): Promise<SpawnedSimulationRunner> {
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(pluginDir, "..");
  const tempDir = await mkdtemp(join(tmpdir(), "agenc-concordia-"));
  const configPath = join(tempDir, "simulation-config.json");

  const payload = {
    world_id: params.request.world_id,
    workspace_id: params.request.workspace_id,
    premise: params.request.premise,
    agents: params.request.agents,
    max_steps: params.request.max_steps ?? 20,
    gm_model: params.request.gm_model ?? "grok-4.20-beta-0309-reasoning",
    gm_provider: params.request.gm_provider ?? "grok",
    gm_api_key: params.request.gm_api_key ?? "",
    gm_base_url: params.request.gm_base_url ?? "",
    event_port: params.request.event_port ?? 3201,
    control_port: params.request.control_port ?? 3202,
    engine_type: params.request.engine_type ?? "sequential",
    gm_prefab: params.request.gm_prefab ?? "generic",
    bridge_url: `http://127.0.0.1:${params.config.bridge_port ?? 3200}`,
  };

  await writeFile(configPath, JSON.stringify(payload, null, 2), "utf-8");

  const pythonCommand = params.config.python_command ?? "python3";
  const child = spawn(
    pythonCommand,
    ["-m", "concordia_bridge.cli", "run-json", "--config-file", configPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => {
    params.logger.info?.(`[concordia-runner] ${String(chunk).trimEnd()}`);
  });
  child.stderr.on("data", (chunk) => {
    params.logger.warn?.(`[concordia-runner] ${String(chunk).trimEnd()}`);
  });

  await waitForControlServer(child, params.request.control_port ?? 3202, 30_000);
  return { child, tempDir };
}

export async function stopSimulationRunner(
  runner: SpawnedSimulationRunner | null,
): Promise<void> {
  if (!runner) {
    return;
  }

  runner.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (runner.child.exitCode === null) {
        runner.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);

    runner.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  await rm(runner.tempDir, { recursive: true, force: true });
}

async function waitForControlServer(
  child: ChildProcess,
  controlPort: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Concordia runner exited early with code ${String(child.exitCode)}`,
      );
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${controlPort}/simulation/status`);
      if (resp.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for Concordia control server on port ${controlPort}`,
  );
}
