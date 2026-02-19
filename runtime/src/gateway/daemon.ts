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
import type { GatewayConfig, GatewayLLMConfig, GatewayStatus } from './types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { WebChatChannel } from '../channels/webchat/plugin.js';
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
  private _voiceBridge: VoiceBridge | null = null;
  private _memoryBackend: MemoryBackend | null = null;
  private _approvalEngine: ApprovalEngine | null = null;
  private _telemetry: UnifiedTelemetryCollector | null = null;
  private _hookDispatcher: HookDispatcher | null = null;
  private _connectionManager: ConnectionManager | null = null;
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

    const gatewayConfig = await loadGatewayConfig(this.configPath);
    const gateway = new Gateway(gatewayConfig, {
      logger: this.logger,
      configPath: this.configPath,
    });

    await gateway.start();

    // Wire up WebChat channel with LLM pipeline
    await this.wireWebChat(gateway, gatewayConfig);

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
    const baseToolHandler = registry.createToolHandler();
    const providers = await this.createLLMProviders(config, llmTools);
    const skillInjector = this.createSkillInjector(availableSkills);
    const memoryBackend = await this.createMemoryBackend(config, telemetry ?? undefined);
    this._memoryBackend = memoryBackend;
    const memoryRetriever = this.createMemoryRetriever(memoryBackend);
    const chatExecutor = providers.length > 0 ? new ChatExecutor({
      providers,
      toolHandler: baseToolHandler,
      skillInjector,
      memoryRetriever,
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
    });
    const signals = this.createWebChatSignals(webChat);
    const onMessage = this.createWebChatMessageHandler({
      webChat,
      commandRegistry,
      chatExecutor,
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
    const processEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        processEnv[key] = value;
      }
    }

    registry.register(createBashTool({ logger: this.logger, env: processEnv, unrestricted: true }));
    registry.registerAll(createHttpTools({}, this.logger));
    registry.registerAll(createFilesystemTools({
      allowedPaths: [homedir(), '/tmp'],
      allowDelete: true,
    }));
    registry.registerAll(createBrowserTools({ mode: 'basic' }, this.logger));

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
        registry.registerAll(createAgencTools({
          connection: connMgr.getConnection(),
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
        sessionMgr.reset(resolveSessionId(ctx.senderId));
        await ctx.reply('Session reset. Starting fresh conversation.');
      },
    });
    commandRegistry.register({
      name: 'reset',
      description: 'Reset session and clear context',
      global: true,
      handler: async (ctx) => {
        sessionMgr.reset(resolveSessionId(ctx.senderId));
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

    return commandRegistry;
  }

  private createOptionalVoiceBridge(
    config: GatewayConfig,
    llmTools: LLMTool[],
    toolHandler: ToolHandler,
    systemPrompt: string,
  ): VoiceBridge | undefined {
    if (
      config.llm?.provider !== 'grok'
      || !config.llm.apiKey
      || config.voice?.enabled === false
    ) {
      return undefined;
    }

    return new VoiceBridge({
      apiKey: config.llm.apiKey,
      tools: llmTools,
      toolHandler,
      systemPrompt,
      voice: config.voice?.voice ?? 'Ara',
      model: config.llm.model ?? DEFAULT_GROK_MODEL,
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
    chatExecutor: ChatExecutor | null;
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
      chatExecutor,
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

      const sessionStreamCallback: StreamProgressCallback = (chunk) => {
        webChat.pushToSession(msg.sessionId, {
          type: 'chat.stream',
          payload: { content: chunk.content, done: chunk.done },
        });
      };

      const sessionToolHandler: ToolHandler = async (name, args) => {
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
        const result = await baseToolHandler(name, args);
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
      case 'anthropic': {
        const { AnthropicProvider } = await import('../llm/anthropic/adapter.js');
        return new AnthropicProvider({
          apiKey: apiKey ?? '',
          model: model ?? 'claude-sonnet-4-5-20250929',
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
   * Defaults to InMemoryBackend when no config or backend='memory'.
   */
  private async createMemoryBackend(
    config: GatewayConfig,
    metrics?: UnifiedTelemetryCollector,
  ): Promise<MemoryBackend> {
    const memConfig = config.memory;
    const backend = memConfig?.backend ?? 'memory';
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
      if (this._connectionManager !== null) {
        this._connectionManager.destroy();
        this._connectionManager = null;
      }
      if (this._memoryBackend !== null) {
        await this._memoryBackend.close();
        this._memoryBackend = null;
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
