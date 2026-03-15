export type NormalizedOperatorMessageKind =
  | "agent"
  | "approval"
  | "chat"
  | "error"
  | "observability"
  | "planner"
  | "run"
  | "social"
  | "status"
  | "subagent"
  | "tool"
  | "unknown";

export interface OperatorMessageEnvelope {
  readonly type?: unknown;
  readonly payload?: unknown;
  readonly sessionId?: unknown;
  readonly error?: unknown;
}

export interface NormalizedOperatorMessage {
  readonly type: string;
  readonly kind: NormalizedOperatorMessageKind;
  readonly transportType: string;
  readonly wrapped: boolean;
  readonly payload: unknown;
  readonly data: Record<string, unknown>;
  readonly sessionIds: readonly string[];
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly toolName?: string;
  readonly traceId?: string;
  readonly parentTraceId?: string;
  readonly timestamp?: number;
  readonly error?: string;
}

export type OperatorSurfaceEventFamily =
  | "agent"
  | "approval"
  | "chat"
  | "error"
  | "observability"
  | "planner"
  | "run"
  | "session"
  | "social"
  | "status"
  | "subagent"
  | "subscription"
  | "tool"
  | "unknown";

export interface OperatorSurfaceEvent {
  readonly family: OperatorSurfaceEventFamily;
  readonly type: string;
  readonly payload: unknown;
  readonly payloadRecord: Record<string, unknown>;
  readonly payloadList: readonly unknown[] | null;
  readonly isSessionScoped: boolean;
  readonly message: NormalizedOperatorMessage;
}

const SESSION_SCOPED_TYPES = new Set([
  "chat.message",
  "chat.stream",
  "chat.typing",
  "chat.cancelled",
  "run.inspect",
  "run.updated",
  "agent.status",
  "tools.executing",
  "tools.result",
]);

const SUBAGENT_METADATA_KEYS = new Set([
  "sessionId",
  "parentSessionId",
  "subagentSessionId",
  "toolName",
  "timestamp",
  "traceId",
  "parentTraceId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSessionValue(value: unknown): string | undefined {
  const text = normalizeText(typeof value === "string" ? value : String(value ?? ""));
  return text ? text.replace(/^session:/, "") : undefined;
}

function sessionValuesMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeSessionValue(left);
  const normalizedRight = normalizeSessionValue(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft === normalizedRight,
  );
}

function collectSessionIds(candidates: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const candidate of candidates) {
    const value = normalizeText(candidate);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    sessionIds.push(value);
  }
  return sessionIds;
}

function classifyOperatorMessageKind(type: string): NormalizedOperatorMessageKind {
  if (type.startsWith("planner_")) return "planner";
  if (type.startsWith("subagents.")) return "subagent";
  if (type === "tools.executing" || type === "tools.result") return "tool";
  if (type.startsWith("chat.")) return "chat";
  if (type === "runs.list" || type.startsWith("run.")) return "run";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("observability.")) return "observability";
  if (type === "status.update") return "status";
  if (type === "agent.status") return "agent";
  if (type === "social.message") return "social";
  if (type === "error") return "error";
  return "unknown";
}

function classifyOperatorSurfaceEventFamily(type: string): OperatorSurfaceEventFamily {
  if (type === "events.subscribed" || type === "events.unsubscribed") {
    return "subscription";
  }
  if (
    type === "chat.session" ||
    type === "chat.owner" ||
    type === "chat.resumed" ||
    type === "chat.sessions" ||
    type === "chat.history"
  ) {
    return "session";
  }
  if (type.startsWith("planner_")) return "planner";
  if (type.startsWith("subagents.")) return "subagent";
  if (type === "tools.executing" || type === "tools.result") return "tool";
  if (
    type === "chat.message" ||
    type === "chat.stream" ||
    type === "chat.typing" ||
    type === "chat.cancelled" ||
    type === "chat.usage"
  ) {
    return "chat";
  }
  if (type === "runs.list" || type.startsWith("run.")) return "run";
  if (type.startsWith("observability.")) return "observability";
  if (type === "status.update") return "status";
  if (type === "agent.status") return "agent";
  if (type.startsWith("approval.")) return "approval";
  if (type === "social.message") return "social";
  if (type === "error") return "error";
  return "unknown";
}

function isSessionScopedType(type: string): boolean {
  return (
    SESSION_SCOPED_TYPES.has(type) ||
    type.startsWith("planner_") ||
    type.startsWith("subagents.")
  );
}

function resolveWrappedPayload(
  rawPayload: unknown,
  eventType: string,
): unknown {
  if (!isRecord(rawPayload)) {
    return rawPayload;
  }
  if (Object.prototype.hasOwnProperty.call(rawPayload, "data")) {
    return rawPayload.data;
  }
  if (!eventType) {
    return rawPayload;
  }
  return {};
}

