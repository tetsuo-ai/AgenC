#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_READINESS_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_PORT_CHECK_TIMEOUT_MS = 1_000;

export function daemonLogLooksReady(agent, logText) {
  return (
    logText.includes(`Gateway started on port ${agent.gatewayPort}`) &&
    logText.includes(`Messaging listener started on port ${agent.messagingPort}`) &&
    logText.includes("Daemon started {")
  );
}

export async function isTcpPortOpen(
  port,
  {
    host = "127.0.0.1",
    timeoutMs = DEFAULT_PORT_CHECK_TIMEOUT_MS,
  } = {},
) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForAgentRuntimeReady(
  agent,
  {
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onProgress,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const [gatewayReady, messagingReady] = await Promise.all([
      isTcpPortOpen(agent.gatewayPort),
      isTcpPortOpen(agent.messagingPort),
    ]);

    let logReady = false;
    try {
      const logText = await readFile(agent.daemonLogPath, "utf8");
      logReady = daemonLogLooksReady(agent, logText);
    } catch {
      logReady = false;
    }

    if (gatewayReady && messagingReady && logReady) {
      return {
        gatewayReady,
        messagingReady,
        logReady,
      };
    }

    if (typeof onProgress === "function") {
      onProgress(
        `${agent.label}: waiting for readiness (gateway=${gatewayReady}, messaging=${messagingReady}, log=${logReady})`,
      );
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `${agent.label} did not become ready within ${timeoutMs}ms (gateway=${agent.gatewayPort}, messaging=${agent.messagingPort}, log=${agent.daemonLogPath})`,
  );
}

export async function waitForAllAgentRuntimesReady(
  agents,
  {
    timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    onProgress,
  } = {},
) {
  for (const agent of agents) {
    if (typeof onProgress === "function") {
      onProgress(`${agent.label}: waiting for daemon readiness via ${agent.daemonLogPath}`);
    }
    await waitForAgentRuntimeReady(agent, { timeoutMs });
    if (typeof onProgress === "function") {
      onProgress(
        `${agent.label}: daemon ready on gateway ${agent.gatewayPort} / messaging ${agent.messagingPort}`,
      );
    }
  }
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/agenc-social-readiness.mjs wait \\
    --label <agent-label> \\
    --gateway-port <port> \\
    --messaging-port <port> \\
    --log-path <path> \\
    [--timeout-ms <ms>]
`);
}

function parseCliArgs(argv) {
  if (argv.length === 0 || argv[0] !== "wait") {
    usage();
    throw new Error("Missing or unsupported command");
  }

  const options = {
    label: null,
    gatewayPort: null,
    messagingPort: null,
    logPath: null,
    timeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--label" && argv[index + 1]) {
      options.label = String(argv[++index]);
      continue;
    }
    if (arg === "--gateway-port" && argv[index + 1]) {
      options.gatewayPort = Number(argv[++index]);
      continue;
    }
    if (arg === "--messaging-port" && argv[index + 1]) {
      options.messagingPort = Number(argv[++index]);
      continue;
    }
    if (arg === "--log-path" && argv[index + 1]) {
      options.logPath = String(argv[++index]);
      continue;
    }
    if (arg === "--timeout-ms" && argv[index + 1]) {
      options.timeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    !options.label ||
    !Number.isFinite(options.gatewayPort) ||
    !Number.isFinite(options.messagingPort) ||
    !options.logPath
  ) {
    usage();
    throw new Error("Missing required readiness arguments");
  }

  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  await waitForAgentRuntimeReady(
    {
      label: options.label,
      gatewayPort: options.gatewayPort,
      messagingPort: options.messagingPort,
      daemonLogPath: options.logPath,
    },
    {
      timeoutMs: options.timeoutMs,
    },
  );
  process.stdout.write(
    `${options.label} ready on gateway ${options.gatewayPort} / messaging ${options.messagingPort}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
