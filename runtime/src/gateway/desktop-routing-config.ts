/**
 * Desktop routing configuration for WebChat — extracted from daemon.ts.
 *
 * Configures the desktop sandbox manager, REST bridges, Playwright MCP,
 * container MCP, and the session-aware tool handler router factory.
 *
 * @module
 */

import type { DesktopBridgeEvent } from "../desktop/rest-bridge.js";
import type { GatewayConfig, GatewayMCPServerConfig } from "./types.js";
import type { LLMTool, ToolHandler } from "../llm/types.js";
import type { Logger } from "../utils/logger.js";
import type { MCPToolBridge } from "../mcp-client/types.js";
import type { DesktopSandboxManager } from "../desktop/manager.js";
import type { DesktopRESTBridge } from "../desktop/rest-bridge.js";
import { toErrorMessage } from "../utils/async.js";
import {
  buildBackgroundRunSignalFromDesktopEvent,
  mapDesktopBridgeEventTypeToWebChatEvent,
} from "./background-run-wake-adapters.js";

/** Minimal callback surface the desktop routing needs from the daemon. */
export interface DesktopRoutingDeps {
  /** Desktop sandbox manager (already initialized). */
  desktopManager: DesktopSandboxManager;
  /** Per-session REST bridge map. */
  desktopBridges: Map<string, DesktopRESTBridge>;
  /** Per-session Playwright MCP bridge map. */
  playwrightBridges: Map<string, MCPToolBridge>;
  /** Container-level MCP server configs. */
  containerMCPConfigs: GatewayMCPServerConfig[];
  /** Container-level MCP bridge map. */
  containerMCPBridges: Map<string, MCPToolBridge[]>;
  /** Logger instance. */
  logger: Logger;
  /** Broadcast a desktop event through the WebChat channel. */
  broadcastDesktopEvent: (
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) => void;
  /**
   * Signal the background-run supervisor from a desktop event.
   * Returns a promise resolving to `true` when the signal was accepted.
   */
  signalBackgroundRun: (
    sessionId: string,
    signal: { type: string; content: string; data?: Record<string, unknown> },
  ) => Promise<boolean>;
  /**
   * Push a control message to a webchat session (e.g. agent.status).
   */
  pushStatusToSession: (
    sessionId: string,
    msg: { type: string; payload: Record<string, unknown> },
  ) => void;
}

export type DesktopRouterFactory = (
  sessionId: string,
  allowedToolNames?: readonly string[],
) => ToolHandler;

/**
 * Configure the desktop-aware tool handler router for WebChat.
 *
 * Populates `llmTools` with static desktop tool definitions and returns a
 * factory that creates per-session desktop-aware tool handlers.
 */
export async function configureDesktopRoutingForWebChat(
  config: GatewayConfig,
  llmTools: LLMTool[],
  baseToolHandler: ToolHandler,
  deps: DesktopRoutingDeps,
): Promise<DesktopRouterFactory | null> {
  if (!config.desktop?.enabled) {
    return null;
  }

  const { createDesktopAwareToolHandler } =
    await import("../desktop/session-router.js");

  const {
    desktopManager,
    desktopBridges,
    playwrightBridges,
    containerMCPConfigs,
    containerMCPBridges,
    logger,
  } = deps;

  const playwrightEnabled = config.desktop?.playwright?.enabled !== false;

  const handleDesktopEvent = (
    sessionId: string,
    event: DesktopBridgeEvent,
  ): void => {
    const eventType = mapDesktopBridgeEventTypeToWebChatEvent(event.type);
    deps.broadcastDesktopEvent(sessionId, eventType, {
      sessionId,
      timestamp: event.timestamp,
      ...event.payload,
    });

    const wakeSignal = buildBackgroundRunSignalFromDesktopEvent(event);
    if (!wakeSignal) {
      return;
    }

    void deps
      .signalBackgroundRun(sessionId, {
        type: wakeSignal.type,
        content: wakeSignal.content,
        data: wakeSignal.data,
      })
      .then((signalled) => {
        if (!signalled) {
          return;
        }
        deps.pushStatusToSession(sessionId, {
          type: "agent.status",
          payload: {
            phase: "background_run",
            detail: wakeSignal.content,
          },
        });
      })
      .catch((error) => {
        logger.debug(
          "Failed to signal background run from desktop event",
          {
            sessionId,
            eventType: event.type,
            error: toErrorMessage(error),
          },
        );
      });
  };

  // Desktop tools are lazily initialized per session via the router.
  // Add static desktop tool definitions to LLM tools so the model knows
  // the full schemas (parameter names, types, required fields).
  const { TOOL_DEFINITIONS } = await import("@tetsuo-ai/desktop-tool-contracts");
  const desktopToolDefs: LLMTool[] = TOOL_DEFINITIONS.filter(
    (def) => def.name !== "screenshot",
  ).map((def) => ({
    type: "function" as const,
    function: {
      name: `desktop.${def.name}`,
      description: def.description,
      parameters: def.inputSchema,
    },
  }));
  llmTools.push(...desktopToolDefs);

  const factory: DesktopRouterFactory = (
    sessionId: string,
    allowedToolNames?: readonly string[],
  ) =>
    createDesktopAwareToolHandler(baseToolHandler, sessionId, {
      desktopManager,
      bridges: desktopBridges,
      playwrightBridges: playwrightEnabled ? playwrightBridges : undefined,
      containerMCPConfigs:
        containerMCPConfigs.length > 0 ? containerMCPConfigs : undefined,
      containerMCPBridges:
        containerMCPConfigs.length > 0 ? containerMCPBridges : undefined,
      allowedToolNames,
      onDesktopEvent: (event) => handleDesktopEvent(sessionId, event),
      logger,
      // Force-disable automatic screenshot capture for action tools.
      autoScreenshot: false,
    });

  return factory;
}

/**
 * Clean up desktop bridges and sandbox resources for a session.
 */
export async function cleanupDesktopSessionResources(
  sessionId: string,
  deps: {
    desktopManager: DesktopSandboxManager | null;
    desktopBridges: Map<string, DesktopRESTBridge>;
    playwrightBridges: Map<string, MCPToolBridge>;
    containerMCPBridges: Map<string, MCPToolBridge[]>;
    logger: Logger;
  },
): Promise<void> {
  if (!deps.desktopManager) return;

  await deps.desktopManager.destroyBySession(sessionId).catch((error) => {
    deps.logger.debug("Failed to destroy desktop session during cleanup", {
      sessionId,
      error: toErrorMessage(error),
    });
  });

  const { destroySessionBridge } =
    await import("../desktop/session-router.js");
  destroySessionBridge(
    sessionId,
    deps.desktopBridges,
    deps.playwrightBridges,
    deps.containerMCPBridges,
    deps.logger,
  );
}
