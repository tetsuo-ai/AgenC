/**
 * MCP tool bridge for @agenc/runtime.
 *
 * Converts MCP server tools into runtime Tool instances,
 * enabling seamless integration with the ToolRegistry and LLM system.
 *
 * @module
 */

import type { Tool, ToolResult, JSONSchema } from "../tools/types.js";
import type { MCPToolBridge } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

/**
 * Create a tool bridge from an MCP client connection.
 *
 * Queries the server for available tools via `client.listTools()`,
 * then wraps each as a runtime `Tool` with namespaced names:
 * `mcp.{serverName}.{toolName}`
 *
 * @param client - Connected MCP Client instance (from createMCPConnection)
 * @param serverName - Server name for tool namespacing
 * @param logger - Optional logger
 * @returns MCPToolBridge with adapted tools
 */
export async function createToolBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  logger: Logger = silentLogger,
): Promise<MCPToolBridge> {
  const response = await client.listTools();
  const mcpTools = response.tools ?? [];

  logger.info(`MCP server "${serverName}" exposes ${mcpTools.length} tools`);

  // Track disposal to prevent use-after-close
  let disposed = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Tool[] = mcpTools.map((mcpTool: any) => {
    const namespacedName = `mcp.${serverName}.${mcpTool.name}`;

    return {
      name: namespacedName,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,

      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (disposed) {
          return {
            content: `MCP server "${serverName}" has been disconnected`,
            isError: true,
          };
        }

        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });

          // MCP tool results contain a content array
          const content = Array.isArray(result.content)
            ? result.content
                .map((c: { type: string; text?: string }) =>
                  c.type === "text" ? c.text ?? "" : JSON.stringify(c),
                )
                .join("\n")
            : typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content);

          return {
            content,
            isError: result.isError === true,
          };
        } catch (error) {
          return {
            content: `MCP tool "${mcpTool.name}" failed: ${(error as Error).message}`,
            isError: true,
          };
        }
      },
    };
  });

  return {
    serverName,
    tools,
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await client.close();
        logger.info(`Disconnected from MCP server "${serverName}"`);
      } catch (error) {
        logger.warn?.(
          `Error disconnecting from MCP server "${serverName}":`,
          error,
        );
      }
    },
  };
}
