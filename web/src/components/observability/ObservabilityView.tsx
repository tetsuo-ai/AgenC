import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  TraceArtifact,
  TraceDetail,
  TraceEvent,
  TraceLogTail,
  TraceStatus,
  TraceSummary,
  TraceSummaryMetrics,
} from '../../types';

interface ObservabilityViewProps {
  summary: TraceSummaryMetrics | null;
  traces: TraceSummary[];
  selectedTraceId: string | null;
  selectedTrace: TraceDetail | null;
  selectedEventId: string | null;
  selectedEvent: TraceEvent | null;
  artifact: TraceArtifact | null;
  logs: TraceLogTail | null;
  loading: boolean;
  error: string | null;
  search: string;
  status: TraceStatus;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: TraceStatus) => void;
  onSelectTrace: (traceId: string) => void;
  onSelectEvent: (eventId: string) => void;
  onRefresh: () => void;
}

const INPUT_CLASS =
  'min-w-0 w-full border border-bbs-border bg-bbs-surface px-3 py-2 text-xs text-bbs-lightgray outline-none placeholder:text-bbs-gray focus:border-bbs-purple-dim';
const CODE_BLOCK_CLASS =
  'overflow-auto border border-bbs-border bg-bbs-surface p-3 text-[11px] leading-5 text-bbs-lightgray whitespace-pre-wrap break-words';
const STATUS_OPTIONS: ReadonlyArray<{ value: TraceStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Error' },
];

function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs) return 'n/a';
  return new Date(timestampMs).toLocaleString();
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return 'n/a';
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  return `${(durationMs / 60_000).toFixed(2)} min`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatStatusTag(status: string): string {
  return `[${status.toUpperCase()}]`;
}

function statusTextClass(status: string): string {
  if (status === 'error') return 'text-bbs-red';
  if (status === 'completed') return 'text-bbs-green';
  return 'text-bbs-yellow';
}

function eventToneClass(level: 'info' | 'error'): string {
  return level === 'error'
    ? 'border-bbs-red/40 bg-bbs-dark text-bbs-lightgray'
    : 'border-bbs-border bg-bbs-dark text-bbs-lightgray';
}

