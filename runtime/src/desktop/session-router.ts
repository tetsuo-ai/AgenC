/**
 * Desktop session router — intercepts `desktop.*` and `playwright.*` tool calls
 * and routes them to the correct sandbox container's REST bridge or Playwright MCP bridge.
 *
 * Wraps a base ToolHandler with desktop-awareness. Non-desktop tools pass through
 * to the original handler unchanged.
 */

import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { ToolHandler } from "../llm/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { DesktopSandboxManager } from "./manager.js";
import { DesktopRESTBridge } from "./rest-bridge.js";
import type { MCPServerConfig, MCPToolBridge } from "../mcp-client/types.js";
import { ResilientMCPBridge } from "../mcp-client/resilient-bridge.js";

// ============================================================================
// Auto-screenshot constants
// ============================================================================

/** Desktop tools that mutate visual state — trigger auto-screenshot. */
const DESKTOP_ACTION_TOOLS = new Set([
  "mouse_click",
  "mouse_move",
  "mouse_drag",
  "mouse_scroll",
  "keyboard_type",
  "keyboard_key",
  "bash",
  "window_focus",
]);

const AUTO_SCREENSHOT_DELAY_MS = 300;

// ============================================================================
// Desktop tool definitions (static — same across all containers)
// ============================================================================

/** Cached tool schemas fetched from the first bridge connection. */
let cachedDesktopTools: Tool[] | null = null;

/** Cached Playwright tool schemas from the first MCP bridge connection. */
let cachedPlaywrightTools: Tool[] | null = null;

/** Cached container MCP tool schemas by server name, from the first bridge connection. */
const cachedContainerMCPTools: Map<string, Tool[]> = new Map();

// ============================================================================
// Session-scoped tool handler factory
// ============================================================================

export interface DesktopRouterOptions {
  desktopManager: DesktopSandboxManager;
  bridges: Map<string, DesktopRESTBridge>;
  /** Per-session Playwright MCP bridges. Optional — omit to disable Playwright. */
  playwrightBridges?: Map<string, MCPToolBridge>;
  /** MCP server configs that should run inside the desktop container. */
  containerMCPConfigs?: MCPServerConfig[];
  /** Per-session container MCP bridges (sessionId → bridge array). */
  containerMCPBridges?: Map<string, MCPToolBridge[]>;
  logger?: Logger;
  /** Auto-capture screenshot after action tools. Default: false. */
  autoScreenshot?: boolean;
}

/**
 * Creates a session-scoped ToolHandler that intercepts `desktop.*` and
 * `playwright.*` tool calls and routes them to the appropriate sandbox container.
 *
 * @param baseHandler - The original ToolHandler for non-desktop tools
 * @param sessionId - The current chat session ID
 * @param options - Desktop manager, bridge map, and logger
 * @returns A ToolHandler that transparently handles desktop tools
 */
