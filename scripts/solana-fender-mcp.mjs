#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeDist = path.resolve(__dirname, "../runtime/dist/index.mjs");

const DEFAULT_SERVER_CONFIG = {
  name: "solana-fender",
  command: process.env.FENDER_MCP_COMMAND ?? "/home/tetsuo/.cargo/bin/anchor-mcp",
  args: ["--mcp"],
  env: {
    ANCHOR_PROVIDER_URL:
      process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com",
    ANCHOR_WALLET:
      process.env.ANCHOR_WALLET ?? "/home/tetsuo/.config/solana/id.json",
  },
  timeout: 30_000,
};

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/solana-fender-mcp.mjs list",
      "  node scripts/solana-fender-mcp.mjs check-file <path>",
      "  node scripts/solana-fender-mcp.mjs check-program <path>",
      "",
      "Env overrides:",
      "  FENDER_MCP_COMMAND (default: /home/tetsuo/.cargo/bin/anchor-mcp)",
      "  ANCHOR_PROVIDER_URL (default: https://api.devnet.solana.com)",
      "  ANCHOR_WALLET (default: /home/tetsuo/.config/solana/id.json)",
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

  const { createMCPConnection } = await import(runtimeDist);
  const client = await createMCPConnection(DEFAULT_SERVER_CONFIG);

  try {
    if (action === "list") {
      const tools = await client.listTools();
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
      const result = await client.callTool({
        name: "security_check_file",
        arguments: { file_path: filePath },
      });
      const text = normalizeContent(result?.content);
      if (text) console.log(text);
      process.exit(result?.isError ? 1 : 0);
      return;
    }

    if (action === "check-program") {
      const programPath = path.resolve(process.cwd(), target);
      const result = await client.callTool({
        name: "security_check_program",
        arguments: { program_path: programPath },
      });
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
