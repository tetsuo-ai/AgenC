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
import { createEmbeddingProvider } from '../memory/embeddings.js';
import { InMemoryVectorStore } from '../memory/vector-store.js';
import { SemanticMemoryRetriever } from '../memory/retriever.js';
import { MemoryIngestionEngine, createIngestionHooks } from '../memory/ingestion.js';
import { DailyLogManager, CuratedMemoryManager } from '../memory/structured.js';
import { UnifiedTelemetryCollector } from '../telemetry/collector.js';
import { SessionManager } from './session.js';
import { WorkspaceLoader, getDefaultWorkspacePath, assembleSystemPrompt } from './workspace-files.js';
import { loadPersonalityTemplate, mergePersonality } from './personality.js';
import { SlashCommandRegistry, createDefaultCommands } from './commands.js';
import { HookDispatcher, createBuiltinHooks } from './hooks.js';
import { ProgressTracker, summarizeToolResult } from './progress.js';
import { PipelineExecutor, type Pipeline, type PipelineStep } from '../workflow/pipeline.js';
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

/** Minimum confidence score for injecting learned patterns into conversations. */
const MIN_LEARNING_CONFIDENCE = 0.7;

/** Default session manager config for external channel plugins. */
const DEFAULT_CHANNEL_SESSION_CONFIG = {
  scope: 'per-channel-peer' as const,
  reset: { mode: 'idle' as const, idleMinutes: 30 },
  compaction: 'truncate' as const,
  maxHistoryLength: 100,
};

/** Hook priority constants — lower numbers run first. */
const HOOK_PRIORITIES = {
  POLICY_GATE: 3,
  APPROVAL_GATE: 5,
  PROGRESS_TRACKER: 95,
} as const;

/** Cron schedule expressions for autonomous features. */
const CRON_SCHEDULES = {
  CURIOSITY: '0 */2 * * *',
  SELF_LEARNING: '0 */6 * * *',
} as const;

/** Semantic memory retriever defaults. */
const SEMANTIC_MEMORY_DEFAULTS = {
  MAX_TOKEN_BUDGET: 2000,
  MAX_RESULTS: 5,
  RECENCY_WEIGHT: 0.3,
  RECENCY_HALF_LIFE_MS: 86_400_000,
  HYBRID_VECTOR_WEIGHT: 0.7,
  HYBRID_KEYWORD_WEIGHT: 0.3,
} as const;

