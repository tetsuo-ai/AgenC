#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultConfigPath = path.resolve(__dirname, "../mcp/security-stack.mcp.json");
const DEFAULT_TIMEOUT_MS = 20_000;

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/check-security-mcp-stack.mjs [--config <path>] [--verbose]",
      "",
      "Options:",
      "  --config <path>   Path to MCP JSON config (default: mcp/security-stack.mcp.json)",
      "  --verbose         Print command output for each probe",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    configPath: defaultConfigPath,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --config");
      }
      args.configPath = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function trimOutput(text) {
  if (typeof text !== "string") return "";
  return text.trim();
}

function looksLikeGitGuardianConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  if (serverConfig.command !== "uvx") return false;
  if (!Array.isArray(serverConfig.args)) return false;
  return serverConfig.args.some(
    (arg) =>
      typeof arg === "string" &&
      (arg.includes("github.com/GitGuardian/ggmcp") || arg === "developer-mcp-server" || arg === "secops-mcp-server"),
  );
}

function looksLikeSemgrepConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  return serverConfig.command === "uvx" && Array.isArray(serverConfig.args) && serverConfig.args.includes("semgrep-mcp");
}

function looksLikeTrivyConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  if (!Array.isArray(serverConfig.args)) return false;
  const commandBasename =
    typeof serverConfig.command === "string"
      ? path.basename(serverConfig.command)
      : "";
  return commandBasename === "trivy" && serverConfig.args.includes("mcp");
}

function looksLikeAnchorMcpConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  return typeof serverConfig.command === "string" && serverConfig.command.endsWith("anchor-mcp");
}

function buildProbe(serverName, serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object" || typeof serverConfig.command !== "string") {
    return null;
  }

  if (looksLikeSemgrepConfig(serverConfig)) {
    return {
      args: ["semgrep-mcp", "--version"],
      command: "uvx",
      note: "Semgrep MCP package/version probe",
    };
  }

  if (looksLikeTrivyConfig(serverConfig)) {
    return {
      args: ["mcp", "--help"],
      command: serverConfig.command,
      note: "Trivy MCP plugin probe",
    };
  }

  if (looksLikeGitGuardianConfig(serverConfig)) {
    return {
      args: [
        "--from",
        "git+https://github.com/GitGuardian/ggmcp",
        "python",
        "-c",
        "import developer_mcp_server, secops_mcp_server; print('ggmcp import OK')",
      ],
      command: "uvx",
      note: "GitGuardian MCP package import probe",
    };
  }

  if (looksLikeAnchorMcpConfig(serverConfig)) {
    return {
      args: ["--help"],
      command: serverConfig.command,
      note: "Anchor MCP binary probe",
    };
  }

  return {
    args: ["--help"],
    command: serverConfig.command,
    note: `Generic --help probe for ${serverName}`,
  };
}

function runProbe(command, args) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_TIMEOUT_MS,
  });
}

async function loadConfig(configPath) {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.mcpServers || typeof parsed.mcpServers !== "object") {
    throw new Error(`Invalid MCP config at ${configPath}: expected { \"mcpServers\": { ... } }`);
  }
  return parsed;
}

async function main() {
  const { configPath, verbose } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    console.log(`No MCP servers defined in ${configPath}`);
    process.exit(0);
  }

  console.log(`Probing ${servers.length} security MCP server(s) from ${configPath}`);

  let failures = 0;
  for (const [serverName, serverConfig] of servers) {
    const probe = buildProbe(serverName, serverConfig);
    if (probe === null) {
      failures += 1;
      console.log(`[${serverName}] FAIL (missing valid "command" in config)`);
      continue;
    }

    process.stdout.write(`[${serverName}] ${probe.note} ... `);
    const result = runProbe(probe.command, probe.args);

    const stdout = trimOutput(result.stdout);
    const stderr = trimOutput(result.stderr);
    const timedOut = result.signal === "SIGTERM" && result.status === null;
    const ok = result.status === 0;

    if (ok) {
      console.log("OK");
      if (verbose) {
        if (stdout) console.log(`  stdout: ${stdout}`);
        if (stderr) console.log(`  stderr: ${stderr}`);
      }
      continue;
    }

    failures += 1;
    if (result.error) {
      console.log(`FAIL (${toErrorMessage(result.error)})`);
    } else if (timedOut) {
      console.log(`FAIL (probe timed out after ${DEFAULT_TIMEOUT_MS}ms)`);
    } else {
      const details = stderr || stdout || `exit code ${String(result.status)}`;
      console.log(`FAIL (${details})`);
    }
  }

  if (failures > 0) {
    console.error(`${failures} security MCP probe(s) failed`);
    process.exit(1);
  }

  console.log("All configured security MCP probes passed.");
}

main().catch((error) => {
  console.error(`check-security-mcp-stack failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
