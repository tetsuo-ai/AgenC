/**
 * Resilient MCP tool bridge with automatic reconnection.
 *
 * Wraps an inner MCPToolBridge, detecting connection errors on tool calls
 * and automatically reconnecting with exponential backoff.
 *
 * @module
 */

import type { Tool, ToolResult } from "../tools/types.js";
import type { MCPServerConfig, MCPToolBridge } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

/** Patterns that indicate the underlying MCP connection is dead. */
const CONNECTION_ERROR_PATTERNS = [
  "not connected",
  "disconnected",
  "epipe",
  "channel closed",
  "process exited",
  "connection refused",
  "broken pipe",
  "transport closed",
  "client closed",
  "econnreset",
  "econnrefused",
];

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * Wraps an MCPToolBridge with automatic reconnection on connection failures.
 *
 * The outer `tools` array stays stable (same object references) — the inner
 * bridge is swapped transparently on reconnect.
 */
export class ResilientMCPBridge implements MCPToolBridge {
  readonly serverName: string;
  readonly tools: Tool[];

  private inner: MCPToolBridge;
  private readonly config: MCPServerConfig;
  private readonly logger: Logger;

  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 0;
  private disposed = false;

  constructor(
    config: MCPServerConfig,
    initialBridge: MCPToolBridge,
    logger: Logger = silentLogger,
  ) {
    this.config = config;
    this.inner = initialBridge;
    this.logger = logger;
    this.serverName = initialBridge.serverName;

    // Build stable proxy tools that delegate to the current inner bridge
    this.tools = initialBridge.tools.map((outerTool) =>
      this.createProxyTool(outerTool.name, outerTool),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.inner.dispose();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createProxyTool(namespacedName: string, templateTool: Tool): Tool {
    return {
      name: namespacedName,
      description: templateTool.description,
      inputSchema: templateTool.inputSchema,
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        if (this.disposed) {
          return { content: `MCP server "${this.serverName}" has been disposed`, isError: true };
        }

        if (this.reconnecting) {
          return { content: `MCP server "${this.serverName}" is reconnecting...`, isError: true };
        }

        // Find the matching inner tool by suffix (strip mcp.{server}. prefix)
        const toolSuffix = namespacedName.replace(`mcp.${this.serverName}.`, "");
        const innerTool = this.inner.tools.find((t) =>
          t.name === namespacedName || t.name.endsWith(`.${toolSuffix}`),
        );
        if (!innerTool) {
          return { content: `Tool "${namespacedName}" not found after reconnect`, isError: true };
        }

        const result = await innerTool.execute(args);

        if (result.isError && isConnectionError(result.content)) {
          this.scheduleReconnect();
          return { content: `MCP server "${this.serverName}" lost connection — reconnecting...`, isError: true };
        }

        return result;
      },
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting) return;

    this.reconnecting = true;
    this.backoffMs = this.backoffMs === 0
      ? INITIAL_BACKOFF_MS
      : Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    this.logger.info(
      `MCP server "${this.serverName}" connection lost — reconnecting in ${this.backoffMs}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      void this.reconnect();
    }, this.backoffMs);
  }

  private async reconnect(): Promise<void> {
    if (this.disposed) return;

    try {
      // Dispose old bridge (best-effort)
      try { await this.inner.dispose(); } catch { /* ignore */ }

      const { createMCPConnection } = await import("./connection.js");
      const { createToolBridge } = await import("./tool-bridge.js");

      const client = await createMCPConnection(this.config, this.logger);
      const newBridge = await createToolBridge(client, this.serverName, this.logger);

      this.inner = newBridge;
      this.reconnecting = false;
      this.backoffMs = 0;

      this.logger.info(`MCP server "${this.serverName}" reconnected (${newBridge.tools.length} tools)`);
    } catch (error) {
      this.logger.warn?.(
        `MCP server "${this.serverName}" reconnection failed: ${(error as Error).message}`,
      );
      this.reconnecting = false;
      // Schedule another attempt with increased backoff
      this.scheduleReconnect();
    }
  }
}

/** Check if an error message indicates a dead connection. */
function isConnectionError(content: string): boolean {
  const lower = content.toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
