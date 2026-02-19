import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage as ChatMessageType } from '../../types';
import { ToolCallCard } from './ToolCallCard';

interface ChatMessageProps {
  message: ChatMessageType;
  theme?: 'light' | 'dark';
}

export function ChatMessage({ message, theme = 'light' }: ChatMessageProps) {
  const isUser = message.sender === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleCopy = useCallback(() => {
    if (message.content) {
      void navigator.clipboard.writeText(message.content);
    }
  }, [message.content]);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse animate-msg-user' : 'flex-row animate-msg-agent'}`}>
      {/* Avatar */}
      {isUser ? (
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold bg-accent text-white">
          U
        </div>
      ) : (
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-tetsuo-100">
          <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-5 h-5 dark:hidden" />
          <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-5 h-5 hidden dark:block" />
        </div>
      )}

      {/* Message content */}
      <div className={`flex flex-col gap-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className="flex items-center gap-2 text-xs text-tetsuo-400">
          {isUser ? (
            <span className="font-medium text-tetsuo-600">You</span>
          ) : (
            <img src="/assets/agenc-wordmark.svg" alt="AgenC" className="h-3 dark:invert opacity-90" />
          )}
          <span>{time}</span>
        </div>

        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-accent text-white rounded-tr-sm'
              : 'bg-tetsuo-50 text-tetsuo-800 border border-tetsuo-200 rounded-tl-sm'
          }`}
        >
          {message.content && (
            <ReactMarkdown
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const inline = !match;
                  return inline ? (
                    <code
                      className="bg-tetsuo-200/60 px-1.5 py-0.5 rounded text-xs text-accent font-medium"
                      {...props}
                    >
                      {children}
                    </code>
                  ) : (
                    <SyntaxHighlighter
                      style={theme === 'dark' ? oneDark : oneLight}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{ margin: '0.5rem 0', borderRadius: '0.75rem', fontSize: '0.75rem' }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                },
                p({ children }) {
                  return <p className="mb-2 last:mb-0">{children}</p>;
                },
                ul({ children }) {
                  return <ul className="list-disc list-inside mb-2">{children}</ul>;
                },
                ol({ children }) {
                  return <ol className="list-decimal list-inside mb-2">{children}</ol>;
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}

          {message.toolCalls?.map((tc, i) => (
            <ToolCallCard key={`${tc.toolName}-${i}`} toolCall={tc} />
          ))}
        </div>

        {/* Action toolbar (agent messages only) */}
        {!isUser && message.content && (
          <div className="flex items-center gap-1 mt-1 animate-msg-fade-up">
            <ActionButton title="Read aloud" onClick={() => {}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </ActionButton>
            <ActionButton title="Copy" onClick={handleCopy}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </ActionButton>
            <ActionButton title="Regenerate" onClick={() => {}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </ActionButton>
            <ActionButton title="Bad response" onClick={() => {}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="w-7 h-7 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors"
    >
      {children}
    </button>
  );
}
