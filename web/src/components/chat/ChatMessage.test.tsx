import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatMessage } from './ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../types';

describe('ChatMessage', () => {
  it('renders markdown content for agent messages', () => {
    const message: ChatMessageType = {
      id: '1',
      sender: 'agent',
      content: '# Hello\n\nThis is **bold** markdown.',
      timestamp: Date.now(),
    };

    render(<ChatMessage message={message} />);
    expect(screen.getByText(/AGENT RESPONSE/)).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeDefined();
    expect(screen.getByText(/bold/i)).toBeDefined();
  });

  it('renders attached tool calls with execution status', () => {
    const message: ChatMessageType = {
      id: '2',
      sender: 'agent',
      content: 'Running a tool',
      timestamp: Date.now(),
      toolCalls: [
        {
          toolName: 'agenc.listTasks',
          status: 'executing',
          args: { page: 1 },
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText(/TOOL CALLS/)).toBeDefined();
    const toolCallButton = screen.getByRole('button', { name: /TOOL CALLS/i });
    fireEvent.click(toolCallButton);
    expect(screen.getByText('agenc.listTasks')).toBeDefined();
  });

  it('keeps subagent tool details collapsed until explicitly expanded', () => {
    const message: ChatMessageType = {
      id: '3',
      sender: 'agent',
      content: 'Delegated task',
      timestamp: Date.now(),
      subagents: [
        {
          subagentSessionId: 'subagent:child-1',
          status: 'running',
          objective: 'Collect diagnostics',
          tools: [
            {
              toolName: 'desktop.bash',
              toolCallId: 'tc-1',
              args: { command: 'echo hi' },
              status: 'completed',
              result: 'ok',
              durationMs: 12,
            },
          ],
          events: [],
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.queryByText('desktop.bash')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /SUBAGENTS/i }));
    expect(screen.getByText('[+] Show tools (1)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /show tools/i }));
    expect(screen.getByText('desktop.bash')).toBeDefined();
  });
});
