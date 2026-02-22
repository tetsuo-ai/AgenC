/**
 * Daemon lifecycle management — PID files, signal handling, and service templates.
 *
 * Wraps the Gateway with Unix daemon conventions: PID file management,
 * graceful signal handling (SIGTERM/SIGINT/SIGHUP), and systemd/launchd
 * service file generation.
 *
 * @module
 */

import { mkdir, readFile, unlink, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { Gateway } from './gateway.js';
import { loadGatewayConfig } from './config-watcher.js';
import { GatewayLifecycleError, GatewayStateError } from './errors.js';
import { toErrorMessage } from '../utils/async.js';
import type { GatewayConfig, GatewayLLMConfig, GatewayStatus, ConfigDiff } from './types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { WebChatChannel } from '../channels/webchat/plugin.js';
import { TelegramChannel } from '../channels/telegram/plugin.js';
import type { LLMProvider, LLMTool, ToolHandler, StreamProgressCallback } from '../llm/types.js';
import type { GatewayMessage } from './message.js';
import { ChatExecutor } from '../llm/chat-executor.js';
import type { SkillInjector, MemoryRetriever } from '../llm/chat-executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBashTool } from '../tools/system/bash.js';
import { createHttpTools } from '../tools/system/http.js';
import { createFilesystemTools } from '../tools/system/filesystem.js';
import { createBrowserTools } from '../tools/system/browser.js';
import { SkillDiscovery } from '../skills/markdown/discovery.js';
import type { DiscoveredSkill } from '../skills/markdown/discovery.js';
import { VoiceBridge } from './voice-bridge.js';
import { InMemoryBackend } from '../memory/in-memory/backend.js';
import { ApprovalEngine } from './approvals.js';
import type { MemoryBackend } from '../memory/types.js';
import { UnifiedTelemetryCollector } from '../telemetry/collector.js';
import { SessionManager } from './session.js';
import { WorkspaceLoader, getDefaultWorkspacePath, assembleSystemPrompt } from './workspace-files.js';
import { loadPersonalityTemplate, mergePersonality } from './personality.js';
import { SlashCommandRegistry, createDefaultCommands } from './commands.js';
import { HookDispatcher, createBuiltinHooks } from './hooks.js';
import { ConnectionManager } from '../connection/manager.js';
import { DiscordChannel } from '../channels/discord/plugin.js';
import { SlackChannel } from '../channels/slack/plugin.js';
import { WhatsAppChannel } from '../channels/whatsapp/plugin.js';
import { SignalChannel } from '../channels/signal/plugin.js';
import { MatrixChannel } from '../channels/matrix/plugin.js';
import { formatForChannel } from './format.js';
import type { ChannelPlugin } from './channel.js';
import type { ProactiveCommunicator } from './proactive.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_GROK_MODEL = 'grok-4-1-fast-reasoning';

interface WebChatSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
}

interface WebChatSignals {
  signalThinking: (sessionId: string) => void;
  signalIdle: (sessionId: string) => void;
}

// ============================================================================
// PID File Types
// ============================================================================

export interface PidFileInfo {
  pid: number;
  port: number;
  configPath: string;
}

export interface StalePidResult {
  status: 'none' | 'alive' | 'stale';
  pid?: number;
  port?: number;
}

// ============================================================================
// PID File Operations
// ============================================================================

export function getDefaultPidPath(): string {
  return process.env.AGENC_PID_PATH ?? join(homedir(), '.agenc', 'daemon.pid');
}

export async function writePidFile(
  info: PidFileInfo,
  pidPath: string,
): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, JSON.stringify(info), { mode: 0o600 });
}

