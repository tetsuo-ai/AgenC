/**
 * MCP client module for @agenc/runtime.
 *
 * Provides infrastructure for connecting to external MCP servers
 * and bridging their tools into the runtime's tool system.
 *
 * @module
 */

export type { MCPServerConfig, MCPToolBridge } from "./types.js";
export { createMCPConnection } from "./connection.js";
export { createToolBridge } from "./tool-bridge.js";
export { ResilientMCPBridge } from "./resilient-bridge.js";
export { MCPManager } from "./manager.js";
