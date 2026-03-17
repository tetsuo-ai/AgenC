#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_IMAGE =
  process.env.PRIVATE_REGISTRY_IMAGE
  || "verdaccio/verdaccio@sha256:3f533981ed514088088df91cf57fcb422c5a5193e657dd609b6bca425b81c13c";
const DEFAULT_PORT = 4873;
const CONTAINER_PORT = 4873;
const VERDACCIO_UID = 10001;
const VERDACCIO_GID = 65533;
const MODE_BOOTSTRAP = "bootstrap";
const MODE_LOCKED = "locked";
const BASE_CONTAINER_NAME = "agenc-private-registry";
const BASE_STORAGE_VOLUME = "agenc-private-registry-storage";
const BASE_AUTH_VOLUME = "agenc-private-registry-auth";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const configPathByMode = {
  [MODE_BOOTSTRAP]: path.join(repoRoot, "containers", "private-registry", "config.bootstrap.yaml"),
  [MODE_LOCKED]: path.join(repoRoot, "containers", "private-registry", "config.locked.yaml"),
};

function sanitizeSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 48);
}

function deriveDefaultInstance(env = process.env, cwd = repoRoot) {
  if (env.GITHUB_RUN_ID) {
    const job = sanitizeSegment(env.GITHUB_JOB ?? "job");
    return sanitizeSegment(`${env.GITHUB_RUN_ID}-${job}`) || "ci";
  }

  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 10);
  return `wt-${hash}`;
}

function parseInteger(value, flagName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env, cwd = repoRoot) {
  if (argv.length === 0) {
    throw new Error("command is required: start, stop, restart, status, logs, health, reset");
  }

  const command = argv[0];
  const options = {
    command,
    mode: MODE_LOCKED,
    instance: env.PRIVATE_REGISTRY_INSTANCE || deriveDefaultInstance(env, cwd),
    port: env.PRIVATE_REGISTRY_PORT ? parseInteger(env.PRIVATE_REGISTRY_PORT, "PRIVATE_REGISTRY_PORT") : DEFAULT_PORT,
    json: false,
    follow: false,
    waitMs: env.PRIVATE_REGISTRY_HEALTH_WAIT_MS
      ? parseInteger(env.PRIVATE_REGISTRY_HEALTH_WAIT_MS, "PRIVATE_REGISTRY_HEALTH_WAIT_MS")
      : 0,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--mode":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--mode requires a value");
        }
        options.mode = argv[index];
        break;
      case "--instance":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--instance requires a value");
        }
        options.instance = sanitizeSegment(argv[index]);
        break;
      case "--port":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--port requires a value");
        }
        options.port = parseInteger(argv[index], "--port");
        break;
      case "--wait-ms":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--wait-ms requires a value");
        }
        options.waitMs = parseInteger(argv[index], "--wait-ms");
        break;
      case "--json":
        options.json = true;
        break;
      case "--follow":
        options.follow = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.instance) {
    throw new Error("instance must not be empty");
  }

  if (![MODE_BOOTSTRAP, MODE_LOCKED].includes(options.mode)) {
    throw new Error(`unsupported mode: ${options.mode}`);
  }

  return options;
}

function buildRuntime(options) {
  const containerName = `${BASE_CONTAINER_NAME}-${options.instance}`;
  const storageVolume = `${BASE_STORAGE_VOLUME}-${options.instance}`;
  const authVolume = `${BASE_AUTH_VOLUME}-${options.instance}`;
  const configPath = configPathByMode[options.mode];
  const runtimeConfigDir = path.join(repoRoot, ".tmp", "private-registry", options.instance);
  const mountedConfigPath = path.join(runtimeConfigDir, `${options.mode}-config.yaml`);

  return {
    mode: options.mode,
    instance: options.instance,
    port: options.port,
    registryUrl: `http://127.0.0.1:${options.port}`,
    containerName,
    storageVolume,
    authVolume,
    configPath,
    runtimeConfigDir,
    mountedConfigPath,
    image: DEFAULT_IMAGE,
  };
}

