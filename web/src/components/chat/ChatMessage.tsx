import { useCallback, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage as ChatMessageType, SubagentTimelineItem, ToolCall } from '../../types';
import { ToolCallCard } from './ToolCallCard';

/** Allow data: URLs (for inline screenshots) in addition to the default safe protocols. */
function urlTransform(url: string): string {
  if (url.startsWith('data:')) return url;
  return defaultUrlTransform(url);
}

interface ExtractedContent {
  text: string;
  images: string[];
}

function extractInlineImages(content: string): ExtractedContent {
  const images: string[] = [];
  const text = content.replace(/!\[([^\]]*)\]\((data:image\/[^)]{200,})\)/g, (_match, _alt, url) => {
    images.push(url as string);
    return '';
  });
  return { text: text.trim(), images };
}

function extractScreenshotsFromToolCalls(toolCalls: ToolCall[] | undefined): string[] {
  if (!toolCalls) return [];
  const urls: string[] = [];
  for (const tc of toolCalls) {
    if (tc.toolName !== 'desktop.screenshot' || !tc.result) continue;
    try {
      let obj = JSON.parse(tc.result) as Record<string, unknown>;
      if (typeof obj.content === 'string') {
        try { obj = JSON.parse(obj.content) as Record<string, unknown>; } catch { /* */ }
      }
      if (typeof obj.dataUrl === 'string' && obj.dataUrl.startsWith('data:image/')) {
        urls.push(obj.dataUrl);
      } else if (typeof obj.image === 'string' && obj.image.length > 100) {
        urls.push(`data:image/png;base64,${obj.image}`);
      }
    } catch { /* not JSON */ }
  }
  return urls;
}

interface ChatMessageProps {
  message: ChatMessageType;
  theme?: 'light' | 'dark';
  searchQuery?: string;
}

function formatElapsedMs(elapsedMs: number | undefined): string | null {
  if (elapsedMs === undefined) return null;
  if (elapsedMs < 1000) return `${elapsedMs.toLocaleString()}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs >= 10_000 ? 0 : 1)}s`;
}

