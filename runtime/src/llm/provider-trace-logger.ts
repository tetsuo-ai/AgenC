import type { Logger } from "../utils/logger.js";
import { persistTracePayloadArtifact } from "../utils/trace-payload-store.js";
import {
  formatTracePayloadForLog,
  summarizeTracePayloadForPreview,
} from "../utils/trace-payload-serialization.js";
import { recordObservabilityTraceEvent } from "../observability/observability.js";
import type { LLMProviderTraceEvent } from "./types.js";
import type { ChatExecutionTraceEvent } from "./chat-executor-types.js";

const DEFAULT_MAX_CHARS = 20_000;

function deriveTraceChannel(traceLabel: string): string | undefined {
  const [channel] = traceLabel.split(".", 1);
  return channel && channel.length > 0 ? channel : undefined;
}

export function formatProviderTracePayloadForLog(
  payload: Record<string, unknown>,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  return formatTracePayloadForLog(payload, maxChars);
}

export function createProviderTraceEventLogger(params: {
  logger: Logger;
  traceLabel: string;
  traceId: string;
  sessionId?: string;
  maxChars?: number;
  staticFields?: Record<string, unknown>;
}): (event: LLMProviderTraceEvent) => void {
  const {
    logger,
    traceLabel,
    traceId,
    sessionId,
    maxChars = DEFAULT_MAX_CHARS,
    staticFields,
  } = params;

  return (event: LLMProviderTraceEvent): void => {
    const eventName = `${traceLabel}.${event.kind}`;
    const payloadArtifact = persistTracePayloadArtifact({
      traceId,
      eventName,
      payload: {
        payload: event.payload,
        ...(event.context ? { context: event.context } : {}),
      },
    });
    const payload = {
      traceId,
      ...(sessionId ? { sessionId } : {}),
      ...(staticFields ?? {}),
      provider: event.provider,
      model: event.model,
      transport: event.transport,
      ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
      ...(event.callPhase !== undefined ? { callPhase: event.callPhase } : {}),
      ...(event.context
        ? { contextPreview: summarizeTracePayloadForPreview(event.context, maxChars) }
        : {}),
      payloadPreview: summarizeTracePayloadForPreview(event.payload, maxChars),
      ...(payloadArtifact ? { payloadArtifact } : {}),
    };
    recordObservabilityTraceEvent({
      eventName,
      level: event.kind === "error" ? "error" : "info",
      traceId,
      sessionId,
      channel: deriveTraceChannel(traceLabel),
      callIndex: event.callIndex,
      callPhase: event.callPhase,
      provider: event.provider,
      model: event.model,
      payloadPreview: payload,
      rawPayload: {
        ...event.payload,
        ...(event.context ? { context: event.context } : {}),
      },
      artifact: payloadArtifact,
    });
    const line =
      `[trace] ${eventName} ` +
      formatProviderTracePayloadForLog(payload, maxChars);
    if (event.kind === "error") {
      logger.error(line);
      return;
    }
    logger.info(line);
  };
}

export function createExecutionTraceEventLogger(params: {
  logger: Logger;
  traceLabel: string;
  traceId: string;
  sessionId?: string;
  maxChars?: number;
  staticFields?: Record<string, unknown>;
}): (event: ChatExecutionTraceEvent) => void {
  const {
    logger,
    traceLabel,
    traceId,
    sessionId,
    maxChars = DEFAULT_MAX_CHARS,
    staticFields,
  } = params;

  return (event: ChatExecutionTraceEvent): void => {
    const eventName = `${traceLabel}.${event.type}`;
    const payloadArtifact = persistTracePayloadArtifact({
      traceId,
      eventName,
      payload: event.payload,
    });
    const payload = {
      traceId,
      ...(sessionId ? { sessionId } : {}),
      ...(staticFields ?? {}),
      ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
      ...(event.phase !== undefined ? { callPhase: event.phase } : {}),
      payloadPreview: summarizeTracePayloadForPreview(event.payload, maxChars),
      ...(payloadArtifact ? { payloadArtifact } : {}),
    };
    recordObservabilityTraceEvent({
      eventName,
      level: "info",
      traceId,
      sessionId,
      channel: deriveTraceChannel(traceLabel),
      callIndex: event.callIndex,
      callPhase: event.phase,
      payloadPreview: payload,
      rawPayload: event.payload,
      artifact: payloadArtifact,
    });
    const line =
      `[trace] ${eventName} ` +
      formatProviderTracePayloadForLog(payload, maxChars);
    logger.info(line);
  };
}

export function logStructuredTraceEvent(params: {
  logger: Logger;
  traceLabel: string;
  traceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  callIndex?: number;
  callPhase?: string;
  level?: "info" | "warn" | "error";
  maxChars?: number;
  staticFields?: Record<string, unknown>;
}): void {
  const {
    logger,
    traceLabel,
    traceId,
    eventType,
    payload,
    sessionId,
    callIndex,
    callPhase,
    level = "info",
    maxChars = DEFAULT_MAX_CHARS,
    staticFields,
  } = params;
  const eventName = `${traceLabel}.${eventType}`;
  const payloadArtifact = persistTracePayloadArtifact({
    traceId,
    eventName,
    payload,
  });
  const preview = {
    traceId,
    ...(sessionId ? { sessionId } : {}),
    ...(staticFields ?? {}),
    ...(callIndex !== undefined ? { callIndex } : {}),
    ...(callPhase !== undefined ? { callPhase } : {}),
    payloadPreview: summarizeTracePayloadForPreview(payload, maxChars),
    ...(payloadArtifact ? { payloadArtifact } : {}),
  };
  recordObservabilityTraceEvent({
    eventName,
    level: level === "warn" ? "info" : level,
    traceId,
    sessionId,
    channel: deriveTraceChannel(traceLabel),
    callIndex,
    callPhase,
    payloadPreview: preview,
    rawPayload: payload,
    artifact: payloadArtifact,
  });
  const line =
    `[trace] ${eventName} ` +
    formatProviderTracePayloadForLog(preview, maxChars);
  if (level === "error") {
    logger.error(line);
    return;
  }
  if (level === "warn") {
    logger.warn(line);
    return;
  }
  logger.info(line);
}
