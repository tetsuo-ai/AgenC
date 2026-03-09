/**
 * Trace/logging summarization helpers for the runtime daemon.
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";
import { persistTracePayloadArtifact, type TracePayloadArtifactRef } from "../utils/trace-payload-store.js";
import {
  formatTracePayloadForLog as formatSharedTracePayloadForLog,
  sanitizeTraceTextForLogSnippet,
  summarizeTracePayloadForPreview,
  summarizeTraceTextForPreview,
} from "../utils/trace-payload-serialization.js";
import type { Logger } from "../utils/logger.js";
import type {
  LLMMessage,
  LLMProviderTraceEvent,
} from "../llm/types.js";
import type {
  ChatCallUsageRecord,
  ChatExecutionTraceEvent,
  ChatToolRoutingSummary,
  ToolCallRecord,
} from "../llm/chat-executor-types.js";
import type { GatewayMessage } from "./message.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import type { GatewayLoggingConfig } from "./types.js";
import type { SubAgentLifecycleEvent } from "./delegation-runtime.js";
import { recordObservabilityTraceEvent } from "../observability/index.js";

const TOOL_LOG_SNIPPET_MAX_CHARS = 240;
export const EVAL_REPLY_MAX_CHARS = 4_000;
const TRACE_LOG_DEFAULT_MAX_CHARS = 20_000;
const TRACE_LOG_MIN_MAX_CHARS = 256;
const TRACE_LOG_MAX_MAX_CHARS = 200_000;
const TRACE_HISTORY_MAX_MESSAGES = 500;

const TRACE_DATA_IMAGE_URL_PATTERN =
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const TRACE_JSON_BINARY_FIELD_PATTERN =
  /"([A-Za-z0-9_.-]*(?:image|dataurl|data|base64)[A-Za-z0-9_.-]*)"\s*:\s*"([A-Za-z0-9+/=\r\n]{128,})"/gi;
const TRACE_QUOTED_BASE64_BLOB_PATTERN = /"([A-Za-z0-9+/=\r\n]{512,})"/g;
const TRACE_RAW_BASE64_BLOB_PATTERN = /[A-Za-z0-9+/=\r\n]{2048,}/g;

export interface ToolFailureSummary {
  readonly name: string;
  readonly durationMs: number;
  readonly error: string;
  args?: Record<string, unknown>;
}

export interface ResolvedTraceLoggingConfig {
  readonly enabled: boolean;
  readonly includeHistory: boolean;
  readonly includeSystemPrompt: boolean;
  readonly includeToolArgs: boolean;
  readonly includeToolResults: boolean;
  readonly includeProviderPayloads: boolean;
  readonly maxChars: number;
}

interface TraceEventLogOptions {
  readonly artifactPayload?: Record<string, unknown>;
}

const DEFAULT_TRACE_LOGGING_CONFIG: ResolvedTraceLoggingConfig = {
  enabled: false,
  includeHistory: true,
  includeSystemPrompt: true,
  includeToolArgs: true,
  includeToolResults: true,
  includeProviderPayloads: false,
  maxChars: TRACE_LOG_DEFAULT_MAX_CHARS,
};

export function truncateToolLogText(
  value: string,
  maxChars = TOOL_LOG_SNIPPET_MAX_CHARS,
): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

export function sanitizeToolResultTextForTrace(rawResult: string): string {
  const sanitized = rawResult
    .replace(TRACE_DATA_IMAGE_URL_PATTERN, "(see image)")
    .replace(
      TRACE_JSON_BINARY_FIELD_PATTERN,
      (_match: string, key: string) => `"${key}":"(base64 omitted)"`,
    )
    .replace(TRACE_QUOTED_BASE64_BLOB_PATTERN, '"(base64 omitted)"')
    .replace(TRACE_RAW_BASE64_BLOB_PATTERN, "(base64 omitted)");
  return sanitizeTraceTextForLogSnippet(sanitized, TRACE_LOG_DEFAULT_MAX_CHARS);
}

function summarizeArtifactText(value: string, maxChars: number): unknown {
  return summarizeTraceTextForPreview(value, maxChars);
}

function clampTraceMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined) return TRACE_LOG_DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars)) return TRACE_LOG_DEFAULT_MAX_CHARS;
  return Math.min(
    TRACE_LOG_MAX_MAX_CHARS,
    Math.max(TRACE_LOG_MIN_MAX_CHARS, Math.floor(maxChars)),
  );
}

export function resolveTraceLoggingConfig(
  logging?: GatewayLoggingConfig,
): ResolvedTraceLoggingConfig {
  const trace = logging?.trace;
  if (!trace?.enabled) {
    return DEFAULT_TRACE_LOGGING_CONFIG;
  }

  return {
    enabled: true,
    includeHistory: trace.includeHistory ?? true,
    includeSystemPrompt: trace.includeSystemPrompt ?? true,
    includeToolArgs: trace.includeToolArgs ?? true,
    includeToolResults: trace.includeToolResults ?? true,
    includeProviderPayloads: trace.includeProviderPayloads ?? false,
    maxChars: clampTraceMaxChars(trace.maxChars),
  };
}

export function summarizeTraceValue(
  value: unknown,
  maxChars: number,
): unknown {
  return summarizeTracePayloadForPreview(value, maxChars);
}

export function formatTracePayloadForLog(
  payload: Record<string, unknown>,
  maxChars = TRACE_LOG_DEFAULT_MAX_CHARS,
): string {
  return formatSharedTracePayloadForLog(payload, maxChars);
}

function buildTraceLogPayload(
  eventName: string,
  payload: Record<string, unknown>,
  options?: TraceEventLogOptions,
): Record<string, unknown> {
  const artifactPayload = options?.artifactPayload;
  const traceId =
    typeof payload.traceId === "string" ? payload.traceId : undefined;
  const payloadArtifact = artifactPayload
    ? persistTracePayloadArtifact({
        traceId,
        eventName,
        payload: artifactPayload,
      })
    : undefined;
  return {
    ...payload,
    ...(payloadArtifact ? { traceArtifact: payloadArtifact } : {}),
  };
}

export function logTraceEvent(
  logger: Logger,
  eventName: string,
  payload: Record<string, unknown>,
  maxChars: number,
  options?: TraceEventLogOptions,
): void {
  const artifactPayload = options?.artifactPayload;
  const builtPayload = buildTraceLogPayload(eventName, payload, options);
  const artifact = builtPayload.traceArtifact as TracePayloadArtifactRef | undefined;
  recordObservabilityTraceEvent({
    eventName,
    level: "info",
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    sessionId:
      typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    channel: eventName.split(".", 1)[0],
    payloadPreview: builtPayload,
    rawPayload: artifactPayload ?? payload,
    artifact,
  });
  logger.info(
    `[trace] ${eventName} ` +
      formatTracePayloadForLog(builtPayload, maxChars),
  );
}

export function logTraceErrorEvent(
  logger: Logger,
  eventName: string,
  payload: Record<string, unknown>,
  maxChars: number,
  options?: TraceEventLogOptions,
): void {
  const artifactPayload = options?.artifactPayload;
  const builtPayload = buildTraceLogPayload(eventName, payload, options);
  const artifact = builtPayload.traceArtifact as TracePayloadArtifactRef | undefined;
  recordObservabilityTraceEvent({
    eventName,
    level: "error",
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    sessionId:
      typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    channel: eventName.split(".", 1)[0],
    payloadPreview: builtPayload,
    rawPayload: artifactPayload ?? payload,
    artifact,
  });
  logger.error(
    `[trace] ${eventName} ` +
      formatTracePayloadForLog(builtPayload, maxChars),
  );
}

export function logProviderPayloadTraceEvent(params: {
  logger: Logger;
  channelName: string;
  traceId: string;
  sessionId: string;
  traceConfig: ResolvedTraceLoggingConfig;
  event: LLMProviderTraceEvent;
}): void {
  const { logger, channelName, traceId, sessionId, traceConfig, event } =
    params;
  logTraceEvent(
    logger,
    `${channelName}.provider.${event.kind}`,
    {
      traceId,
      sessionId,
      provider: event.provider,
      model: event.model,
      transport: event.transport,
      ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
      ...(event.callPhase !== undefined ? { callPhase: event.callPhase } : {}),
      ...(event.context
        ? { contextPreview: summarizeTraceValue(event.context, traceConfig.maxChars) }
        : {}),
      payloadPreview: summarizeTraceValue(event.payload, traceConfig.maxChars),
    },
    traceConfig.maxChars,
    {
      artifactPayload: {
        traceId,
        sessionId,
        provider: event.provider,
        model: event.model,
        transport: event.transport,
        ...(event.callIndex !== undefined
          ? { callIndex: event.callIndex }
          : {}),
        ...(event.callPhase !== undefined
          ? { callPhase: event.callPhase }
          : {}),
        payload: event.payload,
        ...(event.context ? { context: event.context } : {}),
      },
    },
  );
}

export function logExecutionTraceEvent(params: {
  logger: Logger;
  channelName: string;
  traceId: string;
  sessionId: string;
  traceConfig: ResolvedTraceLoggingConfig;
  event: ChatExecutionTraceEvent;
}): void {
  const { logger, channelName, traceId, sessionId, traceConfig, event } =
    params;
  logTraceEvent(
    logger,
    `${channelName}.executor.${event.type}`,
    {
      traceId,
      sessionId,
      ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
      ...(event.phase !== undefined ? { callPhase: event.phase } : {}),
      payloadPreview: summarizeTraceValue(event.payload, traceConfig.maxChars),
    },
    traceConfig.maxChars,
    {
      artifactPayload: {
        traceId,
        sessionId,
        ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
        ...(event.phase !== undefined ? { callPhase: event.phase } : {}),
        payload: event.payload,
      },
    },
  );
}

function summarizeLlmContentForTrace(
  content: LLMMessage["content"],
  maxChars: number,
): unknown {
  if (typeof content === "string") {
    return truncateToolLogText(content, maxChars);
  }
  if (!Array.isArray(content)) {
    return summarizeTraceValue(content, maxChars);
  }

  return content.map((part) => {
    if (!part || typeof part !== "object") {
      return summarizeTraceValue(part, maxChars);
    }

    if (part.type === "text") {
      return {
        type: "text",
        text: truncateToolLogText(part.text, maxChars),
      };
    }

    if (part.type === "image_url") {
      return {
        type: "image_url",
        image_url: {
          url: summarizeArtifactText(part.image_url.url, maxChars),
        },
      };
    }

    return summarizeTraceValue(part, maxChars);
  });
}

export function summarizeHistoryForTrace(
  history: readonly LLMMessage[],
  traceConfig: ResolvedTraceLoggingConfig,
): unknown[] {
  const sliceStart = Math.max(0, history.length - TRACE_HISTORY_MAX_MESSAGES);
  const entries = history.slice(sliceStart).map((entry) => {
    const output: Record<string, unknown> = {
      role: entry.role,
      content: summarizeLlmContentForTrace(entry.content, traceConfig.maxChars),
    };

    if (entry.toolCalls && entry.toolCalls.length > 0) {
      output.toolCalls = entry.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        ...(traceConfig.includeToolArgs
          ? {
              arguments: truncateToolLogText(
                toolCall.arguments,
                traceConfig.maxChars,
              ),
            }
          : {}),
      }));
    }

    if (entry.toolCallId) output.toolCallId = entry.toolCallId;
    if (entry.toolName) output.toolName = entry.toolName;
    return output;
  });

  if (sliceStart > 0) {
    entries.unshift({
      notice: `${sliceStart} oldest history message(s) omitted`,
    });
  }

  return entries;
}

export function summarizeRoleCounts(
  messages: readonly LLMMessage[],
): Record<string, number> {
  const counts = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  for (const entry of messages) {
    if (entry.role === "system") counts.system += 1;
    else if (entry.role === "user") counts.user += 1;
    else if (entry.role === "assistant") counts.assistant += 1;
    else if (entry.role === "tool") counts.tool += 1;
  }
  return counts;
}

export function createTurnTraceId(msg: GatewayMessage): string {
  const messageId = typeof msg.id === "string" ? msg.id.trim() : "";
  if (messageId.length > 0) {
    return `${msg.sessionId}:${messageId}`;
  }
  const stamp = Date.now().toString(36);
  return `${msg.sessionId}:${stamp}:${randomUUID().slice(0, 8)}`;
}

export function sanitizeLifecyclePayloadData(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const summarized = summarizeTraceValue(payload, TRACE_LOG_DEFAULT_MAX_CHARS);
  if (
    typeof summarized === "object" &&
    summarized !== null &&
    !Array.isArray(summarized)
  ) {
    return summarized as Record<string, unknown>;
  }
  return { value: summarized };
}

export function buildSubagentTraceId(
  parentTraceId: string | undefined,
  event: SubAgentLifecycleEvent,
): string | undefined {
  if (!parentTraceId) return undefined;
  const sessionRef = event.subagentSessionId ?? event.sessionId;
  const fingerprint = createHash("sha256")
    .update(`${parentTraceId}|${event.type}|${sessionRef}|${event.timestamp}`)
    .digest("hex")
    .slice(0, 16);
  return `${parentTraceId}:sub:${fingerprint}`;
}

function summarizeBudgetDiagnosticsForTrace(
  diagnostics: ChatCallUsageRecord["budgetDiagnostics"],
): Record<string, unknown> | undefined {
  if (!diagnostics) return undefined;

  const constrainedSections: Record<string, unknown> = {};
  for (const [section, stats] of Object.entries(diagnostics.sections)) {
    if (
      stats.beforeChars > stats.afterChars ||
      stats.droppedMessages > 0 ||
      stats.truncatedMessages > 0
    ) {
      constrainedSections[section] = {
        capChars: stats.capChars,
        beforeMessages: stats.beforeMessages,
        afterMessages: stats.afterMessages,
        beforeChars: stats.beforeChars,
        afterChars: stats.afterChars,
        droppedMessages: stats.droppedMessages,
        truncatedMessages: stats.truncatedMessages,
      };
    }
  }

  return {
    constrained: diagnostics.constrained,
    totalBeforeChars: diagnostics.totalBeforeChars,
    totalAfterChars: diagnostics.totalAfterChars,
    capChars: diagnostics.caps.totalChars,
    model: diagnostics.model,
    droppedSections: diagnostics.droppedSections,
    constrainedSections,
  };
}

function summarizeStatefulDiagnosticsForTrace(
  diagnostics: ChatCallUsageRecord["statefulDiagnostics"],
): Record<string, unknown> | undefined {
  if (!diagnostics) return undefined;
  return {
    enabled: diagnostics.enabled,
    attempted: diagnostics.attempted,
    continued: diagnostics.continued,
    store: diagnostics.store,
    fallbackToStateless: diagnostics.fallbackToStateless,
    previousResponseId: diagnostics.previousResponseId,
    responseId: diagnostics.responseId,
    reconciliationHash: diagnostics.reconciliationHash,
    previousReconciliationHash: diagnostics.previousReconciliationHash,
    reconciliationMessageCount: diagnostics.reconciliationMessageCount,
    reconciliationSource: diagnostics.reconciliationSource,
    anchorMatched: diagnostics.anchorMatched,
    historyCompacted: diagnostics.historyCompacted,
    compactedHistoryTrusted: diagnostics.compactedHistoryTrusted,
    fallbackReason: diagnostics.fallbackReason,
    events: diagnostics.events,
  };
}

export function summarizeCallUsageForTrace(
  callUsage: readonly ChatCallUsageRecord[],
): unknown[] {
  return callUsage.map((entry) => ({
    callIndex: entry.callIndex,
    phase: entry.phase,
    provider: entry.provider,
    model: entry.model,
    finishReason: entry.finishReason,
    usage: entry.usage,
    promptShapeBeforeBudget: entry.beforeBudget,
    promptShapeAfterBudget: entry.afterBudget,
    providerRequestMetrics: entry.providerRequestMetrics,
    budgetDiagnostics: summarizeBudgetDiagnosticsForTrace(
      entry.budgetDiagnostics,
    ),
    statefulDiagnostics: summarizeStatefulDiagnosticsForTrace(
      entry.statefulDiagnostics,
    ),
  }));
}

export function summarizeInitialRequestShape(
  callUsage: readonly ChatCallUsageRecord[],
): Record<string, unknown> | undefined {
  const first = callUsage[0];
  if (!first) return undefined;
  return {
    messageCountsBeforeBudget: {
      system: first.beforeBudget.systemMessages,
      user: first.beforeBudget.userMessages,
      assistant: first.beforeBudget.assistantMessages,
      tool: first.beforeBudget.toolMessages,
      total: first.beforeBudget.messageCount,
    },
    messageCountsAfterBudget: {
      system: first.afterBudget.systemMessages,
      user: first.afterBudget.userMessages,
      assistant: first.afterBudget.assistantMessages,
      tool: first.afterBudget.toolMessages,
      total: first.afterBudget.messageCount,
    },
    estimatedPromptCharsBeforeBudget: first.beforeBudget.estimatedChars,
    estimatedPromptCharsAfterBudget: first.afterBudget.estimatedChars,
    systemPromptCharsAfterBudget: first.afterBudget.systemPromptChars,
    toolSchemaChars: first.providerRequestMetrics?.toolSchemaChars,
    budgetDiagnostics: summarizeBudgetDiagnosticsForTrace(
      first.budgetDiagnostics,
    ),
    statefulDiagnostics: summarizeStatefulDiagnosticsForTrace(
      first.statefulDiagnostics,
    ),
  };
}

export function summarizeToolRoutingDecisionForTrace(
  decision: ToolRoutingDecision | undefined,
): Record<string, unknown> | undefined {
  if (!decision) return undefined;
  return {
    routedToolNames: decision.routedToolNames,
    expandedToolNames: decision.expandedToolNames,
    diagnostics: decision.diagnostics,
  };
}

export function summarizeToolRoutingSummaryForTrace(
  summary: ChatToolRoutingSummary | undefined,
): Record<string, unknown> | undefined {
  if (!summary) return undefined;
  return {
    enabled: summary.enabled,
    initialToolCount: summary.initialToolCount,
    finalToolCount: summary.finalToolCount,
    routeMisses: summary.routeMisses,
    expanded: summary.expanded,
  };
}

export function summarizeGatewayMessageForTrace(
  msg: GatewayMessage,
  maxChars: number,
): Record<string, unknown> {
  return {
    id: msg.id,
    channel: msg.channel,
    senderId: msg.senderId,
    senderName: msg.senderName,
    sessionId: msg.sessionId,
    scope: msg.scope,
    timestamp: msg.timestamp,
    content: truncateToolLogText(msg.content, maxChars),
    attachments: msg.attachments?.map((attachment) => ({
      type: attachment.type,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      url: attachment.url
        ? truncateToolLogText(attachment.url, maxChars)
        : undefined,
      sizeBytes: attachment.sizeBytes,
      durationSeconds: attachment.durationSeconds,
      dataBytes: attachment.data?.byteLength,
    })),
    metadata: summarizeTraceValue(msg.metadata, maxChars),
  };
}

function summarizeExecuteWithAgentArgs(
  args: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> | undefined {
  const summary: Record<string, unknown> = {};
  if (typeof args.objective === "string" && args.objective.trim().length > 0) {
    summary.objective = truncateToolLogText(args.objective, maxChars);
  } else if (typeof args.task === "string" && args.task.trim().length > 0) {
    summary.task = truncateToolLogText(args.task, maxChars);
  }
  if (
    typeof args.inputContract === "string" &&
    args.inputContract.trim().length > 0
  ) {
    summary.inputContract = truncateToolLogText(args.inputContract, maxChars);
  }
  if (Array.isArray(args.tools) && args.tools.length > 0) {
    summary.tools = args.tools
      .filter(
        (tool): tool is string =>
          typeof tool === "string" && tool.trim().length > 0,
      )
      .slice(0, 8);
  }
  if (
    Array.isArray(args.requiredToolCapabilities) &&
    args.requiredToolCapabilities.length > 0
  ) {
    summary.requiredToolCapabilities = args.requiredToolCapabilities
      .filter(
        (tool): tool is string =>
          typeof tool === "string" && tool.trim().length > 0,
      )
      .slice(0, 8);
  }
  if (
    Array.isArray(args.acceptanceCriteria) &&
    args.acceptanceCriteria.length > 0
  ) {
    summary.acceptanceCriteria = args.acceptanceCriteria
      .filter(
        (criterion): criterion is string =>
          typeof criterion === "string" && criterion.trim().length > 0,
      )
      .slice(0, 4)
      .map((criterion) => truncateToolLogText(criterion, maxChars));
  }
  if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) {
    summary.timeoutMs = args.timeoutMs;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizeExecuteWithAgentToolCallsForTrace(
  value: unknown,
  maxChars: number,
): unknown {
  if (!Array.isArray(value)) return undefined;
  const limit = Math.min(value.length, 6);
  const summarized = value.slice(0, limit).map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return summarizeTraceValue(entry, maxChars);
    }
    const toolCall = entry as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    if (typeof toolCall.name === "string") record.name = toolCall.name;
    if (typeof toolCall.isError === "boolean") {
      record.isError = toolCall.isError;
    }
    if (
      typeof toolCall.durationMs === "number" &&
      Number.isFinite(toolCall.durationMs)
    ) {
      record.durationMs = toolCall.durationMs;
    }
    if (
      toolCall.args &&
      typeof toolCall.args === "object" &&
      !Array.isArray(toolCall.args)
    ) {
      record.args =
        summarizeToolArgsForLog(
          typeof toolCall.name === "string" ? toolCall.name : "",
          toolCall.args as Record<string, unknown>,
        ) ?? summarizeTraceValue(toolCall.args, maxChars);
    }
    if (
      typeof toolCall.result === "string" &&
      toolCall.result.trim().length > 0
    ) {
      record.result = summarizeToolResultForTrace(toolCall.result, maxChars);
    }
    return record;
  });
  if (value.length > limit) {
    summarized.push(`[${value.length - limit} more tool call(s)]`);
  }
  return summarized;
}

export function summarizeToolResultForTrace(
  rawResult: string,
  maxChars: number,
): unknown {
  try {
    const parsed = JSON.parse(rawResult) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      const status =
        typeof record.status === "string" ? record.status : undefined;
      const objective =
        typeof record.objective === "string" &&
        record.objective.trim().length > 0
          ? truncateToolLogText(record.objective, maxChars)
          : undefined;
      const output =
        typeof record.output === "string" && record.output.trim().length > 0
          ? summarizeTraceTextForPreview(
              sanitizeToolResultTextForTrace(record.output),
              maxChars,
            )
          : undefined;
      const error =
        typeof record.error === "string" && record.error.trim().length > 0
          ? summarizeTraceTextForPreview(
              sanitizeTraceTextForLogSnippet(record.error, maxChars),
              maxChars,
            )
          : undefined;
      const validationCode =
        typeof record.validationCode === "string"
          ? record.validationCode
          : undefined;
      const stopReason =
        typeof record.stopReason === "string" ? record.stopReason : undefined;
      const stopReasonDetail =
        typeof record.stopReasonDetail === "string" &&
        record.stopReasonDetail.trim().length > 0
          ? truncateToolLogText(record.stopReasonDetail, maxChars)
          : undefined;
      const failedToolCalls =
        typeof record.failedToolCalls === "number" &&
        Number.isFinite(record.failedToolCalls)
          ? record.failedToolCalls
          : undefined;
      const toolCalls = summarizeExecuteWithAgentToolCallsForTrace(
        record.toolCalls,
        maxChars,
      );
      const decomposition = summarizeTraceValue(record.decomposition, maxChars);

      if (
        status !== undefined ||
        objective !== undefined ||
        output !== undefined ||
        error !== undefined ||
        validationCode !== undefined ||
        stopReason !== undefined ||
        stopReasonDetail !== undefined ||
        failedToolCalls !== undefined ||
        toolCalls !== undefined
      ) {
        return {
          ...(typeof record.success === "boolean"
            ? { success: record.success }
            : {}),
          ...(status !== undefined ? { status } : {}),
          ...(objective !== undefined ? { objective } : {}),
          ...(validationCode !== undefined ? { validationCode } : {}),
          ...(stopReason !== undefined ? { stopReason } : {}),
          ...(stopReasonDetail !== undefined ? { stopReasonDetail } : {}),
          ...(failedToolCalls !== undefined ? { failedToolCalls } : {}),
          ...(decomposition !== undefined ? { decomposition } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
        };
      }
    }
    return summarizeTraceValue(parsed, maxChars);
  } catch {
    return truncateToolLogText(
      sanitizeToolResultTextForTrace(rawResult),
      maxChars,
    );
  }
}

export function summarizeToolArgsForLog(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (name === "execute_with_agent") {
    return summarizeExecuteWithAgentArgs(args, 300);
  }

  if (
    (name === "desktop.bash" || name === "system.bash") &&
    typeof args.command === "string"
  ) {
    return {
      command: truncateToolLogText(args.command, 400),
    };
  }

  if (name === "desktop.text_editor") {
    const summary: Record<string, unknown> = {};
    if (typeof args.action === "string") summary.action = args.action;
    if (typeof args.filePath === "string") summary.filePath = args.filePath;
    if (typeof args.text === "string") {
      summary.textPreview = truncateToolLogText(args.text, 200);
    }
    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  return undefined;
}

export function summarizeToolFailureForLog(
  toolCall: ToolCallRecord,
): ToolFailureSummary | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    const decoded = JSON.parse(toolCall.result) as unknown;
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      !Array.isArray(decoded)
    ) {
      parsed = decoded as Record<string, unknown>;
    }
  } catch {
    // Non-JSON tool result
  }

  const parsedError =
    parsed && typeof parsed.error === "string" ? parsed.error : undefined;
  const exitCode =
    parsed && typeof parsed.exitCode === "number" ? parsed.exitCode : undefined;
  const stderr =
    parsed && typeof parsed.stderr === "string" ? parsed.stderr : undefined;

  let error: string | undefined;
  if (toolCall.isError) {
    error = parsedError ?? toolCall.result;
  } else if (parsedError) {
    error = parsedError;
  } else if (exitCode !== undefined && exitCode !== 0) {
    error =
      stderr && stderr.trim().length > 0
        ? `exitCode ${exitCode}: ${stderr}`
        : `exitCode ${exitCode}`;
  }

  if (!error) return null;

  const summary: ToolFailureSummary = {
    name: toolCall.name,
    durationMs: toolCall.durationMs,
    error: sanitizeTraceTextForLogSnippet(error, TOOL_LOG_SNIPPET_MAX_CHARS),
  };
  const args = summarizeToolArgsForLog(toolCall.name, toolCall.args);
  if (args) summary.args = args;
  return summary;
}
