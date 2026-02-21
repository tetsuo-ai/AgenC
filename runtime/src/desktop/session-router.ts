/**
 * Desktop session router — intercepts `desktop.*` tool calls and routes them
 * to the correct sandbox container's REST bridge.
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

// ============================================================================
// Desktop tool definitions (static — same across all containers)
// ============================================================================

/** Cached tool schemas fetched from the first bridge connection. */
let cachedDesktopTools: Tool[] | null = null;

// ============================================================================
// Session-scoped tool handler factory
// ============================================================================

export interface DesktopRouterOptions {
  desktopManager: DesktopSandboxManager;
  bridges: Map<string, DesktopRESTBridge>;
  logger?: Logger;
}

/**
 * Creates a session-scoped ToolHandler that intercepts `desktop.*` tool calls
 * and routes them to the appropriate sandbox container.
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
  const { desktopManager, bridges, logger: log = silentLogger } = options;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
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
 * Disconnect and remove the bridge for a session.
 * Called on session reset, /desktop stop, etc.
 */
export function destroySessionBridge(
  sessionId: string,
  bridges: Map<string, DesktopRESTBridge>,
): void {
  const bridge = bridges.get(sessionId);
  if (bridge) {
    bridge.disconnect();
    bridges.delete(sessionId);
  }
}

// ============================================================================
// Internal
// ============================================================================

/** Create and connect a bridge for the given session. Returns undefined on failure. */
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
