import type { ReactNode } from 'react';
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

function statusClass(status: string): string {
  if (status === 'error') return 'text-red-300 bg-red-500/10 border-red-500/30';
  if (status === 'completed') return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
  return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
}

function eventLevelClass(level: 'info' | 'error'): string {
  return level === 'error'
    ? 'border-red-500/40 bg-red-500/10 text-red-100'
    : 'border-tetsuo-200 bg-tetsuo-50 text-tetsuo-900';
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
    <div className="flex flex-col h-full bg-bbs-black text-tetsuo-50">
      <header className="shrink-0 border-b border-bbs-purple-dim bg-bbs-surface/80 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-[0.22em] text-bbs-purple">
              Observability
            </p>
            <h1 className="text-xl font-semibold text-bbs-white">
              Trace Explorer
            </h1>
            <p className="text-sm text-bbs-gray max-w-3xl">
              Complete runtime traces, exact payload artifacts, and raw daemon log slices
              correlated by trace ID.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-md border border-bbs-purple-dim bg-bbs-black px-3 py-2 text-sm">
              <span className="text-bbs-gray">Search</span>
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="trace, session, tool, stop reason"
                className="min-w-[18rem] bg-transparent text-bbs-white outline-none placeholder:text-bbs-gray"
              />
            </label>

            <label className="flex items-center gap-2 rounded-md border border-bbs-purple-dim bg-bbs-black px-3 py-2 text-sm">
              <span className="text-bbs-gray">Status</span>
              <select
                value={status}
                onChange={(event) => onStatusChange(event.target.value as TraceStatus)}
                className="bg-transparent text-bbs-white outline-none"
              >
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="completed">Completed</option>
                <option value="error">Error</option>
              </select>
            </label>

            <button
              onClick={onRefresh}
              className="rounded-md border border-bbs-purple bg-bbs-purple/10 px-4 py-2 text-sm text-bbs-white transition hover:bg-bbs-purple/20"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Traces" value={summary?.traces.total ?? 0} />
          <MetricCard label="Errors" value={summary?.traces.errors ?? 0} />
          <MetricCard
            label="Completeness"
            value={summary ? formatPercent(summary.traces.completenessRate) : 'n/a'}
          />
          <MetricCard label="Provider Errors" value={summary?.events.providerErrors ?? 0} />
          <MetricCard label="Tool Rejections" value={summary?.events.toolRejections ?? 0} />
          <MetricCard label="Route Misses" value={summary?.events.routeMisses ?? 0} />
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {error}
          </div>
        )}
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-[22rem,1.2fr,1fr]">
        <aside className="min-h-0 overflow-y-auto border-r border-bbs-purple-dim bg-bbs-surface/50">
          <div className="sticky top-0 z-10 border-b border-bbs-purple-dim bg-bbs-surface/95 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-bbs-purple">
                  Trace List
                </p>
                <p className="text-xs text-bbs-gray">{traces.length} result(s)</p>
              </div>
              {loading && <span className="text-xs text-bbs-gray">Loading…</span>}
            </div>
          </div>

          <div className="space-y-2 p-3">
            {traces.length === 0 && (
              <div className="rounded-md border border-dashed border-bbs-purple-dim px-3 py-4 text-sm text-bbs-gray">
                No traces matched the current filters.
              </div>
            )}

            {traces.map((trace) => {
              const isActive = trace.traceId === selectedTraceId;
              return (
                <button
                  key={trace.traceId}
                  onClick={() => onSelectTrace(trace.traceId)}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                    isActive
                      ? 'border-bbs-purple bg-bbs-purple/10 shadow-[0_0_0_1px_rgba(146,111,255,0.25)]'
                      : 'border-bbs-purple-dim bg-bbs-black/30 hover:border-bbs-purple/50 hover:bg-bbs-surface'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <code className="block break-all text-[11px] text-bbs-white">
                      {trace.traceId}
                    </code>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusClass(trace.status)}`}>
                      {trace.status}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-bbs-gray">
                    {trace.sessionId && <div>Session: {trace.sessionId}</div>}
                    <div>Updated: {formatTimestamp(trace.updatedAt)}</div>
                    <div>Events: {trace.eventCount}</div>
                    {trace.stopReason && <div>Stop: {trace.stopReason}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto border-r border-bbs-purple-dim bg-bbs-black/60">
          <div className="sticky top-0 z-10 border-b border-bbs-purple-dim bg-bbs-surface/95 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-bbs-purple">
                  Trace Timeline
                </p>
                <h2 className="mt-1 text-lg font-semibold text-bbs-white">
                  {selectedTrace?.summary.traceId ?? 'Select a trace'}
                </h2>
              </div>
              {selectedTrace && (
                <div className="text-right text-xs text-bbs-gray">
                  <div>Started: {formatTimestamp(selectedTrace.summary.startedAt)}</div>
                  <div>Updated: {formatTimestamp(selectedTrace.summary.updatedAt)}</div>
                </div>
              )}
            </div>

            {selectedTrace && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Pill label={`Status ${selectedTrace.summary.status}`} tone={selectedTrace.summary.status} />
                <Pill label={`${selectedTrace.summary.eventCount} events`} />
                <Pill label={`${selectedTrace.summary.errorCount} errors`} tone={selectedTrace.summary.errorCount > 0 ? 'error' : 'neutral'} />
                {selectedTrace.summary.stopReason && (
                  <Pill label={`Stop ${selectedTrace.summary.stopReason}`} />
                )}
                <Pill
                  label={
                    selectedTrace.completeness.complete
                      ? 'Trace complete'
                      : 'Trace incomplete'
                  }
                  tone={selectedTrace.completeness.complete ? 'success' : 'error'}
                />
              </div>
            )}

            {selectedTrace && !selectedTrace.completeness.complete && (
              <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                {selectedTrace.completeness.issues.join(' ')}
              </div>
            )}
          </div>

          <div className="space-y-3 p-4">
            {selectedTrace?.events.length ? (
              selectedTrace.events.map((event) => {
                const isSelected = event.id === selectedEventId;
                return (
                  <button
                    key={event.id}
                    onClick={() => onSelectEvent(event.id)}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition ${eventLevelClass(event.level)} ${
                      isSelected ? 'shadow-[0_0_0_1px_rgba(146,111,255,0.3)] border-bbs-purple' : ''
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-xs text-bbs-white">{event.eventName}</div>
                        <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-bbs-gray">
                          <span>{formatTimestamp(event.timestampMs)}</span>
                          {event.callPhase && <span>Phase: {event.callPhase}</span>}
                          {event.callIndex !== undefined && <span>Call: {event.callIndex}</span>}
                          {event.toolName && <span>Tool: {event.toolName}</span>}
                          {event.provider && <span>Provider: {event.provider}</span>}
                          {event.model && <span>Model: {event.model}</span>}
                          {event.durationMs !== undefined && (
                            <span>Duration: {formatDuration(event.durationMs)}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-wide">
                        {event.routingMiss && (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                            Route miss
                          </span>
                        )}
                        {event.completionGateDecision && (
                          <span className="rounded-full border border-bbs-purple/30 bg-bbs-purple/10 px-2 py-0.5 text-bbs-white">
                            Gate {event.completionGateDecision}
                          </span>
                        )}
                        {event.artifact && (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
                            Artifact
                          </span>
                        )}
                      </div>
                    </div>
                    <pre className="mt-3 overflow-x-auto rounded-md bg-bbs-black/60 p-3 text-[11px] leading-5 text-bbs-gray">
                      {formatJson(event.payloadPreview)}
                    </pre>
                  </button>
                );
              })
            ) : (
              <div className="rounded-md border border-dashed border-bbs-purple-dim px-4 py-8 text-sm text-bbs-gray">
                Select a trace to inspect its full event timeline.
              </div>
            )}
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto bg-bbs-surface/40">
          <div className="sticky top-0 z-10 border-b border-bbs-purple-dim bg-bbs-surface/95 px-5 py-4">
            <p className="text-xs uppercase tracking-[0.2em] text-bbs-purple">
              Event Detail
            </p>
            <h2 className="mt-1 text-lg font-semibold text-bbs-white">
              {selectedEvent?.eventName ?? 'Select an event'}
            </h2>
            {selectedEvent && (
              <div className="mt-2 space-y-1 text-xs text-bbs-gray">
                <div>Timestamp: {formatTimestamp(selectedEvent.timestampMs)}</div>
                <div>Duration: {formatDuration(selectedEvent.durationMs)}</div>
                {selectedEvent.stopReason && <div>Stop reason: {selectedEvent.stopReason}</div>}
                {selectedEvent.artifact && <div>Artifact: {selectedEvent.artifact.path}</div>}
              </div>
            )}
          </div>

          <div className="space-y-5 p-4">
            <SectionCard title="Preview Payload">
              <pre className="overflow-x-auto rounded-md bg-bbs-black/70 p-3 text-[11px] leading-5 text-bbs-gray">
                {selectedEvent ? formatJson(selectedEvent.payloadPreview) : 'Select an event'}
              </pre>
            </SectionCard>

            <SectionCard title="Exact Artifact">
              <pre className="overflow-x-auto rounded-md bg-bbs-black/70 p-3 text-[11px] leading-5 text-bbs-gray">
                {artifact ? formatJson(artifact.body) : 'No artifact attached to the selected event.'}
              </pre>
            </SectionCard>

            <SectionCard title="Daemon Log Slice">
              <pre className="max-h-[24rem] overflow-auto rounded-md bg-bbs-black/70 p-3 text-[11px] leading-5 text-bbs-gray">
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

function MetricCard(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-bbs-purple-dim bg-bbs-black/50 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-bbs-gray">
        {props.label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-bbs-white">{props.value}</div>
    </div>
  );
}

function Pill(props: { label: string; tone?: 'success' | 'error' | 'neutral' | string }) {
  const tone = props.tone ?? 'neutral';
  const className =
    tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : tone === 'error'
        ? 'border-red-500/30 bg-red-500/10 text-red-200'
        : 'border-bbs-purple/30 bg-bbs-purple/10 text-bbs-white';
  return (
    <span className={`rounded-full border px-2.5 py-1 ${className}`}>
      {props.label}
    </span>
  );
}

function SectionCard(props: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-bbs-purple-dim bg-bbs-black/30">
      <div className="border-b border-bbs-purple-dim px-4 py-3 text-xs uppercase tracking-[0.16em] text-bbs-purple">
        {props.title}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

function NamedCounts(props: { label: string; items: readonly { name: string; count: number }[] }) {
  return (
    <div>
      <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-bbs-purple">
        {props.label}
      </p>
      {props.items.length === 0 ? (
        <p className="text-xs text-bbs-gray">No data yet.</p>
      ) : (
        <div className="space-y-2">
          {props.items.map((item) => (
            <div key={`${props.label}:${item.name}`} className="flex items-center justify-between gap-3 rounded-md border border-bbs-purple-dim bg-bbs-black/40 px-3 py-2">
              <span className="truncate text-bbs-white">{item.name}</span>
              <span className="text-bbs-gray">{item.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
