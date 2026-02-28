import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../../types';

describe('MessageList', () => {
  it('shows empty state when there are no messages', () => {
    render(<MessageList messages={[]} isTyping={false} />);

    expect(screen.getByText('Send a message to start the conversation')).toBeDefined();
  });

  it('shows filtering message when query misses all messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', sender: 'user', content: 'first message', timestamp: 1 },
      { id: '2', sender: 'agent', content: 'second message', timestamp: 2 },
    ];

    render(<MessageList messages={messages} isTyping={false} searchQuery="non-match" />);

    expect(screen.getByText('No messages match "non-match"')).toBeDefined();
  });

  it('filters messages by query text', () => {
    const messages: ChatMessage[] = [
      { id: '1', sender: 'user', content: 'alpha', timestamp: 1 },
      { id: '2', sender: 'agent', content: 'beta', timestamp: 2 },
    ];

    render(<MessageList messages={messages} isTyping={false} searchQuery="beta" />);

    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.queryByText('alpha')).toBeNull();
  });
});
