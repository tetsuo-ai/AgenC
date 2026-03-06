import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from '../../types';

describe('MessageList', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows empty state when there are no messages', () => {
    render(<MessageList messages={[]} isTyping={false} />);

    expect(screen.getByText(/Send a message to start the conversation/)).toBeDefined();
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

  it('keeps following the latest messages when the user is already near the bottom', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const initialMessages: ChatMessage[] = [
      { id: '1', sender: 'user', content: 'alpha', timestamp: 1 },
    ];
    const nextMessages: ChatMessage[] = [
      ...initialMessages,
      { id: '2', sender: 'agent', content: 'beta', timestamp: 2 },
    ];

    const view = render(<MessageList messages={initialMessages} isTyping={false} />);
    const container = view.getByTestId('message-list-scroll-container');

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 640 });

    scrollSpy.mockClear();
    fireEvent.scroll(container);
    view.rerender(<MessageList messages={nextMessages} isTyping={false} />);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('does not yank the user back to the bottom when they scrolled up', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const initialMessages: ChatMessage[] = [
      { id: '1', sender: 'user', content: 'alpha', timestamp: 1 },
    ];
    const nextMessages: ChatMessage[] = [
      ...initialMessages,
      { id: '2', sender: 'agent', content: 'beta', timestamp: 2 },
    ];

    const view = render(<MessageList messages={initialMessages} isTyping={false} />);
    const container = view.getByTestId('message-list-scroll-container');

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 120 });

    scrollSpy.mockClear();
    fireEvent.scroll(container);
    view.rerender(<MessageList messages={nextMessages} isTyping={false} />);

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