export function createDesktopAwareToolHandler(
  baseHandler: ToolHandler,
  sessionId: string,
  options: DesktopRouterOptions,
): ToolHandler {
  const {
    desktopManager,
    bridges,
    playwrightBridges,
    containerMCPConfigs,
    containerMCPBridges,
    logger: log = silentLogger,
    autoScreenshot = false,
  } = options;

  // Build a set of container MCP server names for fast routing checks
  const containerMCPNames = new Set(containerMCPConfigs?.map((c) => c.name) ?? []);

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    // --- Playwright tool routing ---
    if (name.startsWith("playwright.") && playwrightBridges) {
      return handlePlaywrightCall(
        name,
        args,
        sessionId,
        desktopManager,
        bridges,
        playwrightBridges,
        log,
      );
    }

    // --- Container MCP routing: mcp.{serverName}.{toolName} ---
    if (
      name.startsWith("mcp.") &&
      containerMCPConfigs &&
      containerMCPBridges
    ) {
      const parts = name.split(".");
      // mcp.{serverName}.{rest...}
      if (parts.length >= 3 && containerMCPNames.has(parts[1])) {
        return handleContainerMCPCall(
          name,
          args,
          sessionId,
          desktopManager,
          bridges,
          containerMCPConfigs,
          containerMCPBridges,
          log,
        );
      }
    }

    if (!name.startsWith("desktop.")) {
      return baseHandler(name, args);
    }

    const toolName = name.slice("desktop.".length);

    // Ensure bridge is connected for this session
    let bridge = bridges.get(sessionId);
    if (!bridge || !bridge.isConnected()) {
      bridge = await ensureBridge(sessionId, desktopManager, bridges, log);
      if (!bridge) {
        return safeStringify({ error: "Desktop sandbox unavailable" });
      }
    }

    const tool = bridge.getTools().find((t) => t.name === `desktop.${toolName}`);
    if (!tool) {
      return safeStringify({ error: `Unknown desktop tool: ${toolName}` });
    }

    // Reset idle timer
    const handle = desktopManager.getHandleBySession(sessionId);
    if (handle) {
      desktopManager.touchActivity(handle.containerId);
    }

    const result: ToolResult = await tool.execute(args);

    // Auto-capture screenshot after action tools so the LLM can see the result
    if (autoScreenshot && DESKTOP_ACTION_TOOLS.has(toolName)) {
      try {
        await new Promise((r) => setTimeout(r, AUTO_SCREENSHOT_DELAY_MS));
        const screenshotTool = bridge.getTools().find((t) => t.name === "desktop.screenshot");
        if (screenshotTool) {
          const screenshot: ToolResult = await screenshotTool.execute({});
          try {
            const actionData = JSON.parse(result.content) as Record<string, unknown>;
            const shotData = JSON.parse(screenshot.content) as Record<string, unknown>;
            return safeStringify({
              ...actionData,
              _screenshot: { dataUrl: shotData.dataUrl, width: shotData.width, height: shotData.height },
            });
          } catch {
            return result.content + "\n" + screenshot.content;
          }
        }
      } catch (err) {
        log.debug?.(`Auto-screenshot failed for ${toolName}: ${toErrorMessage(err)}`);
      }
    }

    return result.content;
  };
}

/**
 * Returns the cached desktop tool definitions for registration with the ToolRegistry.
 * These are static schemas (same for all containers) discovered from the first bridge connection.
 *
 * Returns null if no bridge has connected yet — caller should defer registration
 * until the first desktop tool call triggers lazy initialization.
 */
export function getCachedDesktopToolDefinitions(): readonly Tool[] | null {
  return cachedDesktopTools;
}

/**
 * Returns the cached Playwright tool definitions discovered from the first MCP bridge.
 * Returns null if no Playwright bridge has connected yet.
 */
export function getCachedPlaywrightToolDefinitions(): readonly Tool[] | null {
  return cachedPlaywrightTools;
}

/**
 * Returns the cached container MCP tool definitions by server name.
 * Returns null for a given server if no bridge has connected yet.
 */
export function getCachedContainerMCPToolDefinitions(): ReadonlyMap<string, readonly Tool[]> {
  return cachedContainerMCPTools;
}

/**
 * Disconnect and remove the bridge for a session.
 * Called on session reset, /desktop stop, etc.
 */
export function destroySessionBridge(
  sessionId: string,
  bridges: Map<string, DesktopRESTBridge>,
  playwrightBridges?: Map<string, MCPToolBridge>,
  containerMCPBridges?: Map<string, MCPToolBridge[]>,
): void {
  const bridge = bridges.get(sessionId);
  if (bridge) {
    bridge.disconnect();
    bridges.delete(sessionId);
  }

  const pwBridge = playwrightBridges?.get(sessionId);
  if (pwBridge) {
    void pwBridge.dispose().catch(() => {});
    playwrightBridges!.delete(sessionId);
  }

  const mcpBridges = containerMCPBridges?.get(sessionId);
  if (mcpBridges) {
    for (const b of mcpBridges) {
      void b.dispose().catch(() => {});
    }
    containerMCPBridges!.delete(sessionId);
  }
}

