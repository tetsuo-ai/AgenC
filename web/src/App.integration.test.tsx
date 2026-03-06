import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WSMessage } from './types';
import { WS_DESKTOP_LIST } from './constants';
import App from './App';

let capturedOnMessage: ((msg: WSMessage) => void) | null = null;
let chatMessages: MockChatViewMessage[] = [];
let chatIsTyping = false;
let chatDesktopOpen = false;
let mockVoiceActive = false;

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
    isVoiceActive: mockVoiceActive,
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
  ChatView: ({
    messages,
    isTyping,
    desktopOpen,
  }: {
    messages: MockChatViewMessage[];
    isTyping: boolean;
    desktopOpen?: boolean;
  }) => {
    chatMessages = messages;
    chatIsTyping = isTyping;
    chatDesktopOpen = Boolean(desktopOpen);
    return (
      <div>
        <textarea data-chat-composer="true" defaultValue="" />
        <div data-testid="desktop-open">{desktopOpen ? 'open' : 'closed'}</div>
        <div data-testid="chat-messages">{JSON.stringify(messages)}</div>
      </div>
    );
  },
}));

beforeEach(() => {
  capturedOnMessage = null;
  chatMessages = [];
  chatIsTyping = false;
  chatDesktopOpen = false;
  mockVoiceActive = false;
});

afterEach(() => {
  cleanup();
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

  it('ignores top-level tool updates marked as subagent activity', () => {
    render(<App />);

    expect(capturedOnMessage).toBeTypeOf('function');

    act(() => {
      capturedOnMessage!({
        type: 'tools.executing',
        payload: {
          toolName: 'desktop.bash',
          toolCallId: 'sub-tool-1',
          subagentSessionId: 'subagent:child-1',
          args: { command: 'echo hi' },
        },
      });
      capturedOnMessage!({
        type: 'tools.result',
        payload: {
          toolName: 'desktop.bash',
          toolCallId: 'sub-tool-1',
          subagentSessionId: 'subagent:child-1',
          result: 'ok',
          durationMs: 10,
        },
      });
    });

    expect(chatMessages).toHaveLength(0);
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

  it('restores composer focus when a desktop auto-opens while the user is typing', async () => {
    mockVoiceActive = true;
    const view = render(<App />);

    const composer = view.container.querySelector('textarea[data-chat-composer="true"]') as HTMLTextAreaElement | null;
    expect(composer).toBeTruthy();
    if (!composer) {
      throw new Error('Expected chat composer textarea');
    }
    fireEvent.change(composer, { target: { value: 'typing now' } });
    composer.focus();
    composer.setSelectionRange(6, 6);

    expect(document.activeElement).toBe(composer);
    expect(screen.getByTestId('desktop-open').textContent).toBe('closed');

    act(() => {
      capturedOnMessage?.({
        type: WS_DESKTOP_LIST,
        payload: [
          {
            containerId: 'desktop-1',
            sessionId: 'other-session',
            status: 'ready',
            createdAt: 0,
            lastActivityAt: 0,
            vncUrl: 'http://desktop.local',
            uptimeMs: 0,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(chatDesktopOpen).toBe(true);
      expect(screen.getByTestId('desktop-open').textContent).toBe('open');
      expect(document.activeElement).toBe(composer);
    });

    expect(composer.selectionStart).toBe(6);
    expect(composer.selectionEnd).toBe(6);
  });
});
