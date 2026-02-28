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

const PLAYWRIGHT_BROWSERS_PATH = "/home/agenc/.cache/ms-playwright";
const PLAYWRIGHT_MCP_BIN = "playwright-mcp";
const DEFAULT_PLAYWRIGHT_MCP_PKG = "@playwright/mcp@0.0.68";
const PLAYWRIGHT_MCP_PACKAGE_PREFIX = "@playwright/mcp@";
const PLAYWRIGHT_MCP_PACKAGE_NAME = "@playwright/mcp";
const TMUX_MCP_PACKAGE = "tmux-mcp";
const NEOVIM_MCP_PACKAGE = "mcp-neovim-server";
const TRANSIENT_DESKTOP_ERROR_PATTERNS = [
  "fetch failed",
  "econnreset",
  "econnrefused",
  "socket hang up",
  "networkerror",
  "connection refused",
];
const DESKTOP_BASH_INTERACTIVE_REPL_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|bash|sh|zsh|irb|php)\s*$/i;
const DESKTOP_BASH_SINGLE_COMMAND_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?([a-zA-Z0-9._+-]+)\s*$/;
const DESKTOP_BASH_BACKGROUND_RE =
  /&\s*(?:disown\s*)?(?:(?:;|&&)?\s*echo\s+\$!\s*)?$/;
const DESKTOP_BROWSER_LAUNCH_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:chromium|chromium-browser|google-chrome|firefox)\b/i;
const DESKTOP_CHROMIUM_LAUNCH_RE = /\b(?:chromium|chromium-browser|google-chrome)\b/i;
const DESKTOP_BROWSER_TARGET_RE = /\b(?:https?:\/\/|file:\/\/|about:|chrome:\/\/)/i;
const DESKTOP_BROWSER_USER_DATA_DIR_RE = /\b--user-data-dir(?:=|\s+)/i;
const DESKTOP_BASH_QUOTED_SEGMENT_RE = /'[^']*'|"[^"]*"/g;
const DESKTOP_PROCESS_INSPECTION_OR_CONTROL_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:pgrep|pkill|ps|grep|ss|lsof|netstat|kill|killall)\b/i;
const LONG_RUNNING_SERVER_COMMAND_FRAGMENT_RE =
  /\b(?:python(?:\d+(?:\.\d+)?)?\s+-m\s+http\.server|npm\s+run\s+(?:dev|start|serve)|pnpm\s+(?:dev|start|serve)|yarn\s+(?:dev|start|serve)|npx\s+vite|vite|flask\s+run|uvicorn|gunicorn)\b/i;
const BROWSER_WINDOW_TITLE_RE = /(chromium|chrome|firefox|epiphany|browser|localhost|https?:\/\/|file:\/\/)/i;

const INCOMPLETE_DESKTOP_COMMAND_HINTS: Record<string, string> = {
  which: 'Use a full command like `which python3`.',
  apt: 'Use a full command like `sudo apt-get update` or `sudo apt-get install -y <pkg>`.',
  "apt-get":
    'Use a full command like `sudo apt-get update` or `sudo apt-get install -y <pkg>`.',
  sudo:
    "Include the full command after sudo, for example `sudo apt-get install -y python3`.",
  curl: "Include a URL, for example `curl -I http://localhost:8000`.",
  pip: "Include a subcommand, for example `pip install flask` or `pip list`.",
  pip3: "Include a subcommand, for example `pip3 install flask` or `pip3 list`.",
  npm: "Include a subcommand, for example `npm run dev` or `npm install`.",
  pnpm: "Include a subcommand, for example `pnpm dev` or `pnpm install`.",
  yarn: "Include a subcommand, for example `yarn dev` or `yarn install`.",
  chromium:
    "Include a URL target, for example `chromium http://localhost:8000`, or use `playwright.browser_navigate`.",
  "chromium-browser":
    "Include a URL target, for example `chromium-browser http://localhost:8000`, or use `playwright.browser_navigate`.",
  "google-chrome":
    "Include a URL target, for example `google-chrome https://example.com`, or use `playwright.browser_navigate`.",
  firefox:
    "Include a URL target, for example `firefox https://example.com`, or use `playwright.browser_navigate`.",
};