export function ObservabilityView(props: ObservabilityViewProps) {
  const {
    summary,
    traces,
    selectedTraceId,
    selectedTrace,
    selectedEventId,
    selectedEvent,
    artifact,
    logs,
    loading,
    error,
    search,
    status,
    onSearchChange,
    onStatusChange,
    onSelectTrace,
    onSelectEvent,
    onRefresh,
  } = props;

  return (
    <div className="flex h-full flex-col bg-bbs-black text-bbs-lightgray font-mono animate-chat-enter">
      <header className="shrink-0 border-b border-bbs-border bg-bbs-surface px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0 text-xs text-bbs-purple">TRACE&gt;</span>
              <div className="min-w-0">
                <h1 className="text-xs font-bold uppercase tracking-[0.18em] text-bbs-white">
                  Trace Explorer
                </h1>
                <p className="mt-1 max-w-3xl text-xs text-bbs-gray">
                  complete runtime traces, exact payload artifacts, and daemon log slices
                  correlated by trace id
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
              <span className="shrink-0">Search</span>
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="trace, session, tool, stop reason"
                className={`${INPUT_CLASS} min-w-[16rem] md:min-w-[20rem]`}
              />
            </label>

            <StatusFilter value={status} onChange={onStatusChange} />

            <button
              onClick={onRefresh}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [REFRESH]
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Traces" value={summary?.traces.total ?? 0} />
          <MetricCard label="Errors" value={summary?.traces.errors ?? 0} tone="error" />
          <MetricCard
            label="Completeness"
            value={summary ? formatPercent(summary.traces.completenessRate) : 'n/a'}
            tone="accent"
          />
          <MetricCard label="Provider Errors" value={summary?.events.providerErrors ?? 0} tone="error" />
          <MetricCard label="Tool Rejections" value={summary?.events.toolRejections ?? 0} tone="warning" />
          <MetricCard label="Route Misses" value={summary?.events.routeMisses ?? 0} tone="warning" />
        </div>

        {error ? (
          <div className="mt-4 border border-bbs-red/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-red">
            [ERROR] {error}
          </div>
        ) : null}
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-1 xl:grid-cols-[22rem,1.15fr,1fr]">
        <aside className="min-h-0 overflow-y-auto border-b xl:border-b-0 xl:border-r border-bbs-border bg-bbs-dark/40">
          <div className="sticky top-0 z-10 border-b border-bbs-border bg-bbs-surface px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">
                  Trace List
                </p>
                <p className="mt-1 text-xs text-bbs-gray">{traces.length} result(s)</p>
              </div>
              {loading ? <span className="text-xs text-bbs-yellow">[LOADING]</span> : null}
            </div>
          </div>

          <div className="space-y-2 p-3">
            {traces.length === 0 ? (
              <div className="border border-dashed border-bbs-border px-3 py-4 text-sm text-bbs-gray">
                no traces matched the current filters
              </div>
            ) : null}

            {traces.map((trace, index) => {
              const isActive = trace.traceId === selectedTraceId;
              return (
                <button
                  key={trace.traceId}
                  onClick={() => onSelectTrace(trace.traceId)}
                  className={`w-full border px-4 py-3 text-left transition-colors animate-list-item ${
                    isActive
                      ? 'border-bbs-purple-dim bg-bbs-surface'
                      : 'border-bbs-border bg-bbs-dark hover:bg-bbs-surface'
                  }`}
                  style={{ animationDelay: `${index * 35}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <code className="block break-all text-[11px] text-bbs-white">
                      {trace.traceId}
                    </code>
                    <span className={`text-[10px] font-bold ${statusTextClass(trace.status)}`}>
                      {formatStatusTag(trace.status)}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-bbs-gray break-words">
                    {trace.sessionId ? <div>session: {trace.sessionId}</div> : null}
                    <div>updated: {formatTimestamp(trace.updatedAt)}</div>
                    <div>events: {trace.eventCount}</div>
                    {trace.stopReason ? <div>stop: {trace.stopReason}</div> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto border-b xl:border-b-0 xl:border-r border-bbs-border bg-bbs-black">
          <div className="sticky top-0 z-10 border-b border-bbs-border bg-bbs-surface px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">
                  Trace Timeline
                </p>
                <h2 className="mt-1 break-all text-sm font-bold text-bbs-white">
                  {selectedTrace?.summary.traceId ?? 'Select a trace'}
                </h2>
              </div>
              {selectedTrace ? (
                <div className="text-right text-xs text-bbs-gray shrink-0">
                  <div>started: {formatTimestamp(selectedTrace.summary.startedAt)}</div>
                  <div>updated: {formatTimestamp(selectedTrace.summary.updatedAt)}</div>
                </div>
              ) : null}
            </div>

            {selectedTrace ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Tag label={`status ${selectedTrace.summary.status}`} tone={selectedTrace.summary.status} />
                <Tag label={`${selectedTrace.summary.eventCount} events`} />
                <Tag
                  label={`${selectedTrace.summary.errorCount} errors`}
                  tone={selectedTrace.summary.errorCount > 0 ? 'error' : 'neutral'}
                />
                {selectedTrace.summary.stopReason ? (
                  <Tag label={`stop ${selectedTrace.summary.stopReason}`} tone="warning" />
                ) : null}
                <Tag
                  label={selectedTrace.completeness.complete ? 'trace complete' : 'trace incomplete'}
                  tone={selectedTrace.completeness.complete ? 'success' : 'error'}
                />
              </div>
            ) : null}

            {selectedTrace && !selectedTrace.completeness.complete ? (
              <div className="mt-3 border border-bbs-yellow/40 bg-bbs-dark px-3 py-2 text-sm text-bbs-yellow">
                [WARN] {selectedTrace.completeness.issues.join(' ')}
              </div>
            ) : null}
          </div>

          <div className="space-y-3 p-4">
            {selectedTrace?.events.length ? (
              selectedTrace.events.map((event, index) => {
                const isSelected = event.id === selectedEventId;
                return (
                  <button
                    key={event.id}
                    onClick={() => onSelectEvent(event.id)}
                    className={`w-full border px-4 py-3 text-left transition-colors animate-list-item ${eventToneClass(event.level)} ${
                      isSelected ? 'border-bbs-purple-dim bg-bbs-surface' : ''
                    }`}
                    style={{ animationDelay: `${index * 30}ms` }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-bbs-white">{event.eventName}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-bbs-gray">
                          <span>{formatTimestamp(event.timestampMs)}</span>
                          {event.callPhase ? <span>phase: {event.callPhase}</span> : null}
                          {event.callIndex !== undefined ? <span>call: {event.callIndex}</span> : null}
                          {event.toolName ? <span>tool: {event.toolName}</span> : null}
                          {event.provider ? <span>provider: {event.provider}</span> : null}
                          {event.model ? <span>model: {event.model}</span> : null}
                          {event.durationMs !== undefined ? (
                            <span>duration: {formatDuration(event.durationMs)}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-[0.12em]">
                        <span className={event.level === 'error' ? 'text-bbs-red' : 'text-bbs-gray'}>
                          [{event.level}]
                        </span>
                        {event.routingMiss ? <span className="text-bbs-yellow">[route miss]</span> : null}
                        {event.completionGateDecision ? (
                          <span className="text-bbs-purple">[gate {event.completionGateDecision}]</span>
                        ) : null}
                        {event.artifact ? <span className="text-bbs-green">[artifact]</span> : null}
                      </div>
                    </div>
                    <pre className={`mt-3 ${CODE_BLOCK_CLASS}`}>{formatJson(event.payloadPreview)}</pre>
                  </button>
                );
              })
            ) : (
              <div className="border border-dashed border-bbs-border px-4 py-8 text-sm text-bbs-gray">
                select a trace to inspect its full event timeline
              </div>
            )}
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto bg-bbs-dark/40">
          <div className="sticky top-0 z-10 border-b border-bbs-border bg-bbs-surface px-5 py-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">
              Event Detail
            </p>
            <h2 className="mt-1 break-words text-sm font-bold text-bbs-white">
              {selectedEvent?.eventName ?? 'Select an event'}
            </h2>
            {selectedEvent ? (
              <div className="mt-2 space-y-1 text-xs text-bbs-gray break-words">
                <div>timestamp: {formatTimestamp(selectedEvent.timestampMs)}</div>
                <div>duration: {formatDuration(selectedEvent.durationMs)}</div>
                {selectedEvent.stopReason ? <div>stop reason: {selectedEvent.stopReason}</div> : null}
                {selectedEvent.artifact ? <div>artifact: {selectedEvent.artifact.path}</div> : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-5 p-4">
            <SectionCard title="Preview Payload">
              <pre className={CODE_BLOCK_CLASS}>
                {selectedEvent ? formatJson(selectedEvent.payloadPreview) : 'Select an event'}
              </pre>
            </SectionCard>

            <SectionCard title="Exact Artifact">
              <pre className={CODE_BLOCK_CLASS}>
                {artifact ? formatJson(artifact.body) : 'No artifact attached to the selected event.'}
              </pre>
            </SectionCard>

            <SectionCard title="Daemon Log Slice">
              <pre className={`${CODE_BLOCK_CLASS} max-h-[24rem]`}>
                {logs?.lines.length
                  ? logs.lines.join('\n')
                  : 'No daemon log lines captured for the selected trace.'}
              </pre>
            </SectionCard>

            <SectionCard title="Top Signals">
              <div className="space-y-3 text-sm text-bbs-gray">
                <NamedCounts label="Top tools" items={summary?.topTools ?? []} />
                <NamedCounts label="Top stop reasons" items={summary?.topStopReasons ?? []} />
              </div>
            </SectionCard>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MetricCard(props: {
  label: string;
  value: string | number;
  tone?: 'default' | 'accent' | 'warning' | 'error';
}) {
  const toneClass =
    props.tone === 'error'
      ? 'text-bbs-red'
      : props.tone === 'warning'
        ? 'text-bbs-yellow'
        : props.tone === 'accent'
          ? 'text-bbs-purple'
          : 'text-bbs-white';

  return (
    <div className="border border-bbs-border bg-bbs-dark px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">{props.label}</div>
      <div className={`mt-2 text-2xl font-bold ${toneClass}`}>{props.value}</div>
    </div>
  );
}

function StatusFilter(props: {
  value: TraceStatus;
  onChange: (value: TraceStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const currentLabel =
    STATUS_OPTIONS.find((option) => option.value === props.value)?.label ?? props.value;

  return (
    <div
      ref={rootRef}
      className="relative flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray"
    >
      <span className="shrink-0">Status</span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="border border-bbs-border bg-bbs-surface px-3 py-2 text-xs text-bbs-lightgray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
      >
        [{currentLabel.toUpperCase()}]
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Trace status"
          className="absolute right-0 top-full z-30 mt-2 min-w-[10rem] border border-bbs-border bg-bbs-dark shadow-[0_0_0_1px_rgba(146,111,255,0.12)]"
        >
          {STATUS_OPTIONS.map((option) => {
            const selected = option.value === props.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors ${
                  selected
                    ? 'bg-bbs-surface text-bbs-white'
                    : 'text-bbs-gray hover:bg-bbs-surface hover:text-bbs-white'
                }`}
              >
                <span>[{option.label.toUpperCase()}]</span>
                {selected ? <span className="text-bbs-purple">ACTIVE</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Tag(props: { label: string; tone?: 'success' | 'error' | 'warning' | 'neutral' | string }) {
  const tone = props.tone ?? 'neutral';
  const className =
    tone === 'success'
      ? 'text-bbs-green'
      : tone === 'error'
        ? 'text-bbs-red'
        : tone === 'warning'
          ? 'text-bbs-yellow'
          : tone === 'completed'
            ? 'text-bbs-green'
            : tone === 'open'
              ? 'text-bbs-yellow'
              : 'text-bbs-purple';

  return <span className={`text-[11px] uppercase tracking-[0.12em] ${className}`}>[{props.label}]</span>;
}

function SectionCard(props: { title: string; children: ReactNode }) {
  return (
    <section className="border border-bbs-border bg-bbs-dark">
      <div className="border-b border-bbs-border px-4 py-3 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
        {props.title}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

function NamedCounts(props: { label: string; items: readonly { name: string; count: number }[] }) {
  return (
    <div>
      <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">{props.label}</p>
      {props.items.length === 0 ? (
        <p className="text-xs text-bbs-gray">No data yet.</p>
      ) : (
        <div className="space-y-2">
          {props.items.map((item) => (
            <div
              key={`${props.label}:${item.name}`}
              className="flex items-center justify-between gap-3 border border-bbs-border bg-bbs-surface px-3 py-2"
            >
              <span className="truncate text-bbs-lightgray">{item.name}</span>
              <span className="text-bbs-gray">{item.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