function docker(args, { stdio = "pipe", allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (!allowFailure && (result.status ?? 1) !== 0) {
    const detail = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`docker ${args.join(" ")} failed with status ${result.status ?? 1}${detail ? `\n${detail}` : ""}`);
  }

  return result;
}

function dockerInspectObject(name) {
  const result = docker(["inspect", name], { allowFailure: true });
  if ((result.status ?? 1) !== 0) {
    return null;
  }
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
}

function volumeExists(name) {
  const result = docker(["volume", "inspect", name], { allowFailure: true });
  return (result.status ?? 1) === 0;
}

function removeContainerIfExists(name) {
  const result = docker(["rm", "-f", name], { allowFailure: true });
  return (result.status ?? 1) === 0;
}

function ensureVolume(name) {
  if (!volumeExists(name)) {
    docker(["volume", "create", name]);
  }
}

function buildVolumeInitScript() {
  return [
    "mkdir -p /mnt/auth /mnt/storage",
    `chown -R ${VERDACCIO_UID}:${VERDACCIO_GID} /mnt/auth /mnt/storage`,
    "chmod 0775 /mnt/auth /mnt/storage",
  ].join(" && ");
}

function initializeWritableVolumes(runtime) {
  docker([
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    "-v",
    `${runtime.authVolume}:/mnt/auth`,
    "-v",
    `${runtime.storageVolume}:/mnt/storage`,
    runtime.image,
    "-lc",
    buildVolumeInitScript(),
  ]);
}

function removeVolumeIfExists(name) {
  const result = docker(["volume", "rm", "-f", name], { allowFailure: true });
  return (result.status ?? 1) === 0;
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`port 127.0.0.1:${port} is already in use`);
    }
    throw error;
  });
}

function summarizeState(runtime, inspectObject) {
  const state = inspectObject?.State ?? null;
  const labels = inspectObject?.Config?.Labels ?? {};
  const labeledMode = labels["agenc.private-registry.mode"] ?? runtime.mode;
  const labeledPort = Number.parseInt(labels["agenc.private-registry.port"] ?? String(runtime.port), 10);
  const port = Number.isInteger(labeledPort) && labeledPort > 0 ? labeledPort : runtime.port;
  return {
    instance: labels["agenc.private-registry.instance"] ?? runtime.instance,
    mode: labeledMode,
    port,
    registryUrl: `http://127.0.0.1:${port}`,
    containerName: runtime.containerName,
    storageVolume: runtime.storageVolume,
    authVolume: runtime.authVolume,
    configPath: path.relative(repoRoot, runtime.configPath),
    image: runtime.image,
    status: state?.Status ?? "absent",
    running: state?.Running ?? false,
    startedAt: state?.StartedAt ?? null,
    finishedAt: state?.FinishedAt ?? null,
  };
}

async function prepareMountedConfig(runtime) {
  await mkdir(runtime.runtimeConfigDir, { recursive: true });
  await copyFile(runtime.configPath, runtime.mountedConfigPath);
  await chmod(runtime.mountedConfigPath, 0o644);
}

