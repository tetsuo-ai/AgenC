/**
 * External channel wiring — extracted from daemon.ts.
 *
 * Standalone functions that wire Telegram and other external channel plugins
 * (Discord, Slack, WhatsApp, Signal, Matrix, iMessage) into the ChatExecutor
 * pipeline.
 *
 * @module
 */

import type { ChatExecutor, ChatToolRoutingSummary } from "../llm/chat-executor.js";
import type { LLMMessage, ToolHandler } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import { isRecord } from "../utils/type-guards.js";
import type { GatewayConfig } from "./types.js";
import type { ResolvedTraceLoggingConfig } from "./daemon-trace.js";
import {
  logTraceEvent,
  logTraceErrorEvent,
  resolveTraceLoggingConfig,
  summarizeGatewayMessageForTrace,
  truncateToolLogText,
  createTurnTraceId,
} from "./daemon-trace.js";
import { summarizeLLMFailureForSurface } from "./daemon-llm-failure.js";
import type { GatewayMessage } from "./message.js";
import { SessionManager } from "./session.js";
import type { ChannelPlugin } from "./channel.js";
import type { Gateway } from "./gateway.js";
import { TelegramChannel } from "../channels/telegram/plugin.js";
import { DiscordChannel } from "../channels/discord/plugin.js";
import { SlackChannel } from "../channels/slack/plugin.js";
import { WhatsAppChannel } from "../channels/whatsapp/plugin.js";
import { SignalChannel } from "../channels/signal/plugin.js";
import { MatrixChannel } from "../channels/matrix/plugin.js";
import { formatForChannel } from "./format.js";
import { executeTextChannelTurn } from "./daemon-text-channel-turn.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import { loadConfiguredPluginChannel } from "../plugins/channel-loader.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHANNEL_SESSION_CONFIG = {
  scope: "per-channel-peer" as const,
  reset: { mode: "idle" as const, idleMinutes: 30 },
  compaction: "truncate" as const,
  maxHistoryLength: 100,
};

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

/**
 * Shared dependencies that external-channel wiring needs from the Daemon.
 * The daemon passes an object satisfying this interface so the extracted
 * functions do not reference `this`.
 */
export interface ChannelWiringDeps {
  readonly gateway: Gateway | null;
  readonly logger: Logger;
  readonly chatExecutor: ChatExecutor | null;
  readonly memoryBackend: MemoryBackend | null;
  readonly defaultForegroundMaxToolRounds: number;

  buildSystemPrompt(
    config: GatewayConfig,
    options?: { forVoice?: boolean },
  ): Promise<string>;

  handleTextChannelApprovalCommand(params: {
    msg: GatewayMessage;
    send: (content: string) => Promise<void>;
  }): Promise<boolean>;

  registerTextApprovalDispatcher(
    sessionId: string,
    channelName: string,
    send: (content: string) => Promise<void>,
  ): () => void;

  createTextChannelSessionToolHandler(params: {
    sessionId: string;
    channelName: string;
    send: (content: string) => Promise<void>;
    traceConfig: ResolvedTraceLoggingConfig;
    traceId: string;
  }): ToolHandler;

  buildToolRoutingDecision(
    sessionId: string,
    content: string,
    history: readonly LLMMessage[],
  ): ToolRoutingDecision | undefined;

  recordToolRoutingOutcome(
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ): void;
}

// ---------------------------------------------------------------------------
// External channel registry
// ---------------------------------------------------------------------------

export type ExternalChannelRegistry = Map<string, ChannelPlugin>;

function isChannelConfigEnabled(config: unknown): boolean {
  return isRecord(config) && config.enabled !== false;
}

function isPluginChannelConfig(config: unknown): config is {
  readonly type: "plugin";
  readonly config?: Record<string, unknown>;
} {
  return isRecord(config) && config.type === "plugin";
}

async function registerGatewayChannel(
  gateway: Gateway | null,
  channel: ChannelPlugin,
): Promise<void> {
  if (!gateway) return;
  try {
    gateway.registerChannel(channel);
  } catch (error) {
    try {
      await channel.stop();
    } catch {
      // Best-effort cleanup after failed registration.
    }
    throw error;
  }
}

async function stopExternalChannelRegistry(
  channels: ExternalChannelRegistry,
  logger: Logger,
): Promise<void> {
  const entries = [...channels.entries()].reverse();
  for (const [name, channel] of entries) {
    try {
      await channel.stop();
    } catch (error) {
      logger.warn?.(`Failed to stop external channel '${name}' during rollback:`, error);
    }
  }
  channels.clear();
}

