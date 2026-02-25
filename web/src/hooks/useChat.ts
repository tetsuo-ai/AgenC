import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMessageAttachment, ToolCall, WSMessage } from '../types';

let msgCounter = 0;

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
  isTyping: boolean;
  sessionId: string | null;
  sessions: ChatSessionInfo[];
  refreshSessions: () => void;
  resumeSession: (sessionId: string) => void;
  startNewChat: () => void;
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
  // Tracks the placeholder message ID for the current response round
  const pendingMsgIdRef = useRef<string | null>(null);

  const refreshSessions = useCallback(() => {
    send({ type: 'chat.sessions' });
  }, [send]);

  // Fetch sessions when connected
  useEffect(() => {
    if (connected) refreshSessions();
  }, [connected, refreshSessions]);

  const resumeSession = useCallback((targetSessionId: string) => {
    send({ type: 'chat.resume', payload: { sessionId: targetSessionId } });
  }, [send]);

  const startNewChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setIsTyping(false);
  }, []);

  const stopGeneration = useCallback(() => {
    send({ type: 'chat.cancel' });
    setIsTyping(false);
  }, [send]);

  const sendMessage = useCallback((content: string, files?: File[]) => {
    if (!files || files.length === 0) {
      const id = `user_${++msgCounter}`;
      const userMsg: ChatMessage = { id, content, sender: 'user', timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      send({ type: 'chat.message', payload: { content } });
      return;
    }

    // Read files as base64, build display attachments, then send
    const readers = files.map(
      (file) =>
        new Promise<{ wire: ChatAttachment; display: ChatMessageAttachment & { dataUrl: string } }>((resolve, reject) => {
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
                dataUrl: file.type.startsWith('image/') ? dataUrl : undefined!,
              },
            });
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    );

    void Promise.all(readers).then((results) => {
      const id = `user_${++msgCounter}`;
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
        type: 'chat.message',
        payload: {
          content,
          attachments: results.map((r) => r.wire),
        },
      });
    });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'chat.message': {
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
            id: `agent_${++msgCounter}`,
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

      case 'chat.typing': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        setIsTyping(!!payload.active);
        break;
      }

      case 'chat.history': {
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

      case 'chat.session': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const id = (payload.sessionId as string) ?? null;
        if (id) setSessionId(id);
        break;
      }

      case 'chat.resumed': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const resumedId = (payload.sessionId as string) ?? null;
        setSessionId(resumedId);
        // Fetch history for the resumed session
        if (resumedId) {
          send({ type: 'chat.history' });
        }
        break;
      }

      case 'chat.sessions': {
        const payload = msg.payload as ChatSessionInfo[];
        if (Array.isArray(payload)) {
          setSessions(payload);
        }
        break;
      }

      case 'chat.cancelled': {
        setIsTyping(false);
        break;
      }

      case 'tools.executing': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const toolCall: ToolCall = {
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
            const newId = `agent_${++msgCounter}`;
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
            const newId = `agent_${++msgCounter}`;
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

      case 'tools.result': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const tc = copy[i].toolCalls;
            if (tc) {
              const executing = tc.find(
                (t) => t.toolName === payload.toolName && t.status === 'executing',
              );
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
    messages, sendMessage, stopGeneration, isTyping, sessionId,
    sessions, refreshSessions, resumeSession, startNewChat,
    handleMessage,
  } as UseChatReturn & { handleMessage: (msg: WSMessage) => void };
}
