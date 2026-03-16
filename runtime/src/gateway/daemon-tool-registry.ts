/**
 * Tool registry creation for the daemon.
 *
 * Extracted from daemon.ts to reduce file size.
 * Contains the createDaemonToolRegistry() function that creates and populates
 * the ToolRegistry with all system, marketplace, social, MCP, and protocol tools.
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { GatewayConfig, GatewayMCPServerConfig } from "./types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createBashTool } from "../tools/system/bash.js";
import { createHttpTools } from "../tools/system/http.js";
import { createFilesystemTools } from "../tools/system/filesystem.js";
import { createBrowserTools } from "../tools/system/browser.js";
import { createProcessTools } from "../tools/system/process.js";
import { createPdfTools } from "../tools/system/pdf.js";
import { createOfficeDocumentTools } from "../tools/system/office-document.js";
import { createEmailMessageTools } from "../tools/system/email-message.js";
import { createCalendarTools } from "../tools/system/calendar.js";
import {
  createRemoteJobTools,
  SystemRemoteJobManager,
} from "../tools/system/remote-job.js";
import { createResearchTools } from "../tools/system/research.js";
import { createSandboxTools } from "../tools/system/sandbox-handle.js";
import { createServerTools } from "../tools/system/server.js";
import { createSqliteTools } from "../tools/system/sqlite.js";
import { createSpreadsheetTools } from "../tools/system/spreadsheet.js";
import { resolveBrowserToolMode } from "./browser-tool-mode.js";
import { createExecuteWithAgentTool } from "./delegation-tool.js";
import { loadWallet } from "./wallet-loader.js";
import {
  buildAllowedFilesystemPaths,
  resolveHostWorkspacePath,
} from "./host-workspace.js";
import {
  validateMCPServerBinaryIntegrity,
  validateMCPServerStaticPolicy,
} from "../policy/index.js";
import { ConnectionManager } from "../connection/manager.js";
import type { UnifiedTelemetryCollector } from "../telemetry/collector.js";
import {
  resolveBashToolEnv,
  resolveBashDenyExclusions,
  resolveStructuredExecDenyExclusions,
  resolveBashToolTimeoutConfig,
  ensureChromiumCompatShims,
  ensureAgencRuntimeShim,
  isCommandUnavailableError,
} from "./daemon.js";

const CHROMIUM_SHIM_DIR_SEGMENTS = [".agenc", "bin"] as const;

function prependPathEntry(
  pathValue: string | undefined,
  entry: string,
): string {
  const { delimiter } = require("node:path");
  const entries = pathValue
    ? pathValue.split(delimiter).map((e: string) => e.trim()).filter((e: string) => e.length > 0)
    : [];
  if (entries.includes(entry)) {
    return entries.join(delimiter);
  }
  return [entry, ...entries].join(delimiter);
}

// ============================================================================
// Side-effect result type
// ============================================================================

export interface ToolRegistrySideEffects {
  registry: ToolRegistry;
  remoteJobManager: SystemRemoteJobManager;
  containerMCPConfigs: GatewayMCPServerConfig[];
  mcpManager: import("../mcp-client/manager.js").MCPManager | null;
  connectionManager: ConnectionManager | null;
}

// ============================================================================
// Deps interface
// ============================================================================

export interface ToolRegistryDeps {
  readonly logger: Logger;
  readonly configPath: string;
  readonly yolo: boolean;
  getBackgroundRunSupervisor(): {
    signalManagedProcessExit(params: {
      processId: string;
      label: string;
      exitCode: number | null;
      signal: string | null;
      occurredAt: number;
      source: string;
    }): Promise<boolean>;
  } | null;
  getMarketplace(): unknown;
  getAgentDiscovery(): unknown;
  getAgentMessaging(): unknown;
  getAgentFeed(): unknown;
  getCollaborationProtocol(): unknown;
}

// ============================================================================
// Main factory function
// ============================================================================

export async function createDaemonToolRegistry(
  config: GatewayConfig,
  deps: ToolRegistryDeps,
  metrics?: UnifiedTelemetryCollector,
): Promise<ToolRegistrySideEffects> {
  const { logger, configPath, yolo } = deps;
  const registry = new ToolRegistry({ logger });

  // Security: Only expose a minimal host env to system.bash.
  // Token-like secrets are intentionally excluded by default.
  const safeEnv = resolveBashToolEnv(config);
  const hostShimDir = join(homedir(), ...CHROMIUM_SHIM_DIR_SEGMENTS);
  safeEnv.PATH = prependPathEntry(safeEnv.PATH, hostShimDir);
  await ensureChromiumCompatShims(config, safeEnv.PATH, logger);
  await ensureAgencRuntimeShim(config, safeEnv.PATH, logger);

  const unrestrictedHostExec = yolo;
  if (unrestrictedHostExec) {
    logger.warn(
      "YOLO mode enabled: host execution deny lists are disabled for system.bash, system.process*, and system.server* tools.",
    );
  }

  // Security: By default, do NOT use unrestricted mode — the default deny
  // list prevents dangerous commands (rm -rf, curl for exfiltration, etc.)
  // from being executed via LLM tool calling / prompt injection attacks.
  //
  // On macOS desktop agents, allow process management (killall, pkill) and
  // network tools for closing apps — the security boundary is Telegram user auth.
  //
  // On Linux desktop mode, include the minimum developer workflow binaries
  // required by host health checks and orchestration smoke tests.
  const bashDenyExclusions = resolveBashDenyExclusions(config);
  const structuredExecDenyExclusions = resolveStructuredExecDenyExclusions(config);

  const bashToolTimeoutConfig = resolveBashToolTimeoutConfig(config);
  registry.register(
    createBashTool({
      logger,
      env: safeEnv,
      denyExclusions: bashDenyExclusions,
      unrestricted: unrestrictedHostExec,
      timeoutMs: bashToolTimeoutConfig.timeoutMs,
      maxTimeoutMs: bashToolTimeoutConfig.maxTimeoutMs,
    }),
  );
  registry.registerAll(
    createProcessTools({
      logger,
      env: safeEnv,
      denyExclusions: structuredExecDenyExclusions,
      unrestricted: unrestrictedHostExec,
      onLifecycleEvent: async (event) => {
        if (event.state !== "exited" && event.state !== "failed") {
          return;
        }
        const supervisor = deps.getBackgroundRunSupervisor();
        const signalled = await supervisor?.signalManagedProcessExit({
          processId: event.processId as string,
          label: event.label as string,
          exitCode: (event.exitCode ?? null) as number | null,
          signal: (event.signal ?? null) as string | null,
          occurredAt: event.occurredAt as number,
          source: `system.process:${event.cause}`,
        });
        if (signalled) {
          logger.info("Background run signalled from host process lifecycle", {
            processId: event.processId,
            label: event.label,
            state: event.state,
            cause: event.cause,
          });
        }
      },
    }),
  );
  const callbackPort = config.gateway?.port ?? 3100;
  const remoteJobManager = new SystemRemoteJobManager({
    logger,
    callbackBaseUrl: `http://127.0.0.1:${callbackPort}`,
  });
  registry.registerAll(
    createRemoteJobTools(
      {
        logger,
        callbackBaseUrl: `http://127.0.0.1:${callbackPort}`,
      },
      remoteJobManager,
    ),
  );
  registry.registerAll(
    createResearchTools({
      logger,
    }),
  );
  registry.registerAll(
    createSandboxTools({
      logger,
      workspacePath: resolveHostWorkspacePath({
        config,
        configPath,
        daemonCwd: process.cwd(),
      }),
    }),
  );
  registry.registerAll(
    createServerTools({
      logger,
      env: safeEnv,
      denyExclusions: structuredExecDenyExclusions,
      unrestricted: unrestrictedHostExec,
    }),
  );
  registry.registerAll(createHttpTools({}, logger));

  // Security: Restrict filesystem access to workspace + project root + Desktop + /tmp.
  // Excludes ~/.ssh, ~/.gnupg, ~/.config/solana (private keys), etc.
  const allowedFilesystemPaths = buildAllowedFilesystemPaths({
    hostWorkspacePath: resolveHostWorkspacePath({
      config,
      configPath,
      daemonCwd: process.cwd(),
    }),
    homePath: homedir(),
  });
  registry.registerAll(
    createFilesystemTools({
      allowedPaths: allowedFilesystemPaths,
      allowDelete: false,
    }),
  );
  registry.registerAll(
    createPdfTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  registry.registerAll(
    createOfficeDocumentTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  registry.registerAll(
    createEmailMessageTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  registry.registerAll(
    createCalendarTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  registry.registerAll(
    createSqliteTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  registry.registerAll(
    createSpreadsheetTools({
      allowedPaths: allowedFilesystemPaths,
      logger,
    }),
  );
  const browserToolMode = await resolveBrowserToolMode(logger);
  registry.registerAll(
    createBrowserTools(
      {
        mode: browserToolMode,
        allowedFileUploadPaths: allowedFilesystemPaths,
      },
      logger,
    ),
  );
  registry.register(createExecuteWithAgentTool());
  const walletResult = await loadWallet(config);
  const marketplaceActorId = walletResult
    ? Buffer.from(walletResult.agentId).toString("hex")
    : "gateway-agent";

  if (config.marketplace?.enabled) {
    try {
      const { createMarketplaceTools } =
        await import("../tools/marketplace/index.js");
      registry.registerAll(
        createMarketplaceTools({
          getMarketplace: () => deps.getMarketplace() as any,
          actorId: marketplaceActorId,
          logger,
        }),
      );
    } catch (error) {
      logger.warn?.("Marketplace tools unavailable:", error);
    }
  }

  if (config.social?.enabled) {
    try {
      const { createSocialTools } = await import("../tools/social/index.js");
      registry.registerAll(
        createSocialTools({
          getDiscovery: () => deps.getAgentDiscovery() as any,
          getMessaging: () => deps.getAgentMessaging() as any,
          getFeed: () => deps.getAgentFeed() as any,
          getCollaboration: () => deps.getCollaborationProtocol() as any,
          getPeerDirectory: () => config.social?.peerDirectory ?? null,
          logger,
        }),
      );
    } catch (error) {
      logger.warn?.("Social tools unavailable:", error);
    }
  }

  // macOS native automation tools (AppleScript, JXA, open, notifications)
  if (process.platform === "darwin") {
    try {
      const { createMacOSTools } = await import("../tools/system/macos.js");
      registry.registerAll(createMacOSTools({ logger }));
    } catch (err) {
      logger.warn?.("macOS tools unavailable:", err);
    }
  }

  // External MCP server tools (Peekaboo, macos-automator, etc.)
  let mcpManager: import("../mcp-client/manager.js").MCPManager | null = null;
  let containerMCPConfigs: GatewayMCPServerConfig[] = [];

  if (config.mcp?.servers?.length) {
    const desktopImage = config.desktop?.image ?? "agenc/desktop:latest";
    for (const server of config.mcp.servers.filter(
      (entry) => entry.enabled !== false,
    )) {
      const staticViolations = validateMCPServerStaticPolicy(server, {
        desktopImage,
      });
      if (staticViolations.length > 0) {
        throw new Error(
          staticViolations.map((violation) => violation.message).join("; "),
        );
      }
      if (!server.container) {
        const binaryViolations = await validateMCPServerBinaryIntegrity({
          server,
        });
        if (binaryViolations.length > 0) {
          throw new Error(
            binaryViolations.map((violation) => violation.message).join("; "),
          );
        }
      }
    }

    // Split: host servers boot now, container servers are per-session (via desktop router)
    const hostServers = config.mcp.servers.filter((s) => !s.container);
    const containerServers = config.mcp.servers.filter(
      (s) => s.container === "desktop",
    );
    containerMCPConfigs = containerServers;

    if (hostServers.length > 0) {
      try {
        const { MCPManager } = await import("../mcp-client/index.js");
        mcpManager = new MCPManager(hostServers, logger);
        await mcpManager.start();
        registry.registerAll(mcpManager.getTools());
      } catch (err) {
        logger.error("Failed to initialize MCP servers:", err);
      }
    }

    if (containerServers.length > 0) {
      logger.info(
        `${containerServers.length} MCP server(s) configured for desktop container: ${containerServers.map((s) => s.name).join(", ")}`,
      );

      // Boot container MCP servers on host temporarily to discover tool schemas.
      // The LLM needs to know the tools exist (names, descriptions, input schemas).
      // Actual execution is routed through `docker exec` per-session via the desktop router.
      // Host command availability is best-effort; container-only installs may not
      // have these MCP binaries on the host PATH.
      try {
        const { createMCPConnection } =
          await import("../mcp-client/connection.js");
        const { createToolBridge } =
          await import("../mcp-client/tool-bridge.js");

        const discoveryResults = await Promise.allSettled(
          containerServers.map(async (serverConfig) => {
            const client = await createMCPConnection(
              serverConfig,
              logger,
            );
            const bridge = await createToolBridge(
              client,
              serverConfig.name,
              logger,
              {
                listToolsTimeoutMs: serverConfig.timeout,
                callToolTimeoutMs: serverConfig.timeout,
                serverConfig,
              },
            );
            const schemas = bridge.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }));
            await bridge.dispose();
            return schemas;
          }),
        );

        let totalDiscovered = 0;
        const skippedUnavailable: string[] = [];
        for (let i = 0; i < discoveryResults.length; i++) {
          const result = discoveryResults[i];
          if (result.status === "fulfilled") {
            // Register stub tools — execute is never called because the desktop router
            // intercepts mcp.{name}.* calls before the base handler
            for (const schema of result.value) {
              registry.register({
                name: schema.name,
                description: schema.description,
                inputSchema: schema.inputSchema,
                execute: async () => ({
                  content: "Container MCP tool — requires desktop session",
                  isError: true,
                }),
              });
            }
            totalDiscovered += result.value.length;
          } else {
            const serverName = containerServers[i].name;
            if (isCommandUnavailableError(result.reason)) {
              skippedUnavailable.push(serverName);
            } else {
              logger.warn?.(
                `Container MCP "${serverName}" schema discovery failed: ${toErrorMessage(result.reason)}`,
              );
            }
          }
        }

        // Fallback: discover schemas via `docker run --rm -i <image>` for servers
        // whose binaries are only installed inside the container image.
        if (skippedUnavailable.length > 0 && config.desktop?.enabled) {
          const desktopImage = config.desktop.image ?? "agenc/desktop:latest";
          logger.info(
            `Retrying schema discovery via container image for: ${skippedUnavailable.join(", ")}`,
          );

          const containerFallback = await Promise.allSettled(
            skippedUnavailable.map(async (serverName) => {
              const serverConfig = containerServers.find(
                (s) => s.name === serverName,
              )!;
              const dockerArgs = [
                "run",
                "--rm",
                "-i",
                desktopImage,
                serverConfig.command,
                ...serverConfig.args,
              ];
              const client = await createMCPConnection(
                {
                  name: serverConfig.name,
                  command: "docker",
                  args: dockerArgs,
                  timeout: serverConfig.timeout ?? 30_000,
                },
                logger,
              );
              const bridge = await createToolBridge(
                client,
                serverConfig.name,
                logger,
                {
                  listToolsTimeoutMs: serverConfig.timeout ?? 30_000,
                  callToolTimeoutMs: serverConfig.timeout ?? 30_000,
                  serverConfig,
                },
              );
              const schemas = bridge.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              }));
              await bridge.dispose();
              return { serverName, schemas };
            }),
          );

          for (const result of containerFallback) {
            if (result.status === "fulfilled") {
              for (const schema of result.value.schemas) {
                registry.register({
                  name: schema.name,
                  description: schema.description,
                  inputSchema: schema.inputSchema,
                  execute: async () => ({
                    content: "Container MCP tool — requires desktop session",
                    isError: true,
                  }),
                });
              }
              totalDiscovered += result.value.schemas.length;
              logger.info(
                `Discovered ${result.value.schemas.length} tool(s) from container image for "${result.value.serverName}"`,
              );
            } else {
              logger.warn?.(
                `Container image schema discovery also failed for "${skippedUnavailable[containerFallback.indexOf(result)]}": ${toErrorMessage(result.reason)}`,
              );
            }
          }
        } else if (skippedUnavailable.length > 0) {
          logger.info(
            `Skipped schema discovery for container MCP server(s): ${skippedUnavailable.join(", ")} (host command unavailable, desktop not enabled).`,
          );
        }

        if (totalDiscovered > 0) {
          logger.info(
            `Discovered ${totalDiscovered} container MCP tool schemas for LLM`,
          );
        } else if (skippedUnavailable.length === 0) {
          logger.warn?.(
            "No container MCP tool schemas discovered at startup; tools will only become visible after successful container bridge initialization.",
          );
        }
      } catch (err) {
        logger.warn?.("Container MCP schema discovery failed:", err);
      }
    }
  }

  let connectionManager: ConnectionManager | null = null;
  if (config.connection?.rpcUrl) {
    try {
      const endpoints: string[] = [config.connection.rpcUrl];
      if (config.connection.endpoints) {
        for (const endpoint of config.connection.endpoints) {
          if (endpoint !== config.connection.rpcUrl) {
            endpoints.push(endpoint);
          }
        }
      }
      const connMgr = new ConnectionManager({
        endpoints,
        logger,
        metrics,
      });
      connectionManager = connMgr;

      const { createAgencTools } = await import("../tools/agenc/index.js");
      registry.registerAll(
        createAgencTools({
          connection: connMgr.getConnection(),
          wallet: walletResult?.wallet,
          logger,
        }),
      );
    } catch (error) {
      logger.warn?.("AgenC protocol tools unavailable:", error);
    }
  }

  // X (Twitter) tools — registered when config.x credentials are present.
  const xConfig = (config as unknown as Record<string, unknown>).x as
    | {
        consumerKey?: string;
        consumerSecret?: string;
        accessToken?: string;
        accessTokenSecret?: string;
      }
    | undefined;
  if (
    xConfig?.consumerKey &&
    xConfig.consumerSecret &&
    xConfig.accessToken &&
    xConfig.accessTokenSecret
  ) {
    try {
      const { createXTools } = await import("../tools/x/index.js");
      registry.registerAll(
        createXTools(
          {
            consumerKey: xConfig.consumerKey,
            consumerSecret: xConfig.consumerSecret,
            accessToken: xConfig.accessToken,
            accessTokenSecret: xConfig.accessTokenSecret,
          },
          logger,
        ),
      );
      logger.info("X (Twitter) tools registered");
    } catch (error) {
      logger.warn?.("X tools unavailable:", error);
    }
  }

  return {
    registry,
    remoteJobManager,
    containerMCPConfigs,
    mcpManager,
    connectionManager,
  };
}
