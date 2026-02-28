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

const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 45_000;

interface ToolBridgeOptions {
  listToolsTimeoutMs?: number;
  callToolTimeoutMs?: number;
}

interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface MCPListToolsResponse {
  tools?: MCPToolDescriptor[];
}

interface MCPCallToolResponse {
  content?: unknown;
  isError?: boolean;
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

async function withRPCDeadline<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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
  options: ToolBridgeOptions = {},
): Promise<MCPToolBridge> {
  const listToolsTimeoutMs = normalizeTimeoutMs(
    options.listToolsTimeoutMs,
    DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS,
  );
  const callToolTimeoutMs = normalizeTimeoutMs(
    options.callToolTimeoutMs,
    DEFAULT_MCP_CALL_TIMEOUT_MS,
  );

  const response = await withRPCDeadline<MCPListToolsResponse>(
    `MCP server "${serverName}" listTools`,
    listToolsTimeoutMs,
    () => client.listTools(),
  );
  const mcpTools = Array.isArray(response.tools) ? response.tools : [];

  logger.info(`MCP server "${serverName}" exposes ${mcpTools.length} tools`);

  // Track disposal to prevent use-after-close
  let disposed = false;

  const tools: Tool[] = mcpTools.map((mcpTool) => {
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
          const result = await withRPCDeadline<MCPCallToolResponse>(
            `MCP tool "${mcpTool.name}" callTool`,
            callToolTimeoutMs,
            () =>
              client.callTool({
                name: mcpTool.name,
                arguments: args,
              }),
          );

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
