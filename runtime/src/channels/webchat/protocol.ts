/**
 * Canonical WebChat websocket protocol schema shared by runtime + web.
 *
 * Keep message type constants and payload shapes here, then consume this
 * module from both backend and UI to avoid protocol drift.
 *
 * @module
 */

// ============================================================================
// Shared constants
// ============================================================================

/** PCM 24kHz, 16-bit signed, mono, little-endian — matching xAI Realtime API format. */
export const VOICE_SAMPLE_RATE = 24_000 as const;

/** Interval (ms) between mic audio chunk flushes. */
export const VOICE_CHUNK_INTERVAL_MS = 100 as const;

// Chat
export const WS_CHAT_MESSAGE = "chat.message" as const;
export const WS_CHAT_TYPING = "chat.typing" as const;
export const WS_CHAT_HISTORY = "chat.history" as const;
export const WS_CHAT_SESSION = "chat.session" as const;
export const WS_CHAT_OWNER = "chat.owner" as const;
export const WS_CHAT_NEW = "chat.new" as const;
export const WS_CHAT_RESUMED = "chat.resumed" as const;
export const WS_CHAT_SESSIONS = "chat.sessions" as const;
export const WS_CHAT_CANCELLED = "chat.cancelled" as const;
export const WS_CHAT_CANCEL = "chat.cancel" as const;
export const WS_CHAT_RESUME = "chat.resume" as const;
export const WS_CHAT_USAGE = "chat.usage" as const;

// Events
export const WS_EVENTS_SUBSCRIBE = "events.subscribe" as const;
export const WS_EVENTS_UNSUBSCRIBE = "events.unsubscribe" as const;
export const WS_EVENTS_SUBSCRIBED = "events.subscribed" as const;
export const WS_EVENTS_UNSUBSCRIBED = "events.unsubscribed" as const;
export const WS_EVENTS_EVENT = "events.event" as const;

// Subagent lifecycle
export const WS_SUBAGENTS_PLANNED = "subagents.planned" as const;
export const WS_SUBAGENTS_SPAWNED = "subagents.spawned" as const;
export const WS_SUBAGENTS_STARTED = "subagents.started" as const;
export const WS_SUBAGENTS_PROGRESS = "subagents.progress" as const;
export const WS_SUBAGENTS_TOOL_EXECUTING = "subagents.tool.executing" as const;
export const WS_SUBAGENTS_TOOL_RESULT = "subagents.tool.result" as const;
export const WS_SUBAGENTS_COMPLETED = "subagents.completed" as const;
export const WS_SUBAGENTS_FAILED = "subagents.failed" as const;
export const WS_SUBAGENTS_CANCELLED = "subagents.cancelled" as const;
export const WS_SUBAGENTS_SYNTHESIZED = "subagents.synthesized" as const;

// Tools
export const WS_TOOLS_EXECUTING = "tools.executing" as const;
export const WS_TOOLS_RESULT = "tools.result" as const;

// Voice
export const WS_VOICE_START = "voice.start" as const;
export const WS_VOICE_STOP = "voice.stop" as const;
export const WS_VOICE_AUDIO = "voice.audio" as const;
export const WS_VOICE_COMMIT = "voice.commit" as const;
export const WS_VOICE_STARTED = "voice.started" as const;
export const WS_VOICE_STOPPED = "voice.stopped" as const;
export const WS_VOICE_TRANSCRIPT = "voice.transcript" as const;
export const WS_VOICE_USER_TRANSCRIPT = "voice.user_transcript" as const;
export const WS_VOICE_SPEECH_STARTED = "voice.speech_started" as const;
export const WS_VOICE_SPEECH_STOPPED = "voice.speech_stopped" as const;
export const WS_VOICE_RESPONSE_DONE = "voice.response_done" as const;
export const WS_VOICE_DELEGATION = "voice.delegation" as const;
export const WS_VOICE_STATE = "voice.state" as const;
export const WS_VOICE_ERROR = "voice.error" as const;

// Desktop
export const WS_DESKTOP_LIST = "desktop.list" as const;
export const WS_DESKTOP_CREATE = "desktop.create" as const;
export const WS_DESKTOP_CREATED = "desktop.created" as const;
export const WS_DESKTOP_ATTACH = "desktop.attach" as const;
export const WS_DESKTOP_ATTACHED = "desktop.attached" as const;
export const WS_DESKTOP_DESTROY = "desktop.destroy" as const;
export const WS_DESKTOP_DESTROYED = "desktop.destroyed" as const;
export const WS_DESKTOP_ERROR = "desktop.error" as const;

// Durable runs
export const WS_RUNS_LIST = "runs.list" as const;
export const WS_RUN_INSPECT = "run.inspect" as const;
export const WS_RUN_CONTROL = "run.control" as const;
export const WS_RUN_UPDATED = "run.updated" as const;

// Observability
export const WS_OBSERVABILITY_SUMMARY = "observability.summary" as const;
export const WS_OBSERVABILITY_TRACES = "observability.traces" as const;
export const WS_OBSERVABILITY_TRACE = "observability.trace" as const;
export const WS_OBSERVABILITY_ARTIFACT = "observability.artifact" as const;
export const WS_OBSERVABILITY_LOGS = "observability.logs" as const;

// Approval
export const WS_APPROVAL_REQUEST = "approval.request" as const;

// Agent status
export const WS_AGENT_STATUS = "agent.status" as const;

// ============================================================================
// Shared payload shapes (drift-prone messages first)
// ============================================================================

export interface ChatSessionPayload {
  sessionId: string;
}

export interface ChatOwnerPayload {
  ownerToken: string;
}

export interface ChatSessionSummary {
  sessionId: string;
  label: string;
  messageCount: number;
  lastActiveAt: number;
}

export type ChatSessionsPayload = ChatSessionSummary[];

export interface ChatCancelledPayload {
  cancelled: boolean;
}

export interface EventsSubscriptionPayload {
  active: boolean;
  filters: string[];
}

export interface EventsEventPayload {
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
  traceId?: string;
  parentTraceId?: string;
}

export const WS_SUBAGENT_LIFECYCLE_TYPES = [
  WS_SUBAGENTS_PLANNED,
  WS_SUBAGENTS_SPAWNED,
  WS_SUBAGENTS_STARTED,
  WS_SUBAGENTS_PROGRESS,
  WS_SUBAGENTS_TOOL_EXECUTING,
  WS_SUBAGENTS_TOOL_RESULT,
  WS_SUBAGENTS_COMPLETED,
  WS_SUBAGENTS_FAILED,
  WS_SUBAGENTS_CANCELLED,
  WS_SUBAGENTS_SYNTHESIZED,
] as const;

export type SubagentLifecycleType = (typeof WS_SUBAGENT_LIFECYCLE_TYPES)[number];

export interface SubagentLifecyclePayload {
  sessionId: string;
  parentSessionId?: string;
  subagentSessionId?: string;
  toolName?: string;
  timestamp: number;
  data?: Record<string, unknown>;
  traceId?: string;
  parentTraceId?: string;
}

export type WebChatFilterList = readonly string[] | null;

export function matchesEventFilters(
  eventType: string,
  filters: WebChatFilterList,
): boolean {
  if (!filters || filters.length === 0) return true;
  for (const filter of filters) {
    if (filter === "*" || filter === eventType) return true;
    if (filter.endsWith("*")) {
      const prefix = filter.slice(0, -1);
      if (eventType.startsWith(prefix)) return true;
    }
    if (eventType.startsWith(`${filter}.`)) return true;
  }
  return false;
}