export async function readPidFile(
  pidPath: string,
): Promise<PidFileInfo | null> {
  try {
    const raw = await readFile(pidPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'pid' in parsed
      && 'port' in parsed
      && 'configPath' in parsed
      && typeof (parsed as PidFileInfo).pid === 'number'
      && typeof (parsed as PidFileInfo).port === 'number'
      && typeof (parsed as PidFileInfo).configPath === 'string'
    ) {
      return parsed as PidFileInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removePidFile(pidPath: string): Promise<void> {
  try {
    await unlink(pidPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function pidFileExists(pidPath: string): Promise<boolean> {
  try {
    await access(pidPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Process Detection
// ============================================================================

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function checkStalePid(pidPath: string): Promise<StalePidResult> {
  const info = await readPidFile(pidPath);
  if (info === null) {
    return { status: 'none' };
  }
  if (isProcessAlive(info.pid)) {
    return { status: 'alive', pid: info.pid, port: info.port };
  }
  return { status: 'stale', pid: info.pid, port: info.port };
}

// ============================================================================
// DaemonManager
// ============================================================================

export interface DaemonManagerConfig {
  configPath: string;
  pidPath?: string;
  logger?: Logger;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptimeMs: number;
  gatewayStatus: GatewayStatus | null;
  memoryUsage: { heapUsedMB: number; rssMB: number };
}

export class DaemonManager {
  private gateway: Gateway | null = null;
  private _webChatChannel: WebChatChannel | null = null;
  private _telegramChannel: TelegramChannel | null = null;
  private _discordChannel: DiscordChannel | null = null;
  private _slackChannel: SlackChannel | null = null;
  private _whatsAppChannel: WhatsAppChannel | null = null;
  private _signalChannel: SignalChannel | null = null;
  private _matrixChannel: MatrixChannel | null = null;
  private _imessageChannel: ChannelPlugin | null = null;
  private _proactiveCommunicator: ProactiveCommunicator | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _heartbeatScheduler: import('./heartbeat.js').HeartbeatScheduler | null = null;
  private _cronScheduler: import('./scheduler.js').CronScheduler | null = null;
  private _mcpManager: import('../mcp-client/manager.js').MCPManager | null = null;
  private _voiceBridge: VoiceBridge | null = null;
  private _memoryBackend: MemoryBackend | null = null;
  private _approvalEngine: ApprovalEngine | null = null;
  private _telemetry: UnifiedTelemetryCollector | null = null;
  private _hookDispatcher: HookDispatcher | null = null;
  private _connectionManager: ConnectionManager | null = null;
  private _chatExecutor: ChatExecutor | null = null;
  private _llmTools: LLMTool[] = [];
  private _llmProviders: LLMProvider[] = [];
  private _baseToolHandler: ToolHandler | null = null;
  private _desktopManager: import('../desktop/manager.js').DesktopSandboxManager | null = null;
  private _desktopBridges: Map<string, import('../desktop/rest-bridge.js').DesktopRESTBridge> = new Map();
  private _desktopRouterFactory: ((sessionId: string) => ToolHandler) | null = null;
  private _desktopExecutor: import('../autonomous/desktop-executor.js').DesktopExecutor | null = null;
  private _goalManager: import('../autonomous/goal-manager.js').GoalManager | null = null;
  private shutdownInProgress = false;
  private startedAt = 0;
  private signalHandlersRegistered = false;
  private signalHandlerRefs: { signal: string; handler: () => void }[] = [];
  private readonly configPath: string;
  private readonly pidPath: string;
  private readonly logger: Logger;

  constructor(config: DaemonManagerConfig) {
    this.configPath = config.configPath;
    this.pidPath = config.pidPath ?? getDefaultPidPath();
    this.logger = config.logger ?? silentLogger;
  }

  async start(): Promise<void> {
    if (this.gateway !== null) {
      throw new GatewayStateError('Daemon is already running');
    }

    const loadedConfig = await loadGatewayConfig(this.configPath);

    // Shallow-copy so we don't mutate the loaded config object
    const gatewayConfig = { ...loadedConfig };

    // Auto-configure default MCP servers on macOS when none are specified
    if (process.platform === 'darwin' && !gatewayConfig.mcp?.servers?.length) {
      gatewayConfig.mcp = {
        servers: [
          {
            name: 'peekaboo',
            command: 'npx',
            args: ['-y', '@steipete/peekaboo@latest'],
            enabled: true,
          },
          {
            name: 'macos-automator',
            command: 'npx',
            args: ['-y', '@steipete/macos-automator-mcp@latest'],
            enabled: true,
          },
        ],
      };
      this.logger.info('Auto-configured default macOS MCP servers (Peekaboo + macos-automator)');
    }

    const gateway = new Gateway(gatewayConfig, {
      logger: this.logger,
      configPath: this.configPath,
    });

    await gateway.start();

    // Start desktop sandbox manager before wiring WebChat (commands need it)
    if (gatewayConfig.desktop?.enabled) {
      try {
        const { DesktopSandboxManager } = await import('../desktop/manager.js');
        this._desktopManager = new DesktopSandboxManager(gatewayConfig.desktop, {
          logger: this.logger,
        });
        await this._desktopManager.start();
        this.logger.info('Desktop sandbox manager started');
      } catch (err) {
        this.logger.warn?.('Desktop sandbox manager failed to start:', err);
      }
    }

    // Wire up WebChat channel with LLM pipeline
    await this.wireWebChat(gateway, gatewayConfig);

    // Wire up Telegram channel if configured
    if (gatewayConfig.channels?.telegram) {
      await this.wireTelegram(gatewayConfig);
    }

    // Wire up all other external channels (Discord, Slack, WhatsApp, Signal, Matrix, iMessage)
    await this.wireExternalChannels(gatewayConfig);

    // Wire up autonomous features (curiosity, self-learning, meta-planner, proactive comms)
    await this.wireAutonomousFeatures(gatewayConfig);

    try {
      await writePidFile(
        {
          pid: process.pid,
          port: gatewayConfig.gateway.port,
          configPath: this.configPath,
        },
        this.pidPath,
      );
    } catch (error) {
      await gateway.stop();
      throw new GatewayLifecycleError(
        `Failed to write PID file: ${toErrorMessage(error)}`,
      );
    }

    this.gateway = gateway;
    this.startedAt = Date.now();
    this.setupSignalHandlers();

    this.logger.info('Daemon started', {
      pid: process.pid,
      port: gatewayConfig.gateway.port,
    });
  }

  /**
   * Wire the WebChat channel plugin to the Gateway's WebSocket control plane
   * and connect it to an LLM provider with tool execution, skill injection,
   * session management, workspace-driven system prompt, slash commands,
   * memory retrieval, lifecycle hooks, and real-time tool/typing events.
   */
  private async wireWebChat(gateway: Gateway, config: GatewayConfig): Promise<void> {
    const hooks = await this.createHookDispatcher(config);
    const discovered = await this.discoverSkills();
    const availableSkills = discovered.filter((d) => d.available);
    const skillList: WebChatSkillSummary[] = discovered.map((d) => ({
      name: d.skill.name,
      description: d.skill.description,
      enabled: d.available,
    }));
    const skillToggle = (name: string, enabled: boolean): void => {
      const skill = skillList.find((entry) => entry.name === name);
      if (skill) skill.enabled = enabled;
    };

    let telemetry: UnifiedTelemetryCollector | null = null;
    if (config.telemetry?.enabled !== false) {
      telemetry = new UnifiedTelemetryCollector(
        { flushIntervalMs: config.telemetry?.flushIntervalMs ?? 60_000 },
        this.logger,
      );
      this._telemetry = telemetry;
    }

    const registry = await this.createToolRegistry(config, telemetry ?? undefined);

    const llmTools = registry.toLLMTools();
    let baseToolHandler = registry.createToolHandler();

    // Wrap base tool handler with desktop routing if enabled
    if (config.desktop?.enabled && this._desktopManager) {
      const { createDesktopAwareToolHandler } = await import('../desktop/session-router.js');
      const desktopManager = this._desktopManager;
      const desktopBridges = this._desktopBridges;
      const desktopLogger = this.logger;

      // Desktop tools are lazily initialized per session via the router.
      // Add static desktop tool definitions to LLM tools so the model knows
      // the full schemas (parameter names, types, required fields).
      const { TOOL_DEFINITIONS } = await import('../desktop/tool-definitions.js');
      const desktopToolDefs: LLMTool[] = TOOL_DEFINITIONS.map((def) => ({
        type: 'function' as const,
        function: {
          name: `desktop.${def.name}`,
          description: def.description,
          parameters: def.inputSchema,
        },
      }));
      llmTools.push(...desktopToolDefs);

      // The original handler is wrapped per-session in createWebChatMessageHandler
      // Store the original so per-session wrapping can use it
      const originalBaseHandler = baseToolHandler;
      baseToolHandler = originalBaseHandler;
      this._desktopRouterFactory = (sessionId: string) =>
        createDesktopAwareToolHandler(originalBaseHandler, sessionId, {
          desktopManager,
          bridges: desktopBridges,
          logger: desktopLogger,
        });
    }

    this._llmTools = llmTools;
    this._baseToolHandler = baseToolHandler;
    const providers = await this.createLLMProviders(config, llmTools);
    this._llmProviders = providers;
    const skillInjector = this.createSkillInjector(availableSkills);
    const memoryBackend = await this.createMemoryBackend(config, telemetry ?? undefined);
    this._memoryBackend = memoryBackend;
    const memoryRetriever = this.createMemoryRetriever(memoryBackend);
    this._chatExecutor = providers.length > 0 ? new ChatExecutor({
      providers,
      toolHandler: baseToolHandler,
      skillInjector,
      memoryRetriever,
      maxToolRounds: config.llm?.maxToolRounds ?? 3,
      sessionTokenBudget: config.llm?.sessionTokenBudget || undefined,
    }) : null;

    const approvalEngine = new ApprovalEngine();
    this._approvalEngine = approvalEngine;
    const sessionMgr = this.createSessionManager(hooks);
    const resolveSessionId = this.createSessionIdResolver(sessionMgr);
    const systemPrompt = await this.buildSystemPrompt(config);
    const commandRegistry = this.createCommandRegistry(
      sessionMgr,
      resolveSessionId,
      providers,
      memoryBackend,
      registry,
      availableSkills,
      skillList,
    );
    const voiceBridge = this.createOptionalVoiceBridge(config, llmTools, baseToolHandler, systemPrompt);
    this._voiceBridge = voiceBridge ?? null;

    const webChat = new WebChatChannel({
      gateway: { getStatus: () => gateway.getStatus(), config },
      skills: skillList,
      voiceBridge,
      memoryBackend,
      approvalEngine,
      skillToggle,
      connection: this._connectionManager?.getConnection(),
      broadcastEvent: (type, data) => webChat.broadcastEvent(type, data),
      desktopManager: this._desktopManager ?? undefined,
    });
    const signals = this.createWebChatSignals(webChat);
    const onMessage = this.createWebChatMessageHandler({
      webChat,
      commandRegistry,
      getChatExecutor: () => this._chatExecutor,
      hooks,
      sessionMgr,
      systemPrompt,
      baseToolHandler,
      approvalEngine,
      memoryBackend,
      signals,
    });

    await webChat.initialize({ onMessage, logger: this.logger, config: {} });
    await webChat.start();

    gateway.setWebChatHandler(webChat);
    this._webChatChannel = webChat;

    // Hot-swap LLM provider and voice bridge when config changes at runtime
    gateway.on('configReloaded', (...args: unknown[]) => {
      const diff = args[0] as ConfigDiff;
      const llmChanged = diff.safe.some((key) => key.startsWith('llm.'));
      if (llmChanged) {
        void this.hotSwapLLMProvider(gateway.config, skillInjector, memoryRetriever);
      }
      const voiceChanged = diff.safe.some((key) => key.startsWith('voice.') || key.startsWith('llm.apiKey'));
      if (voiceChanged) {
        void this._voiceBridge?.stopAll();
        const newBridge = this.createOptionalVoiceBridge(gateway.config, llmTools, baseToolHandler, systemPrompt);
        this._voiceBridge = newBridge ?? null;
        if (this._webChatChannel) {
          this._webChatChannel.updateVoiceBridge(newBridge ?? null);
        }
        this.logger.info(`Voice bridge ${newBridge ? 'recreated' : 'disabled'}`);
      }
    });

    const toolCount = registry.size;
    const skillCount = availableSkills.length;
    const providerNames = providers.map((p) => p.name).join(' → ') || 'none';
    this.logger.info(
      `WebChat wired` +
      ` with LLM [${providerNames}]` +
      `, ${toolCount} tools, ${skillCount} skills` +
      `, memory=${memoryBackend.name}` +
      `, ${commandRegistry.size} commands` +
      (telemetry ? ', telemetry' : '') +
      (config.llm?.sessionTokenBudget ? `, budget=${config.llm.sessionTokenBudget}` : '') +
      (voiceBridge ? ', voice' : '') +
      ', hooks, sessions, approvals',
    );
  }

  /**
   * Wire the Telegram channel plugin.
   *
   * Creates a TelegramChannel instance, initializes it with an onMessage
   * handler that routes messages through the shared ChatExecutor pipeline,
   * then starts long-polling (or webhook if configured).
   */
  private async wireTelegram(config: GatewayConfig): Promise<void> {
    const telegramConfig = config.channels?.telegram;
    if (!telegramConfig) return;

    const escapeHtml = (text: string): string =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const agentName = config.agent?.name ?? "AgenC";

    const welcomeMessage =
      `\u{1F916} <b>${agentName}</b>\n` +
      `\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\n\n` +
      `Privacy-preserving AI agent coordinating tasks on <b>Solana</b> via the AgenC protocol.\n\n` +
      `\u{2699}\uFE0F  <b>Capabilities</b>\n` +
      `\u{251C} \u{1F4CB} On-chain task coordination\n` +
      `\u{251C} \u{1F50D} Agent &amp; protocol queries\n` +
      `\u{251C} \u{1F4BB} Local shell &amp; file operations\n` +
      `\u{2514} \u{1F310} Web search &amp; lookups\n\n` +
      `\u{26A1} <b>Quick Commands</b>\n` +
      `\u{2022} <code>List open tasks</code>\n` +
      `\u{2022} <code>Create a task for ...</code>\n` +
      `\u{2022} <code>Show my agent status</code>\n` +
      `\u{2022} <code>Run git status</code>\n\n` +
      `<i>Send any message to get started.</i>`;

    const telegram = new TelegramChannel();
    const sessionMgr = new SessionManager({
      scope: "per-channel-peer",
      reset: { mode: "idle", idleMinutes: 30 },
      compaction: "truncate",
      maxHistoryLength: 100,
    });
    const systemPrompt = await this.buildSystemPrompt(config);

    const onMessage = async (msg: GatewayMessage): Promise<void> => {
      if (!msg.content.trim()) return;

      // Handle /start command with curated welcome
      if (msg.content.trim() === "/start") {
        await telegram.send({
          sessionId: msg.sessionId,
          content: welcomeMessage,
        });
        return;
      }

      const chatExecutor = this._chatExecutor;
      if (!chatExecutor) {
        await telegram.send({
          sessionId: msg.sessionId,
          content: "\u{26A0}\uFE0F No LLM provider configured.",
        });
        return;
      }

      const session = sessionMgr.getOrCreate({
        channel: "telegram",
        senderId: msg.senderId,
        scope: msg.scope,
        workspaceId: "default",
      });

      try {
        const result = await chatExecutor.execute({
          message: msg,
          history: session.history,
          systemPrompt,
          sessionId: msg.sessionId,
          toolHandler: this._baseToolHandler!,
        });

        sessionMgr.appendMessage(session.id, {
          role: "user",
          content: msg.content,
        });
        sessionMgr.appendMessage(session.id, {
          role: "assistant",
          content: result.content,
        });

        await telegram.send({
          sessionId: msg.sessionId,
          content: escapeHtml(result.content || "(no response)"),
        });

        // Persist to memory
        if (this._memoryBackend) {
          try {
            await this._memoryBackend.addEntry({
              sessionId: msg.sessionId,
              role: "user",
              content: msg.content,
            });
            await this._memoryBackend.addEntry({
              sessionId: msg.sessionId,
              role: "assistant",
              content: result.content,
            });
          } catch {
            // non-critical
          }
        }
      } catch (error) {
        this.logger.error("Telegram LLM error:", error);
        await telegram.send({
          sessionId: msg.sessionId,
          content: `\u{274C} Error: ${escapeHtml((error as Error).message)}`,
        });
      }
    };

    await telegram.initialize({
      onMessage,
      logger: this.logger,
      config: telegramConfig as unknown as Record<string, unknown>,
    });
    await telegram.start();
    this._telegramChannel = telegram;
    this.logger.info("Telegram channel wired");
  }

  /**
   * Wire a generic external channel plugin to the ChatExecutor pipeline.
   *
   * Creates a per-channel SessionManager, routes incoming messages through
   * the shared ChatExecutor, formats output per channel, and persists to memory.
   */
  private async wireExternalChannel(
    channel: ChannelPlugin,
    channelName: string,
    config: GatewayConfig,
    channelConfig: Record<string, unknown>,
  ): Promise<void> {
    const sessionMgr = new SessionManager({
      scope: "per-channel-peer",
      reset: { mode: "idle", idleMinutes: 30 },
      compaction: "truncate",
      maxHistoryLength: 100,
    });
    const systemPrompt = await this.buildSystemPrompt(config);

    const onMessage = async (msg: GatewayMessage): Promise<void> => {
      if (!msg.content.trim()) return;

      const chatExecutor = this._chatExecutor;
      if (!chatExecutor) {
        await channel.send({
          sessionId: msg.sessionId,
          content: "No LLM provider configured.",
        });
        return;
      }

      const session = sessionMgr.getOrCreate({
        channel: channelName,
        senderId: msg.senderId,
        scope: msg.scope,
        workspaceId: "default",
      });

      try {
        const result = await chatExecutor.execute({
          message: msg,
          history: session.history,
          systemPrompt,
          sessionId: msg.sessionId,
          toolHandler: this._baseToolHandler!,
        });

        sessionMgr.appendMessage(session.id, { role: "user", content: msg.content });
        sessionMgr.appendMessage(session.id, { role: "assistant", content: result.content });

        const formatted = formatForChannel(result.content || "(no response)", channelName);
        await channel.send({ sessionId: msg.sessionId, content: formatted });

        if (this._memoryBackend) {
          try {
            await this._memoryBackend.addEntry({
              sessionId: msg.sessionId,
              role: "user",
              content: msg.content,
            });
            await this._memoryBackend.addEntry({
              sessionId: msg.sessionId,
              role: "assistant",
              content: result.content,
            });
          } catch { /* non-critical */ }
        }
      } catch (error) {
        this.logger.error(`${channelName} LLM error:`, error);
        const errMsg = formatForChannel(
          `Error: ${(error as Error).message}`,
          channelName,
        );
        await channel.send({ sessionId: msg.sessionId, content: errMsg });
      }
    };

    await channel.initialize({ onMessage, logger: this.logger, config: channelConfig });
    await channel.start();
    this.logger.info(`${channelName} channel wired`);
  }

  /**
   * Wire all configured external channels (Discord, Slack, WhatsApp, Signal, Matrix, iMessage).
   * Each channel is wrapped in try/catch so one failure doesn't block the others.
   */
  private async wireExternalChannels(config: GatewayConfig): Promise<void> {
    const channels = config.channels ?? {};

    if (channels.discord) {
      try {
        const discord = new DiscordChannel(channels.discord as unknown as ConstructorParameters<typeof DiscordChannel>[0]);
        await this.wireExternalChannel(discord, "discord", config, channels.discord as unknown as Record<string, unknown>);
        this._discordChannel = discord;
      } catch (err) { this.logger.error("Failed to wire Discord channel:", err); }
    }

    if (channels.slack) {
      try {
        const slack = new SlackChannel(channels.slack as unknown as ConstructorParameters<typeof SlackChannel>[0]);
        await this.wireExternalChannel(slack, "slack", config, channels.slack as unknown as Record<string, unknown>);
        this._slackChannel = slack;
      } catch (err) { this.logger.error("Failed to wire Slack channel:", err); }
    }

    if (channels.whatsapp) {
      try {
        const whatsapp = new WhatsAppChannel(channels.whatsapp as unknown as ConstructorParameters<typeof WhatsAppChannel>[0]);
        await this.wireExternalChannel(whatsapp, "whatsapp", config, channels.whatsapp as unknown as Record<string, unknown>);
        this._whatsAppChannel = whatsapp;
      } catch (err) { this.logger.error("Failed to wire WhatsApp channel:", err); }
    }

    if (channels.signal) {
      try {
        const signal = new SignalChannel(channels.signal as unknown as ConstructorParameters<typeof SignalChannel>[0]);
        await this.wireExternalChannel(signal, "signal", config, channels.signal as unknown as Record<string, unknown>);
        this._signalChannel = signal;
      } catch (err) { this.logger.error("Failed to wire Signal channel:", err); }
    }

    if (channels.matrix) {
      try {
        const matrix = new MatrixChannel(channels.matrix as unknown as ConstructorParameters<typeof MatrixChannel>[0]);
        await this.wireExternalChannel(matrix, "matrix", config, channels.matrix as unknown as Record<string, unknown>);
        this._matrixChannel = matrix;
      } catch (err) { this.logger.error("Failed to wire Matrix channel:", err); }
    }

    // iMessage: macOS only, lazy-loaded
    if (channels.imessage && process.platform === "darwin") {
      try {
        const { IMessageChannel } = await import("../channels/imessage/plugin.js");
        const imessage = new IMessageChannel();
        await this.wireExternalChannel(imessage, "imessage", config, channels.imessage as unknown as Record<string, unknown>);
        this._imessageChannel = imessage;
      } catch (err) { this.logger.error("Failed to wire iMessage channel:", err); }
    }
  }

  /**
   * Wire autonomous features: curiosity, self-learning, meta-planner, proactive comms, desktop awareness.
   *
   * Uses HeartbeatScheduler for short-cycle actions (meta-planner, proactive comms, desktop awareness)
   * and CronScheduler for long-running research tasks (curiosity every 2h, self-learning every 6h).
   */
  private async wireAutonomousFeatures(config: GatewayConfig): Promise<void> {
    const heartbeatConfig = (config as unknown as Record<string, unknown>).heartbeat as
      | { enabled?: boolean; intervalMs?: number }
      | undefined;
    if (heartbeatConfig?.enabled === false) return;
    if (!this._chatExecutor || !this._memoryBackend) return;

    const intervalMs = heartbeatConfig?.intervalMs ?? 300_000; // default 5 min

    // Build active channels map for ProactiveCommunicator
    const activeChannels = new Map<string, ChannelPlugin>();
    if (this._telegramChannel) activeChannels.set("telegram", this._telegramChannel as unknown as ChannelPlugin);
    if (this._discordChannel) activeChannels.set("discord", this._discordChannel as unknown as ChannelPlugin);
    if (this._slackChannel) activeChannels.set("slack", this._slackChannel as unknown as ChannelPlugin);
    if (this._whatsAppChannel) activeChannels.set("whatsapp", this._whatsAppChannel as unknown as ChannelPlugin);
    if (this._signalChannel) activeChannels.set("signal", this._signalChannel as unknown as ChannelPlugin);
    if (this._matrixChannel) activeChannels.set("matrix", this._matrixChannel as unknown as ChannelPlugin);
    if (this._imessageChannel) activeChannels.set("imessage", this._imessageChannel);

    // ProactiveCommunicator works fine with no channels — it just won't broadcast.
    // Don't block autonomous features for channel-less configurations.

    try {
      const { ProactiveCommunicator: ProactiveComm } = await import("./proactive.js");
      const communicator = new ProactiveComm({
        channels: activeChannels,
        logger: this.logger,
        defaultTargets: {},
      });
      this._proactiveCommunicator = communicator;

      // Import autonomous action factories
      const [
        { createCuriosityAction },
        { createSelfLearningAction },
        { createMetaPlannerAction },
        { createProactiveCommsAction },
      ] = await Promise.all([
        import("../autonomous/curiosity.js"),
        import("../autonomous/self-learning.js"),
        import("../autonomous/meta-planner.js"),
        import("./heartbeat-actions.js"),
      ]);

      // Get a provider for actions that need direct LLM access
      const llm = this._llmProviders[0];
      if (!llm) {
        this.logger.warn("No LLM provider — skipping autonomous features");
        return;
      }

      // Create GoalManager early so actions can reference it
      const { GoalManager } = await import("../autonomous/goal-manager.js");
      this._goalManager = new GoalManager({ memory: this._memoryBackend! });

      const curiosityAction = createCuriosityAction({
        interests: ["Solana ecosystem", "DeFi protocols", "AI agents"],
        chatExecutor: this._chatExecutor!,
        toolHandler: this._baseToolHandler!,
        memory: this._memoryBackend!,
        systemPrompt: "You are an autonomous AI research agent.",
        communicator,
        goalManager: this._goalManager,
      });
      const selfLearningAction = createSelfLearningAction({
        llm,
        memory: this._memoryBackend!,
      });
      const metaPlannerAction = createMetaPlannerAction({
        llm,
        memory: this._memoryBackend!,
      });
      const proactiveCommsAction = createProactiveCommsAction({
        llm,
        memory: this._memoryBackend!,
        communicator,
      });

      // --- HeartbeatScheduler for short-cycle actions ---
      const { HeartbeatScheduler } = await import("./heartbeat.js");
      const heartbeatScheduler = new HeartbeatScheduler(
        { enabled: true, intervalMs, timeoutMs: 60_000 },
        { logger: this.logger },
      );
      heartbeatScheduler.registerAction(metaPlannerAction);
      heartbeatScheduler.registerAction(proactiveCommsAction);

      // Desktop awareness: register if Peekaboo MCP tools are available
      let setBridgeCallback: ((cb: (text: string) => Promise<unknown>) => void) | null = null;
      if (this._mcpManager) {
        const screenshotTool = this._mcpManager
          .getToolsByServer("peekaboo")
          .find((t) => t.name.includes("takeScreenshot"));
        if (screenshotTool) {
          const { createDesktopAwarenessAction } = await import(
            "../autonomous/desktop-awareness.js"
          );
          const awarenessAction = createDesktopAwarenessAction({
            screenshotTool,
            llm,
            memory: this._memoryBackend!,
          });

          // Wrap awareness to pipe noteworthy output through goal bridge (attached below)
          let awarenessBridgeCallback: ((text: string) => Promise<unknown>) | null = null;
          const originalAwarenessExecute = awarenessAction.execute.bind(awarenessAction);
          const wrappedAwareness: typeof awarenessAction = {
            name: awarenessAction.name,
            enabled: awarenessAction.enabled,
            async execute(ctx) {
              const result = await originalAwarenessExecute(ctx);
              if (result.hasOutput && result.output && awarenessBridgeCallback) {
                await awarenessBridgeCallback(result.output).catch(() => {});
              }
              return result;
            },
          };
          // Store setter in closure-accessible variable for GoalManager to connect
          setBridgeCallback = (cb) => { awarenessBridgeCallback = cb; };

          heartbeatScheduler.registerAction(wrappedAwareness);
          this.logger.info("Desktop awareness action registered (Peekaboo available)");
        }

        // Desktop executor: instantiate if Peekaboo + action tools available
        const peekabooTools = this._mcpManager.getToolsByServer("peekaboo");
        const screenshotToolForExec = peekabooTools.find((t) =>
          t.name.includes("takeScreenshot"),
        );
        const hasActionTools = peekabooTools.some(
          (t) => t.name.includes("click") || t.name.includes("type"),
        );

        if (screenshotToolForExec && hasActionTools) {
          const { DesktopExecutor } = await import(
            "../autonomous/desktop-executor.js"
          );
          this._desktopExecutor = new DesktopExecutor({
            chatExecutor: this._chatExecutor!,
            toolHandler: this._baseToolHandler!,
            screenshotTool: screenshotToolForExec,
            llm,
            memory: this._memoryBackend!,
            approvalEngine: this._approvalEngine ?? undefined,
            communicator,
          });
          this.logger.info(
            "Desktop executor ready (Peekaboo action tools available)",
          );
        }
      }

      // Wire awareness → goal bridge
      if (this._goalManager && setBridgeCallback) {
        const { createAwarenessGoalBridge } = await import(
          "../autonomous/awareness-goal-bridge.js"
        );
        setBridgeCallback(createAwarenessGoalBridge({
          goalManager: this._goalManager,
        }));
        this.logger.info("Awareness → goal bridge connected");
      }

      // Bridge meta-planner goals into GoalManager
      {
        const goalManager = this._goalManager;
        const memory = this._memoryBackend!;
        const originalMetaPlannerExecute = metaPlannerAction.execute.bind(metaPlannerAction);
        (metaPlannerAction as { execute: typeof metaPlannerAction.execute }).execute = async function (ctx) {
          const result = await originalMetaPlannerExecute(ctx);
          if (result.hasOutput) {
            try {
              const goals = await memory.get<Array<{ description: string; title: string; priority: "critical" | "high" | "medium" | "low"; rationale: string; status: string }>>("goal:active");
              if (goals) {
                for (const g of goals.filter((g) => g.status === "proposed")) {
                  const active = await goalManager.getActiveGoals();
                  if (!goalManager.isDuplicate(g.description, active)) {
                    await goalManager.addGoal({
                      title: g.title,
                      description: g.description,
                      priority: g.priority,
                      source: "meta-planner",
                      maxAttempts: 2,
                      rationale: g.rationale,
                    });
                  }
                }
              }
            } catch {
              // Silently ignore sync errors — meta-planner result still valid
            }
          }
          // Sync GoalManager state to a key meta-planner can see next cycle
          try {
            const managedActive = await goalManager.getActiveGoals();
            if (managedActive.length > 0) {
              await memory.set("goal:managed-active", managedActive.map(g => ({
                title: g.title,
                description: g.description,
                priority: g.priority,
                status: g.status,
                source: g.source,
              })));
            }
          } catch {
            // non-critical
          }
          return result;
        };
      }

      // Goal executor: dequeue from GoalManager and execute via DesktopExecutor
      if (this._desktopExecutor && this._goalManager) {
        const { createGoalExecutorAction } = await import(
          "../autonomous/goal-executor-action.js"
        );
        heartbeatScheduler.registerAction(
          createGoalExecutorAction({
            goalManager: this._goalManager,
            desktopExecutor: this._desktopExecutor,
            memory: this._memoryBackend!,
          }),
        );
      }

      heartbeatScheduler.start();
      this._heartbeatScheduler = heartbeatScheduler;

      // --- CronScheduler for long-running research tasks ---
      const { CronScheduler } = await import("./scheduler.js");
      const cronScheduler = new CronScheduler({ logger: this.logger });

      // Curiosity research every 2 hours
      cronScheduler.addJob("curiosity", "0 */2 * * *", {
        name: curiosityAction.name,
        execute: async (ctx) => {
          if (!curiosityAction.enabled) return;
          const result = await curiosityAction.execute({
            logger: ctx.logger,
            sendToChannels: async () => {},
          });
          if (result.hasOutput && !result.quiet) {
            ctx.logger.info(`[cron:curiosity] ${result.output}`);
          }
        },
      });

      // Self-learning analysis every 6 hours
      cronScheduler.addJob("self-learning", "0 */6 * * *", {
        name: selfLearningAction.name,
        execute: async (ctx) => {
          if (!selfLearningAction.enabled) return;
          const result = await selfLearningAction.execute({
            logger: ctx.logger,
            sendToChannels: async () => {},
          });
          if (result.hasOutput && !result.quiet) {
            ctx.logger.info(`[cron:self-learning] ${result.output}`);
          }
        },
      });

      cronScheduler.start();
      this._cronScheduler = cronScheduler;

      this.logger.info(
        `Autonomous features wired: heartbeat (interval=${intervalMs}ms) + cron (curiosity @2h, self-learning @6h)`,
      );
    } catch (err) {
      this.logger.error("Failed to wire autonomous features:", err);
    }
  }

  /**
   * Hot-swap the LLM provider when config.set changes llm.* fields.
   * Re-creates the provider chain and ChatExecutor without restarting the gateway.
   */
  private async hotSwapLLMProvider(
    newConfig: GatewayConfig,
    skillInjector: SkillInjector,
    memoryRetriever: MemoryRetriever,
  ): Promise<void> {
    try {
      const providers = await this.createLLMProviders(newConfig, this._llmTools);
      this._chatExecutor = providers.length > 0 ? new ChatExecutor({
        providers,
        toolHandler: this._baseToolHandler!,
        skillInjector,
        memoryRetriever,
        maxToolRounds: newConfig.llm?.maxToolRounds ?? 3,
        sessionTokenBudget: newConfig.llm?.sessionTokenBudget || undefined,
      }) : null;

      const providerNames = providers.map((p) => p.name).join(' → ') || 'none';
      this.logger.info(`LLM provider hot-swapped to [${providerNames}]`);
    } catch (err) {
      this.logger.error('Failed to hot-swap LLM provider:', err);
    }
  }

  private async createHookDispatcher(config: GatewayConfig): Promise<HookDispatcher> {
    const hooks = new HookDispatcher({ logger: this.logger });
    for (const hook of createBuiltinHooks()) {
      hooks.on(hook);
    }
    this._hookDispatcher = hooks;
    await hooks.dispatch('gateway:startup', { config });
    return hooks;
  }

  private async createToolRegistry(
    config: GatewayConfig,
    metrics?: UnifiedTelemetryCollector,
  ): Promise<ToolRegistry> {
    const registry = new ToolRegistry({ logger: this.logger });

    // Security: Only expose necessary environment variables to the bash tool.
    // Never pass the full process.env as it contains secrets (API keys, private key paths, etc.).
    const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'SOLANA_RPC_URL'];
    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }

    // Security: Do NOT use unrestricted mode — the default deny list prevents
    // dangerous commands (rm -rf, curl for exfiltration, etc.) from being
    // executed via LLM tool calling / prompt injection attacks.
    registry.register(createBashTool({ logger: this.logger, env: safeEnv }));
    registry.registerAll(createHttpTools({}, this.logger));

    // Security: Restrict filesystem access to a dedicated workspace directory.
    // The entire home directory is too broad — it exposes ~/.ssh, ~/.gnupg,
    // ~/.config/solana/id.json (private keys), etc. Disable delete by default.
    const workspacePath = join(homedir(), '.agenc', 'workspace');
    registry.registerAll(createFilesystemTools({
      allowedPaths: [workspacePath, '/tmp'],
      allowDelete: false,
    }));
    registry.registerAll(createBrowserTools({ mode: 'basic' }, this.logger));

    // macOS native automation tools (AppleScript, JXA, open, notifications)
    if (process.platform === 'darwin') {
      try {
        const { createMacOSTools } = await import('../tools/system/macos.js');
        registry.registerAll(createMacOSTools({ logger: this.logger }));
      } catch (err) {
        this.logger.warn?.('macOS tools unavailable:', err);
      }
    }

    // External MCP server tools (Peekaboo, macos-automator, etc.)
    if (config.mcp?.servers?.length) {
      try {
        const { MCPManager } = await import('../mcp-client/index.js');
        this._mcpManager = new MCPManager(config.mcp.servers, this.logger);
        await this._mcpManager.start();
        registry.registerAll(this._mcpManager.getTools());
      } catch (err) {
        this.logger.error('Failed to initialize MCP servers:', err);
      }
    }

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
          logger: this.logger,
          metrics,
        });
        this._connectionManager = connMgr;

        const { createAgencTools } = await import('../tools/agenc/index.js');
        // Load wallet so chat agent can sign transactions (createTask, etc.)
        let wallet: import('../tools/types.js').ToolContext['wallet'] | undefined;
        try {
          const { loadKeypairFromFile, getDefaultKeypairPath } = await import('../types/wallet.js');
          const kpPath = config.connection?.keypairPath ?? getDefaultKeypairPath();
          const keypair = await loadKeypairFromFile(kpPath);
          wallet = {
            publicKey: keypair.publicKey,
            signTransaction: async (tx: any) => { tx.sign(keypair); return tx; },
            signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.sign(keypair)); return txs; },
          };
        } catch { /* wallet unavailable — tools will be read-only */ }
        registry.registerAll(createAgencTools({
          connection: connMgr.getConnection(),
          wallet,
          logger: this.logger,
        }));
      } catch (error) {
        this.logger.warn?.('AgenC protocol tools unavailable:', error);
      }
    }

    return registry;
  }

  private createSkillInjector(skills: DiscoveredSkill[]): SkillInjector {
    return {
      async inject(_message: string, _sessionId: string): Promise<string | undefined> {
        if (skills.length === 0) {
          return undefined;
        }

        const sections = skills.map((skill) =>
          `## Skill: ${skill.skill.name}\n${skill.skill.description}\n\n${skill.skill.body}`,
        );
        return (
          '# Available Skills\n\n' +
          'You have the following skills available. Use the system.bash tool to execute commands. ' +
          'The system.bash tool takes a `command` (executable name) and `args` (array of argument strings). ' +
          'Do NOT use shell syntax — pass the executable and its arguments separately.\n\n' +
          sections.join('\n\n---\n\n')
        );
      },
    };
  }

  private createMemoryRetriever(memoryBackend: MemoryBackend): MemoryRetriever {
    return {
      async retrieve(_message: string, sessionId: string): Promise<string | undefined> {
        try {
          const entries = await memoryBackend.getThread(sessionId, 10);
          if (entries.length === 0) {
            return undefined;
          }
          const lines = entries.map((entry) => `[${entry.role}] ${entry.content}`);
          return '# Recent Memory\n\n' + lines.join('\n');
        } catch {
          return undefined;
        }
      },
    };
  }

  private createSessionManager(hooks: HookDispatcher): SessionManager {
    return new SessionManager(
      {
        scope: 'per-peer',
        reset: { mode: 'idle', idleMinutes: 120 },
        maxHistoryLength: 100,
        compaction: 'sliding-window',
      },
      {
        compactionHook: async (payload) => {
          await hooks.dispatch('session:compact', {
            phase: payload.phase,
            sessionId: payload.sessionId,
            strategy: payload.strategy,
            historyLengthBefore: payload.historyLengthBefore,
            historyLengthAfter: payload.historyLengthAfter,
            result: payload.result,
            error: payload.error,
          });
        },
      },
    );
  }

  private createSessionIdResolver(sessionMgr: SessionManager): (senderId: string) => string {
    return (senderId: string): string => {
      return sessionMgr.getOrCreate({
        channel: 'webchat',
        senderId,
        scope: 'dm',
        workspaceId: 'default',
      }).id;
    };
  }

  private createCommandRegistry(
    sessionMgr: SessionManager,
    resolveSessionId: (senderId: string) => string,
    providers: LLMProvider[],
    memoryBackend: MemoryBackend,
    registry: ToolRegistry,
    availableSkills: DiscoveredSkill[],
    skillList: WebChatSkillSummary[],
  ): SlashCommandRegistry {
    const commandRegistry = new SlashCommandRegistry({ logger: this.logger });
    for (const command of createDefaultCommands()) {
      commandRegistry.register(command);
    }

    commandRegistry.register({
      name: 'help',
      description: 'Show available commands',
      global: true,
      handler: async (ctx) => {
        const commands = commandRegistry.getCommands();
        const lines = commands.map((command) => `  /${command.name} — ${command.description}`);
        await ctx.reply('Available commands:\n' + lines.join('\n'));
      },
    });
    commandRegistry.register({
      name: 'new',
      description: 'Start a new session (reset conversation)',
      global: true,
      handler: async (ctx) => {
        const sessionId = resolveSessionId(ctx.senderId);
        sessionMgr.reset(sessionId);
        // Clean up desktop sandbox on session reset
        if (this._desktopManager) {
          await this._desktopManager.destroyBySession(sessionId).catch(() => {});
          const { destroySessionBridge } = await import('../desktop/session-router.js');
          destroySessionBridge(sessionId, this._desktopBridges);
        }
        await ctx.reply('Session reset. Starting fresh conversation.');
      },
    });
    commandRegistry.register({
      name: 'reset',
      description: 'Reset session and clear context',
      global: true,
      handler: async (ctx) => {
        const sessionId = resolveSessionId(ctx.senderId);
        sessionMgr.reset(sessionId);
        if (this._desktopManager) {
          await this._desktopManager.destroyBySession(sessionId).catch(() => {});
          const { destroySessionBridge } = await import('../desktop/session-router.js');
          destroySessionBridge(sessionId, this._desktopBridges);
        }
        await ctx.reply('Session and context cleared.');
      },
    });
    commandRegistry.register({
      name: 'compact',
      description: 'Force conversation compaction',
      global: true,
      handler: async (ctx) => {
        const sessionId = resolveSessionId(ctx.senderId);
        const result = await sessionMgr.compact(sessionId);
        if (result) {
          await ctx.reply(`Compacted: removed ${result.messagesRemoved}, retained ${result.messagesRetained}.`);
        } else {
          await ctx.reply('No session to compact.');
        }
      },
    });
    commandRegistry.register({
      name: 'status',
      description: 'Show agent status',
      global: true,
      handler: async (ctx) => {
        const sessionId = resolveSessionId(ctx.senderId);
        const session = sessionMgr.get(sessionId);
        const historyLen = session?.history.length ?? 0;
        const providerNames = providers.map((provider) => provider.name).join(' → ') || 'none';
        await ctx.reply(
          `Agent is running.\n` +
          `Session: ${sessionId.slice(0, 16)}...\n` +
          `History: ${historyLen} messages\n` +
          `LLM: ${providerNames}\n` +
          `Memory: ${memoryBackend.name}\n` +
          `Tools: ${registry.size}\n` +
          `Skills: ${availableSkills.length}`,
        );
      },
    });
    commandRegistry.register({
      name: 'skills',
      description: 'List available skills',
      global: true,
      handler: async (ctx) => {
        if (skillList.length === 0) {
          await ctx.reply('No skills available.');
          return;
        }
        const lines = skillList.map((skill) =>
          `  ${skill.enabled ? '●' : '○'} ${skill.name} — ${skill.description}`,
        );
        await ctx.reply('Skills:\n' + lines.join('\n'));
      },
    });
    commandRegistry.register({
      name: 'model',
      description: 'Show current LLM model',
      args: '[name]',
      global: true,
      handler: async (ctx) => {
        const providerInfo = providers.map((provider) => provider.name).join(', ') || 'none';
        await ctx.reply(`LLM providers: ${providerInfo}`);
      },
    });

    // Desktop sandbox commands (only when desktop is enabled)
    if (this._desktopManager) {
      const desktopMgr = this._desktopManager;
      commandRegistry.register({
        name: 'desktop',
        description: 'Manage desktop sandbox (start|stop|status|vnc)',
        args: '<subcommand>',
        global: true,
        handler: async (ctx) => {
          const sub = ctx.argv[0]?.toLowerCase();
          const sessionId = resolveSessionId(ctx.senderId);

          if (sub === 'start') {
            try {
              const handle = await desktopMgr.getOrCreate(sessionId);
              await ctx.reply(
                `Desktop sandbox started.\nVNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}`,
              );
            } catch (err) {
              await ctx.reply(`Failed to start desktop: ${err instanceof Error ? err.message : err}`);
            }
          } else if (sub === 'stop') {
            await desktopMgr.destroyBySession(sessionId);
            const { destroySessionBridge } = await import('../desktop/session-router.js');
            destroySessionBridge(sessionId, this._desktopBridges);
            await ctx.reply('Desktop sandbox stopped.');
          } else if (sub === 'status') {
            const handle = desktopMgr.getHandleBySession(sessionId);
            if (!handle) {
              await ctx.reply('No active desktop sandbox for this session.');
            } else {
              const uptimeS = Math.round((Date.now() - handle.createdAt) / 1000);
              await ctx.reply(
                `Desktop sandbox: ${handle.status}\n` +
                `Container: ${handle.containerId}\n` +
                `Uptime: ${uptimeS}s\n` +
                `VNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}`,
              );
            }
          } else if (sub === 'vnc') {
            const handle = desktopMgr.getHandleBySession(sessionId);
            if (!handle) {
              await ctx.reply('No active desktop sandbox. Use /desktop start first.');
            } else {
              await ctx.reply(`http://localhost:${handle.vncHostPort}/vnc.html`);
            }
          } else {
            await ctx.reply('Usage: /desktop <start|stop|status|vnc>');
          }
        },
      });
    }

    // /goal — create or list goals (lazy access to goalManager via getter)
    const daemon = this;
    commandRegistry.register({
      name: 'goal',
      description: 'Create or list goals',
      args: '[description]',
      global: true,
      handler: async (ctx) => {
        const gm = daemon.goalManager;
        if (!gm) {
          await ctx.reply('Goal manager not available. Autonomous features may be disabled.');
          return;
        }
        if (ctx.args) {
          const goal = await gm.addGoal({
            title: ctx.args.slice(0, 60),
            description: ctx.args,
            priority: "medium",
            source: "user",
            maxAttempts: 2,
          });
          await ctx.reply(`Goal created [${goal.id.slice(0, 8)}]: ${goal.title}`);
        } else {
          const active = await gm.getActiveGoals();
          if (active.length === 0) {
            await ctx.reply('No active goals. Use /goal <description> to create one.');
            return;
          }
          const lines = active.map(g =>
            `  [${g.priority}/${g.status}] ${g.title}`,
          );
          await ctx.reply(`Active goals (${active.length}):\n${lines.join('\n')}`);
        }
      },
    });

    return commandRegistry;
  }

  private createOptionalVoiceBridge(
    config: GatewayConfig,
    llmTools: LLMTool[],
    toolHandler: ToolHandler,
    systemPrompt: string,
  ): VoiceBridge | undefined {
    const voiceApiKey = config.voice?.apiKey || config.llm?.apiKey;
    if (!voiceApiKey || config.voice?.enabled === false) {
      return undefined;
    }

    return new VoiceBridge({
      apiKey: voiceApiKey,
      tools: llmTools,
      toolHandler,
      systemPrompt,
      voice: config.voice?.voice ?? 'Ara',
      model: config.llm?.model ?? DEFAULT_GROK_MODEL,
      mode: config.voice?.mode ?? 'vad',
      logger: this.logger,
    });
  }

  private createWebChatSignals(webChat: WebChatChannel): WebChatSignals {
    return {
      signalThinking: (sessionId: string): void => {
        webChat.pushToSession(sessionId, {
          type: 'agent.status',
          payload: { phase: 'thinking' },
        });
        webChat.pushToSession(sessionId, {
          type: 'chat.typing',
          payload: { active: true },
        });
      },
      signalIdle: (sessionId: string): void => {
        webChat.pushToSession(sessionId, {
          type: 'agent.status',
          payload: { phase: 'idle' },
        });
        webChat.pushToSession(sessionId, {
          type: 'chat.typing',
          payload: { active: false },
        });
      },
    };
  }

  private createWebChatMessageHandler(params: {
    webChat: WebChatChannel;
    commandRegistry: SlashCommandRegistry;
    getChatExecutor: () => ChatExecutor | null;
    hooks: HookDispatcher;
    sessionMgr: SessionManager;
    systemPrompt: string;
    baseToolHandler: ToolHandler;
    approvalEngine: ApprovalEngine;
    memoryBackend: MemoryBackend;
    signals: WebChatSignals;
  }): (msg: GatewayMessage) => Promise<void> {
    const {
      webChat,
      commandRegistry,
      getChatExecutor,
      hooks,
      sessionMgr,
      systemPrompt,
      baseToolHandler,
      approvalEngine,
      memoryBackend,
      signals,
    } = params;

    return async (msg: GatewayMessage): Promise<void> => {
      const hasAttachments = msg.attachments && msg.attachments.length > 0;
      if (!msg.content.trim() && !hasAttachments) {
        return;
      }

      const reply = async (content: string): Promise<void> => {
        await webChat.send({ sessionId: msg.sessionId, content });
      };
      const handled = await commandRegistry.dispatch(
        msg.content,
        msg.sessionId,
        msg.senderId,
        'webchat',
        reply,
      );
      if (handled) {
        return;
      }

      const chatExecutor = getChatExecutor();
      if (!chatExecutor) {
        await webChat.send({
          sessionId: msg.sessionId,
          content: 'No LLM provider configured. Add an `llm` section to ~/.agenc/config.json.',
        });
        return;
      }

      const inboundResult = await hooks.dispatch('message:inbound', {
        sessionId: msg.sessionId,
        content: msg.content,
        senderId: msg.senderId,
      });
      if (!inboundResult.completed) {
        return;
      }

      webChat.broadcastEvent('chat.inbound', { sessionId: msg.sessionId });

      const sessionStreamCallback: StreamProgressCallback = (chunk) => {
        webChat.pushToSession(msg.sessionId, {
          type: 'chat.stream',
          payload: { content: chunk.content, done: chunk.done },
        });
      };

      // Detect greeting messages — block tool execution for casual conversation
      const GREETING_RE = /^(h(i|ello|ey|ola|owdy)|yo|sup|what'?s\s*up|greetings?|good\s*(morning|afternoon|evening)|gm|gn)\s*[!?.,:;\-)*]*$/i;
      const isGreeting = GREETING_RE.test(msg.content.trim());

      const sessionToolHandler: ToolHandler = async (name, args) => {
        if (isGreeting) {
          return JSON.stringify({
            error: 'This is a greeting message. Respond conversationally without using any tools.',
          });
        }

        const toolBeforeResult = await hooks.dispatch('tool:before', {
          sessionId: msg.sessionId,
          toolName: name,
          args,
        });
        if (!toolBeforeResult.completed) {
          return JSON.stringify({ error: `Tool "${name}" blocked by hook` });
        }

        webChat.pushToSession(msg.sessionId, {
          type: 'agent.status',
          payload: { phase: 'tool_call', detail: `Calling ${name}` },
        });
        webChat.pushToSession(msg.sessionId, {
          type: 'tools.executing',
          payload: { toolName: name, args },
        });

        const rule = approvalEngine.requiresApproval(name, args);
        if (rule && !approvalEngine.isToolElevated(msg.sessionId, name)) {
          const request = approvalEngine.createRequest(
            name,
            args,
            msg.sessionId,
            rule.description ?? `Approval required for ${name}`,
            rule,
          );
          webChat.pushToSession(msg.sessionId, {
            type: 'approval.request',
            payload: {
              requestId: request.id,
              action: name,
              details: args,
              message: request.message,
            },
          });
          const response = await approvalEngine.requestApproval(request);
          if (response.disposition === 'no') {
            const err = JSON.stringify({ error: `Tool "${name}" denied by user` });
            webChat.pushToSession(msg.sessionId, {
              type: 'tools.result',
              payload: { toolName: name, result: err, durationMs: 0, isError: true },
            });
            webChat.pushToSession(msg.sessionId, {
              type: 'agent.status',
              payload: { phase: 'generating' },
            });
            return err;
          }
          if (response.disposition === 'always') {
            approvalEngine.elevate(msg.sessionId, name);
          }
        }

        const start = Date.now();
        // Use desktop-aware handler if available, otherwise base handler
        const activeHandler = this._desktopRouterFactory
          ? this._desktopRouterFactory(msg.sessionId)
          : baseToolHandler;
        const result = await activeHandler(name, args);
        const durationMs = Date.now() - start;

        webChat.pushToSession(msg.sessionId, {
          type: 'tools.result',
          payload: { toolName: name, result, durationMs },
        });

        await hooks.dispatch('tool:after', {
          sessionId: msg.sessionId,
          toolName: name,
          args,
          result,
          durationMs,
        });

        webChat.broadcastEvent('tool.executed', {
          toolName: name,
          durationMs,
          sessionId: msg.sessionId,
        });

        webChat.pushToSession(msg.sessionId, {
          type: 'agent.status',
          payload: { phase: 'generating' },
        });

        return result;
      };

      try {
        signals.signalThinking(msg.sessionId);

        const session = sessionMgr.getOrCreate({
          channel: 'webchat',
          senderId: msg.senderId,
          scope: 'dm',
          workspaceId: 'default',
        });

        const result = await chatExecutor.execute({
          message: msg,
          history: session.history,
          systemPrompt,
          sessionId: msg.sessionId,
          toolHandler: sessionToolHandler,
          onStreamChunk: sessionStreamCallback,
        });

        signals.signalIdle(msg.sessionId);
        sessionMgr.appendMessage(session.id, { role: 'user', content: msg.content });
        sessionMgr.appendMessage(session.id, { role: 'assistant', content: result.content });

        await webChat.send({
          sessionId: msg.sessionId,
          content: result.content || '(no response)',
        });

        webChat.broadcastEvent('chat.response', { sessionId: msg.sessionId });

        await hooks.dispatch('message:outbound', {
          sessionId: msg.sessionId,
          content: result.content,
          provider: result.provider,
        });

        try {
          await memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: 'user',
            content: msg.content,
          });
          await memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: 'assistant',
            content: result.content,
          });
        } catch (error) {
          this.logger.warn?.('Failed to persist messages to memory:', error);
        }

        if (result.toolCalls.length > 0) {
          this.logger.info(`Chat used ${result.toolCalls.length} tool call(s)`, {
            tools: result.toolCalls.map((toolCall) => toolCall.name),
            provider: result.provider,
          });
        }
      } catch (error) {
        signals.signalIdle(msg.sessionId);
        this.logger.error('LLM chat error:', error);
        await webChat.send({
          sessionId: msg.sessionId,
          content: `Error: ${(error as Error).message}`,
        });
      }
    };
  }

  /**
   * Build the system prompt from workspace files, falling back to
   * personality template when no workspace directory exists.
   */
  private async buildSystemPrompt(config: GatewayConfig): Promise<string> {
    const workspacePath = getDefaultWorkspacePath();
    const loader = new WorkspaceLoader(workspacePath);

    try {
      const workspaceFiles = await loader.load();
      // If at least AGENT.md exists, use workspace-driven prompt
      if (workspaceFiles.agent) {
        const prompt = assembleSystemPrompt(workspaceFiles, {
          additionalContext:
            'You have full access to the local machine via the system.bash tool. ' +
            'You can create files, compile and run code, install packages, run git commands, ' +
            'and execute any CLI tool. Use your tools proactively to fulfill requests.',
        });
        this.logger.info('System prompt loaded from workspace files');
        return prompt;
      }
    } catch {
      // Workspace directory doesn't exist or is unreadable — fall back
    }

    // Fall back to personality template
    const template = loadPersonalityTemplate('default');
    const nameOverride = config.agent?.name
      ? { agent: template.agent?.replace(/^AgenC$/m, config.agent.name) }
      : {};
    const merged = mergePersonality(template, nameOverride);
    const prompt = assembleSystemPrompt(merged, {
      additionalContext:
        'You have full access to the local machine via the system.bash tool. ' +
        'You can create files, compile and run code, install packages, run git commands, ' +
        'and execute any CLI tool. You are NOT sandboxed — use your tools proactively. ' +
        'Be helpful and concise.',
    });
    this.logger.info('System prompt loaded from default personality template');
    return prompt;
  }

  /**
   * Create the ordered provider chain: primary + optional fallbacks.
   * ChatExecutor handles cooldown-based failover across the chain.
   */
  private async createLLMProviders(config: GatewayConfig, tools: LLMTool[]): Promise<LLMProvider[]> {
    if (!config.llm) return [];

    const providers: LLMProvider[] = [];
    const primary = await this.createSingleLLMProvider(config.llm, tools);
    if (primary) providers.push(primary);

    if (config.llm.fallback) {
      for (const fb of config.llm.fallback) {
        const fallback = await this.createSingleLLMProvider(fb, tools);
        if (fallback) providers.push(fallback);
      }
    }

    return providers;
  }

  /**
   * Create a single LLM provider from a provider config.
   */
  private async createSingleLLMProvider(llmConfig: GatewayLLMConfig, tools: LLMTool[]): Promise<LLMProvider | null> {
    const { provider, apiKey, model, baseUrl } = llmConfig;

    switch (provider) {
      case 'grok': {
        const { GrokProvider } = await import('../llm/grok/adapter.js');
        return new GrokProvider({
          apiKey: apiKey ?? '',
          model: model ?? DEFAULT_GROK_MODEL,
          baseURL: baseUrl,
          tools,
        });
      }
      case 'ollama': {
        const { OllamaProvider } = await import('../llm/ollama/adapter.js');
        return new OllamaProvider({
          model: model ?? 'llama3',
          host: baseUrl,
          tools,
        });
      }
      default:
        this.logger.warn(`Unknown LLM provider: ${provider}`);
        return null;
    }
  }

  /**
   * Create a memory backend based on gateway config.
   * Defaults to SqliteBackend for persistence across restarts.
   * Use backend='memory' to explicitly opt into InMemoryBackend.
   */
  private async createMemoryBackend(
    config: GatewayConfig,
    metrics?: UnifiedTelemetryCollector,
  ): Promise<MemoryBackend> {
    const memConfig = config.memory;
    const backend = memConfig?.backend ?? 'sqlite';
    const encryption = memConfig?.encryptionKey
      ? { key: memConfig.encryptionKey }
      : undefined;

    switch (backend) {
      case 'sqlite': {
        const { SqliteBackend } = await import('../memory/sqlite/backend.js');
        return new SqliteBackend({
          dbPath: memConfig?.dbPath ?? join(homedir(), '.agenc', 'memory.db'),
          logger: this.logger,
          metrics,
          encryption,
        });
      }
      case 'redis': {
        const { RedisBackend } = await import('../memory/redis/backend.js');
        return new RedisBackend({
          url: memConfig?.url,
          host: memConfig?.host,
          port: memConfig?.port,
          password: memConfig?.password,
          logger: this.logger,
          metrics,
        });
      }
      case 'memory':
        return new InMemoryBackend({ logger: this.logger, metrics });
      default:
        return new InMemoryBackend({ logger: this.logger, metrics });
    }
  }

  /**
   * Discover bundled and user skills. Returns full DiscoveredSkill objects
   * so skill bodies can be injected into LLM context.
   */
  private async discoverSkills(): Promise<DiscoveredSkill[]> {
    try {
      // __filename = runtime/dist/bin/agenc-runtime.js (tsup entry point).
      // We need the package root (runtime/) to find src/skills/bundled/.
      // dist/bin/ → dist/ → runtime/ (2 levels up from dirname)
      const pkgRoot = resolvePath(dirname(__filename), '..', '..');
      const builtinSkills = join(pkgRoot, 'src', 'skills', 'bundled');
      const userSkills = join(homedir(), '.agenc', 'skills');

      const discovery = new SkillDiscovery({ builtinSkills, userSkills });
      return await discovery.discoverAll();
    } catch (err) {
      this.logger.warn('Skill discovery failed:', err);
      return [];
    }
  }

  async stop(): Promise<void> {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    try {
      // Dispatch shutdown hook (best-effort)
      if (this._hookDispatcher !== null) {
        await this._hookDispatcher.dispatch('gateway:shutdown', {});
        this._hookDispatcher.clear();
        this._hookDispatcher = null;
      }
      // Stop voice sessions before WebChat channel
      if (this._voiceBridge !== null) {
        await this._voiceBridge.stopAll();
        this._voiceBridge = null;
      }
      // Clean up subsystems
      if (this._approvalEngine !== null) {
        this._approvalEngine.dispose();
        this._approvalEngine = null;
      }
      if (this._telemetry !== null) {
        this._telemetry.flush();
        this._telemetry.destroy();
        this._telemetry = null;
      }
      // Disconnect desktop bridges and destroy containers
      for (const bridge of this._desktopBridges.values()) {
        bridge.disconnect();
      }
      this._desktopBridges.clear();
      if (this._desktopManager !== null) {
        await this._desktopManager.stop();
        this._desktopManager = null;
      }
      if (this._connectionManager !== null) {
        this._connectionManager.destroy();
        this._connectionManager = null;
      }
      if (this._memoryBackend !== null) {
        await this._memoryBackend.close();
        this._memoryBackend = null;
      }
      // Stop MCP server connections
      if (this._mcpManager !== null) {
        await this._mcpManager.stop();
        this._mcpManager = null;
      }
      // Stop autonomous schedulers
      if (this._heartbeatScheduler !== null) {
        this._heartbeatScheduler.stop();
        this._heartbeatScheduler = null;
      }
      if (this._cronScheduler !== null) {
        this._cronScheduler.stop();
        this._cronScheduler = null;
      }
      // Stop legacy heartbeat timer (if still in use)
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      // Stop desktop executor
      if (this._desktopExecutor !== null) {
        this._desktopExecutor.cancel();
        this._desktopExecutor = null;
      }
      // Clear goal manager
      this._goalManager = null;
      // Clear proactive communicator
      this._proactiveCommunicator = null;
      // Stop external channels (reverse order of wiring)
      if (this._imessageChannel !== null) {
        await this._imessageChannel.stop();
        this._imessageChannel = null;
      }
      if (this._matrixChannel !== null) {
        await this._matrixChannel.stop();
        this._matrixChannel = null;
      }
      if (this._signalChannel !== null) {
        await this._signalChannel.stop();
        this._signalChannel = null;
      }
      if (this._whatsAppChannel !== null) {
        await this._whatsAppChannel.stop();
        this._whatsAppChannel = null;
      }
      if (this._slackChannel !== null) {
        await this._slackChannel.stop();
        this._slackChannel = null;
      }
      if (this._discordChannel !== null) {
        await this._discordChannel.stop();
        this._discordChannel = null;
      }
      // Stop Telegram channel
      if (this._telegramChannel !== null) {
        await this._telegramChannel.stop();
        this._telegramChannel = null;
      }
      // Stop WebChat channel before gateway
      if (this._webChatChannel !== null) {
        await this._webChatChannel.stop();
        this._webChatChannel = null;
      }
      if (this.gateway !== null) {
        await this.gateway.stop();
        this.gateway = null;
      }
      await removePidFile(this.pidPath);
      this.removeSignalHandlers();
      this.startedAt = 0;
      this.logger.info('Daemon stopped');
    } finally {
      this.shutdownInProgress = false;
    }
  }

  get desktopExecutor(): import('../autonomous/desktop-executor.js').DesktopExecutor | null {
    return this._desktopExecutor;
  }

  get goalManager(): import('../autonomous/goal-manager.js').GoalManager | null {
    return this._goalManager;
  }

  get proactiveCommunicator(): ProactiveCommunicator | null {
    return this._proactiveCommunicator;
  }

  getStatus(): DaemonStatus {
    const mem = process.memoryUsage();
    return {
      running: this.gateway !== null && this.gateway.state === 'running',
      pid: process.pid,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      gatewayStatus: this.gateway !== null ? this.gateway.getStatus() : null,
      memoryUsage: {
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      },
    };
  }

  setupSignalHandlers(): void {
    if (this.signalHandlersRegistered) {
      return;
    }
    this.signalHandlersRegistered = true;

    const shutdown = () => {
      void this.stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    const reload = () => {
      void this.handleConfigReload();
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', reload);

    this.signalHandlerRefs = [
      { signal: 'SIGTERM', handler: shutdown },
      { signal: 'SIGINT', handler: shutdown },
      { signal: 'SIGHUP', handler: reload },
    ];
  }

  private removeSignalHandlers(): void {
    for (const ref of this.signalHandlerRefs) {
      process.removeListener(ref.signal, ref.handler);
    }
    this.signalHandlerRefs = [];
    this.signalHandlersRegistered = false;
  }

  private async handleConfigReload(): Promise<void> {
    try {
      this.logger.info('Reloading config', { configPath: this.configPath });
      const newConfig = await loadGatewayConfig(this.configPath);
      if (this.gateway !== null) {
        const diff = this.gateway.reloadConfig(newConfig);
        this.logger.info('Config reloaded', {
          safe: diff.safe,
          unsafe: diff.unsafe,
        });
      }
    } catch (error) {
      this.logger.error(
        'Config reload failed',
        { error: toErrorMessage(error) },
      );
    }
  }
}

// ============================================================================
// Service Templates
// ============================================================================

export function generateSystemdUnit(options: {
  execStart: string;
  description?: string;
  user?: string;
}): string {
  const desc = options.description ?? 'AgenC Gateway Daemon';
  const lines = [
    '[Unit]',
    `Description=${desc}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${options.execStart}`,
    'Restart=on-failure',
    'RestartSec=10s',
    'TimeoutStopSec=35s',
    'Environment=NODE_ENV=production',
  ];
  if (options.user) {
    lines.push(`User=${options.user}`);
  }
  lines.push(
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  );
  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateLaunchdPlist(options: {
  programArguments: string[];
  label?: string;
  logDir?: string;
}): string {
  const label = escapeXml(options.label ?? 'ai.agenc.gateway');
  const logDir = options.logDir ?? join(homedir(), '.agenc', 'logs');
  const programArgs = options.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(join(logDir, 'agenc-stdout.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(join(logDir, 'agenc-stderr.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
