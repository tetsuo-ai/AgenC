import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  ChatMessageAttachment,
  ContextUsageSection,
  SubagentTimelineEvent,
  SubagentTimelineItem,
  SubagentTimelineStatus,
  TokenUsage,
  ToolCall,
  WSMessage,
} from '../types';
import {
  WS_CHAT_MESSAGE,
  WS_CHAT_TYPING,
  WS_CHAT_HISTORY,
  WS_CHAT_SESSION,
  WS_CHAT_NEW,
  WS_CHAT_RESUME,
  WS_CHAT_RESUMED,
  WS_CHAT_SESSIONS,
  WS_CHAT_CANCELLED,
  WS_CHAT_CANCEL,
  WS_CHAT_USAGE,
  WS_EVENTS_EVENT,
  WS_SUBAGENT_LIFECYCLE_TYPES,
  WS_SUBAGENTS_CANCELLED,
  WS_SUBAGENTS_COMPLETED,
  WS_SUBAGENTS_FAILED,
  WS_SUBAGENTS_PLANNED,
  WS_SUBAGENTS_PROGRESS,
  WS_SUBAGENTS_SPAWNED,
  WS_SUBAGENTS_STARTED,
  WS_SUBAGENTS_SYNTHESIZED,
  WS_SUBAGENTS_TOOL_EXECUTING,
  WS_SUBAGENTS_TOOL_RESULT,
  WS_TOOLS_EXECUTING,
  WS_TOOLS_RESULT,
} from '../constants';

/** Read a File as a base64 data URL and produce wire + display representations. */
function readFileAttachment(
  file: File,
): Promise<{ wire: ChatAttachment; display: ChatMessageAttachment }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve({
        wire: {
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: base64,
          sizeBytes: file.size,
        },
        display: {
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          ...(file.type.startsWith('image/') && { dataUrl }),
        },
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface ChatAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
  sizeBytes: number;
}

export interface ChatSessionInfo {
  sessionId: string;
  label: string;
  messageCount: number;
  lastActiveAt: number;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (content: string, attachments?: File[]) => void;
  stopGeneration: () => void;
  /** Inject a message from an external source (e.g. voice transcript). */
  injectMessage: (content: string, sender: 'user' | 'agent') => void;
  /** Replace the content of the most recent user message (for voice transcript updates). */
  replaceLastUserMessage: (content: string) => void;
  isTyping: boolean;
  sessionId: string | null;
  sessions: ChatSessionInfo[];
  refreshSessions: () => void;
  resumeSession: (sessionId: string) => void;
  startNewChat: () => void;
  /** Cumulative token usage for the current session. */
  tokenUsage: TokenUsage | null;
  /** Handle incoming WS messages for the chat domain. */
  handleMessage: (msg: WSMessage) => void;
}

interface UseChatOptions {
  send: (msg: Record<string, unknown>) => void;
  connected?: boolean;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function parseUsageSections(value: unknown): ContextUsageSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      const label = typeof row.label === 'string' ? row.label : '';
      const tokens = asNumber(row.tokens);
      const percent = asNumber(row.percent);
      if (!id || !label || tokens === undefined || percent === undefined) {
        return null;
      }
      return { id, label, tokens, percent } satisfies ContextUsageSection;
    })
    .filter((section): section is ContextUsageSection => section !== null);
  return sections.length > 0 ? sections : undefined;
}

const SUBAGENT_LIFECYCLE_TYPE_SET = new Set<string>(
  WS_SUBAGENT_LIFECYCLE_TYPES as readonly string[],
);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asSubagentStatus(type: string): SubagentTimelineStatus {
  switch (type) {
    case WS_SUBAGENTS_PLANNED:
      return 'planned';
    case WS_SUBAGENTS_SPAWNED:
      return 'spawned';
    case WS_SUBAGENTS_STARTED:
      return 'started';
    case WS_SUBAGENTS_PROGRESS:
    case WS_SUBAGENTS_TOOL_EXECUTING:
    case WS_SUBAGENTS_TOOL_RESULT:
      return 'running';
    case WS_SUBAGENTS_COMPLETED:
      return 'completed';
    case WS_SUBAGENTS_FAILED:
      return 'failed';
    case WS_SUBAGENTS_CANCELLED:
      return 'cancelled';
    case WS_SUBAGENTS_SYNTHESIZED:
      return 'synthesized';
    default:
      return 'running';
  }
}