export function ChatMessage({ message, theme: _theme = 'dark', searchQuery = '' }: ChatMessageProps) {
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

  const { text: markdownText, images: inlineImages } = useMemo(
    () => (message.content ? extractInlineImages(message.content) : { text: '', images: [] }),
    [message.content],
  );

  const screenshotImages = useMemo(
    () => extractScreenshotsFromToolCalls(message.toolCalls),
    [message.toolCalls],
  );

  const allImages = useMemo(
    () => [...screenshotImages, ...inlineImages],
    [screenshotImages, inlineImages],
  );

  // ── User message ──
  if (isUser) {
    return (
      <div className={`animate-msg-user${searchQuery ? ' ring-1 ring-bbs-yellow/40' : ''}`}>
        <div className="text-sm leading-relaxed">
          <span className="text-bbs-orange font-bold">USER{'>'} </span>
          <span className="text-bbs-white">{message.content}</span>
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1 ml-6">
            {message.attachments.map((att, i) =>
              att.dataUrl ? (
                <img
                  key={`${att.filename}-${i}`}
                  src={att.dataUrl}
                  alt={att.filename}
                  className="max-h-[150px] max-w-[200px] border border-bbs-border"
                />
              ) : (
                <span
                  key={`${att.filename}-${i}`}
                  className="text-xs text-bbs-cyan"
                >
                  [{att.filename}]
                </span>
              ),
            )}
          </div>
        )}
        <div className="text-bbs-border text-xs mt-1 select-none">{'\u2500'.repeat(60)}</div>
      </div>
    );
  }

  // ── Agent message ──
  return (
    <div className={`animate-msg-agent${searchQuery ? ' ring-1 ring-bbs-yellow/40' : ''}`}>
      <div className="border border-bbs-purple-dim">
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-1 bg-bbs-purple-dim/40">
          <span className="text-xs text-bbs-white">
            {'\u2524'} AGENT RESPONSE {'\u251C'}
          </span>
          <span className="text-xs text-bbs-pink">{time}</span>
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          {/* Screenshots */}
          {allImages.map((src, i) => (
            <img
              key={`inline-img-${i}`}
              src={src}
              alt="Desktop screenshot"
              className="my-2 max-w-full border border-bbs-border"
            />
          ))}

          {/* Markdown content */}
          {markdownText && (
            <div className="text-[13px] leading-relaxed text-bbs-lightgray bbs-markdown">
              <ReactMarkdown
                urlTransform={urlTransform}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const inline = !match;
                    return inline ? (
                      <code
                        className="bg-bbs-surface px-1.5 py-0.5 text-xs text-bbs-cyan border border-bbs-border"
                        {...props}
                      >
                        {children}
                      </code>
                    ) : (
                      <SyntaxHighlighter
                        style={vscDarkPlus}
                        language={match[1]}
                        PreTag="div"
                        customStyle={{
                          margin: '0.5rem 0',
                          borderRadius: '0',
                          fontSize: '0.75rem',
                          border: '1px solid #2A2A3A',
                          background: '#111118',
                        }}
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    );
                  },
                  img({ src, alt, ...props }) {
                    return (
                      <img
                        src={src}
                        alt={alt || 'image'}
                        className="my-2 max-w-full border border-bbs-border"
                        {...props}
                      />
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
                  a({ href, children, ...props }) {
                    return (
                      <a href={href} className="text-bbs-cyan underline" {...props}>
                        {children}
                      </a>
                    );
                  },
                  strong({ children }) {
                    return <strong className="text-bbs-white font-bold">{children}</strong>;
                  },
                }}
              >
                {markdownText}
              </ReactMarkdown>
            </div>
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallGroup toolCalls={message.toolCalls} />
          )}

          {/* Subagents */}
          {message.subagents && message.subagents.length > 0 && (
            <SubagentGroup subagents={message.subagents} />
          )}

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {message.attachments.map((att, i) =>
                att.dataUrl ? (
                  <img
                    key={`${att.filename}-${i}`}
                    src={att.dataUrl}
                    alt={att.filename}
                    className="max-h-[150px] max-w-[200px] border border-bbs-border"
                  />
                ) : (
                  <span
                    key={`${att.filename}-${i}`}
                    className="text-xs text-bbs-cyan"
                  >
                    [{att.filename}]
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      {message.content && (
        <div className="flex items-center gap-3 mt-1 text-xs text-bbs-gray animate-msg-fade-up">
          <button onClick={handleCopy} className="hover:text-bbs-white transition-colors">[C]opy</button>
          <button className="hover:text-bbs-white transition-colors">[R]etry</button>
          <button className="hover:text-bbs-white transition-colors">[S]peak</button>
        </div>
      )}
    </div>
  );
}

function ToolCallGroup({ toolCalls }: { toolCalls: NonNullable<ChatMessageType['toolCalls']> }) {
  const [open, setOpen] = useState(false);
  const errorCount = toolCalls.filter((tc) => tc.isError).length;
  const executingCount = toolCalls.filter((tc) => tc.status === 'executing').length;
  const completedCount = Math.max(0, toolCalls.length - executingCount - errorCount);

  const statusText = executingCount > 0
    ? `${executingCount} RUNNING`
    : errorCount > 0
      ? `${errorCount} FAILED`
      : `${completedCount}/${toolCalls.length} PASSED`;

  const statusColor = executingCount > 0
    ? 'text-bbs-yellow'
    : errorCount > 0
      ? 'text-bbs-red'
      : 'text-bbs-green';

  return (
    <div className="mt-3 border border-bbs-green-dim">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-bbs-green-dim/30 text-xs hover:bg-bbs-green-dim/50 transition-colors"
      >
        <span className="text-bbs-white">
          {open ? '\u25BC' : '\u25B6'} {'\u2524'} TOOL CALLS {'\u251C'}
        </span>
        <span className={statusColor}>{statusText}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1">
          {toolCalls.map((tc, i) => (
            <ToolCallCard key={`${tc.toolName}-${i}`} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function subagentStatusText(status: SubagentTimelineItem['status']): { text: string; color: string } {
  switch (status) {
    case 'completed': return { text: '[COMPLETED]', color: 'text-bbs-green' };
    case 'synthesized': return { text: '[SYNTHESIZED]', color: 'text-bbs-cyan' };
    case 'failed':
    case 'cancelled': return { text: `[${status.toUpperCase()}]`, color: 'text-bbs-red' };
    case 'running':
    case 'started':
    case 'spawned': return { text: '[RUNNING]', color: 'text-bbs-yellow' };
    default: return { text: `[${status.toUpperCase()}]`, color: 'text-bbs-gray' };
  }
}

function SubagentGroup({ subagents }: { subagents: SubagentTimelineItem[] }) {
  const [open, setOpen] = useState(false);
  const [toolPanels, setToolPanels] = useState<Record<string, boolean>>({});
  const toggleToolPanel = (subagentSessionId: string) => {
    setToolPanels((prev) => ({ ...prev, [subagentSessionId]: !prev[subagentSessionId] }));
  };

  return (
    <div className="mt-3 border border-bbs-magenta-dim">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-bbs-magenta-dim/30 text-xs hover:bg-bbs-magenta-dim/50 transition-colors"
      >
        <span className="text-bbs-white">
          {open ? '\u25BC' : '\u25B6'} {'\u2524'} SUBAGENTS {'\u251C'}
        </span>
        <span className="text-bbs-magenta">{subagents.length} SPAWNED</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {subagents.map((item, index) => {
            const st = subagentStatusText(item.status);
            return (
              <div key={`${item.subagentSessionId}-${index}`} className="border border-bbs-border p-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-bbs-white font-bold">Agent {index + 1}</span>
                  <span className={st.color}>{st.text}</span>
                </div>
                <span className="block truncate font-mono text-[10px] text-bbs-gray mt-0.5">
                  {item.subagentSessionId}
                </span>
                {item.objective && (
                  <p className="mt-1 text-xs text-bbs-lightgray">{item.objective}</p>
                )}
                {(item.elapsedMs !== undefined || item.errorReason || item.outputSummary) && (
                  <div className="mt-1.5 space-y-0.5 text-[11px] text-bbs-gray">
                    {formatElapsedMs(item.elapsedMs) && (
                      <div>Elapsed: {formatElapsedMs(item.elapsedMs)}</div>
                    )}
                    {item.errorReason && (
                      <div className="text-bbs-red">Error: {item.errorReason}</div>
                    )}
                    {item.outputSummary && (
                      <div className="line-clamp-3 text-bbs-lightgray">Summary: {item.outputSummary}</div>
                    )}
                  </div>
                )}
                {item.tools.length > 0 && (
                  <div className="mt-2 border-t border-bbs-border pt-1.5">
                    <button
                      onClick={() => toggleToolPanel(item.subagentSessionId)}
                      className="text-[11px] text-bbs-gray hover:text-bbs-white transition-colors"
                    >
                      {toolPanels[item.subagentSessionId] ? '[-] Hide tools' : `[+] Show tools (${item.tools.length})`}
                    </button>
                    {toolPanels[item.subagentSessionId] && (
                      <div className="mt-1.5 space-y-0">
                        {item.tools.map((tool, toolIndex) => (
                          <ToolCallCard key={`${item.subagentSessionId}-${tool.toolCallId ?? toolIndex}`} toolCall={tool} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