// ============================================================================
// Internal
// ============================================================================

/** Route a `playwright.*` tool call to the session's Playwright MCP bridge. */
async function handlePlaywrightCall(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  bridges: Map<string, DesktopRESTBridge>,
  playwrightBridges: Map<string, MCPToolBridge>,
  log: Logger,
): Promise<string> {
  // Ensure desktop bridge exists first (Playwright needs a running container)
  let bridge = bridges.get(sessionId);
  if (!bridge || !bridge.isConnected()) {
    bridge = await ensureBridge(sessionId, desktopManager, bridges, log);
    if (!bridge) {
      return safeStringify({ error: "Desktop sandbox unavailable" });
    }
  }

  // Ensure Playwright bridge exists
  let pwBridge = playwrightBridges.get(sessionId);
  if (!pwBridge) {
    pwBridge = await ensurePlaywrightBridge(sessionId, desktopManager, playwrightBridges, log);
    if (!pwBridge) {
      return safeStringify({ error: "Playwright browser unavailable — falling back to desktop tools" });
    }
  }

  const tool = pwBridge.tools.find((t) => t.name === name);
  if (!tool) {
    return safeStringify({ error: `Unknown Playwright tool: ${name}` });
  }

  // Reset idle timer
  const handle = desktopManager.getHandleBySession(sessionId);
  if (handle) {
    desktopManager.touchActivity(handle.containerId);
  }

  const result: ToolResult = await tool.execute(args);
  return result.content;
}

/** Create and connect a REST bridge for the given session. Returns undefined on failure. */
async function ensureBridge(
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  bridges: Map<string, DesktopRESTBridge>,
  log: Logger,
): Promise<DesktopRESTBridge | undefined> {
  try {
    const handle = await desktopManager.getOrCreate(sessionId);
    const bridge = new DesktopRESTBridge({
      apiHostPort: handle.apiHostPort,
      containerId: handle.containerId,
      logger: log,
    });
    await bridge.connect();
    bridges.set(sessionId, bridge);

    if (!cachedDesktopTools && bridge.getTools().length > 0) {
      cachedDesktopTools = [...bridge.getTools()];
    }

    return bridge;
  } catch (err) {
    log.error(
      `Failed to create desktop sandbox for session ${sessionId}: ${toErrorMessage(err)}`,
    );
    return undefined;
  }
}

/** Create Playwright MCP bridge via docker exec into the session's container. */
async function ensurePlaywrightBridge(
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  playwrightBridges: Map<string, MCPToolBridge>,
  log: Logger,
): Promise<MCPToolBridge | undefined> {
  try {
    const handle = desktopManager.getHandleBySession(sessionId);
    if (!handle) return undefined;

    const { createMCPConnection } = await import("../mcp-client/connection.js");
    const { createToolBridge } = await import("../mcp-client/tool-bridge.js");

    const client = await createMCPConnection(
      {
        name: "playwright",
        command: "docker",
        args: [
          "exec",
          "-i",
          "-e",
          "DISPLAY=:1",
          handle.containerId,
          "npx",
          "@playwright/mcp@1.8.0",
          "--headless=false",
        ],
        timeout: 30_000,
      },
      log,
    );

    const pwBridge = await createToolBridge(client, "playwright", log);
    playwrightBridges.set(sessionId, pwBridge);

    if (!cachedPlaywrightTools && pwBridge.tools.length > 0) {
      cachedPlaywrightTools = [...pwBridge.tools];
    }

    log.info(`Playwright MCP bridge connected for session ${sessionId} (${pwBridge.tools.length} tools)`);
    return pwBridge;
  } catch (err) {
    log.warn?.(
      `Playwright MCP bridge failed for session ${sessionId}: ${toErrorMessage(err)}. Browser tools unavailable.`,
    );
    return undefined;
  }
}