async function startRegistry(runtime) {
  const inspectObject = dockerInspectObject(runtime.containerName);
  if (inspectObject?.State?.Running) {
    const modeLabel = inspectObject.Config?.Labels?.["agenc.private-registry.mode"] ?? null;
    const portLabel = inspectObject.Config?.Labels?.["agenc.private-registry.port"] ?? null;
    if (modeLabel === runtime.mode && portLabel === String(runtime.port)) {
      return summarizeState(runtime, inspectObject);
    }
    removeContainerIfExists(runtime.containerName);
  } else if (inspectObject) {
    removeContainerIfExists(runtime.containerName);
  }

  await assertPortAvailable(runtime.port);
  ensureVolume(runtime.storageVolume);
  ensureVolume(runtime.authVolume);
  initializeWritableVolumes(runtime);
  await prepareMountedConfig(runtime);

  docker([
    "run",
    "-d",
    "--name",
    runtime.containerName,
    "--label",
    "agenc.private-registry=true",
    "--label",
    `agenc.private-registry.instance=${runtime.instance}`,
    "--label",
    `agenc.private-registry.mode=${runtime.mode}`,
    "--label",
    `agenc.private-registry.port=${runtime.port}`,
    "--entrypoint",
    "verdaccio",
    "-p",
    `127.0.0.1:${runtime.port}:${CONTAINER_PORT}`,
    "-v",
    `${runtime.storageVolume}:/verdaccio/storage`,
    "-v",
    `${runtime.authVolume}:/verdaccio/auth`,
    "-v",
    `${runtime.mountedConfigPath}:/verdaccio/conf/config.yaml:ro`,
    runtime.image,
    "--listen",
    `0.0.0.0:${CONTAINER_PORT}`,
    "--config",
    "/verdaccio/conf/config.yaml",
  ]);

  const refreshed = dockerInspectObject(runtime.containerName);
  if (!refreshed) {
    throw new Error(`failed to inspect started registry container ${runtime.containerName}`);
  }
  return summarizeState(runtime, refreshed);
}

function stopRegistry(runtime) {
  removeContainerIfExists(runtime.containerName);
  const inspectObject = dockerInspectObject(runtime.containerName);
  return summarizeState(runtime, inspectObject);
}

async function resetRegistry(runtime) {
  removeContainerIfExists(runtime.containerName);
  removeVolumeIfExists(runtime.storageVolume);
  removeVolumeIfExists(runtime.authVolume);
  await rm(runtime.runtimeConfigDir, { force: true, recursive: true });
  return summarizeState(runtime, null);
}

async function waitForHealth(runtime, waitMs) {
  const deadline = Date.now() + waitMs;
  do {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`${runtime.registryUrl}/-/ping`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    if (waitMs === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() <= deadline);

  return false;
}

async function healthRegistry(runtime, waitMs) {
  const healthy = await waitForHealth(runtime, waitMs);
  return {
    ...summarizeState(runtime, dockerInspectObject(runtime.containerName)),
    healthy,
  };
}

function logsRegistry(runtime, follow) {
  docker(["logs", ...(follow ? ["-f"] : []), runtime.containerName], { stdio: "inherit" });
}

function printOutput(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `instance: ${value.instance}`,
      `mode: ${value.mode}`,
      `status: ${value.status}`,
      `running: ${value.running}`,
      `registryUrl: ${value.registryUrl}`,
      `container: ${value.containerName}`,
      `storageVolume: ${value.storageVolume}`,
      `authVolume: ${value.authVolume}`,
      `config: ${value.configPath}`,
      `healthy: ${"healthy" in value ? value.healthy : "n/a"}`,
    ].join("\n") + "\n",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = buildRuntime(options);

  switch (options.command) {
    case "start":
      printOutput(await startRegistry(runtime), options.json);
      break;
    case "stop":
      printOutput(stopRegistry(runtime), options.json);
      break;
    case "restart":
      stopRegistry(runtime);
      printOutput(await startRegistry(runtime), options.json);
      break;
    case "status":
      printOutput(summarizeState(runtime, dockerInspectObject(runtime.containerName)), options.json);
      break;
    case "health": {
      const health = await healthRegistry(runtime, options.waitMs);
      printOutput(health, options.json);
      if (!health.healthy) {
        process.exit(1);
      }
      break;
    }
    case "reset":
      printOutput(await resetRegistry(runtime), options.json);
      break;
    case "logs":
      logsRegistry(runtime, options.follow);
      break;
    default:
      throw new Error(`unsupported command: ${options.command}`);
  }
}

export {
  BASE_AUTH_VOLUME,
  BASE_CONTAINER_NAME,
  BASE_STORAGE_VOLUME,
  DEFAULT_IMAGE,
  DEFAULT_PORT,
  buildRuntime,
  buildVolumeInitScript,
  deriveDefaultInstance,
  initializeWritableVolumes,
  parseArgs,
  sanitizeSegment,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