// ---------------------------------------------------------------------------
// wireTelegram
// ---------------------------------------------------------------------------

export async function wireTelegram(
  config: GatewayConfig,
  deps: ChannelWiringDeps,
): Promise<TelegramChannel | null> {
  const telegramConfig = config.channels?.telegram;
  if (!telegramConfig || !isChannelConfigEnabled(telegramConfig)) return null;

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
  const systemPrompt = await deps.buildSystemPrompt(config);

  // Telegram allowlist: only these user IDs can interact with the bot.
  // Empty array = allow everyone. Populated = restrict to listed IDs.
  const telegramAllowedUsers: string[] = (
    (telegramConfig.allowedUsers as string[]) ?? []
  ).map(String);

  const onMessage = async (msg: GatewayMessage): Promise<void> => {
    const turnTraceId = createTurnTraceId(msg);
    const traceConfig = resolveTraceLoggingConfig(
      deps.gateway?.config.logging ?? config.logging,
    );
    if (traceConfig.enabled) {
      logTraceEvent(
        deps.logger,
        "telegram.inbound",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          message: summarizeGatewayMessageForTrace(msg, traceConfig.maxChars),
        },
        traceConfig.maxChars,
      );
    }

    deps.logger.info("Telegram message received", {
      traceId: turnTraceId,
      senderId: msg.senderId,
      sessionId: msg.sessionId,
      contentLength: msg.content.length,
      contentPreview: msg.content.slice(0, 50),
    });
    if (!msg.content.trim()) return;

    // Enforce allowlist if configured
    if (
      telegramAllowedUsers.length > 0 &&
      !telegramAllowedUsers.includes(msg.senderId)
    ) {
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

    const sendTelegramText = async (content: string): Promise<void> => {
      await telegram.send({
        sessionId: msg.sessionId,
        content: escapeHtml(content),
      });
    };
    if (
      await deps.handleTextChannelApprovalCommand({
        msg,
        send: sendTelegramText,
      })
    ) {
      return;
    }

    const chatExecutor = deps.chatExecutor;
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
    const unregisterTextApproval = deps.registerTextApprovalDispatcher(
      msg.sessionId,
      "telegram",
      sendTelegramText,
    );

    try {
      const toolHandler = deps.createTextChannelSessionToolHandler({
        sessionId: msg.sessionId,
        channelName: "telegram",
        send: sendTelegramText,
        traceConfig,
        traceId: turnTraceId,
      });

      const result = await executeTextChannelTurn({
        logger: deps.logger,
        channelName: "telegram",
        msg,
        session,
        sessionMgr,
        systemPrompt,
        chatExecutor,
        toolHandler,
        defaultMaxToolRounds: deps.defaultForegroundMaxToolRounds,
        traceConfig,
        turnTraceId,
        memoryBackend: deps.memoryBackend,
        includeTraceArtifacts: true,
        includePlannerSummaryInTrace: true,
        buildToolRoutingDecision: (sessionId, content, history) =>
          deps.buildToolRoutingDecision(sessionId, content, history),
        recordToolRoutingOutcome: (sessionId, summary) => {
          deps.recordToolRoutingOutcome(sessionId, summary);
        },
      });

      deps.logger.debug("Telegram reply ready", {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        contentLength: (result.content || "").length,
        contentPreview: (result.content || "(no response)").slice(0, 200),
      });
      try {
        await telegram.send({
          sessionId: msg.sessionId,
          content: escapeHtml(result.content || "(no response)"),
        });
        deps.logger.debug("Telegram reply sent successfully");
      } catch (sendErr) {
        deps.logger.error("Telegram send failed:", sendErr);
      }

      // Persist to memory
      if (deps.memoryBackend) {
        try {
          await deps.memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: "user",
            content: msg.content,
          });
          await deps.memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: "assistant",
            content: result.content,
          });
        } catch {
          // non-critical
        }
      }
    } catch (error) {
      const failure = summarizeLLMFailureForSurface(error);
      if (traceConfig.enabled) {
        logTraceErrorEvent(
          deps.logger,
          "telegram.chat.error",
          {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            stopReason: failure.stopReason,
            stopReasonDetail: failure.stopReasonDetail,
            error: toErrorMessage(error),
            ...(error instanceof Error && error.stack
              ? {
                  stack: truncateToolLogText(
                    error.stack,
                    traceConfig.maxChars,
                  ),
                }
              : {}),
          },
          traceConfig.maxChars,
        );
      }
      deps.logger.error("Telegram LLM error:", {
        stopReason: failure.stopReason,
        stopReasonDetail: failure.stopReasonDetail,
        error: toErrorMessage(error),
      });
      await telegram.send({
        sessionId: msg.sessionId,
        content: `\u{274C} ${escapeHtml(failure.userMessage)}`,
      });
    } finally {
      unregisterTextApproval();
    }
  };

  await telegram.initialize({
    onMessage,
    logger: deps.logger,
    config: telegramConfig as unknown as Record<string, unknown>,
  });
  await telegram.start();
  await registerGatewayChannel(deps.gateway, telegram);
  deps.logger.info("Telegram channel wired");
  return telegram;
}

