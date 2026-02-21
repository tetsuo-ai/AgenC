import { useState } from 'react';
import type { ActivityEvent } from '../../types';

interface EventCardProps {
  event: ActivityEvent;
}

const EVENT_META: Record<string, { icon: string; color: string; label: string }> = {
  'chat.inbound': { icon: '↓', color: 'text-blue-500 bg-blue-500/10', label: 'Chat Inbound' },
  'chat.response': { icon: '↑', color: 'text-emerald-500 bg-emerald-500/10', label: 'Chat Response' },
  'tool.executed': { icon: '⚡', color: 'text-amber-500 bg-amber-500/10', label: 'Tool Executed' },
  'task.created': { icon: '+', color: 'text-emerald-500 bg-emerald-500/10', label: 'Task Created' },
  'task.cancelled': { icon: '×', color: 'text-red-500 bg-red-500/10', label: 'Task Cancelled' },
  taskCreated: { icon: '+', color: 'text-emerald-500 bg-emerald-500/10', label: 'Task Created' },
  taskCompleted: { icon: '✓', color: 'text-blue-500 bg-blue-500/10', label: 'Task Completed' },
  taskCancelled: { icon: '×', color: 'text-red-500 bg-red-500/10', label: 'Task Cancelled' },
  taskClaimed: { icon: '→', color: 'text-amber-500 bg-amber-500/10', label: 'Task Claimed' },
  disputeInitiated: { icon: '!', color: 'text-red-500 bg-red-500/10', label: 'Dispute Initiated' },
  disputeResolved: { icon: '✓', color: 'text-blue-500 bg-blue-500/10', label: 'Dispute Resolved' },
  agentRegistered: { icon: '+', color: 'text-emerald-500 bg-emerald-500/10', label: 'Agent Registered' },
  agentUpdated: { icon: '↻', color: 'text-amber-500 bg-amber-500/10', label: 'Agent Updated' },
};

function truncateId(id: string, len = 12): string {
  if (id.length <= len * 2 + 3) return id;
  return `${id.slice(0, len)}...${id.slice(-len)}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-1.5 text-tetsuo-300 hover:text-accent transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-500">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/** Known fields we render in structured rows instead of raw JSON. */
const KNOWN_FIELDS = new Set(['sessionId', 'toolName', 'durationMs', 'taskPda', 'description']);

export function EventCard({ event }: EventCardProps) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const meta = EVENT_META[event.eventType] ?? { icon: '•', color: 'text-accent bg-accent-bg', label: event.eventType };
  const { sessionId, toolName, durationMs, taskPda, description, ...rest } = event.data as Record<string, string | number>;
  const hasExtra = Object.keys(rest).length > 0;

  return (
    <div className="px-4 py-3 rounded-xl border border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 hover:shadow-sm">
      {/* Header: badge + time */}
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${meta.color}`}>
          <span className="text-[11px]">{meta.icon}</span>
          {meta.label}
        </span>
        <span className="text-[10px] text-tetsuo-400 font-mono shrink-0">{time}</span>
      </div>

      {/* Structured fields */}
      <div className="mt-2 space-y-1.5">
        {toolName && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-tetsuo-400 shrink-0">Tool</span>
            <span className="font-mono font-medium text-tetsuo-700">{String(toolName)}</span>
            {durationMs != null && (
              <span className="text-tetsuo-400 ml-auto">{Number(durationMs).toLocaleString()}ms</span>
            )}
          </div>
        )}
        {description && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-tetsuo-400 shrink-0">Desc</span>
            <span className="text-tetsuo-700 truncate">{String(description)}</span>
          </div>
        )}
        {taskPda && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-tetsuo-400 shrink-0">Task</span>
            <span className="font-mono text-tetsuo-600 truncate">{truncateId(String(taskPda))}</span>
            <CopyButton value={String(taskPda)} />
          </div>
        )}
        {sessionId && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-tetsuo-400 shrink-0">Session</span>
            <span className="font-mono text-tetsuo-500 truncate">{truncateId(String(sessionId))}</span>
            <CopyButton value={String(sessionId)} />
          </div>
        )}
      </div>

      {/* Extra fields as compact key-value */}
      {hasExtra && (
        <div className="mt-2 bg-tetsuo-100/50 rounded-lg px-2.5 py-2 space-y-1">
          {Object.entries(rest).map(([key, val]) => (
            <div key={key} className="flex items-center gap-2 text-[11px]">
              <span className="text-tetsuo-400">{key}</span>
              <span className="font-mono text-tetsuo-600 truncate">{typeof val === 'object' ? JSON.stringify(val) : String(val)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