/** Result of loadWallet() — either a keypair + wallet adapter or null. */
interface WalletResult {
  keypair: import('@solana/web3.js').Keypair;
  agentId: Uint8Array;
  wallet: {
    publicKey: import('@solana/web3.js').PublicKey;
    signTransaction: (tx: any) => Promise<any>;
    signAllTransactions: (txs: any[]) => Promise<any[]>;
  };
}

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
  private _playwrightBridges: Map<string, import('../mcp-client/types.js').MCPToolBridge> = new Map();
  private _desktopRouterFactory: ((sessionId: string) => ToolHandler) | null = null;
  private _desktopExecutor: import('../autonomous/desktop-executor.js').DesktopExecutor | null = null;
  private _goalManager: import('../autonomous/goal-manager.js').GoalManager | null = null;
  private _policyEngine: import('../policy/engine.js').PolicyEngine | null = null;
  private _marketplace: import('../marketplace/service-marketplace.js').ServiceMarketplace | null = null;
  private _agentDiscovery: import('../social/discovery.js').AgentDiscovery | null = null;
  private _agentMessaging: import('../social/messaging.js').AgentMessaging | null = null;
  private _agentFeed: import('../social/feed.js').AgentFeed | null = null;
  private _reputationScorer: import('../social/reputation.js').ReputationScorer | null = null;
  private _collaborationProtocol: import('../social/collaboration.js').CollaborationProtocol | null = null;
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

    // Wire up subsystems (marketplace, social module)
    await this.wireMarketplace(gatewayConfig);
    await this.wireSocial(gatewayConfig);

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
      const playwrightBridges = this._playwrightBridges;
      const desktopLogger = this.logger;
      const playwrightEnabled = config.desktop?.playwright?.enabled !== false;

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
          playwrightBridges: playwrightEnabled ? playwrightBridges : undefined,
          logger: desktopLogger,
          autoScreenshot: true,
        });
    }

    this._llmTools = llmTools;
    this._baseToolHandler = baseToolHandler;
    const providers = await this.createLLMProviders(config, llmTools);
    this._llmProviders = providers;
    const skillInjector = this.createSkillInjector(availableSkills);
    const memoryBackend = await this.createMemoryBackend(config, telemetry ?? undefined);
    this._memoryBackend = memoryBackend;

    // --- Semantic memory stack ---
    const embeddingProvider = await createEmbeddingProvider({
      preferred: config.memory?.embeddingProvider,
      apiKey: config.memory?.embeddingApiKey ?? config.llm?.apiKey,
      baseUrl: config.memory?.embeddingBaseUrl,
      model: config.memory?.embeddingModel,
    });

    const isSemanticAvailable = embeddingProvider.name !== 'noop';
    let memoryRetriever: MemoryRetriever;

    if (isSemanticAvailable) {
      const workspacePath = getDefaultWorkspacePath();
      const vectorStore = new InMemoryVectorStore({ dimension: embeddingProvider.dimension });

      const curatedMemory = new CuratedMemoryManager(join(workspacePath, 'MEMORY.md'));
      const logManager = new DailyLogManager(join(workspacePath, 'logs'));

      const ingestionEngine = new MemoryIngestionEngine({
        embeddingProvider,
        vectorStore,
        logManager,
        curatedMemory,
        generateSummaries: false,
        enableDailyLogs: true,
        enableEntityExtraction: false,
        logger: this.logger,
      });

      const ingestionHooks = createIngestionHooks(ingestionEngine, this.logger);
      for (const hook of ingestionHooks) {
        hooks.on(hook);
      }

      memoryRetriever = new SemanticMemoryRetriever({
        vectorBackend: vectorStore,
        embeddingProvider,
        curatedMemory,
        maxTokenBudget: SEMANTIC_MEMORY_DEFAULTS.MAX_TOKEN_BUDGET,
        maxResults: SEMANTIC_MEMORY_DEFAULTS.MAX_RESULTS,
        recencyWeight: SEMANTIC_MEMORY_DEFAULTS.RECENCY_WEIGHT,
        recencyHalfLifeMs: SEMANTIC_MEMORY_DEFAULTS.RECENCY_HALF_LIFE_MS,
        hybridVectorWeight: SEMANTIC_MEMORY_DEFAULTS.HYBRID_VECTOR_WEIGHT,
        hybridKeywordWeight: SEMANTIC_MEMORY_DEFAULTS.HYBRID_KEYWORD_WEIGHT,
        logger: this.logger,
      });

      this.logger.info(`Semantic memory enabled (embedding: ${embeddingProvider.name}, dim: ${embeddingProvider.dimension})`);
    } else {
      memoryRetriever = this.createMemoryRetriever(memoryBackend);
      this.logger.info('Semantic memory unavailable — using basic history retriever');
    }

    // Learning context provider — reads self-learning patterns per message
    const learningProvider: MemoryRetriever = {
      async retrieve(): Promise<string | undefined> {
        if (!memoryBackend) return undefined;
        try {
          const learning = await memoryBackend.get<{
            patterns: Array<{ type: string; description: string; lesson: string; confidence: number }>;
            strategies: Array<{ name: string; description: string; steps: string[] }>;
            preferences: Record<string, string>;
          }>('learning:latest');
          if (!learning) return undefined;

          const parts: string[] = [];
          const lessons = (learning.patterns ?? [])
            .filter((p) => p.confidence >= MIN_LEARNING_CONFIDENCE)
            .slice(0, 10)
            .map((p) => `- ${p.lesson}`);
          if (lessons.length > 0) parts.push('Lessons:\n' + lessons.join('\n'));

          const strats = (learning.strategies ?? []).slice(0, 5)
            .map((s) => `- ${s.name}: ${s.description}`);
          if (strats.length > 0) parts.push('Strategies:\n' + strats.join('\n'));

          const prefs = Object.entries(learning.preferences ?? {}).slice(0, 5)
            .map(([k, v]) => `- ${k}: ${v}`);
          if (prefs.length > 0) parts.push('Preferences:\n' + prefs.join('\n'));

          if (parts.length === 0) return undefined;
          return '## Learned Patterns\n\n' + parts.join('\n\n');
        } catch {
          return undefined;
        }
      },
    };

    // --- Cross-session progress tracker ---
    const progressTracker = new ProgressTracker({ memoryBackend, logger: this.logger });
    hooks.on({
      event: 'tool:after',
      name: 'progress-tracker',
      priority: HOOK_PRIORITIES.PROGRESS_TRACKER,
      handler: async (ctx) => {
        const { sessionId, toolName, args, result, durationMs } = ctx.payload as {
          sessionId: string; toolName: string; args: Record<string, unknown>;
          result: string; durationMs: number;
        };
        await progressTracker.append({
          sessionId,
          type: 'tool_result',
          summary: summarizeToolResult(toolName, args, result, durationMs),
        });
        return { continue: true };
      },
    });

    // Wire PolicyEngine as tool:before hook
    if (config.policy?.enabled) {
      try {
        const { PolicyEngine } = await import('../policy/engine.js');
        this._policyEngine = new PolicyEngine({
          policy: {
            enabled: true,
            toolAllowList: config.policy.toolAllowList,
            toolDenyList: config.policy.toolDenyList,
            actionBudgets: config.policy.actionBudgets,
            spendBudget: config.policy.spendBudget
              ? { limitLamports: BigInt(config.policy.spendBudget.limitLamports), windowMs: config.policy.spendBudget.windowMs }
              : undefined,
            maxRiskScore: config.policy.maxRiskScore,
            circuitBreaker: config.policy.circuitBreaker,
          },
          logger: this.logger,
          metrics: telemetry ?? undefined,
        });
        hooks.on({
          event: 'tool:before',
          name: 'policy-gate',
          priority: HOOK_PRIORITIES.POLICY_GATE,
          handler: async (ctx) => {
            const payload = ctx.payload as Record<string, unknown>;
            const decision = this._policyEngine!.evaluate({
              type: 'tool_call',
              name: payload.toolName as string,
              access: 'write',
              metadata: payload,
            });
            if (!decision.allowed) {
              this.logger.warn?.(
                `Policy blocked tool "${payload.toolName}": ${decision.violations.map((v) => v.message).join('; ')}`,
              );
              return { continue: false };
            }
            return { continue: true };
          },
        });
        this.logger.info('Policy engine initialized');
      } catch (err) {
        this.logger.warn?.('Policy engine initialization failed:', err);
      }
    }

    this._chatExecutor = providers.length > 0 ? new ChatExecutor({
      providers,
      toolHandler: baseToolHandler,
      skillInjector,
      memoryRetriever,
      learningProvider,
      progressProvider: progressTracker,
      maxToolRounds: config.llm?.maxToolRounds ?? (config.desktop?.enabled ? 50 : 3),
      sessionTokenBudget: config.llm?.sessionTokenBudget || undefined,
      onCompaction: this.handleCompaction,
    }) : null;

    const approvalEngine = new ApprovalEngine();
    this._approvalEngine = approvalEngine;

    // --- Resumable pipeline executor ---
    const pipelineExecutor = new PipelineExecutor({
      toolHandler: baseToolHandler,
      memoryBackend,
      approvalEngine,
      progressTracker,
      logger: this.logger,
    });

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
      progressTracker,
      pipelineExecutor,
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
        void this.hotSwapLLMProvider(gateway.config, skillInjector, memoryRetriever, learningProvider, progressTracker);
      }
      const policyChanged = diff.safe.some((key) => key.startsWith('policy.'));
      if (policyChanged && this._policyEngine) {
        const newConfig = gateway.config;
        if (newConfig.policy?.enabled) {
          this._policyEngine.setPolicy({
            enabled: true,
            toolAllowList: newConfig.policy.toolAllowList,
            toolDenyList: newConfig.policy.toolDenyList,
            actionBudgets: newConfig.policy.actionBudgets,
            spendBudget: newConfig.policy.spendBudget
              ? { limitLamports: BigInt(newConfig.policy.spendBudget.limitLamports), windowMs: newConfig.policy.spendBudget.windowMs }
              : undefined,
            maxRiskScore: newConfig.policy.maxRiskScore,
            circuitBreaker: newConfig.policy.circuitBreaker,
          });
          this.logger.info('Policy engine config reloaded');
        }
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
    const sessionMgr = new SessionManager(DEFAULT_CHANNEL_SESSION_CONFIG);
    const systemPrompt = await this.buildSystemPrompt(config);

    // Telegram allowlist: only these user IDs can interact with the bot.
    // Empty array = allow everyone. Populated = restrict to listed IDs.
    const telegramAllowedUsers: string[] = (
      telegramConfig.allowedUsers as string[] ?? []
    ).map(String);

    const onMessage = async (msg: GatewayMessage): Promise<void> => {
      this.logger.info("Telegram message received", {
        senderId: msg.senderId,
        sessionId: msg.sessionId,
        contentLength: msg.content.length,
        contentPreview: msg.content.slice(0, 50),
      });
      if (!msg.content.trim()) return;

      // Enforce allowlist if configured
      if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(msg.senderId)) {
        await telegram.send({
          sessionId: msg.sessionId,
          content: "\u{1F6AB} Access restricted. This bot is private.",
        });
        return;
      }

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

        this.logger.debug("Telegram reply ready", {
          sessionId: msg.sessionId,
          contentLength: (result.content || "").length,
          contentPreview: (result.content || "(no response)").slice(0, 200),
        });
        try {
          await telegram.send({
            sessionId: msg.sessionId,
            content: escapeHtml(result.content || "(no response)"),
          });
          this.logger.debug("Telegram reply sent successfully");
        } catch (sendErr) {
          this.logger.error("Telegram send failed:", sendErr);
        }

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
    const sessionMgr = new SessionManager(DEFAULT_CHANNEL_SESSION_CONFIG);
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

    // Standard channel plugins — identical wiring pattern
    const standardChannels: Array<{
      key: string;
      name: string;
      create: (cfg: unknown) => ChannelPlugin;
      field: '_discordChannel' | '_slackChannel' | '_whatsAppChannel' | '_signalChannel' | '_matrixChannel';
    }> = [
      { key: 'discord', name: 'discord', create: (cfg) => new DiscordChannel(cfg as ConstructorParameters<typeof DiscordChannel>[0]), field: '_discordChannel' },
      { key: 'slack', name: 'slack', create: (cfg) => new SlackChannel(cfg as ConstructorParameters<typeof SlackChannel>[0]), field: '_slackChannel' },
      { key: 'whatsapp', name: 'whatsapp', create: (cfg) => new WhatsAppChannel(cfg as ConstructorParameters<typeof WhatsAppChannel>[0]), field: '_whatsAppChannel' },
      { key: 'signal', name: 'signal', create: (cfg) => new SignalChannel(cfg as ConstructorParameters<typeof SignalChannel>[0]), field: '_signalChannel' },
      { key: 'matrix', name: 'matrix', create: (cfg) => new MatrixChannel(cfg as ConstructorParameters<typeof MatrixChannel>[0]), field: '_matrixChannel' },
    ];

    for (const { key, name, create, field } of standardChannels) {
      if (!channels[key]) continue;
      try {
        const plugin = create(channels[key]);
        await this.wireExternalChannel(plugin, name, config, channels[key] as unknown as Record<string, unknown>);
        this[field] = plugin as any;
      } catch (err) { this.logger.error(`Failed to wire ${name} channel:`, err); }
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
   * Wire the TaskBidMarketplace + ServiceMarketplace for agent-to-agent task bidding.
   * Session-scoped, in-memory bid book.
   */
  private async wireMarketplace(config: GatewayConfig): Promise<void> {
    if (!config.marketplace?.enabled) return;

    try {
      const { TaskBidMarketplace } = await import('../marketplace/engine.js');
      const { ServiceMarketplace } = await import('../marketplace/service-marketplace.js');

      const bidMarketplace = new TaskBidMarketplace({
        antiSpam: config.marketplace.antiSpam,
        defaultPolicy: config.marketplace.defaultMatchingPolicy
          ? { policy: config.marketplace.defaultMatchingPolicy }
          : undefined,
        authorizedSelectorIds: config.marketplace.authorizedSelectorIds,
      });

      this._marketplace = new ServiceMarketplace({
        bidMarketplace,
      });

      this.logger.info('Marketplace initialized (TaskBidMarketplace + ServiceMarketplace)');
    } catch (err) {
      this.logger.warn?.('Marketplace initialization failed:', err);
    }
  }

  /**
   * Wire the social module: AgentDiscovery, AgentMessaging, AgentFeed,
   * ReputationScorer, and CollaborationProtocol.
   *
   * Each sub-component is independently enabled/disabled.
   * CollaborationProtocol only initializes when all its dependencies are available.
   */
  private async wireSocial(config: GatewayConfig): Promise<void> {
    if (!config.social?.enabled) return;
    if (!this._connectionManager) {
      this.logger.warn?.('Social module requires connection config — skipping');
      return;
    }

    const connection = this._connectionManager.getConnection();

    const walletResult = await this.loadWallet(config);
    if (!walletResult) {
      this.logger.warn?.('Social module keypair unavailable — write operations disabled');
    }
    const keypair = walletResult?.keypair ?? null;
    const agentId = walletResult?.agentId ?? null;

    // Create program instance
    let program: import('@coral-xyz/anchor').Program<import('../types/agenc_coordination.js').AgencCoordination>;
    try {
      if (walletResult) {
        const { AnchorProvider } = await import('@coral-xyz/anchor');
        const provider = new AnchorProvider(connection, walletResult.wallet as any, {});
        const { createProgram } = await import('../idl.js');
        program = createProgram(provider);
      } else {
        const { createReadOnlyProgram } = await import('../idl.js');
        program = createReadOnlyProgram(connection);
      }
    } catch (err) {
      this.logger.warn?.('Social module program creation failed:', err);
      return;
    }

    // 1. AgentDiscovery (read-only, no wallet needed)
    if (config.social.discoveryEnabled !== false) {
      try {
        const { AgentDiscovery } = await import('../social/discovery.js');
        this._agentDiscovery = new AgentDiscovery({
          program,
          logger: this.logger,
          cache: {
            ttlMs: config.social.discoveryCacheTtlMs ?? 60_000,
            maxEntries: config.social.discoveryCacheMaxEntries ?? 200,
          },
        });
        this.logger.info('Agent discovery initialized');
      } catch (err) {
        this.logger.warn?.('Agent discovery initialization failed:', err);
      }
    }

    // 2. AgentMessaging (needs wallet)
    if (keypair && agentId && config.social.messagingEnabled !== false) {
      try {
        const { AgentMessaging } = await import('../social/messaging.js');
        this._agentMessaging = new AgentMessaging({
          program,
          agentId,
          wallet: keypair,
          logger: this.logger,
          config: {
            defaultMode: config.social.messagingMode ?? 'auto',
            offChainPort: config.social.messagingPort ?? 0,
          },
        });
        if (config.social.messagingPort) {
          await this._agentMessaging.startListener(config.social.messagingPort);
        }
        this.logger.info('Agent messaging initialized');
      } catch (err) {
        this.logger.warn?.('Agent messaging initialization failed:', err);
      }
    }

    // 3. AgentFeed (needs wallet)
    if (keypair && agentId && config.social.feedEnabled !== false) {
      try {
        const { AgentFeed } = await import('../social/feed.js');
        this._agentFeed = new AgentFeed({
          program,
          agentId,
          wallet: keypair,
          config: { logger: this.logger },
        });
        this.logger.info('Agent feed initialized');
      } catch (err) {
        this.logger.warn?.('Agent feed initialization failed:', err);
      }
    }

    // 4. ReputationScorer (read-only)
    if (config.social.reputationEnabled !== false) {
      try {
        const { ReputationScorer } = await import('../social/reputation.js');
        this._reputationScorer = new ReputationScorer({
          program,
          logger: this.logger,
        });
        this.logger.info('Reputation scorer initialized');
      } catch (err) {
        this.logger.warn?.('Reputation scorer initialization failed:', err);
      }
    }

    // 5. CollaborationProtocol (needs all sub-components + wallet)
    if (
      config.social.collaborationEnabled !== false &&
      keypair && agentId &&
      this._agentDiscovery && this._agentMessaging && this._agentFeed
    ) {
      try {
        const { CollaborationProtocol } = await import('../social/collaboration.js');
        const { TeamContractEngine } = await import('../team/engine.js');
        const teamEngine = new TeamContractEngine();
        this._collaborationProtocol = new CollaborationProtocol({
          program,
          agentId,
          wallet: keypair,
          feed: this._agentFeed,
          messaging: this._agentMessaging,
          discovery: this._agentDiscovery,
          teamEngine,
          config: { logger: this.logger },
        });
        this.logger.info('Collaboration protocol initialized');
      } catch (err) {
        this.logger.warn?.('Collaboration protocol initialization failed:', err);
      }
    }

    const wiredCount = [
      this._agentDiscovery,
      this._agentMessaging,
      this._agentFeed,
      this._reputationScorer,
      this._collaborationProtocol,
    ].filter(Boolean).length;
    this.logger.info(`Social module wired with ${wiredCount}/5 components`);
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
        this.logger.warn?.("No LLM provider — skipping autonomous features");
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
      cronScheduler.addJob("curiosity", CRON_SCHEDULES.CURIOSITY, {
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
      cronScheduler.addJob("self-learning", CRON_SCHEDULES.SELF_LEARNING, {
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
  private handleCompaction = (sessionId: string, summary: string): void => {
    this.logger.info(`Context compacted for session ${sessionId} (${summary.length} chars)`);
    if (this._hookDispatcher) {
      void this._hookDispatcher.dispatch('session:compact', {
        sessionId, summary, source: 'budget',
      });
    }
  };

  private async hotSwapLLMProvider(
    newConfig: GatewayConfig,
    skillInjector: SkillInjector,
    memoryRetriever: MemoryRetriever,
    learningProvider?: MemoryRetriever,
    progressProvider?: MemoryRetriever,
  ): Promise<void> {
    try {
      const providers = await this.createLLMProviders(newConfig, this._llmTools);
      this._chatExecutor = providers.length > 0 ? new ChatExecutor({
        providers,
        toolHandler: this._baseToolHandler!,
        skillInjector,
        memoryRetriever,
        learningProvider,
        progressProvider,
        maxToolRounds: newConfig.llm?.maxToolRounds ?? (newConfig.desktop?.enabled ? 50 : 3),
        sessionTokenBudget: newConfig.llm?.sessionTokenBudget || undefined,
        onCompaction: this.handleCompaction,
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
    // When desktop containers are enabled (Linux desktop agent mode), the host
    // needs additional env keys for development tools (gh, docker, npm, cargo).
    const DESKTOP_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'DOCKER_HOST', 'NPM_TOKEN', 'CARGO_HOME', 'GOPATH', 'DISPLAY'];
    const envKeys = config.desktop?.enabled ? [...SAFE_ENV_KEYS, ...DESKTOP_ENV_KEYS] : SAFE_ENV_KEYS;
    const safeEnv: Record<string, string> = {};
    for (const key of envKeys) {
      const value = process.env[key];
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }

    // Security: Do NOT use unrestricted mode — the default deny list prevents
    // dangerous commands (rm -rf, curl for exfiltration, etc.) from being
    // executed via LLM tool calling / prompt injection attacks.
    //
    // On macOS desktop agents, allow process management (killall, pkill) and
    // network tools for closing apps — the security boundary is Telegram user auth.
    //
    // On Linux with desktop containers enabled, the host needs development tools
    // (curl, wget, python, node, rm, chmod, etc.) while still blocking shell
    // re-invocation (bash, sh, env, xargs) to preserve the execFile() security model.
    const isMacDesktop = process.platform === 'darwin';
    const isLinuxDesktop = config.desktop?.enabled && process.platform !== 'darwin';
    const denyExclusions = isMacDesktop
      ? ['killall', 'pkill', 'curl', 'wget']
      : isLinuxDesktop
        ? ['curl', 'wget', 'python', 'python3', 'node', 'rm', 'chmod', 'chown', 'tee', 'awk', 'killall', 'pkill']
        : undefined;

    registry.register(createBashTool({
      logger: this.logger,
      env: safeEnv,
      denyExclusions,
      timeoutMs: config.desktop?.enabled ? 300_000 : undefined,
      maxTimeoutMs: config.desktop?.enabled ? 600_000 : undefined,
    }));
    registry.registerAll(createHttpTools({}, this.logger));

    // Security: Restrict filesystem access to workspace + Desktop + /tmp.
    // Excludes ~/.ssh, ~/.gnupg, ~/.config/solana (private keys), etc.
    const workspacePath = join(homedir(), '.agenc', 'workspace');
    const desktopPath = join(homedir(), 'Desktop');
    registry.registerAll(createFilesystemTools({
      allowedPaths: [workspacePath, desktopPath, '/tmp'],
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
        const walletResult = await this.loadWallet(config);
        registry.registerAll(createAgencTools({
          connection: connMgr.getConnection(),
          wallet: walletResult?.wallet,
          logger: this.logger,
        }));
      } catch (error) {
        this.logger.warn?.('AgenC protocol tools unavailable:', error);
      }
    }

    // X (Twitter) tools — registered when config.x credentials are present.
    const xConfig = (config as unknown as Record<string, unknown>).x as
      | { consumerKey?: string; consumerSecret?: string; accessToken?: string; accessTokenSecret?: string }
      | undefined;
    if (xConfig?.consumerKey && xConfig.consumerSecret && xConfig.accessToken && xConfig.accessTokenSecret) {
      try {
        const { createXTools } = await import('../tools/x/index.js');
        registry.registerAll(createXTools({
          consumerKey: xConfig.consumerKey,
          consumerSecret: xConfig.consumerSecret,
          accessToken: xConfig.accessToken,
          accessTokenSecret: xConfig.accessTokenSecret,
        }, this.logger));
        this.logger.info('X (Twitter) tools registered');
      } catch (error) {
        this.logger.warn?.('X tools unavailable:', error);
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
    const mgr = new SessionManager(
      {
        scope: 'per-peer',
        reset: { mode: 'idle', idleMinutes: 120 },
        maxHistoryLength: 100,
        compaction: 'sliding-window',
      },
      {
        compactionHook: async (payload) => {
          // Extract the compaction summary text if available
          let summary: string | undefined;
          if (payload.phase === 'after' && payload.result?.summaryGenerated) {
            const session = mgr.get(payload.sessionId);
            const first = session?.history[0];
            if (first?.role === 'system') {
              summary = typeof first.content === 'string' ? first.content : undefined;
            }
          }
          await hooks.dispatch('session:compact', {
            ...payload,
            summary,
          });
        },
      },
    );
    return mgr;
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
    progressTracker?: ProgressTracker,
    pipelineExecutor?: PipelineExecutor,
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
        await progressTracker?.clear(sessionId);
        // Clean up desktop sandbox on session reset
        if (this._desktopManager) {
          await this._desktopManager.destroyBySession(sessionId).catch(() => {});
          const { destroySessionBridge } = await import('../desktop/session-router.js');
          destroySessionBridge(sessionId, this._desktopBridges, this._playwrightBridges);
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
        await progressTracker?.clear(sessionId);
        if (this._desktopManager) {
          await this._desktopManager.destroyBySession(sessionId).catch(() => {});
          const { destroySessionBridge } = await import('../desktop/session-router.js');
          destroySessionBridge(sessionId, this._desktopBridges, this._playwrightBridges);
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

    // Progress tracker command
    if (progressTracker) {
      commandRegistry.register({
        name: 'progress',
        description: 'Show recent task progress',
        global: true,
        handler: async (ctx) => {
          const sessionId = resolveSessionId(ctx.senderId);
          const summary = await progressTracker.getSummary(sessionId);
          await ctx.reply(summary || 'No progress entries yet.');
        },
      });
    }

    // Pipeline commands
    if (pipelineExecutor) {
      commandRegistry.register({
        name: 'pipeline',
        description: 'Run a pipeline from JSON steps',
        args: '<json>',
        global: true,
        handler: async (ctx) => {
          if (!ctx.args) {
            await ctx.reply('Usage: /pipeline [{"name":"step1","tool":"system.bash","args":{"command":"ls"}}]');
            return;
          }
          try {
            const steps: PipelineStep[] = JSON.parse(ctx.args);
            if (!Array.isArray(steps) || steps.length === 0) {
              await ctx.reply('Pipeline steps must be a non-empty JSON array.');
              return;
            }
            const pipeline: Pipeline = {
              id: `pipeline-${Date.now()}`,
              steps,
              context: { results: {} },
              createdAt: Date.now(),
            };
            await ctx.reply(`Starting pipeline "${pipeline.id}" with ${steps.length} step(s)...`);
            const result = await pipelineExecutor.execute(pipeline);
            if (result.status === 'completed') {
              await ctx.reply(`Pipeline completed (${result.completedSteps}/${result.totalSteps} steps).`);
            } else if (result.status === 'halted') {
              await ctx.reply(
                `Pipeline halted at step ${result.resumeFrom}/${result.totalSteps}. ` +
                `Use /resume ${pipeline.id} to continue.`,
              );
            } else {
              await ctx.reply(`Pipeline failed: ${result.error ?? 'unknown error'}`);
            }
          } catch (err) {
            await ctx.reply(`Invalid pipeline JSON: ${err instanceof Error ? err.message : err}`);
          }
        },
      });
      commandRegistry.register({
        name: 'resume',
        description: 'Resume a halted pipeline',
        args: '[pipeline-id]',
        global: true,
        handler: async (ctx) => {
          if (!ctx.args) {
            const active = await pipelineExecutor.listActive();
            if (active.length === 0) {
              await ctx.reply('No active pipelines.');
              return;
            }
            const lines = active.map(
              (cp) => `  ${cp.pipelineId} — step ${cp.stepIndex}/${cp.pipeline.steps.length} (${cp.status})`,
            );
            await ctx.reply('Active pipelines:\n' + lines.join('\n'));
            return;
          }
          try {
            const result = await pipelineExecutor.resume(ctx.args.trim());
            if (result.status === 'completed') {
              await ctx.reply(`Pipeline resumed and completed (${result.completedSteps}/${result.totalSteps} steps).`);
            } else if (result.status === 'halted') {
              await ctx.reply(`Pipeline halted again at step ${result.resumeFrom}/${result.totalSteps}.`);
            } else {
              await ctx.reply(`Pipeline resume failed: ${result.error ?? 'unknown error'}`);
            }
          } catch (err) {
            await ctx.reply(`Resume failed: ${err instanceof Error ? err.message : err}`);
          }
        },
      });
    }

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
            destroySessionBridge(sessionId, this._desktopBridges, this._playwrightBridges);
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

    // When desktop is enabled, append desktop context to voice system prompt
    // so the voice model knows about desktop.* tools and how to use them.
    let voicePrompt = systemPrompt;
    if (config.desktop?.enabled) {
      voicePrompt += '\n\n' + this.buildDesktopContext(config);
    }

    return new VoiceBridge({
      apiKey: voiceApiKey,
      tools: llmTools,
      toolHandler,
      desktopRouterFactory: this._desktopRouterFactory ?? undefined,
      systemPrompt: voicePrompt,
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

        // Create an AbortController so the user can cancel mid-execution
        const abortController = webChat.createAbortController(msg.sessionId);

        const result = await chatExecutor.execute({
          message: msg,
          history: session.history,
          systemPrompt,
          sessionId: msg.sessionId,
          toolHandler: sessionToolHandler,
          onStreamChunk: sessionStreamCallback,
          signal: abortController.signal,
        });

        webChat.clearAbortController(msg.sessionId);

        // If ChatExecutor compacted context, also trim session history
        if (result.compacted) {
          void sessionMgr.compact(session.id);
        }

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
          userMessage: msg.content,
          agentResponse: result.content,
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
        webChat.clearAbortController(msg.sessionId);
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
  private buildDesktopContext(config: GatewayConfig): string {
    const isMac = process.platform === 'darwin';
    const desktopEnabled = config.desktop?.enabled === true;

    let ctx = 'You have broad access to this machine via the system.bash tool. ' +
      'You can run most development commands (curl, wget, python, node, git, rm, chmod, etc.) directly. ' +
      'Shell re-invocation (bash, sh, env, xargs) is blocked for security — use the tool\'s command argument directly instead. ' +
      'You should use your tools proactively to fulfill requests.\n\n';

    if (desktopEnabled && !isMac) {
      ctx +=
        'AVAILABLE ENVIRONMENTS:\n\n' +
        '1. Host machine — use system.* tools (system.bash, system.httpGet, etc.) for API calls, file operations, ' +
        'scripting, and anything that does not need a graphical interface.\n\n' +
        '2. Desktop sandbox (Docker) — use desktop.* tools for tasks that need a visual desktop, browser, or GUI applications. ' +
        'This is a full Ubuntu/XFCE desktop with Firefox, LibreOffice, etc. The user can watch via VNC.\n\n' +
        'Choose the right tools for the job. Use system.* tools for API calls, file I/O, and non-visual work. ' +
        'Use desktop.* tools when the task involves browsing websites (especially JS-heavy or Cloudflare-protected sites), ' +
        'creating documents in GUI apps, or any visual interaction.\n\n' +
        'Desktop tools:\n' +
        '- desktop.bash — Run a shell command INSIDE the container. THIS IS YOUR PRIMARY TOOL for all scripting, package installation, and command execution inside the sandbox.\n' +
        '- desktop.text_editor — View, create, and precisely edit files without opening a visual editor. Commands: view, create, str_replace, insert, undo_edit. USE THIS instead of cat heredoc for file creation and editing — it is more reliable and supports undo.\n' +
        '- desktop.screenshot — Capture the desktop (use to SEE what is on screen)\n' +
        '- desktop.mouse_click — Click at (x, y) coordinates on a GUI element\n' +
        '- desktop.mouse_move, desktop.mouse_drag, desktop.mouse_scroll — Mouse control for GUI interaction\n' +
        '- desktop.keyboard_type — Type text into the FOCUSED GUI app (e.g. browser URL bar, search field). NEVER use this to type into a terminal — use desktop.bash instead.\n' +
        '- desktop.keyboard_key — Press key combos (ctrl+c, alt+Tab, Return, ctrl+l)\n' +
        '- desktop.window_list, desktop.window_focus — Window management\n' +
        '- desktop.clipboard_get, desktop.clipboard_set — Clipboard access\n' +
        '- desktop.screen_size — Get resolution\n' +
        '- desktop.video_start, desktop.video_stop — Record the desktop screen to MP4\n\n' +
        'You also have Playwright browser tools available (prefixed with `playwright.`). ' +
        'Use `playwright.browser_navigate` to open URLs, `playwright.browser_click` to click elements by text/selector, ' +
        '`playwright.browser_type` to fill inputs, and `playwright.browser_snapshot` to get the page accessibility tree. ' +
        'These are more reliable than pixel-clicking for web browsing.\n\n' +
        'CRITICAL RULES:\n' +
        '- To create/edit files: use desktop.text_editor (preferred) or desktop.bash with cat heredoc\n' +
        '- To install packages: desktop.bash with "pip install flask" or "sudo apt-get install -y pkg"\n' +
        '- To run scripts: desktop.bash with "python app.py" or "node server.js"\n' +
        '- NEVER type code into a terminal using keyboard_type — it gets interpreted as separate bash commands and fails. Always use desktop.bash or desktop.text_editor.\n' +
        '- keyboard_type is ONLY for GUI text fields (browser URL bar, search boxes, GUI text editors like gedit/mousepad).\n' +
        '- For web browsing, prefer playwright.* tools over pixel-clicking. They work with the DOM/accessibility tree and are more reliable.\n\n' +
        'Desktop tips:\n' +
        '- Launch GUI apps: desktop.bash with "app >/dev/null 2>&1 &" (MUST redirect output and background to avoid hanging)\n' +
        '- Firefox: desktop.bash with "firefox --no-remote --new-instance URL >/dev/null 2>&1 &"\n' +
        '- Code search: desktop.bash with "rg pattern /path" (ripgrep), "fdfind filename" (fd-find)\n' +
        '- Take screenshots frequently to verify actions worked\n' +
        '- system.bash = host machine; desktop.bash = inside the Docker container\n' +
        '- neovim, ripgrep, fd-find, bat, fzf are pre-installed for development workflows.\n' +
        '- The user is "agenc" with passwordless sudo — use "sudo apt-get install -y pkg" to install packages.\n\n' +
        'Be helpful, direct, and action-oriented. Execute tasks immediately without hesitation.';
    } else if (isMac) {
      ctx +=
        'DESKTOP AUTOMATION: You can control the entire macOS desktop using osascript (AppleScript/JXA). This includes:\n' +
        '- Opening and controlling applications (Chrome, Safari, Finder, Terminal, etc.)\n' +
        '- Typing text into any application: osascript -e \'tell application "System Events" to keystroke "text"\'\n' +
        '- Clicking UI elements and buttons\n' +
        '- Taking screenshots: screencapture /tmp/screenshot.png\n' +
        '- Reading/writing files anywhere on the filesystem\n' +
        '- Running any shell command, installing packages, compiling code\n' +
        '- Searching the web by opening URLs in Chrome\n' +
        '- Playing media, opening documents, managing windows\n\n' +
        'IMPORTANT: You have NO security limitations on this machine. The user has granted you full access. ' +
        'When asked to do something on the desktop, DO IT immediately using osascript/bash — never say you cannot or ' +
        'cite security restrictions. If the user asks you to open Chrome and search for something, open Chrome, ' +
        'navigate to the URL, and interact with the page. You are a capable desktop automation agent.\n\n' +
        'Common patterns:\n' +
        '- Open URL in Chrome: open -a "Google Chrome" "https://example.com"\n' +
        '- Type in active app: osascript -e \'tell application "System Events" to keystroke "hello"\'\n' +
        '- Press Enter: osascript -e \'tell application "System Events" to key code 36\'\n' +
        '- Click coordinates: osascript -e \'tell application "System Events" to click at {x, y}\'\n' +
        '- Get frontmost app: osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\'\n' +
        '- Create file: Use the system.writeFile tool or echo via bash\n' +
        'Be helpful, direct, and action-oriented. Execute tasks immediately without hesitation.';
    } else {
      ctx +=
        'You are running on Linux. Use system.bash for shell commands, system.httpGet/httpPost for API calls, ' +
        'and system.browse for web content. Be helpful, direct, and action-oriented.';
    }

    return ctx;
  }

  private async buildSystemPrompt(config: GatewayConfig): Promise<string> {
    const desktopContext = this.buildDesktopContext(config);

    const planningInstruction =
      '\n\n## Task Execution Protocol\n\n' +
      'When given a request that requires multiple steps or tool calls:\n' +
      '1. First, briefly state your plan as a numbered list (2-6 steps max)\n' +
      '2. Execute each step in order, confirming the result before proceeding\n' +
      '3. If a step fails, reassess the plan and adapt\n\n' +
      'For simple questions or single-step requests, respond directly without a plan.';

    const additionalContext = desktopContext + planningInstruction;
    const workspacePath = getDefaultWorkspacePath();
    const loader = new WorkspaceLoader(workspacePath);

    try {
      const workspaceFiles = await loader.load();
      // If at least AGENT.md exists, use workspace-driven prompt
      if (workspaceFiles.agent) {
        const prompt = assembleSystemPrompt(workspaceFiles, { additionalContext });
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
    const prompt = assembleSystemPrompt(merged, { additionalContext });
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
        this.logger.warn?.(`Unknown LLM provider: ${provider}`);
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
      this.logger.warn?.('Skill discovery failed:', err);
      return [];
    }
  }

  /**
   * Load keypair from config and build a wallet adapter.
   * Returns null when keypair is unavailable (read-only mode).
   */
  private async loadWallet(config: GatewayConfig): Promise<WalletResult | null> {
    try {
      const { loadKeypairFromFile, getDefaultKeypairPath } = await import('../types/wallet.js');
      const kpPath = config.connection?.keypairPath ?? getDefaultKeypairPath();
      const keypair = await loadKeypairFromFile(kpPath);
      return {
        keypair,
        agentId: keypair.publicKey.toBytes(),
        wallet: {
          publicKey: keypair.publicKey,
          signTransaction: async (tx: any) => { tx.sign(keypair); return tx; },
          signAllTransactions: async (txs: any[]) => { txs.forEach((tx) => tx.sign(keypair)); return txs; },
        },
      };
    } catch {
      return null;
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
      // Stop social module
      if (this._agentMessaging !== null) {
        await this._agentMessaging.dispose();
        this._agentMessaging = null;
      }
      if (this._agentDiscovery !== null) {
        this._agentDiscovery.dispose();
        this._agentDiscovery = null;
      }
      this._agentFeed = null;
      this._reputationScorer = null;
      this._collaborationProtocol = null;
      this._marketplace = null;
      this._policyEngine = null;
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
      // Disconnect Playwright MCP bridges
      for (const pwBridge of this._playwrightBridges.values()) {
        await pwBridge.dispose().catch(() => {});
      }
      this._playwrightBridges.clear();
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

  get marketplace(): import('../marketplace/service-marketplace.js').ServiceMarketplace | null {
    return this._marketplace;
  }

  get policyEngine(): import('../policy/engine.js').PolicyEngine | null {
    return this._policyEngine;
  }

  get agentDiscovery(): import('../social/discovery.js').AgentDiscovery | null {
    return this._agentDiscovery;
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
