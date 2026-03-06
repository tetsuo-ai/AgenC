import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../../types';
import { ChatMessage } from './ChatMessage';

const AUTO_SCROLL_THRESHOLD_PX = 96;

interface MessageListProps {
  messages: ChatMessageType[];
  isTyping: boolean;
  theme?: 'light' | 'dark';
  searchQuery?: string;
}

export function MessageList({ messages, isTyping, theme = 'dark', searchQuery = '' }: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const query = searchQuery.trim().toLowerCase();

  const filtered = useMemo(
    () => (query ? messages.filter((m) => m.content.toLowerCase().includes(query)) : messages),
    [messages, query],
  );

  const updateStickToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    updateStickToBottom();
  }, [updateStickToBottom]);

  useEffect(() => {
    if (query || !stickToBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, query]);

  return (
    <div
      ref={scrollContainerRef}
      data-testid="message-list-scroll-container"
      className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6"
      onScroll={updateStickToBottom}
    >
      <div className="space-y-3">
        {filtered.length === 0 && !query && (
          <div className="flex items-center justify-center h-full text-bbs-gray text-xs">
            {'>'} Send a message to start the conversation
          </div>
        )}

        {filtered.length === 0 && query && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-xs text-bbs-gray">No messages match "{searchQuery.trim()}"</span>
          </div>
        )}

        {filtered.map((msg) => (
          <ChatMessage key={msg.id} message={msg} theme={theme} searchQuery={query} />
        ))}

        {isTyping && (
          <div className="animate-msg-agent text-sm">
            <span className="text-bbs-purple font-bold">AGENT{'>'} </span>
            <span className="text-bbs-purple">
              <span className="animate-typing-dot inline-block" style={{ animationDelay: '0ms' }}>.</span>
              <span className="animate-typing-dot inline-block" style={{ animationDelay: '200ms' }}>.</span>
              <span className="animate-typing-dot inline-block" style={{ animationDelay: '400ms' }}>.</span>
            </span>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}
