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
    expect(screen.getAllByRole('img', { name: 'AgenC' }).length).toBeGreaterThan(0);
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

    expect(screen.getByText('1 tool call', { exact: false })).toBeDefined();
    const toolCallButton = screen.getByRole('button', { name: /tool call/i });
    fireEvent.click(toolCallButton);
    expect(screen.getByText('agenc.listTasks')).toBeDefined();
  });
});