interface ParsedSubagentEvent {
  type: string;
  payload: {
    sessionId: string;
    parentSessionId?: string;
    subagentSessionId?: string;
    toolName?: string;
    timestamp: number;
    data: Record<string, unknown>;
    traceId?: string;
    parentTraceId?: string;
  };
}

function parseSubagentEvent(msg: WSMessage): ParsedSubagentEvent | null {
  if (SUBAGENT_LIFECYCLE_TYPE_SET.has(msg.type)) {
    const payload = asRecord(msg.payload ?? msg);
    if (!payload) return null;
    const sessionId = asString(payload.sessionId);
    if (!sessionId) return null;
    return {
      type: msg.type,
      payload: {
        sessionId,
        parentSessionId: asString(payload.parentSessionId),
        subagentSessionId: asString(payload.subagentSessionId),
        toolName: asString(payload.toolName),
        timestamp: asNumber(payload.timestamp) ?? Date.now(),
        data: asRecord(payload.data) ?? {},
        traceId: asString(payload.traceId),
        parentTraceId: asString(payload.parentTraceId),
      },
    };
  }

  if (msg.type === WS_EVENTS_EVENT) {
    const envelope = asRecord(msg.payload ?? msg);
    if (!envelope) return null;
    const lifecycleType = asString(envelope.eventType);
    if (!lifecycleType || !SUBAGENT_LIFECYCLE_TYPE_SET.has(lifecycleType)) {
      return null;
    }
    const data = asRecord(envelope.data) ?? {};
    const sessionId =
      asString(data.sessionId) ??
      asString(data.parentSessionId) ??
      asString(msg.sessionId);
    if (!sessionId) return null;
    const subagentData = { ...data };
    delete subagentData.sessionId;
    delete subagentData.parentSessionId;
    delete subagentData.subagentSessionId;
    delete subagentData.toolName;
    delete subagentData.timestamp;
    return {
      type: lifecycleType,
      payload: {
        sessionId,
        parentSessionId: asString(data.parentSessionId),
        subagentSessionId: asString(data.subagentSessionId),
        toolName: asString(data.toolName),
        timestamp: asNumber(data.timestamp) ?? asNumber(envelope.timestamp) ?? Date.now(),
        data: subagentData,
        traceId: asString(envelope.traceId),
        parentTraceId: asString(envelope.parentTraceId),
      },
    };
  }

  return null;
}

function resolveSubagentId(event: ParsedSubagentEvent): string {
  if (event.payload.subagentSessionId) return event.payload.subagentSessionId;
  const stepName = asString(event.payload.data.stepName);
  if (stepName) return `planned:${stepName}`;
  return `planned:${event.type}:${event.payload.timestamp}`;
}

