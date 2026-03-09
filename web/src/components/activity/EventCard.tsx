import { useState } from 'react';
import type { ActivityEvent } from '../../types';

interface EventCardProps {
  event: ActivityEvent;
}

const EVENT_META: Record<string, { icon: string; tone: string; label: string }> = {
  'chat.inbound': { icon: '↓', tone: 'text-bbs-cyan border-bbs-cyan/40', label: 'chat inbound' },
  'chat.response': { icon: '↑', tone: 'text-bbs-green border-bbs-green/40', label: 'chat response' },
  'tool.executed': { icon: '⚡', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'tool executed' },
  'task.created': { icon: '+', tone: 'text-bbs-green border-bbs-green/40', label: 'task created' },
  'task.cancelled': { icon: '×', tone: 'text-bbs-red border-bbs-red/40', label: 'task cancelled' },
  'subagents.planned': { icon: '⋯', tone: 'text-bbs-cyan border-bbs-cyan/40', label: 'subagent planned' },
  'subagents.spawned': { icon: '⧉', tone: 'text-bbs-cyan border-bbs-cyan/40', label: 'subagent spawned' },
  'subagents.started': { icon: '▶', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'subagent started' },
  'subagents.progress': { icon: '↻', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'subagent progress' },
  'subagents.tool.executing': { icon: '⚙', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'subagent tool start' },
  'subagents.tool.result': { icon: '✓', tone: 'text-bbs-green border-bbs-green/40', label: 'subagent tool result' },
  'subagents.completed': { icon: '✓', tone: 'text-bbs-green border-bbs-green/40', label: 'subagent completed' },
  'subagents.failed': { icon: '!', tone: 'text-bbs-red border-bbs-red/40', label: 'subagent failed' },
  'subagents.cancelled': { icon: '×', tone: 'text-bbs-red border-bbs-red/40', label: 'subagent cancelled' },
  'subagents.synthesized': { icon: 'Σ', tone: 'text-bbs-purple border-bbs-purple-dim', label: 'delegation synthesized' },
  taskCreated: { icon: '+', tone: 'text-bbs-green border-bbs-green/40', label: 'task created' },
  taskCompleted: { icon: '✓', tone: 'text-bbs-cyan border-bbs-cyan/40', label: 'task completed' },
  taskCancelled: { icon: '×', tone: 'text-bbs-red border-bbs-red/40', label: 'task cancelled' },
  taskClaimed: { icon: '→', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'task claimed' },
  disputeInitiated: { icon: '!', tone: 'text-bbs-red border-bbs-red/40', label: 'dispute initiated' },
  disputeResolved: { icon: '✓', tone: 'text-bbs-cyan border-bbs-cyan/40', label: 'dispute resolved' },
  agentRegistered: { icon: '+', tone: 'text-bbs-green border-bbs-green/40', label: 'agent registered' },
  agentUpdated: { icon: '↻', tone: 'text-bbs-yellow border-bbs-yellow/40', label: 'agent updated' },
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
      type="button"
      onClick={handleCopy}
      className="border border-bbs-border bg-bbs-black px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
      title="Copy to clipboard"
    >
      {copied ? '[copied]' : '[copy]'}
    </button>
  );
}

export function EventCard({ event }: EventCardProps) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const meta = EVENT_META[event.eventType] ?? {
    icon: '•',
    tone: 'text-bbs-purple border-bbs-purple-dim',
    label: event.eventType,
  };

  const {
    sessionId,
    parentSessionId,
    subagentSessionId,
    toolName,
    durationMs,
    taskPda,
    description,
    traceId,
    parentTraceId,
    ...rest
  } = event.data as Record<string, string | number>;
  const effectiveTraceId = traceId ?? event.traceId;
  const effectiveParentTraceId = parentTraceId ?? event.parentTraceId;
  const extraEntries = Object.entries(rest);

  return (
    <article className="border border-bbs-border bg-bbs-dark px-4 py-4 transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em]">
          <span className={`border bg-bbs-black px-3 py-2 ${meta.tone}`}>
            [{meta.icon} {meta.label}]
          </span>
          <span className="text-bbs-gray">{time}</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">{event.eventType}</span>
      </div>

      <div className="mt-4 grid gap-2 text-xs md:grid-cols-2">
        {toolName ? (
          <Field label="tool" value={String(toolName)} accent="text-bbs-yellow" extra={durationMs != null ? `${Number(durationMs).toLocaleString()}ms` : undefined} />
        ) : null}
        {description ? <Field label="desc" value={String(description)} /> : null}
        {taskPda ? <Field label="task" value={truncateId(String(taskPda))} copyValue={String(taskPda)} /> : null}
        {sessionId ? <Field label="session" value={truncateId(String(sessionId))} copyValue={String(sessionId)} /> : null}
        {parentSessionId ? <Field label="parent" value={truncateId(String(parentSessionId))} copyValue={String(parentSessionId)} /> : null}
        {subagentSessionId ? <Field label="child" value={truncateId(String(subagentSessionId))} copyValue={String(subagentSessionId)} /> : null}
        {effectiveTraceId ? <Field label="trace" value={truncateId(String(effectiveTraceId), 8)} copyValue={String(effectiveTraceId)} /> : null}
        {effectiveParentTraceId ? <Field label="parent trace" value={truncateId(String(effectiveParentTraceId), 8)} copyValue={String(effectiveParentTraceId)} /> : null}
      </div>

      {extraEntries.length > 0 ? (
        <div className="mt-4 border border-bbs-border bg-bbs-black/40 px-3 py-3 text-xs text-bbs-lightgray">
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">payload</div>
          <div className="space-y-2">
            {extraEntries.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                <span className="text-bbs-gray">{key}</span>
                <span className="break-words font-mono text-bbs-lightgray md:max-w-[65%]">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Field({
  label,
  value,
  accent,
  extra,
  copyValue,
}: {
  label: string;
  value: string;
  accent?: string;
  extra?: string;
  copyValue?: string;
}) {
  return (
    <div className="border border-bbs-border bg-bbs-black/40 px-3 py-3 text-bbs-lightgray">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
        <span>{label}</span>
        {extra ? <span>{extra}</span> : null}
      </div>
      <div className={`mt-2 break-all text-sm ${accent ?? ''}`}>{value}</div>
      {copyValue ? (
        <div className="mt-2">
          <CopyButton value={copyValue} />
        </div>
      ) : null}
    </div>
  );
}
