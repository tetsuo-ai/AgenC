import { WebChatChannel } from "../channels/webchat/plugin.js";
import type {
  ChatExecutor,
  ChatExecutorResult,
  ChatToolRoutingSummary,
} from "../llm/chat-executor.js";
import type { ChatExecutionTraceEvent } from "../llm/chat-executor-types.js";
import type {
  LLMProviderTraceEvent,
  StreamProgressCallback,
  ToolHandler,
} from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import { buildChatUsagePayload } from "./chat-usage.js";
import { summarizeLLMFailureForSurface } from "./daemon-llm-failure.js";
import {
  buildSessionStatefulOptions,
  persistSessionStatefulContinuation,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  logExecutionTraceEvent,
  logProviderPayloadTraceEvent,
  logTraceErrorEvent,
  logTraceEvent,
  summarizeCallUsageForTrace,
  summarizeHistoryForTrace,
  summarizeInitialRequestShape,
  summarizeRoleCounts,
  summarizeToolArgsForLog,
  summarizeToolFailureForLog,
  summarizeToolResultForTrace,
  summarizeToolRoutingDecisionForTrace,
  summarizeToolRoutingSummaryForTrace,
  summarizeTraceValue,
  truncateToolLogText,
  type ResolvedTraceLoggingConfig,
  type ToolFailureSummary,
} from "./daemon-trace.js";
import type { HookDispatcher } from "./hooks.js";
import type { GatewayMessage } from "./message.js";
import type { Session, SessionManager } from "./session.js";
import type { ToolRoutingDecision } from "./tool-routing.js";

export interface WebChatTurnSignals {
  signalThinking: (sessionId: string) => void;
  signalIdle: (sessionId: string) => void;
}

export interface ExecuteWebChatConversationTurnParams {
  readonly logger: Logger;
  readonly msg: GatewayMessage;
  readonly webChat: WebChatChannel;
  readonly chatExecutor: ChatExecutor;
  readonly sessionMgr: SessionManager;
  readonly getSystemPrompt: () => string;
  readonly sessionToolHandler: ToolHandler;
  readonly sessionStreamCallback: StreamProgressCallback;
  readonly signals: WebChatTurnSignals;
  readonly hooks: HookDispatcher;
  readonly memoryBackend: MemoryBackend;
  readonly sessionTokenBudget: number;
  readonly contextWindowTokens?: number;
  readonly traceConfig: ResolvedTraceLoggingConfig;
  readonly turnTraceId: string;
  readonly buildToolRoutingDecision: (
    sessionId: string,
    content: string,
    history: Session["history"],
  ) => ToolRoutingDecision | undefined;
  readonly recordToolRoutingOutcome: (
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ) => void;
  readonly getSessionTokenUsage: (sessionId: string) => number;
  readonly onModelInfo?: (result: ChatExecutorResult) => void;
  readonly onSubagentSynthesis?: (result: ChatExecutorResult) => void;
}