// ---------------------------------------------------------------------------
// wireExternalChannel
// ---------------------------------------------------------------------------

export async function wireExternalChannel(
  channel: ChannelPlugin,
  channelName: string,
  config: GatewayConfig,
  channelConfig: Record<string, unknown>,
  deps: ChannelWiringDeps,
): Promise<void> {
  const sessionMgr = new SessionManager(DEFAULT_CHANNEL_SESSION_CONFIG);
  const systemPrompt = await deps.buildSystemPrompt(config);

  const onMessage = async (msg: GatewayMessage): Promise<void> => {
    const turnTraceId = createTurnTraceId(msg);
    const traceConfig = resolveTraceLoggingConfig(
      deps.gateway?.config.logging ?? config.logging,
    );
    if (traceConfig.enabled) {
      logTraceEvent(
        deps.logger,
        `${channelName}.inbound`,
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          message: summarizeGatewayMessageForTrace(msg, traceConfig.maxChars),
        },
        traceConfig.maxChars,
      );
    }
    if (!msg.content.trim()) return;

    const sendChannelText = async (content: string): Promise<void> => {
      const formatted = formatForChannel(content, channelName);
      await channel.send({ sessionId: msg.sessionId, content: formatted });
    };
    if (
      await deps.handleTextChannelApprovalCommand({
        msg,
        send: sendChannelText,
      })
    ) {
      return;
    }

    const chatExecutor = deps.chatExecutor;
    if (!chatExecutor) {
      await sendChannelText("No LLM provider configured.");
      return;
    }

    const session = sessionMgr.getOrCreate({
      channel: channelName,
      senderId: msg.senderId,
      scope: msg.scope,
      workspaceId: "default",
    });
    const unregisterTextApproval = deps.registerTextApprovalDispatcher(
      msg.sessionId,
      channelName,
      sendChannelText,
    );

    try {
      const toolHandler = deps.createTextChannelSessionToolHandler({
        sessionId: msg.sessionId,
        channelName,
        send: sendChannelText,
        traceConfig,
        traceId: turnTraceId,
      });

      const result = await executeTextChannelTurn({
        logger: deps.logger,
        channelName,
        msg,
        session,
        sessionMgr,
        systemPrompt,
        chatExecutor,
        toolHandler,
        defaultMaxToolRounds: deps.defaultForegroundMaxToolRounds,
        traceConfig,
        turnTraceId,
        memoryBackend: deps.memoryBackend,
        buildToolRoutingDecision: (sessionId, content, history) =>
          deps.buildToolRoutingDecision(sessionId, content, history),
        recordToolRoutingOutcome: (sessionId, summary) => {
          deps.recordToolRoutingOutcome(sessionId, summary);
        },
      });

      const formatted = formatForChannel(
        result.content || "(no response)",
        channelName,
      );
      await channel.send({ sessionId: msg.sessionId, content: formatted });

      if (deps.memoryBackend) {
        try {
          await deps.memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: "user",
            content: msg.content,
          });
          await deps.memoryBackend.addEntry({
            sessionId: msg.sessionId,
            role: "assistant",
            content: result.content,
          });
        } catch {
          /* non-critical */
        }
      }
    } catch (error) {
      const failure = summarizeLLMFailureForSurface(error);
      if (traceConfig.enabled) {
        logTraceErrorEvent(
          deps.logger,
          `${channelName}.chat.error`,
          {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            stopReason: failure.stopReason,
            stopReasonDetail: failure.stopReasonDetail,
            error: toErrorMessage(error),
            ...(error instanceof Error && error.stack
              ? {
                  stack: truncateToolLogText(
                    error.stack,
                    traceConfig.maxChars,
                  ),
                }
              : {}),
          },
          traceConfig.maxChars,
        );
      }
      deps.logger.error(`${channelName} LLM error:`, {
        stopReason: failure.stopReason,
        stopReasonDetail: failure.stopReasonDetail,
        error: toErrorMessage(error),
      });
      const errMsg = formatForChannel(failure.userMessage, channelName);
      await channel.send({ sessionId: msg.sessionId, content: errMsg });
    } finally {
      unregisterTextApproval();
    }
  };

  await channel.initialize({
    onMessage,
    logger: deps.logger,
    config: channelConfig,
  });
  await channel.start();
  await registerGatewayChannel(deps.gateway, channel);
  deps.logger.info(`${channelName} channel wired`);
}