function stripQuotedSegments(command: string): string {
  return command.replace(DESKTOP_BASH_QUOTED_SEGMENT_RE, " ");
}

function getDesktopBashGuardError(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name !== "desktop.bash") return undefined;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return undefined;
  const unquotedCommand = stripQuotedSegments(command);

  if (DESKTOP_BASH_INTERACTIVE_REPL_RE.test(command)) {
    return (
      `Command "${command}" opens an interactive shell/REPL and will hang in desktop.bash. ` +
      "Use a non-interactive one-shot command instead (for example `python3 script.py`, `python3 -c \"...\"`, or `node app.js`)."
    );
  }

  const singleCommand = command.match(DESKTOP_BASH_SINGLE_COMMAND_RE)?.[1]?.toLowerCase();
  if (singleCommand) {
    const hint = INCOMPLETE_DESKTOP_COMMAND_HINTS[singleCommand];
    if (hint) {
      return `Command "${command}" is incomplete. ${hint}`;
    }
  }

  if (
    DESKTOP_BROWSER_LAUNCH_RE.test(command) &&
    !DESKTOP_BROWSER_TARGET_RE.test(command)
  ) {
    return (
      `Browser launch command "${command}" is missing a target URL. ` +
      "Provide an explicit URL/path (for example `chromium-browser http://localhost:8000`) " +
      "or use `playwright.browser_navigate`."
    );
  }

  if (
    DESKTOP_BROWSER_LAUNCH_RE.test(command) &&
    !DESKTOP_BASH_BACKGROUND_RE.test(command)
  ) {
    return (
      `Browser launch command "${command}" should run in background to avoid hanging desktop.bash. ` +
      "Append `>/dev/null 2>&1 &` or use `playwright.browser_navigate`."
    );
  }

  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? args.timeoutMs
      : undefined;
  if (
    !DESKTOP_PROCESS_INSPECTION_OR_CONTROL_RE.test(command) &&
    LONG_RUNNING_SERVER_COMMAND_FRAGMENT_RE.test(unquotedCommand) &&
    !DESKTOP_BASH_BACKGROUND_RE.test(command) &&
    (timeoutMs === undefined || timeoutMs <= 60_000)
  ) {
    return (
      `Command "${command}" is a long-running server process and is likely to timeout in foreground mode. ` +
      "Start it in background (append `&`) and then verify with curl or logs."
    );
  }

  return undefined;
}

function inferFocusTitleFromWindowList(resultContent: string): string | undefined {
  try {
    const parsed = JSON.parse(resultContent) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const windows = (parsed as { windows?: unknown }).windows;
    if (!Array.isArray(windows)) return undefined;
    const titles = windows
      .map((w) => {
        if (typeof w !== "object" || w === null || Array.isArray(w)) return "";
        const title = (w as { title?: unknown }).title;
        return typeof title === "string" ? title.trim() : "";
      })
      .filter((title) => title.length > 0 && title !== "(unknown)");
    if (titles.length === 0) return undefined;
    return titles.find((title) => BROWSER_WINDOW_TITLE_RE.test(title)) ??
      (titles.length === 1 ? titles[0] : undefined);
  } catch {
    return undefined;
  }
}