function deriveSubagentData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  if (isRecord(payload.data)) {
    return payload.data;
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SUBAGENT_METADATA_KEYS.has(key)) {
      continue;
    }
    data[key] = value;
  }
  return data;
}

function deriveNormalizedData(
  kind: NormalizedOperatorMessageKind,
  payload: unknown,
): Record<string, unknown> {
  if (kind === "subagent") {
    return deriveSubagentData(payload);
  }
  if (isRecord(payload)) {
    return payload;
  }
  return {};
}

function pickFirstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function normalizeOperatorMessage(
  message: OperatorMessageEnvelope,
): NormalizedOperatorMessage {
  const transportType = normalizeText(message?.type) ?? "";
  const wrapped = transportType === "events.event";
  const rawPayload = message?.payload;
  const envelopePayload = isRecord(rawPayload) ? rawPayload : {};
  const wrappedType = wrapped
    ? (normalizeText(envelopePayload.eventType) ?? "")
    : "";
  const type = wrappedType || transportType;
  const payload = wrapped
    ? resolveWrappedPayload(rawPayload, wrappedType)
    : rawPayload;
  const payloadRecord = isRecord(payload) ? payload : {};
  const kind = classifyOperatorMessageKind(type);
  const data = deriveNormalizedData(kind, payload);
  const sessionId = pickFirstText(
    payloadRecord.sessionId,
    data.sessionId,
    message?.sessionId,
  );
  const parentSessionId = pickFirstText(
    payloadRecord.parentSessionId,
    data.parentSessionId,
  );
  const subagentSessionId = pickFirstText(
    payloadRecord.subagentSessionId,
    data.subagentSessionId,
  );
  const toolName = pickFirstText(
    payloadRecord.toolName,
    data.toolName,
  );
  const traceId = pickFirstText(
    payloadRecord.traceId,
    data.traceId,
    envelopePayload.traceId,
  );
  const parentTraceId = pickFirstText(
    payloadRecord.parentTraceId,
    data.parentTraceId,
    envelopePayload.parentTraceId,
  );
  const timestamp = Number.isFinite(Number(payloadRecord.timestamp))
    ? Number(payloadRecord.timestamp)
    : Number.isFinite(Number(data.timestamp))
      ? Number(data.timestamp)
      : Number.isFinite(Number(envelopePayload.timestamp))
        ? Number(envelopePayload.timestamp)
        : undefined;
  const error = normalizeText(message?.error);

  return {
    type,
    kind,
    transportType,
    wrapped,
    payload,
    data,
    sessionIds: collectSessionIds([
      message?.sessionId,
      payloadRecord.sessionId,
      payloadRecord.parentSessionId,
      data.sessionId,
      data.parentSessionId,
    ]),
    ...(sessionId ? { sessionId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(subagentSessionId ? { subagentSessionId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(traceId ? { traceId } : {}),
    ...(parentTraceId ? { parentTraceId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(error ? { error } : {}),
  };
}

export function shouldIgnoreOperatorMessage(
  message: OperatorMessageEnvelope | NormalizedOperatorMessage,
  activeSessionId: string | null | undefined,
): boolean {
  const normalizedActiveSessionId = normalizeText(activeSessionId);
  if (!normalizedActiveSessionId) {
    return false;
  }
  const normalized =
    message &&
    typeof (message as NormalizedOperatorMessage).kind === "string" &&
    Array.isArray((message as NormalizedOperatorMessage).sessionIds)
      ? (message as NormalizedOperatorMessage)
      : normalizeOperatorMessage(message as OperatorMessageEnvelope);
  if (!isSessionScopedType(normalized.type)) {
    return false;
  }
  if (normalized.sessionIds.length === 0) {
    return false;
  }
  return !normalized.sessionIds.some((value) =>
    sessionValuesMatch(value, normalizedActiveSessionId)
  );
}

export function projectOperatorSurfaceEvent(
  message: OperatorMessageEnvelope | NormalizedOperatorMessage,
): OperatorSurfaceEvent {
  const normalized =
    message &&
    typeof (message as NormalizedOperatorMessage).kind === "string" &&
    Array.isArray((message as NormalizedOperatorMessage).sessionIds)
      ? (message as NormalizedOperatorMessage)
      : normalizeOperatorMessage(message as OperatorMessageEnvelope);
  return {
    family: classifyOperatorSurfaceEventFamily(normalized.type),
    type: normalized.type,
    payload: normalized.payload,
    payloadRecord: isRecord(normalized.payload) ? normalized.payload : {},
    payloadList: Array.isArray(normalized.payload) ? normalized.payload : null,
    isSessionScoped: isSessionScopedType(normalized.type),
    message: normalized,
  };
}
