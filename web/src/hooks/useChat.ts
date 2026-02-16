import { useCallback, useState } from 'react';
import type { ChatMessage, ToolCall, WSMessage } from '../types';

let msgCounter = 0;

export interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (content: string) => void;
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

  const sendMessage = useCallback((content: string) => {
    const id = `user_${++msgCounter}`;
    const userMsg: ChatMessage = {
      id,
      content,
      sender: 'user',
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    send({ type: 'chat.message', payload: { content } });
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
