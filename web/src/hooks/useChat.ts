import { useCallback, useState } from 'react';
import type { ChatMessage, ChatMessageAttachment, ToolCall, WSMessage } from '../types';

let msgCounter = 0;

export interface ChatAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
  sizeBytes: number;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (content: string, attachments?: File[]) => void;
  isTyping: boolean;
  sessionId: string | null;
}

interface UseChatOptions {
  send: (msg: Record<string, unknown>) => void;
}

export function useChat({ send }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

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
        const agentMsg: ChatMessage = {
          id: `agent_${++msgCounter}`,
          content: (payload.content as string) ?? '',
          sender: 'agent',
          timestamp: (payload.timestamp as number) ?? Date.now(),
        };
        setMessages((prev) => [...prev, agentMsg]);
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

      case 'chat.resumed': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        setSessionId((payload.sessionId as string) ?? null);
        break;
      }

      case 'tools.executing': {
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const toolCall: ToolCall = {
          toolName: (payload.toolName as string) ?? 'unknown',
          args: (payload.args as Record<string, unknown>) ?? {},
          status: 'executing',
        };
        // Attach to the last agent message, or create a system one
        setMessages((prev) => {
          const copy = [...prev];
          const lastAgent = [...copy].reverse().find((m) => m.sender === 'agent');
          if (lastAgent) {
            lastAgent.toolCalls = [...(lastAgent.toolCalls ?? []), toolCall];
          } else {
            copy.push({
              id: `tool_${++msgCounter}`,
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
  }, []);

  return { messages, sendMessage, isTyping, sessionId, handleMessage } as UseChatReturn & { handleMessage: (msg: WSMessage) => void };
}
