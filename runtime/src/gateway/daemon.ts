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
import type { GatewayConfig, GatewayStatus } from './types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { WebChatChannel } from '../channels/webchat/plugin.js';
import type { LLMProvider, LLMMessage, LLMTool } from '../llm/types.js';
import type { GatewayMessage } from './message.js';
import { ChatExecutor } from '../llm/chat-executor.js';
import type { SkillInjector } from '../llm/chat-executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBashTool } from '../tools/system/bash.js';
import { createHttpTools } from '../tools/system/http.js';
import { SkillDiscovery } from '../skills/markdown/discovery.js';
import type { DiscoveredSkill } from '../skills/markdown/discovery.js';

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
   * and connect it to an LLM provider with tool execution and skill injection.
   */
  private async wireWebChat(gateway: Gateway, config: GatewayConfig): Promise<void> {
    // Discover bundled + user skills
    const discovered = await this.discoverSkills();
    const skillList = discovered.map((d) => ({
      name: d.skill.name,
      description: d.skill.description,
      enabled: d.available,
    }));

    // Create tool registry with system tools
    const registry = new ToolRegistry({ logger: this.logger });
    const processEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) processEnv[key] = value;
    }
    registry.register(createBashTool({ logger: this.logger, env: processEnv }));
    registry.registerAll(createHttpTools({}, this.logger));

    const llmTools = registry.toLLMTools();

    // Create LLM provider with tools configured
    const llm = await this.createLLMProvider(config, llmTools);

    // Build skill injector — injects available skill instructions as system context
    const availableSkills = discovered.filter((d) => d.available);
    const skillInjector: SkillInjector = {
      async inject(_message: string, _sessionId: string): Promise<string | undefined> {
        if (availableSkills.length === 0) return undefined;
        const sections = availableSkills.map((s) =>
          `## Skill: ${s.skill.name}\n${s.skill.description}\n\n${s.skill.body}`,
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

    // Create ChatExecutor with tool-calling loop
    const chatExecutor = llm ? new ChatExecutor({
      providers: [llm],
      toolHandler: registry.createToolHandler(),
      maxToolRounds: 10,
      skillInjector,
    }) : null;

    // Per-session conversation history
    const sessionHistory = new Map<string, LLMMessage[]>();
    const MAX_HISTORY = 50;
    const MAX_SESSIONS = 100;

    const webChat = new WebChatChannel(
      { gateway: { getStatus: () => gateway.getStatus(), config }, skills: skillList },
    );

    const systemPrompt = config.agent?.name
      ? `You are ${config.agent.name}, an AI agent on the AgenC protocol. Be helpful, concise, and use your tools when appropriate.`
      : 'You are an AI agent on the AgenC protocol. Be helpful, concise, and use your tools when appropriate.';

    const onMessage = async (msg: GatewayMessage): Promise<void> => {
      if (!msg.content.trim()) return;

      if (!chatExecutor) {
        await webChat.send({
          sessionId: msg.sessionId,
          content: 'No LLM provider configured. Add an `llm` section to ~/.agenc/config.json.',
        });
        return;
      }

      try {
        const history = sessionHistory.get(msg.sessionId) ?? [];

        const result = await chatExecutor.execute({
          message: msg,
          history,
          systemPrompt,
          sessionId: msg.sessionId,
        });

        // Update session history
        const updated: LLMMessage[] = [
          ...history,
          { role: 'user', content: msg.content },
          { role: 'assistant', content: result.content },
        ];
        sessionHistory.set(
          msg.sessionId,
          updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated,
        );

        // Evict oldest session if over capacity
        if (sessionHistory.size > MAX_SESSIONS) {
          const oldest = sessionHistory.keys().next().value;
          if (oldest !== undefined) sessionHistory.delete(oldest);
        }

        const text = result.content || '(no response)';
        await webChat.send({ sessionId: msg.sessionId, content: text });

        if (result.toolCalls.length > 0) {
          this.logger.info(`Chat used ${result.toolCalls.length} tool call(s)`, {
            tools: result.toolCalls.map((tc) => tc.name),
            provider: result.provider,
          });
        }
      } catch (err) {
        this.logger.error('LLM chat error:', err);
        await webChat.send({
          sessionId: msg.sessionId,
          content: `Error: ${(err as Error).message}`,
        });
      }
    };

    await webChat.initialize({ onMessage, logger: this.logger, config: {} });
    await webChat.start();

    gateway.setWebChatHandler(webChat);
    this._webChatChannel = webChat;

    const toolCount = registry.size;
    const skillCount = availableSkills.length;
    this.logger.info(
      `WebChat wired` +
      (llm ? ` with ${llm.name} LLM` : ' (no LLM)') +
      `, ${toolCount} tools, ${skillCount} skills`,
    );
  }

  /**
   * Create an LLM provider from gateway config. Returns null if no LLM is configured.
   */
  private async createLLMProvider(config: GatewayConfig, tools: LLMTool[] = []): Promise<LLMProvider | null> {
    if (!config.llm) return null;

    const { provider, apiKey, model, baseUrl } = config.llm;

    switch (provider) {
      case 'grok': {
        const { GrokProvider } = await import('../llm/grok/adapter.js');
        return new GrokProvider({
          apiKey: apiKey ?? '',
          model: model ?? 'grok-3',
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