/** Route a container MCP tool call to the session's container MCP bridges. */
async function handleContainerMCPCall(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  bridges: Map<string, DesktopRESTBridge>,
  containerMCPConfigs: MCPServerConfig[],
  containerMCPBridges: Map<string, MCPToolBridge[]>,
  log: Logger,
): Promise<string> {
  // Ensure desktop bridge exists first (container MCP needs a running container)
  let bridge = bridges.get(sessionId);
  if (!bridge || !bridge.isConnected()) {
    bridge = await ensureBridge(sessionId, desktopManager, bridges, log);
    if (!bridge) {
      return safeStringify({ error: "Desktop sandbox unavailable" });
    }
  }

  // Ensure container MCP bridges exist for this session
  let mcpBridges = containerMCPBridges.get(sessionId);
  if (!mcpBridges) {
    mcpBridges = await ensureContainerMCPBridges(
      sessionId,
      desktopManager,
      containerMCPConfigs,
      containerMCPBridges,
      log,
    );
  }

  // Find the matching tool across all container MCP bridges
  for (const mcpBridge of mcpBridges) {
    const tool = mcpBridge.tools.find((t) => t.name === name);
    if (tool) {
      // Reset idle timer
      const handle = desktopManager.getHandleBySession(sessionId);
      if (handle) {
        desktopManager.touchActivity(handle.containerId);
      }

      const result: ToolResult = await tool.execute(args);
      return result.content;
    }
  }

  return safeStringify({ error: `Unknown container MCP tool: ${name}` });
}

/**
 * Create MCP bridges for all container-routed servers inside the desktop container.
 * Each config is rewritten to use `docker exec -i` into the session's container.
 */
async function ensureContainerMCPBridges(
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  configs: MCPServerConfig[],
  containerMCPBridges: Map<string, MCPToolBridge[]>,
  log: Logger,
): Promise<MCPToolBridge[]> {
  const handle = desktopManager.getHandleBySession(sessionId);
  if (!handle) {
    log.warn?.(`No desktop container for session ${sessionId} — container MCP unavailable`);
    containerMCPBridges.set(sessionId, []);
    return [];
  }

  const { createMCPConnection } = await import("../mcp-client/connection.js");
  const { createToolBridge } = await import("../mcp-client/tool-bridge.js");

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      // Rewrite config to docker exec
      const dockerArgs = ["exec", "-i", "-e", "DISPLAY=:1"];
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          dockerArgs.push("-e", `${key}=${value}`);
        }
      }
      dockerArgs.push(handle.containerId, config.command, ...config.args);

      const client = await createMCPConnection(
        {
          name: config.name,
          command: "docker",
          args: dockerArgs,
          timeout: config.timeout ?? 30_000,
        },
        log,
      );

      const rawBridge = await createToolBridge(client, config.name, log);

      // Wrap in ResilientMCPBridge with the docker-exec config for auto-reconnection
      const dockerConfig: MCPServerConfig = {
        name: config.name,
        command: "docker",
        args: dockerArgs,
        timeout: config.timeout ?? 30_000,
      };
      const mcpBridge = new ResilientMCPBridge(dockerConfig, rawBridge, log);

      // Cache tool definitions on first connection
      if (!cachedContainerMCPTools.has(config.name) && mcpBridge.tools.length > 0) {
        cachedContainerMCPTools.set(config.name, [...mcpBridge.tools]);
      }

      log.info(
        `Container MCP "${config.name}" connected for session ${sessionId} (${mcpBridge.tools.length} tools)`,
      );
      return mcpBridge;
    }),
  );

  const successfulBridges: MCPToolBridge[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      successfulBridges.push(result.value);
    } else {
      log.warn?.(
        `Container MCP "${configs[i].name}" failed for session ${sessionId}: ${toErrorMessage(result.reason)}`,
      );
    }
  }

  containerMCPBridges.set(sessionId, successfulBridges);
  return successfulBridges;
}