export async function executeWebChatConversationTurn(
  params: ExecuteWebChatConversationTurnParams,
): Promise<void> {
  const {
    logger,
    msg,
    webChat,
    chatExecutor,
    sessionMgr,
    getSystemPrompt,
    sessionToolHandler,
    sessionStreamCallback,
    signals,
    hooks,
    memoryBackend,
    sessionTokenBudget,
    contextWindowTokens,
    traceConfig,
    turnTraceId,
    buildToolRoutingDecision,
    recordToolRoutingOutcome,
    getSessionTokenUsage,
    onModelInfo,
    onSubagentSynthesis,
  } = params;

  try {
    signals.signalThinking(msg.sessionId);

    const session = sessionMgr.getOrCreate({
      channel: "webchat",
      senderId: msg.sessionId,
      scope: "dm",
      workspaceId: "default",
    });

    if (traceConfig.enabled) {
      const currentPrompt = getSystemPrompt();
      const requestTracePayload = {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        historyLength: session.history.length,
        historyRoleCounts: summarizeRoleCounts(session.history),
        systemPromptChars: currentPrompt.length,
        ...(traceConfig.includeSystemPrompt
          ? {
              systemPrompt: truncateToolLogText(
                currentPrompt,
                traceConfig.maxChars,
              ),
            }
          : {}),
        ...(traceConfig.includeHistory
          ? {
              history: summarizeHistoryForTrace(session.history, traceConfig),
            }
          : {}),
      };
      logTraceEvent(
        logger,
        "webchat.chat.request",
        requestTracePayload,
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            historyLength: session.history.length,
            historyRoleCounts: summarizeRoleCounts(session.history),
            systemPromptChars: currentPrompt.length,
            ...(traceConfig.includeSystemPrompt
              ? { systemPrompt: currentPrompt }
              : {}),
            ...(traceConfig.includeHistory ? { history: session.history } : {}),
          },
        },
      );
    }

    const toolRoutingDecision = buildToolRoutingDecision(
      msg.sessionId,
      msg.content,
      session.history,
    );
    if (traceConfig.enabled && toolRoutingDecision) {
      logTraceEvent(
        logger,
        "webchat.tool_routing",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          routing: summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
        },
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            routing: toolRoutingDecision,
          },
        },
      );
    }

    const abortController = webChat.createAbortController(msg.sessionId);
    const sessionStateful = buildSessionStatefulOptions(session);

    const result = await chatExecutor.execute({
      message: msg,
      history: session.history,
      systemPrompt: getSystemPrompt(),
      sessionId: msg.sessionId,
      toolHandler: sessionToolHandler,
      onStreamChunk: sessionStreamCallback,
      signal: abortController.signal,
      ...(sessionStateful ? { stateful: sessionStateful } : {}),
      toolRouting: toolRoutingDecision
        ? {
            routedToolNames: toolRoutingDecision.routedToolNames,
            expandedToolNames: toolRoutingDecision.expandedToolNames,
            expandOnMiss: true,
          }
        : undefined,
      ...(traceConfig.enabled
        ? {
            trace: {
              ...(traceConfig.includeProviderPayloads
                ? {
                    includeProviderPayloads: true,
                    onProviderTraceEvent: (event: LLMProviderTraceEvent) => {
                      logProviderPayloadTraceEvent({
                        logger,
                        channelName: "webchat",
                        traceId: turnTraceId,
                        sessionId: msg.sessionId,
                        traceConfig,
                        event,
                      });
                    },
                  }
                : {}),
              onExecutionTraceEvent: (event: ChatExecutionTraceEvent) => {
                logExecutionTraceEvent({
                  logger,
                  channelName: "webchat",
                  traceId: turnTraceId,
                  sessionId: msg.sessionId,
                  traceConfig,
                  event,
                });
              },
            },
          }
        : {}),
    });
    recordToolRoutingOutcome(msg.sessionId, result.toolRoutingSummary);

    webChat.clearAbortController(msg.sessionId);
    onModelInfo?.(result);

    if (traceConfig.enabled) {
      const responseTracePayload = {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        provider: result.provider,
        model: result.model,
        usedFallback: result.usedFallback,
        durationMs: result.durationMs,
        compacted: result.compacted,
        tokenUsage: result.tokenUsage,
        requestShape: summarizeInitialRequestShape(result.callUsage),
        callUsage: summarizeCallUsageForTrace(result.callUsage),
        statefulSummary: result.statefulSummary,
        plannerSummary: result.plannerSummary,
        toolRoutingDecision:
          summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
        toolRoutingSummary: summarizeToolRoutingSummaryForTrace(
          result.toolRoutingSummary,
        ),
        stopReason: result.stopReason,
        stopReasonDetail: result.stopReasonDetail,
        response: truncateToolLogText(result.content, traceConfig.maxChars),
        toolCalls: result.toolCalls.map((toolCall) => ({
          name: toolCall.name,
          durationMs: toolCall.durationMs,
          isError: toolCall.isError,
          ...(traceConfig.includeToolArgs
            ? {
                args:
                  summarizeToolArgsForLog(toolCall.name, toolCall.args) ??
                  summarizeTraceValue(toolCall.args, traceConfig.maxChars),
              }
            : {}),
          ...(traceConfig.includeToolResults
            ? {
                result: summarizeToolResultForTrace(
                  toolCall.result,
                  traceConfig.maxChars,
                ),
              }
            : {}),
        })),
      };
      logTraceEvent(
        logger,
        "webchat.chat.response",
        responseTracePayload,
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            provider: result.provider,
            model: result.model,
            usedFallback: result.usedFallback,
            durationMs: result.durationMs,
            compacted: result.compacted,
            tokenUsage: result.tokenUsage,
            requestShape: summarizeInitialRequestShape(result.callUsage),
            callUsage: result.callUsage,
            statefulSummary: result.statefulSummary,
            plannerSummary: result.plannerSummary,
            toolRoutingDecision,
            toolRoutingSummary: result.toolRoutingSummary,
            stopReason: result.stopReason,
            stopReasonDetail: result.stopReasonDetail,
            response: result.content,
            toolCalls: result.toolCalls.map((toolCall) => ({
              name: toolCall.name,
              durationMs: toolCall.durationMs,
              isError: toolCall.isError,
              ...(traceConfig.includeToolArgs ? { args: toolCall.args } : {}),
              ...(traceConfig.includeToolResults
                ? { result: toolCall.result }
                : {}),
            })),
          },
        },
      );
    }
    if ((result.statefulSummary?.fallbackCalls ?? 0) > 0) {
      logger.warn("[stateful] webchat fallback_to_stateless", {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        summary: result.statefulSummary,
      });
    }

    persistSessionStatefulContinuation(session, result);
    if (result.compacted) {
      await sessionMgr.compact(session.id);
    }
    await persistWebSessionRuntimeState(memoryBackend, msg.sessionId, session);

    signals.signalIdle(msg.sessionId);
    sessionMgr.appendMessage(session.id, {
      role: "user",
      content: msg.content,
    });
    sessionMgr.appendMessage(session.id, {
      role: "assistant",
      content: result.content,
    });

    await webChat.send({
      sessionId: msg.sessionId,
      content: result.content || "(no response)",
    });

    webChat.pushToSession(msg.sessionId, {
      type: "chat.usage",
      payload: buildChatUsagePayload({
        totalTokens: getSessionTokenUsage(msg.sessionId),
        sessionTokenBudget,
        compacted: result.compacted ?? false,
        contextWindowTokens,
        callUsage: result.callUsage,
      }),
    });

    onSubagentSynthesis?.(result);

    webChat.broadcastEvent("chat.response", { sessionId: msg.sessionId });

    await hooks.dispatch("message:outbound", {
      sessionId: msg.sessionId,
      content: result.content,
      provider: result.provider,
      userMessage: msg.content,
      agentResponse: result.content,
    });

    try {
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "user",
        content: msg.content,
      });
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "assistant",
        content: result.content,
      });
    } catch (error) {
      logger.warn?.("Failed to persist messages to memory:", error);
    }

    if (result.toolCalls.length > 0) {
      const failures = result.toolCalls
        .map((toolCall) => summarizeToolFailureForLog(toolCall))
        .filter((entry): entry is ToolFailureSummary => entry !== null);

      logger.info(`Chat used ${result.toolCalls.length} tool call(s)`, {
        traceId: turnTraceId,
        tools: result.toolCalls.map((toolCall) => toolCall.name),
        provider: result.provider,
        failedToolCalls: failures.length,
        ...(failures.length > 0 ? { failureDetails: failures } : {}),
      });
    }
  } catch (error) {
    const failure = summarizeLLMFailureForSurface(error);
    webChat.clearAbortController(msg.sessionId);
    signals.signalIdle(msg.sessionId);
    if (traceConfig.enabled) {
      logTraceErrorEvent(
        logger,
        "webchat.chat.error",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          stopReason: failure.stopReason,
          stopReasonDetail: failure.stopReasonDetail,
          error: toErrorMessage(error),
          ...(error instanceof Error && error.stack
            ? {
                stack: truncateToolLogText(error.stack, traceConfig.maxChars),
              }
            : {}),
        },
        traceConfig.maxChars,
      );
    }
    logger.error("LLM chat error:", {
      stopReason: failure.stopReason,
      stopReasonDetail: failure.stopReasonDetail,
      error: toErrorMessage(error),
    });
    await webChat.send({
      sessionId: msg.sessionId,
      content: failure.userMessage,
    });
  }
}
