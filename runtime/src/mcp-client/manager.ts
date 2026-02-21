/**
 * MCP connection manager for @agenc/runtime.
 *
 * Manages multiple MCP server connections, creating tool bridges
 * for each and exposing a unified tool list for the ToolRegistry.
 *
 * @module
 */

import type { MCPServerConfig, MCPToolBridge } from "./types.js";
import type { Tool } from "../tools/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tool-bridge.js";

/**
 * Manages multiple external MCP server connections.
 *
 * @example
 * ```typescript
 * const manager = new MCPManager([
 *   { name: 'peekaboo', command: 'npx', args: ['-y', '@steipete/peekaboo@latest'] },
 * ], logger);
 *
 * await manager.start();
 * registry.registerAll(manager.getTools());
 *
 * // Later...
 * await manager.stop();
 * ```
 */
export class MCPManager {
  private readonly configs: MCPServerConfig[];
  private readonly logger: Logger;
  private readonly bridges: Map<string, MCPToolBridge> = new Map();

  constructor(configs: MCPServerConfig[], logger: Logger = silentLogger) {
    this.configs = configs;
    this.logger = logger;
  }

  /**
   * Connect to all enabled MCP servers and create tool bridges.
   * Failures on individual servers are logged but don't block others.
   */
  async start(): Promise<void> {
    const enabledConfigs = this.configs.filter((c) => c.enabled !== false);

    if (enabledConfigs.length === 0) {
      this.logger.info("No MCP servers configured");
      return;
    }

    this.logger.info(`Starting ${enabledConfigs.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      enabledConfigs.map(async (config) => {
        const client = await createMCPConnection(config, this.logger);
        try {
          const bridge = await createToolBridge(client, config.name, this.logger);
          this.bridges.set(config.name, bridge);
          return bridge;
        } catch (error) {
          // Close the client if tool bridge creation fails to avoid orphaned processes
          try { await client.close(); } catch { /* best-effort */ }
          throw error;
        }
      }),
    );

    let successCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        this.logger.error(
          `Failed to connect to MCP server "${enabledConfigs[i].name}":`,
          result.reason,
        );
      }
    }

    const totalTools = this.getTools().length;
    this.logger.info(
      `MCP: ${successCount}/${enabledConfigs.length} servers connected, ${totalTools} tools available`,
    );
  }

  /**
   * Disconnect from all MCP servers and clean up resources.
   */
  async stop(): Promise<void> {
    const bridges = Array.from(this.bridges.values());
    // Dispose all bridges first, then clear the map to avoid race conditions
    await Promise.allSettled(bridges.map((bridge) => bridge.dispose()));
    this.bridges.clear();
    this.logger.info("All MCP servers disconnected");
  }

  /**
   * Get all tools from all connected MCP servers.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const bridge of this.bridges.values()) {
      tools.push(...bridge.tools);
    }
    return tools;
  }

  /**
   * Get tools from a specific MCP server.
   */
  getToolsByServer(name: string): Tool[] {
    return this.bridges.get(name)?.tools ?? [];
  }

  /**
   * Get the names of all connected servers.
   */
  getConnectedServers(): string[] {
    return Array.from(this.bridges.keys());
  }
}
