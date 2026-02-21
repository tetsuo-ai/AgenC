/**
 * MCP client connection management.
 *
 * Spawns external MCP servers as child processes and establishes
 * JSON-RPC communication via stdio transport.
 *
 * @module
 */

import type { MCPServerConfig } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

/**
 * Create an MCP client connection to an external server.
 *
 * Uses `@modelcontextprotocol/sdk` StdioClientTransport to spawn
 * the server as a child process and communicate via stdin/stdout.
 *
 * @returns MCP Client instance (typed as `any` to avoid ESM/CJS type conflicts)
 */
export async function createMCPConnection(
  config: MCPServerConfig,
  logger: Logger = silentLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  const timeout = config.timeout ?? 30_000;

  // Build env: inherit process.env (filtering undefined values) + user overrides
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (config.env) {
    Object.assign(env, config.env);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
  });

  const client = new Client(
    { name: `agenc-runtime`, version: "0.1.0" },
    { capabilities: {} },
  );

  logger.info(`Connecting to MCP server "${config.name}"...`, {
    command: config.command,
    args: config.args,
  });

  // Connect with timeout — clean up timer on success, kill child on timeout
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Kill the child process to avoid orphans
      try { client.close(); } catch { /* best-effort */ }
      reject(new Error(`MCP connection to "${config.name}" timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP server "${config.name}"`);
  return client;
}
