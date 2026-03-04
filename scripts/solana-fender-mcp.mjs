#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function defaultAnchorWalletPath() {
  const home = process.env.HOME;
  if (!home) return ".config/solana/id.json";
  return path.join(home, ".config/solana/id.json");
}

function resolveFenderCommand() {
  if (process.env.FENDER_MCP_COMMAND) return process.env.FENDER_MCP_COMMAND;
  if (process.env.ANCHOR_MCP_COMMAND) return process.env.ANCHOR_MCP_COMMAND;

  const home = process.env.HOME;
  if (home) {
    const cargoPath = path.join(home, ".cargo", "bin", "anchor-mcp");
    if (fs.existsSync(cargoPath)) return cargoPath;
  }

  return "anchor-mcp";
}

const DEFAULT_SERVER_CONFIG = {
  name: "solana-fender",
  command: resolveFenderCommand(),
  args: ["--mcp"],
  env: {
    ANCHOR_PROVIDER_URL:
      process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com",
    ANCHOR_WALLET: process.env.ANCHOR_WALLET ?? defaultAnchorWalletPath(),
  },
  timeout: 30_000,
};

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

async function createClient(config) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: {
      ...process.env,
      ...(config.env ?? {}),
    },
  });

  const client = new Client(
    {
      name: "solana-fender-wrapper",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  await withTimeout(client.connect(transport), config.timeout, "MCP connect");
  return client;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/solana-fender-mcp.mjs list",
      "  node scripts/solana-fender-mcp.mjs check-file <path>",
      "  node scripts/solana-fender-mcp.mjs check-program <path>",
      "",
      "Env overrides:",
      "  FENDER_MCP_COMMAND (default: anchor-mcp or $HOME/.cargo/bin/anchor-mcp if present)",
      "  ANCHOR_PROVIDER_URL (default: https://api.devnet.solana.com)",
      "  ANCHOR_WALLET (default: $HOME/.config/solana/id.json)",
    ].join("\n"),
  );
}

function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === "object" && item.type === "text") {
          return item.text ?? "";
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join("\n");
  }
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

async function main() {
  const action = process.argv[2];
  const target = process.argv[3];

  if (!action || action === "--help" || action === "-h") {
    usage();
    process.exit(0);
  }

  const client = await createClient(DEFAULT_SERVER_CONFIG);

  try {
    if (action === "list") {
      const tools = await withTimeout(
        client.listTools(),
        DEFAULT_SERVER_CONFIG.timeout,
        "listTools",
      );
      console.log(JSON.stringify(tools, null, 2));
      return;
    }

    if ((action === "check-file" || action === "check-program") && !target) {
      console.error(`Missing path for ${action}`);
      usage();
      process.exit(2);
    }

    if (action === "check-file") {
      const filePath = path.resolve(process.cwd(), target);
      const result = await withTimeout(
        client.callTool({
          name: "security_check_file",
          arguments: { file_path: filePath },
        }),
        DEFAULT_SERVER_CONFIG.timeout,
        "security_check_file",
      );
      const text = normalizeContent(result?.content);
      if (text) console.log(text);
      process.exit(result?.isError ? 1 : 0);
      return;
    }

    if (action === "check-program") {
      const programPath = path.resolve(process.cwd(), target);
      const result = await withTimeout(
        client.callTool({
          name: "security_check_program",
          arguments: { program_path: programPath },
        }),
        DEFAULT_SERVER_CONFIG.timeout,
        "security_check_program",
      );
      const text = normalizeContent(result?.content);
      if (text) console.log(text);
      process.exit(result?.isError ? 1 : 0);
      return;
    }

    console.error(`Unknown command: ${action}`);
    usage();
    process.exit(2);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`solana-fender-mcp failed: ${message}`);
  process.exit(1);
});
