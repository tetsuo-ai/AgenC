import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';

vi.mock('./MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock('./ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('./VoiceOverlay', () => ({
  VoiceOverlay: () => <div data-testid="voice-overlay" />,
}));

vi.mock('./DesktopPanel', () => ({
  DesktopPanel: () => <div data-testid="desktop-panel" />,
}));

describe('ChatView delegation summary', () => {
  it('shows a multi-agent summary when subagents are present', () => {
    render(
      <ChatView
        messages={[
          {
            id: 'agent-1',
            sender: 'agent',
            content: 'Delegating...',
            timestamp: Date.now(),
            subagents: [
              {
                subagentSessionId: 'subagent:1',
                status: 'running',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:2',
                status: 'started',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:3',
                status: 'failed',
                tools: [],
                events: [],
              },
            ],
          },
        ]}
        isTyping={false}
        onSend={vi.fn()}
        connected
      />,
    );

    expect(screen.getAllByText(/3 agents: 2 running/).length).toBeGreaterThan(0);
  });

  it('shows delegation summary for the latest subagent run only', () => {
    render(
      <ChatView
        messages={[
          {
            id: 'agent-old',
            sender: 'agent',
            content: 'Old run',
            timestamp: Date.now() - 10_000,
            subagents: [
              {
                subagentSessionId: 'subagent:old-1',
                status: 'completed',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:old-2',
                status: 'completed',
                tools: [],
                events: [],
              },
            ],
          },
          {
            id: 'agent-new',
            sender: 'agent',
            content: 'New run',
            timestamp: Date.now(),
            subagents: [
              {
                subagentSessionId: 'subagent:new-1',
                status: 'running',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:new-2',
                status: 'running',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:new-3',
                status: 'completed',
                tools: [],
                events: [],
              },
              {
                subagentSessionId: 'subagent:new-4',
                status: 'completed',
                tools: [],
                events: [],
              },
            ],
          },
        ]}
        isTyping={false}
        onSend={vi.fn()}
        connected
      />,
    );

    expect(screen.getAllByText(/4 agents: 2 running/).length).toBeGreaterThan(0);
  });
});