function rewriteDesktopChromiumLaunchArgs(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  log: Logger,
): Record<string, unknown> {
  if (name !== "desktop.bash") return args;

  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return args;
  if (!DESKTOP_CHROMIUM_LAUNCH_RE.test(command)) return args;
  if (!DESKTOP_BROWSER_TARGET_RE.test(command)) return args;
  if (DESKTOP_BROWSER_USER_DATA_DIR_RE.test(command)) return args;

  const sessionTag =
    sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-16) || "session";
  const profileDir = `/tmp/agenc-chrome-${sessionTag}-${Date.now().toString(36)}`;
  const rewrittenCommand = command.replace(
    DESKTOP_CHROMIUM_LAUNCH_RE,
    (match) =>
      `${match} --new-window --incognito --user-data-dir=${profileDir}`,
  );

  if (rewrittenCommand === command) return args;

  log.info?.(
    `desktop.bash chromium launch rewritten with isolated profile for session ${sessionId}`,
  );
  return { ...args, command: rewrittenCommand };
}

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
  /** Deprecated no-op. Auto-screenshot capture is disabled. */
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
    autoScreenshot: _autoScreenshot = false,
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
    if (toolName === "screenshot") {
      return safeStringify({ error: "desktop.screenshot is disabled" });
    }

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

    let effectiveArgs = args;
    const guardError = getDesktopBashGuardError(name, effectiveArgs);
    if (guardError) {
      return safeStringify({ error: guardError });
    }

    effectiveArgs = rewriteDesktopChromiumLaunchArgs(
      name,
      effectiveArgs,
      sessionId,
      log,
    );

    if (name === "desktop.window_focus") {
      const title =
        typeof effectiveArgs.title === "string" ? effectiveArgs.title.trim() : "";
      if (!title) {
        const windowListTool = bridge
          .getTools()
          .find((t) => t.name === "desktop.window_list");
        if (windowListTool) {
          try {
            const windowListResult = await windowListTool.execute({});
            const inferredTitle = inferFocusTitleFromWindowList(
              windowListResult.content,
            );
            if (inferredTitle) {
              effectiveArgs = { ...effectiveArgs, title: inferredTitle };
              log.info?.(
                `desktop.window_focus missing title for session ${sessionId}; inferred "${inferredTitle}" from window list`,
              );
            }
          } catch {
            // fall through and return deterministic validation error below
          }
        }
      }

      const finalTitle =
        typeof effectiveArgs.title === "string" ? effectiveArgs.title.trim() : "";
      if (!finalTitle) {
        return safeStringify({
          error:
            "desktop.window_focus requires `title`. Call `desktop.window_list` and pass a non-empty window title.",
        });
      }
      effectiveArgs = { ...effectiveArgs, title: finalTitle };
    }

    // Reset idle timer
    const handle = desktopManager.getHandleBySession(sessionId);
    if (handle) {
      desktopManager.touchActivity(handle.containerId);
    }

    const result: ToolResult = await tool.execute(effectiveArgs);
    if (result.isError && looksLikeTransientDesktopFailure(result.content)) {
      log.warn?.(
        `Desktop tool "${name}" failed with transient error for session ${sessionId}; recycling sandbox and retrying once`,
      );
      await recycleDesktopSession(sessionId, desktopManager, bridges, playwrightBridges, containerMCPBridges);
      const recovered = await ensureBridge(sessionId, desktopManager, bridges, log);
      if (recovered) {
        const retryTool = recovered.getTools().find((t) => t.name === `desktop.${toolName}`);
        if (retryTool) {
          const retryResult = await retryTool.execute(effectiveArgs);
          return retryResult.content;
        }
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
  const connectBridge = async (): Promise<DesktopRESTBridge> => {
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
  };

  try {
    return await connectBridge();
  } catch (firstErr) {
    log.warn?.(
      `Desktop bridge bootstrap failed for session ${sessionId}: ${toErrorMessage(firstErr)}. Recycling sandbox and retrying once.`,
    );
    await recycleDesktopSession(sessionId, desktopManager, bridges);
    try {
      return await connectBridge();
    } catch (secondErr) {
      log.error(
        `Failed to create desktop sandbox for session ${sessionId}: ${toErrorMessage(secondErr)}`,
      );
      return undefined;
    }
  }
}

function looksLikeTransientDesktopFailure(content: string): boolean {
  const lower = content.toLowerCase();
  return TRANSIENT_DESKTOP_ERROR_PATTERNS.some((pattern) =>
    lower.includes(pattern),
  );
}

async function recycleDesktopSession(
  sessionId: string,
  desktopManager: DesktopSandboxManager,
  bridges: Map<string, DesktopRESTBridge>,
  playwrightBridges?: Map<string, MCPToolBridge>,
  containerMCPBridges?: Map<string, MCPToolBridge[]>,
): Promise<void> {
  destroySessionBridge(
    sessionId,
    bridges,
    playwrightBridges,
    containerMCPBridges,
  );
  try {
    await desktopManager.destroyBySession(sessionId);
  } catch {
    // best-effort cleanup
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
          "-e",
          `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}`,
          handle.containerId,
          PLAYWRIGHT_MCP_BIN,
        ],
        timeout: 30_000,
      },
      log,
    );

    const pwBridge = await createToolBridge(client, "playwright", log, {
      listToolsTimeoutMs: 30_000,
      callToolTimeoutMs: 30_000,
    });
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
      const dockerArgs = [
        "exec",
        "-i",
        "-e",
        "DISPLAY=:1",
      ];

      const hasPlaywrightBrowserPath = config.env
        ? Object.prototype.hasOwnProperty.call(config.env, "PLAYWRIGHT_BROWSERS_PATH")
        : false;
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          dockerArgs.push("-e", `${key}=${value}`);
        }
      }

      if (!hasPlaywrightBrowserPath) {
        // Keep behavior stable for non-browser MCP servers while ensuring
        // Playwright-based servers inside desktop containers get a valid browser path.
        dockerArgs.push(
          "-e",
          `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}`,
        );
      }
      const normalized = normalizeContainerMCPCommand(config.command, config.args);
      dockerArgs.push(handle.containerId, normalized.command, ...normalized.args);

      const client = await createMCPConnection(
        {
          name: config.name,
          command: "docker",
          args: dockerArgs,
          timeout: config.timeout ?? 30_000,
        },
        log,
      );

      const rawBridge = await createToolBridge(client, config.name, log, {
        listToolsTimeoutMs: config.timeout ?? 30_000,
        callToolTimeoutMs: config.timeout ?? 30_000,
      });

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

function normalizePlaywrightArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--browser") {
      const value = args[i + 1];
      if (typeof value === "string" && value.toLowerCase() === "chromium") {
        // Older MCP configs force a named browser that may not exist in all
        // container images. Let the bundled MCP/Playwright environment resolve
        // runtime browser defaults instead.
        i += 1;
        continue;
      }
      out.push(arg);
      continue;
    }

    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length).toLowerCase();
      if (value !== "chromium") {
        out.push(arg);
      }
      continue;
    }

    out.push(arg);
  }

  return out;
}

function normalizeContainerMCPCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  let normalizedCommand = command;
  let normalizedArgs = [...args];

  // Convert npx package invocations to direct binaries when available so
  // session startup does not depend on npm registry/network availability.
  if (command === "npx") {
    if (normalizedArgs[0] === "-y") {
      normalizedArgs = normalizedArgs.slice(1);
    }

    const pkg = normalizedArgs[0];
    if (pkg === TMUX_MCP_PACKAGE) {
      normalizedCommand = TMUX_MCP_PACKAGE;
      normalizedArgs = normalizedArgs.slice(1);
    } else if (pkg === NEOVIM_MCP_PACKAGE) {
      normalizedCommand = NEOVIM_MCP_PACKAGE;
      normalizedArgs = normalizedArgs.slice(1);
    } else if (
      pkg === PLAYWRIGHT_MCP_PACKAGE_NAME ||
      pkg === DEFAULT_PLAYWRIGHT_MCP_PKG ||
      (typeof pkg === "string" && pkg.startsWith(PLAYWRIGHT_MCP_PACKAGE_PREFIX))
    ) {
      normalizedCommand = PLAYWRIGHT_MCP_BIN;
      normalizedArgs = normalizePlaywrightArgs(normalizedArgs.slice(1));
    }
  } else if (command === PLAYWRIGHT_MCP_BIN) {
    normalizedArgs = normalizePlaywrightArgs(normalizedArgs);
  }

  return { command: normalizedCommand, args: normalizedArgs };
}
