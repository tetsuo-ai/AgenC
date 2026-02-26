/**
 * MCP client types for @agenc/runtime.
 *
 * Defines configuration and bridge interfaces for connecting to external
 * MCP servers (e.g. Peekaboo, macos-automator-mcp) via stdio transport.
 *
 * @module
 */

import type { Tool } from "../tools/types.js";

/**
 * Configuration for an external MCP server launched as a child process.
 */
export interface MCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  name: string;
  /** Executable command (e.g. "npx", "node") */
  command: string;
  /** Command arguments (e.g. ["-y", "@nicholasareed/peekaboo-mcp@latest"]) */
  args: string[];
  /** Optional environment variables for the child process */
  env?: Record<string, string>;
  /** Whether this server is enabled. Default: true */
  enabled?: boolean;
  /** Connection timeout in ms. Default: 30000 */
  timeout?: number;
  /** Route this server into a container instead of running on the host.
   *  Currently only "desktop" is supported — the MCP server will be spawned
   *  via `docker exec` inside the desktop sandbox container. */
  container?: string;
}

/**
 * Bridge between an MCP server connection and the runtime Tool system.
 */
export interface MCPToolBridge {
  /** Name of the connected MCP server */
  readonly serverName: string;
  /** Tools exposed by this server, adapted to the runtime Tool interface */
  readonly tools: Tool[];
  /** Disconnect from the server and clean up resources */
  dispose(): Promise<void>;
}
