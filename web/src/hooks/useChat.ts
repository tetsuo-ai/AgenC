import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMessageAttachment, TokenUsage, ToolCall, WSMessage } from '../types';
import {
  WS_CHAT_MESSAGE,
  WS_CHAT_TYPING,
  WS_CHAT_HISTORY,
  WS_CHAT_SESSION,
  WS_CHAT_RESUME,
  WS_CHAT_RESUMED,
  WS_CHAT_SESSIONS,
  WS_CHAT_CANCELLED,
  WS_CHAT_CANCEL,
  WS_CHAT_USAGE,
  WS_TOOLS_EXECUTING,
  WS_TOOLS_RESULT,
} from '../constants';

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

export function useChat({ send, connected }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  // Tracks the placeholder message ID for the current response round
  const pendingMsgIdRef = useRef<string | null>(null);
  const msgCounterRef = useRef(0);

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
  }, []);

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
      send({ type: WS_CHAT_MESSAGE, payload: { content } });
      return;
    }

    // Read files as base64, build display attachments, then send
    const readers = files.map(
      (file) =>
        new Promise<{ wire: ChatAttachment; display: ChatMessageAttachment }>((resolve, reject) => {
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
        }),
    );

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
        payload: {
          content,
          attachments: results.map((r) => r.wire),
        },
      });
    });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
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
          totalTokens: (payload.totalTokens as number) ?? 0,
          budget: (payload.budget as number) ?? 0,
          compacted: (payload.compacted as boolean) ?? false,
        });
        break;
      }

      case WS_TOOLS_EXECUTING: {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
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
