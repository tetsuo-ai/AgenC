import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage as ChatMessageType } from '../../types';
import { ToolCallCard } from './ToolCallCard';

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div className="flex items-center gap-2 text-xs text-tetsuo-500">
        <span>{isUser ? 'You' : 'Agent'}</span>
        <span>{time}</span>
      </div>

      <div
        className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-accent/20 text-tetsuo-100 border border-accent/30'
            : 'bg-tetsuo-800 text-tetsuo-100 border border-tetsuo-700'
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
                    className="bg-tetsuo-900 px-1.5 py-0.5 rounded text-xs text-accent-light"
                    {...props}
                  >
                    {children}
                  </code>
                ) : (
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                    customStyle={{ margin: '0.5rem 0', borderRadius: '0.375rem', fontSize: '0.75rem' }}
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
    </div>
  );
}