export function useChat({ send, connected }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  // Tracks the placeholder message ID for the current response round
  const pendingMsgIdRef = useRef<string | null>(null);
  const msgCounterRef = useRef(0);
  const requestCounterRef = useRef(0);

  const nextRequestId = useCallback((prefix: string): string => {
    requestCounterRef.current += 1;
    return `${prefix}_${Date.now().toString(36)}_${requestCounterRef.current}`;
  }, []);

  const refreshSessions = useCallback(() => {
    send({ type: WS_CHAT_SESSIONS });
  }, [send]);

  // Fetch sessions when connected
  useEffect(() => {
    if (connected) refreshSessions();
  }, [connected, refreshSessions]);

  const resumeSession = useCallback((targetSessionId: string) => {
    send({ type: WS_CHAT_RESUME, payload: { sessionId: targetSessionId } });
  }, [send]);

  const startNewChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setIsTyping(false);
    setTokenUsage(null);
    pendingMsgIdRef.current = null;
    send({ type: WS_CHAT_NEW, id: nextRequestId('chat_new') });
  }, [nextRequestId, send]);

  const stopGeneration = useCallback(() => {
    send({ type: WS_CHAT_CANCEL });
    setIsTyping(false);
  }, [send]);

  const injectMessage = useCallback((content: string, sender: 'user' | 'agent') => {
    const id = `${sender}_${++msgCounterRef.current}`;
    setMessages((prev) => [...prev, { id, content, sender, timestamp: Date.now() }]);
  }, []);

  const replaceLastUserMessage = useCallback((content: string) => {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].sender === 'user') {
          const updated = [...prev];
          updated[i] = { ...updated[i], content };
          return updated;
        }
      }
      return prev;
    });
  }, []);

  const sendMessage = useCallback((content: string, files?: File[]) => {
    if (!files || files.length === 0) {
      const id = `user_${++msgCounterRef.current}`;
      const userMsg: ChatMessage = { id, content, sender: 'user', timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      send({
        type: WS_CHAT_MESSAGE,
        id: nextRequestId('chat_msg'),
        payload: { content },
      });
      return;
    }

    // Read files as base64, build display attachments, then send
    const readers = files.map((file) => readFileAttachment(file));

    void Promise.all(readers).then((results) => {
      const id = `user_${++msgCounterRef.current}`;
      const displayAttachments: ChatMessageAttachment[] = results.map((r) => ({
        filename: r.display.filename,
        mimeType: r.display.mimeType,
        ...(r.display.dataUrl ? { dataUrl: r.display.dataUrl } : {}),
      }));
      const userMsg: ChatMessage = {
        id,
        content,
        sender: 'user',
        timestamp: Date.now(),
        attachments: displayAttachments,
      };
      setMessages((prev) => [...prev, userMsg]);
      send({
        type: WS_CHAT_MESSAGE,
        id: nextRequestId('chat_msg'),
        payload: {
          content,
          attachments: results.map((r) => r.wire),
        },
      });
    });
  }, [nextRequestId, send]);

  const appendSubagentLifecycle = useCallback((event: ParsedSubagentEvent) => {
    setMessages((prev) => {
      const copy = [...prev];
      const pendingId = pendingMsgIdRef.current;
      let targetIdx = pendingId
        ? copy.findIndex((message) => message.id === pendingId)
        : -1;

      if (targetIdx === -1) {
        for (let i = copy.length - 1; i >= 0; i -= 1) {
          if (copy[i].sender === 'agent') {
            targetIdx = i;
            break;
          }
        }
      }

      if (targetIdx === -1) {
        const newId = `agent_${++msgCounterRef.current}`;
        pendingMsgIdRef.current = newId;
        copy.push({
          id: newId,
          content: '',
          sender: 'agent',
          timestamp: event.payload.timestamp,
          subagents: [],
        });
        targetIdx = copy.length - 1;
      }

      const target = copy[targetIdx];
      const subagents = [...(target.subagents ?? [])];
      const stepName = asString(event.payload.data.stepName);
      const resolvedId = resolveSubagentId(event);
      let itemIndex = subagents.findIndex((entry) => entry.subagentSessionId === resolvedId);
      if (itemIndex === -1 && event.payload.subagentSessionId && stepName) {
        itemIndex = subagents.findIndex(
          (entry) => entry.subagentSessionId === `planned:${stepName}`,
        );
      }
      if (itemIndex === -1 && event.type === WS_SUBAGENTS_SYNTHESIZED) {
        itemIndex = subagents.findIndex((entry) => entry.subagentSessionId === '__synthesis__');
      }

      if (itemIndex === -1) {
        subagents.push({
          subagentSessionId:
            event.type === WS_SUBAGENTS_SYNTHESIZED
              ? '__synthesis__'
              : resolvedId,
          parentSessionId: event.payload.parentSessionId,
          objective:
            asString(event.payload.data.objective) ??
            (stepName ? `Step ${stepName}` : undefined),
          status: asSubagentStatus(event.type),
          tools: [],
          events: [],
          traceId: event.payload.traceId,
          parentTraceId: event.payload.parentTraceId,
        });
        itemIndex = subagents.length - 1;
      }

      const current = subagents[itemIndex] as SubagentTimelineItem;
      const updated: SubagentTimelineItem = {
        ...current,
        tools: [...current.tools],
        events: [...current.events],
      };

      if (
        event.payload.subagentSessionId &&
        updated.subagentSessionId.startsWith('planned:')
      ) {
        updated.subagentSessionId = event.payload.subagentSessionId;
      }

      const status = asSubagentStatus(event.type);
      updated.status = status;
      updated.parentSessionId = event.payload.parentSessionId ?? updated.parentSessionId;
      const objective = asString(event.payload.data.objective);
      if (objective) updated.objective = objective;
      if (event.payload.traceId) updated.traceId = event.payload.traceId;
      if (event.payload.parentTraceId) updated.parentTraceId = event.payload.parentTraceId;

      if (
        !updated.startedAt &&
        (status === 'spawned' || status === 'started' || status === 'running')
      ) {
        updated.startedAt = event.payload.timestamp;
      }
      if (
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'synthesized'
      ) {
        updated.completedAt = event.payload.timestamp;
      }

      const outputSummary =
        asString(event.payload.data.output) ??
        asString(event.payload.data.summary) ??
        asString(event.payload.data.result);
      if (outputSummary) {
        updated.outputSummary =
          outputSummary.length > 500
            ? `${outputSummary.slice(0, 497)}...`
            : outputSummary;
      }

      const errorReason =
        asString(event.payload.data.reason) ??
        asString(event.payload.data.error) ??
        asString(event.payload.data.message);
      if (errorReason) updated.errorReason = errorReason;

      const durationMs = asNumber(event.payload.data.durationMs);
      if (durationMs !== undefined) {
        updated.elapsedMs = durationMs;
      } else if (updated.startedAt && updated.completedAt) {
        updated.elapsedMs = Math.max(0, updated.completedAt - updated.startedAt);
      }

      const toolName = asString(event.payload.toolName) ?? asString(event.payload.data.toolName);
      const toolCallId = asString(event.payload.data.toolCallId);
      if (
        (event.type === WS_SUBAGENTS_TOOL_EXECUTING || event.type === WS_SUBAGENTS_TOOL_RESULT) &&
        toolName
      ) {
        let toolIndex = updated.tools.findIndex((tool) => {
          if (toolCallId) return tool.toolCallId === toolCallId;
          return tool.toolName === toolName && tool.status === 'executing';
        });
        if (toolIndex === -1) {
          updated.tools.push({
            toolName,
            toolCallId,
            args: asRecord(event.payload.data.args) ?? {},
            status: event.type === WS_SUBAGENTS_TOOL_RESULT ? 'completed' : 'executing',
            subagentSessionId: updated.subagentSessionId,
            traceId: event.payload.traceId,
            parentTraceId: event.payload.parentTraceId,
          });
          toolIndex = updated.tools.length - 1;
        }

        const existingTool = updated.tools[toolIndex];
        const merged: ToolCall = {
          ...existingTool,
          toolName,
          toolCallId: toolCallId ?? existingTool.toolCallId,
          args: asRecord(event.payload.data.args) ?? existingTool.args,
          subagentSessionId: updated.subagentSessionId,
          traceId: event.payload.traceId ?? existingTool.traceId,
          parentTraceId: event.payload.parentTraceId ?? existingTool.parentTraceId,
        };

        if (event.type === WS_SUBAGENTS_TOOL_RESULT) {
          merged.status = 'completed';
          if (asString(event.payload.data.result) !== undefined) {
            merged.result = asString(event.payload.data.result);
          }
          const resultDuration = asNumber(event.payload.data.durationMs);
          if (resultDuration !== undefined) {
            merged.durationMs = resultDuration;
          }
          const isError = asBoolean(event.payload.data.isError);
          if (isError !== undefined) {
            merged.isError = isError;
          }
        } else {
          merged.status = 'executing';
        }

        updated.tools[toolIndex] = merged;
      }

      updated.events.push({
        type: event.type as SubagentTimelineEvent['type'],
        timestamp: event.payload.timestamp,
        toolName: event.payload.toolName,
        data: event.payload.data,
      });

      subagents[itemIndex] = updated;

      copy[targetIdx] = {
        ...target,
        timestamp: Math.max(target.timestamp, event.payload.timestamp),
        subagents,
      };

      return copy;
    });
  }, []);

  const handleMessage = useCallback((msg: WSMessage) => {
    const subagentEvent = parseSubagentEvent(msg);
    if (subagentEvent) {
      appendSubagentLifecycle(subagentEvent);
      if (
        subagentEvent.type === WS_SUBAGENTS_COMPLETED ||
        subagentEvent.type === WS_SUBAGENTS_FAILED ||
        subagentEvent.type === WS_SUBAGENTS_CANCELLED ||
        subagentEvent.type === WS_SUBAGENTS_SYNTHESIZED
      ) {
        setIsTyping(false);
      } else {
        setIsTyping(true);
      }
      return;
    }

    switch (msg.type) {
      case WS_CHAT_MESSAGE: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const content = (payload.content as string) ?? '';
        const timestamp = (payload.timestamp as number) ?? Date.now();
        const pendingId = pendingMsgIdRef.current;
        setMessages((prev) => {
          const copy = [...prev];
          // Merge into the placeholder created by tools.executing if one exists
          if (pendingId) {
            const idx = copy.findIndex((m) => m.id === pendingId);
            if (idx !== -1) {
              copy[idx] = { ...copy[idx], content, timestamp };
              pendingMsgIdRef.current = null;
              return copy;
            }
          }
          // Dedup: skip if the last agent message already has this exact content
          const last = copy[copy.length - 1];
          if (last?.sender === 'agent' && last.content === content) {
            return prev;
          }
          copy.push({
            id: `agent_${++msgCounterRef.current}`,
            content,
            sender: 'agent',
            timestamp,
          });
          return copy;
        });
        pendingMsgIdRef.current = null;
        setIsTyping(false);
        break;
      }

      case WS_CHAT_TYPING: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        setIsTyping(!!payload.active);
        break;
      }

      case WS_CHAT_HISTORY: {
        const payload = msg.payload as Array<{ content: string; sender: 'user' | 'agent'; timestamp: number }>;
        if (Array.isArray(payload)) {
          const historyMsgs = payload.map((m, i) => ({
            id: `history_${i}`,
            content: m.content,
            sender: m.sender,
            timestamp: m.timestamp,
          }));
          setMessages(historyMsgs);
        }
        break;
      }

      case WS_CHAT_SESSION: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const id = (payload.sessionId as string) ?? null;
        if (id) setSessionId(id);
        break;
      }

      case WS_CHAT_RESUMED: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const resumedId = (payload.sessionId as string) ?? null;
        setSessionId(resumedId);
        // Fetch history for the resumed session
        if (resumedId) {
          send({ type: WS_CHAT_HISTORY });
        }
        break;
      }

      case WS_CHAT_SESSIONS: {
        const payload = msg.payload as ChatSessionInfo[];
        if (Array.isArray(payload)) {
          setSessions(payload);
        }
        break;
      }

      case WS_CHAT_CANCELLED: {
        setIsTyping(false);
        break;
      }

      case WS_CHAT_USAGE: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        setTokenUsage({
          totalTokens: asNumber(payload.totalTokens) ?? 0,
          budget: asNumber(payload.budget) ?? 0,
          compacted: (payload.compacted as boolean) ?? false,
          contextWindowTokens: asNumber(payload.contextWindowTokens),
          promptTokens: asNumber(payload.promptTokens),
          promptTokenBudget: asNumber(payload.promptTokenBudget),
          maxOutputTokens: asNumber(payload.maxOutputTokens),
          safetyMarginTokens: asNumber(payload.safetyMarginTokens),
          sections: parseUsageSections(payload.sections),
        });
        break;
      }

      case WS_TOOLS_EXECUTING: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        if (asString(payload.subagentSessionId)) {
          // Sub-agent tools are rendered from subagents.tool.* lifecycle events.
          // Ignore duplicated top-level tools.* events to avoid UI spam.
          break;
        }
        const toolCallId = payload.toolCallId
          ? `${payload.toolCallId}`
          : undefined;
        const toolCall: ToolCall = {
          toolCallId,
          toolName: (payload.toolName as string) ?? 'unknown',
          args: (payload.args as Record<string, unknown>) ?? {},
          status: 'executing',
        };
        setMessages((prev) => {
          const copy = [...prev];

          // If we already have a pending placeholder for this round, append to it
          const pendingId = pendingMsgIdRef.current;
          if (pendingId) {
            const idx = copy.findIndex((m) => m.id === pendingId);
            if (idx !== -1) {
              copy[idx] = {
                ...copy[idx],
                toolCalls: [...(copy[idx].toolCalls ?? []), toolCall],
              };
              return copy;
            }
          }

          // Find the last agent and user message indices
          let lastAgentIdx = -1;
          let lastUserIdx = -1;
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].sender === 'agent' && lastAgentIdx === -1) lastAgentIdx = i;
            if (copy[i].sender === 'user' && lastUserIdx === -1) lastUserIdx = i;
            if (lastAgentIdx !== -1 && lastUserIdx !== -1) break;
          }

          // If user sent a message AFTER the last agent message, this is a
          // new response round — create a placeholder agent message for it.
          if (lastUserIdx > lastAgentIdx) {
            const newId = `agent_${++msgCounterRef.current}`;
            pendingMsgIdRef.current = newId;
            copy.push({
              id: newId,
              content: '',
              sender: 'agent',
              timestamp: Date.now(),
              toolCalls: [toolCall],
            });
          } else if (lastAgentIdx !== -1) {
            copy[lastAgentIdx] = {
              ...copy[lastAgentIdx],
              toolCalls: [...(copy[lastAgentIdx].toolCalls ?? []), toolCall],
            };
          } else {
            const newId = `agent_${++msgCounterRef.current}`;
            pendingMsgIdRef.current = newId;
            copy.push({
              id: newId,
              content: '',
              sender: 'agent',
              timestamp: Date.now(),
              toolCalls: [toolCall],
            });
          }
          return copy;
        });
        break;
      }

      case WS_TOOLS_RESULT: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        if (asString(payload.subagentSessionId)) {
          break;
        }
        const toolCallId = payload.toolCallId
          ? `${payload.toolCallId}`
          : undefined;
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const tc = copy[i].toolCalls;
            if (tc) {
              const executing = tc.find((t) => {
                if (toolCallId) {
                  return t.toolCallId === toolCallId && t.status === 'executing';
                }
                return (
                  t.toolName === (payload.toolName as string)
                  && t.status === 'executing'
                );
              });
              if (executing) {
                executing.result = (payload.result as string) ?? '';
                executing.durationMs = payload.durationMs as number;
                executing.isError = payload.isError as boolean;
                executing.status = 'completed';
                break;
              }
            }
          }
          return copy;
        });
        break;
      }
    }
  }, [send]);

  return {
    messages, sendMessage, stopGeneration, injectMessage, replaceLastUserMessage, isTyping, sessionId,
    sessions, refreshSessions, resumeSession, startNewChat, tokenUsage,
    handleMessage,
  };
}
