import type { GatewayStatus } from '../../types';
import { StatCard } from './StatCard';

interface AgentStatusViewProps {
  status: GatewayStatus | null;
  onRefresh: () => void;
}

type MetricTone = 'default' | 'accent' | 'success' | 'warn' | 'danger';

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatMetric(value: number | undefined, fractionDigits = 2): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return value.toFixed(fractionDigits);
}

function formatRate(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

const STATE_STYLES: Record<string, { border: string; text: string; dot: string }> = {
  running: { border: 'border-bbs-green-dim', text: 'text-bbs-green', dot: 'bg-bbs-green' },
  starting: { border: 'border-bbs-yellow/40', text: 'text-bbs-yellow', dot: 'bg-bbs-yellow' },
  stopped: { border: 'border-bbs-red/40', text: 'text-bbs-red', dot: 'bg-bbs-red' },
  error: { border: 'border-bbs-red/40', text: 'text-bbs-red', dot: 'bg-bbs-red' },
};

const ALERT_STYLES: Record<'info' | 'warn' | 'error', { tag: string; text: string }> = {
  info: { tag: '[INFO]', text: 'text-bbs-cyan' },
  warn: { tag: '[WARN]', text: 'text-bbs-yellow' },
  error: { tag: '[FAIL]', text: 'text-bbs-red' },
};

function stateTone(state: string): MetricTone {
  if (state === 'running') return 'success';
  if (state === 'starting') return 'warn';
  if (state === 'error' || state === 'stopped') return 'danger';
  return 'default';
}

function rateTone(
  value: number | undefined,
  thresholds: { success: number; warn: number; inverse?: boolean },
): MetricTone {
  if (value === undefined || Number.isNaN(value)) return 'default';

  if (thresholds.inverse) {
    if (value <= thresholds.success) return 'success';
    if (value <= thresholds.warn) return 'warn';
    return 'danger';
  }

  if (value >= thresholds.success) return 'success';
  if (value >= thresholds.warn) return 'warn';
  return 'danger';
}

function formatStateTag(state: string): string {
  return `[${state.toUpperCase()}]`;
}

export function AgentStatusView({ status, onRefresh }: AgentStatusViewProps) {
  const titleLabel = 'AGENT STATUS';

  if (!status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 bg-bbs-black px-6 font-mono">
        <div
          aria-label={titleLabel}
          className="text-xs tracking-[0.42em] text-bbs-purple whitespace-nowrap"
        >
          {titleLabel}
        </div>
        <div className="text-bbs-pink text-xs whitespace-nowrap">[{String.fromCharCode(0x2588).repeat(10)}{String.fromCharCode(0x2591).repeat(18)}] BOOTING</div>
        <div className="text-xs text-bbs-gray">connecting to agent runtime...</div>
      </div>
    );
  }

  const badge = STATE_STYLES[status.state] ?? STATE_STYLES.stopped;
  const backgroundRuns = status.backgroundRuns;
  const summaryTone = stateTone(status.state);
  const queueTone: MetricTone = backgroundRuns && backgroundRuns.queuedSignalsTotal > 0 ? 'warn' : 'default';
  const blockedTone: MetricTone = backgroundRuns && backgroundRuns.stateCounts.blocked > 0 ? 'danger' : 'default';
  const activeTone: MetricTone = backgroundRuns && backgroundRuns.activeTotal > 0 ? 'accent' : 'default';
  const recoveredTone: MetricTone = backgroundRuns && backgroundRuns.metrics.recoveredTotal > 0 ? 'success' : 'default';
  const falseCompletionTone = backgroundRuns
    ? rateTone(backgroundRuns.metrics.falseCompletionRate, { success: 0.005, warn: 0.02, inverse: true })
    : 'default';
  const verifierTone = backgroundRuns
    ? rateTone(backgroundRuns.metrics.verifierAccuracyRate, { success: 0.95, warn: 0.85 })
    : 'default';

  return (
    <div className="flex flex-col h-full bg-bbs-black text-bbs-lightgray font-mono animate-chat-enter">
      <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-3 border-b border-bbs-border bg-bbs-surface">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-bbs-purple text-xs shrink-0">SYS&gt;</span>
          <div className="min-w-0">
            <div
              aria-label={titleLabel}
              className="text-xs font-bold tracking-[0.32em] text-bbs-white uppercase whitespace-nowrap"
            >
              {titleLabel}
            </div>
            <div className="text-[11px] text-bbs-gray truncate">runtime health, channels, and background run signals</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className={`inline-flex items-center gap-2 border px-3 py-1.5 text-xs ${badge.border}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot} animate-pulse`} />
            <span className={`font-bold ${badge.text}`}>{formatStateTag(status.state)}</span>
          </div>
          <button
            onClick={onRefresh}
            className="border border-bbs-border px-3 py-1.5 text-xs text-bbs-gray hover:text-bbs-white hover:border-bbs-purple-dim transition-colors"
            title="Refresh agent status"
          >
            [REFRESH]
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-5xl mx-auto space-y-5">
          <section className="border border-bbs-border bg-bbs-dark animate-panel-enter">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 px-4 py-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">Runtime Identity</div>
                <div className="mt-2 flex items-center gap-2 text-sm font-bold text-bbs-white break-all">
                  <span className="text-bbs-purple">&gt;</span>
                  <span>{status.agentName ?? 'agenc-agent'}</span>
                </div>
                <div className="mt-2 text-xs text-bbs-gray leading-relaxed">
                  control plane :{status.controlPlanePort} &nbsp;•&nbsp; {status.activeSessions} active session(s) &nbsp;•&nbsp; {status.channels.length} channel(s)
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div>
                  <div className="text-bbs-gray uppercase tracking-[0.14em]">Uptime</div>
                  <div className="mt-1 text-bbs-lightgray">{formatUptime(status.uptimeMs)}</div>
                </div>
                <div>
                  <div className="text-bbs-gray uppercase tracking-[0.14em]">Port</div>
                  <div className="mt-1 text-bbs-lightgray">:{status.controlPlanePort}</div>
                </div>
                <div>
                  <div className="text-bbs-gray uppercase tracking-[0.14em]">Sessions</div>
                  <div className="mt-1 text-bbs-lightgray">{status.activeSessions}</div>
                </div>
                <div>
                  <div className="text-bbs-gray uppercase tracking-[0.14em]">Channels</div>
                  <div className="mt-1 text-bbs-lightgray">{status.channels.length}</div>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-3 animate-panel-enter">
            <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">Runtime Metrics</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <StatCard
                label="State"
                value={formatStateTag(status.state)}
                subtext="gateway lifecycle state"
                tone={summaryTone}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                }
              />
              <StatCard
                label="Uptime"
                value={formatUptime(status.uptimeMs)}
                subtext="current runtime session"
                tone="accent"
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
                  </svg>
                }
              />
              <StatCard
                label="Sessions"
                value={status.activeSessions}
                subtext="currently attached clients"
                tone={status.activeSessions > 0 ? 'accent' : 'default'}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                }
              />
              <StatCard
                label="Port"
                value={`:${status.controlPlanePort}`}
                subtext="websocket control plane"
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="2" y="2" width="20" height="8" /><rect x="2" y="14" width="20" height="8" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
                  </svg>
                }
              />
            </div>
          </section>

          <section className="border border-bbs-border bg-bbs-dark animate-panel-enter">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-bbs-border">
              <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">Channels</div>
              <div className={`text-xs font-bold ${status.channels.length > 0 ? 'text-bbs-green' : 'text-bbs-gray'}`}>
                {status.channels.length > 0 ? `[${status.channels.length} ONLINE]` : '[NONE]'}
              </div>
            </div>
            {status.channels.length === 0 ? (
              <div className="px-4 py-6 text-xs text-bbs-gray">no channels connected</div>
            ) : (
              <div className="divide-y divide-bbs-border/60">
                {status.channels.map((channel, index) => (
                  <div
                    key={channel}
                    className="flex items-center gap-3 px-4 py-3 text-xs animate-list-item"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <span className="text-bbs-green">&gt;</span>
                    <span className="text-bbs-lightgray break-all">{channel}</span>
                    <span className="ml-auto text-bbs-green">[ONLINE]</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {backgroundRuns ? (
            <section className="space-y-4 animate-panel-enter">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">Background Runs</div>
                <div className={`text-xs font-bold ${backgroundRuns.multiAgentEnabled ? 'text-bbs-green' : 'text-bbs-gray'}`}>
                  {backgroundRuns.multiAgentEnabled ? '[MULTI-AGENT ON]' : '[MULTI-AGENT OFF]'}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
                <StatCard label="Multi-Agent" value={backgroundRuns.multiAgentEnabled ? 'ON' : 'OFF'} subtext="runtime orchestration mode" tone={backgroundRuns.multiAgentEnabled ? 'success' : 'default'} />
                <StatCard label="Active" value={backgroundRuns.activeTotal} subtext="runs currently executing" tone={activeTone} />
                <StatCard label="Queued Signals" value={backgroundRuns.queuedSignalsTotal} subtext="pending wake signals" tone={queueTone} />
                <StatCard label="Recovered" value={backgroundRuns.metrics.recoveredTotal} subtext="runs restored after interruption" tone={recoveredTone} />
                <StatCard label="Blocked" value={backgroundRuns.stateCounts.blocked} subtext="runs waiting for operator or verifier" tone={blockedTone} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <StatCard label="Mean Ack" value={`${formatMetric(backgroundRuns.metrics.meanTimeToFirstAckMs)}ms`} subtext="time to first scheduler acknowledgement" />
                <StatCard label="Mean Verified" value={`${formatMetric(backgroundRuns.metrics.meanTimeToFirstVerifiedUpdateMs)}ms`} subtext="time to first verified runtime update" />
                <StatCard label="False Completion" value={formatRate(backgroundRuns.metrics.falseCompletionRate)} subtext="lower is healthier" tone={falseCompletionTone} />
                <StatCard label="Verifier Accuracy" value={formatRate(backgroundRuns.metrics.verifierAccuracyRate)} subtext="higher is healthier" tone={verifierTone} />
              </div>

              <div className="border border-bbs-border bg-bbs-dark">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-bbs-border">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">Recent Alerts</div>
                  <div className="text-xs text-bbs-gray">{backgroundRuns.recentAlerts.length} event(s)</div>
                </div>
                {backgroundRuns.recentAlerts.length === 0 ? (
                  <div className="px-4 py-6 text-xs text-bbs-gray">no background-run alerts recorded</div>
                ) : (
                  <div className="divide-y divide-bbs-border/60">
                    {backgroundRuns.recentAlerts.slice(0, 5).map((alert) => {
                      const style = ALERT_STYLES[alert.severity];
                      return (
                        <div key={alert.id} className="px-4 py-3 text-xs animate-list-item">
                          <div className="flex items-start gap-3">
                            <span className={`font-bold shrink-0 ${style.text}`}>{style.tag}</span>
                            <div className="min-w-0 flex-1">
                              <div className="text-bbs-lightgray leading-relaxed break-words">{alert.message}</div>
                              <div className="mt-1 text-[11px] text-bbs-gray break-all">
                                {alert.code}
                                {alert.sessionId ? ` • ${alert.sessionId}` : ''}
                                {alert.runId ? ` • ${alert.runId}` : ''}
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] text-bbs-gray">
                              {new Date(alert.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