// ---------------------------------------------------------------------------
// wireExternalChannels
// ---------------------------------------------------------------------------

/**
 * Wire all enabled external channels (Telegram, Discord, Slack, WhatsApp,
 * Signal, Matrix, iMessage) into one registry map.
 */
export async function wireExternalChannels(
  config: GatewayConfig,
  deps: ChannelWiringDeps,
): Promise<ExternalChannelRegistry> {
  const channels = config.channels ?? {};
  const result: ExternalChannelRegistry = new Map();
  try {
    const telegram = await wireTelegram(config, deps);
    if (telegram) {
      result.set("telegram", telegram);
    }

    // Standard channel plugins — identical wiring pattern
    const standardChannels: Array<{
      key: string;
      name: string;
      create: (cfg: unknown) => ChannelPlugin;
    }> = [
      {
        key: "discord",
        name: "discord",
        create: (cfg) =>
          new DiscordChannel(
            cfg as ConstructorParameters<typeof DiscordChannel>[0],
          ),
      },
      {
        key: "slack",
        name: "slack",
        create: (cfg) =>
          new SlackChannel(
            cfg as ConstructorParameters<typeof SlackChannel>[0],
          ),
      },
      {
        key: "whatsapp",
        name: "whatsapp",
        create: (cfg) =>
          new WhatsAppChannel(
            cfg as ConstructorParameters<typeof WhatsAppChannel>[0],
          ),
      },
      {
        key: "signal",
        name: "signal",
        create: (cfg) =>
          new SignalChannel(
            cfg as ConstructorParameters<typeof SignalChannel>[0],
          ),
      },
      {
        key: "matrix",
        name: "matrix",
        create: (cfg) =>
          new MatrixChannel(
            cfg as ConstructorParameters<typeof MatrixChannel>[0],
          ),
      },
    ];

    for (const { key, name, create } of standardChannels) {
      if (!channels[key] || !isChannelConfigEnabled(channels[key])) continue;
      const plugin = create(channels[key]);
      await wireExternalChannel(
        plugin,
        name,
        config,
        channels[key] as unknown as Record<string, unknown>,
        deps,
      );
      result.set(name, plugin);
    }

    // iMessage: macOS only, lazy-loaded
    if (channels.imessage && isChannelConfigEnabled(channels.imessage)) {
      if (process.platform !== "darwin") {
        throw new Error("iMessage channel requires macOS");
      }
      const { IMessageChannel } =
        await import("../channels/imessage/plugin.js");
      const imessage = new IMessageChannel();
      await wireExternalChannel(
        imessage,
        "imessage",
        config,
        channels.imessage as unknown as Record<string, unknown>,
        deps,
      );
      result.set("imessage", imessage);
    }

    for (const [channelName, channelConfig] of Object.entries(channels)) {
      if (
        !isChannelConfigEnabled(channelConfig) ||
        !isPluginChannelConfig(channelConfig)
      ) {
        continue;
      }

      const loaded = await loadConfiguredPluginChannel({
        channelName,
        channelConfig,
        trustedPackages: config.plugins?.trustedPackages,
      });
      await wireExternalChannel(
        loaded.channel,
        loaded.manifest.channel_name,
        config,
        (channelConfig.config ?? {}) as Record<string, unknown>,
        deps,
      );
      result.set(loaded.manifest.channel_name, loaded.channel);
    }

    return result;
  } catch (error) {
    await stopExternalChannelRegistry(result, deps.logger);
    throw error;
  }
}
