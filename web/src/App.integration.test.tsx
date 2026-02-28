import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WSMessage } from './types';
import App from './App';

let capturedOnMessage: ((msg: WSMessage) => void) | null = null;
let chatMessages: MockChatViewMessage[] = [];
let chatIsTyping = false;

interface MockChatViewMessage {
  id: string;
  sender: 'user' | 'agent';
  content: string;
  toolCalls?: Array<{ toolName: string; status: 'executing' | 'completed'; toolCallId?: string; result?: string }>;
}

vi.mock('./hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage?: (msg: WSMessage) => void }) => {
    capturedOnMessage = onMessage ?? null;
    return {
      state: 'connected',
      send: () => {},
      lastMessage: null,
    };
  },
}));

vi.mock('./hooks/useVoice', () => ({
  useVoice: () => ({
    isVoiceActive: false,
    isRecording: false,
    isSpeaking: false,
    voiceState: 'inactive',
    transcript: '',
    delegationTask: '',
    startVoice: () => {},
    stopVoice: () => {},
    mode: 'vad',
    setMode: () => {},
    pushToTalkStart: () => {},
    pushToTalkStop: () => {},
    handleMessage: () => {},
  }),
}));

vi.mock('./components/chat/ChatView', () => ({
  ChatView: ({ messages, isTyping }: { messages: MockChatViewMessage[]; isTyping: boolean }) => {
    chatMessages = messages;
    chatIsTyping = isTyping;
    return (
      <div>
        <div data-testid="chat-messages">{JSON.stringify(messages)}</div>
      </div>
    );
  },
}));

beforeEach(() => {
  capturedOnMessage = null;
  chatMessages = [];
  chatIsTyping = false;
});

describe('App websocket integration', () => {
  it('routes tool call updates to the chat stream by toolCallId', () => {
    render(<App />);

    expect(capturedOnMessage).toBeTypeOf('function');

    act(() => {
      capturedOnMessage!({
        type: 'tools.executing',
        payload: {
          toolName: 'system.task',
          toolCallId: 'tool-b',
          args: { round: 'b' },
        },
      });
      capturedOnMessage!({
        type: 'tools.executing',
        payload: {
          toolName: 'system.task',
          toolCallId: 'tool-a',
          args: { round: 'a' },
        },
      });
      capturedOnMessage!({
        type: 'tools.result',
        payload: {
          toolName: 'system.task',
          toolCallId: 'tool-a',
          result: 'result-a',
          durationMs: 11,
        },
      });
      capturedOnMessage!({
        type: 'tools.result',
        payload: {
          toolName: 'system.task',
          toolCallId: 'tool-b',
          result: 'result-b',
          durationMs: 22,
        },
      });
    });

    expect(chatMessages).toHaveLength(1);
    const toolCalls = chatMessages[0]?.toolCalls ?? [];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolName: 'system.task',
      toolCallId: 'tool-b',
      status: 'completed',
      result: 'result-b',
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: 'system.task',
      toolCallId: 'tool-a',
      status: 'completed',
      result: 'result-a',
    });
  });

  it('bridges voice transcripts to chat and suppresses delegated completion text', () => {
    render(<App />);

    act(() => {
      capturedOnMessage!({ type: 'voice.speech_stopped' });
    });

    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0]?.content).toBe('[Voice]');

    act(() => {
      capturedOnMessage!({ type: 'voice.user_transcript', payload: { text: 'live user text' } });
    });

    expect(chatMessages[0]?.content).toBe('live user text');

    act(() => {
      capturedOnMessage!({ type: 'voice.transcript', payload: { done: true, text: 'agent response' } });
    });

    expect(chatMessages).toHaveLength(2);
    expect(chatMessages[1]?.content).toBe('agent response');
    expect(chatIsTyping).toBe(false);

    act(() => {
      capturedOnMessage!({ type: 'voice.delegation', payload: { status: 'completed' } });
      capturedOnMessage!({ type: 'voice.transcript', payload: { done: true, text: 'delegated response should suppress' } });
    });

    expect(chatMessages).toHaveLength(2);
    expect(
      chatMessages.some((m) => m.content === 'delegated response should suppress'),
    ).toBe(false);
  });
});
