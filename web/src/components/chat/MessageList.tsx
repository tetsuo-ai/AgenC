import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../../types';
import { ChatMessage } from './ChatMessage';

interface MessageListProps {
  messages: ChatMessageType[];
  isTyping: boolean;
  theme?: 'light' | 'dark';
  searchQuery?: string;
}

export function MessageList({ messages, isTyping, theme = 'light', searchQuery = '' }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const query = searchQuery.trim().toLowerCase();

  const filtered = useMemo(
    () => (query ? messages.filter((m) => m.content.toLowerCase().includes(query)) : messages),
    [messages, query],
  );

  useEffect(() => {
    if (!query) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, query]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6 space-y-4 md:space-y-6">
      {filtered.length === 0 && !query && (
        <div className="flex items-center justify-center h-full text-tetsuo-400 text-sm">
          Send a message to start the conversation
        </div>
      )}

      {filtered.length === 0 && query && (
        <div className="flex flex-col items-center justify-center h-full gap-2">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-300" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span className="text-sm text-tetsuo-400">No messages match "{searchQuery.trim()}"</span>
        </div>
      )}

      {filtered.map((msg) => (
        <ChatMessage key={msg.id} message={msg} theme={theme} searchQuery={query} />
      ))}

      {isTyping && (
        <div className="flex items-start gap-3 animate-msg-agent">
          <div className="w-8 h-8 rounded-full bg-tetsuo-100 flex items-center justify-center">
            <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-5 h-5 dark:hidden" />
            <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-5 h-5 hidden dark:block" />
          </div>
          <div className="bg-tetsuo-50 border border-tetsuo-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-accent animate-typing-dot" style={{ animationDelay: '200ms' }} />
              <span className="w-2 h-2 rounded-full bg-accent animate-typing-dot" style={{ animationDelay: '400ms' }} />
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
