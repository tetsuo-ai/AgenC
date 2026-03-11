import type {
  ChatExecutor,
  ChatExecutorResult,
  ChatToolRoutingSummary,
} from "../llm/chat-executor.js";
import type {
  LLMProviderTraceEvent,
  ToolHandler,
} from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import type { ChatExecutionTraceEvent } from "../llm/chat-executor-types.js";
import type { GatewayMessage } from "./message.js";
import type { Session, SessionManager } from "./session.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import { resolveTurnMaxToolRounds } from "./tool-round-budget.js";
import {
  buildSessionStatefulOptions,
  persistSessionStatefulContinuation,
} from "./daemon-session-state.js";
import { filterSystemPromptForToolRouting } from "./system-prompt-routing.js";
import {
  logExecutionTraceEvent,
  logProviderPayloadTraceEvent,
  logTraceEvent,
  summarizeCallUsageForTrace,
  summarizeHistoryForTrace,
  summarizeInitialRequestShape,
  summarizeRoleCounts,
  summarizeToolArgsForLog,
  summarizeToolResultForTrace,
  summarizeToolRoutingDecisionForTrace,
  summarizeToolRoutingSummaryForTrace,
  summarizeTraceValue,
  truncateToolLogText,
  type ResolvedTraceLoggingConfig,
} from "./daemon-trace.js";

export interface ExecuteTextChannelTurnParams {
  readonly logger: Logger;
  readonly channelName: string;
  readonly msg: GatewayMessage;
  readonly session: Session;
  readonly sessionMgr: SessionManager;
  readonly systemPrompt: string;
  readonly chatExecutor: ChatExecutor;
  readonly toolHandler: ToolHandler;
  readonly defaultMaxToolRounds: number;
  readonly traceConfig: ResolvedTraceLoggingConfig;
  readonly turnTraceId: string;
  readonly memoryBackend?: MemoryBackend | null;
  readonly includeTraceArtifacts?: boolean;
  readonly includePlannerSummaryInTrace?: boolean;
  readonly buildToolRoutingDecision: (
    sessionId: string,
    content: string,
    history: Session["history"],
  ) => ToolRoutingDecision | undefined;
  readonly recordToolRoutingOutcome: (
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ) => void;
}

export async function executeTextChannelTurn(
  params: ExecuteTextChannelTurnParams,
): Promise<ChatExecutorResult> {
  const {
    logger,
    channelName,
    msg,
    session,
    sessionMgr,
    systemPrompt,
    chatExecutor,
    toolHandler,
    defaultMaxToolRounds,
    traceConfig,
    turnTraceId,
    memoryBackend,
    includeTraceArtifacts = false,
    includePlannerSummaryInTrace = false,
    buildToolRoutingDecision,
    recordToolRoutingOutcome,
  } = params;

  const toolRoutingDecision = buildToolRoutingDecision(
    msg.sessionId,
    msg.content,
    session.history,
  );
  const effectiveSystemPrompt = filterSystemPromptForToolRouting({
    systemPrompt,
    routedToolNames: toolRoutingDecision?.routedToolNames,
  });

  if (traceConfig.enabled) {
    const requestTracePayload = {
      traceId: turnTraceId,
      sessionId: msg.sessionId,
      historyLength: session.history.length,
      historyRoleCounts: summarizeRoleCounts(session.history),
      systemPromptChars: effectiveSystemPrompt.length,
      ...(traceConfig.includeSystemPrompt
        ? {
            systemPrompt: truncateToolLogText(
              effectiveSystemPrompt,
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
      `${channelName}.chat.request`,
      requestTracePayload,
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
            artifactPayload: {
              traceId: turnTraceId,
              sessionId: msg.sessionId,
              historyLength: session.history.length,
              historyRoleCounts: summarizeRoleCounts(session.history),
              systemPromptChars: effectiveSystemPrompt.length,
              ...(traceConfig.includeSystemPrompt
                ? { systemPrompt: effectiveSystemPrompt }
                : {}),
              ...(traceConfig.includeHistory
                ? { history: session.history }
                : {}),
            },
          }
        : undefined,
    );
  }
  if (traceConfig.enabled && toolRoutingDecision) {
    logTraceEvent(
      logger,
      `${channelName}.tool_routing`,
      {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        routing: summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
      },
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
            artifactPayload: {
              traceId: turnTraceId,
              sessionId: msg.sessionId,
              routing: toolRoutingDecision,
            },
          }
        : undefined,
    );
  }

  const sessionStateful = buildSessionStatefulOptions(session);
  const effectiveMaxToolRounds = resolveTurnMaxToolRounds(
    defaultMaxToolRounds,
    toolRoutingDecision,
  );
  const result = await chatExecutor.execute({
    message: msg,
    history: session.history,
    systemPrompt: effectiveSystemPrompt,
    sessionId: msg.sessionId,
    toolHandler,
    maxToolRounds: effectiveMaxToolRounds,
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
                      channelName,
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
                channelName,
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
      ...(includePlannerSummaryInTrace
        ? { plannerSummary: result.plannerSummary }
        : {}),
      toolRoutingDecision: summarizeToolRoutingDecisionForTrace(
        toolRoutingDecision,
      ),
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
      `${channelName}.chat.response`,
      responseTracePayload,
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
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
              ...(includePlannerSummaryInTrace
                ? { plannerSummary: result.plannerSummary }
                : {}),
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
          }
        : undefined,
    );
  }

  if ((result.statefulSummary?.fallbackCalls ?? 0) > 0) {
    logger.warn(`[stateful] ${channelName} fallback_to_stateless`, {
      traceId: turnTraceId,
      sessionId: msg.sessionId,
      summary: result.statefulSummary,
    });
  }

  persistSessionStatefulContinuation(session, result);
  sessionMgr.appendMessage(session.id, {
    role: "user",
    content: msg.content,
  });
  sessionMgr.appendMessage(session.id, {
    role: "assistant",
    content: result.content,
  });

  if (memoryBackend) {
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
    } catch {
      // Non-critical memory persistence failures should not fail the chat turn.
    }
  }

  return result;
}
