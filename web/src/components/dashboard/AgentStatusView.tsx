import type { GatewayStatus } from '../../types';
import { StatCard } from './StatCard';

interface AgentStatusViewProps {
  status: GatewayStatus | null;
  onRefresh: () => void;
}

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

const STATE_BADGE: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', dot: 'bg-emerald-500' },
  starting: { bg: 'bg-amber-500/10', text: 'text-amber-500', dot: 'bg-amber-500' },
  stopped: { bg: 'bg-red-500/10', text: 'text-red-500', dot: 'bg-red-500' },
  error: { bg: 'bg-red-500/10', text: 'text-red-500', dot: 'bg-red-500' },
};

export function AgentStatusView({ status, onRefresh }: AgentStatusViewProps) {
  if (!status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="w-12 h-12 rounded-full border-2 border-tetsuo-200 border-t-accent animate-spin" />
        <span className="text-sm text-tetsuo-400">Connecting to agent...</span>
      </div>
    );
  }

  const badge = STATE_BADGE[status.state] ?? STATE_BADGE.stopped;
  let idx = 0;
  const delay = () => `${(idx++) * 60}ms`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <path d="M18 20V10M12 20V4M6 20v-6" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Agent Status</h2>
        </div>
        <button
          onClick={onRefresh}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90"
          title="Refresh"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl mx-auto space-y-6">
        {/* Agent identity */}
        <div className="animate-list-item flex items-center justify-between" style={{ animationDelay: delay() }}>
          <div>
            <div className="text-[10px] text-tetsuo-400 uppercase tracking-[0.15em] font-medium mb-1">Agent</div>
            <div className="text-lg font-bold text-tetsuo-800">{status.agentName ?? 'agenc-agent'}</div>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${badge.bg} ${badge.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot} animate-pulse`} />
            {status.state}
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="animate-list-item" style={{ animationDelay: delay() }}>
            <StatCard
              label="State"
              value={status.state}
              accent={status.state === 'running'}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              }
            />
          </div>
          <div className="animate-list-item" style={{ animationDelay: delay() }}>
            <StatCard
              label="Uptime"
              value={formatUptime(status.uptimeMs)}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
                </svg>
              }
            />
          </div>
          <div className="animate-list-item" style={{ animationDelay: delay() }}>
            <StatCard
              label="Sessions"
              value={status.activeSessions}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              }
            />
          </div>
          <div className="animate-list-item" style={{ animationDelay: delay() }}>
            <StatCard
              label="Port"
              value={status.controlPlanePort}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              }
            />
          </div>
        </div>

        {/* Channels */}
        <div className="animate-list-item" style={{ animationDelay: delay() }}>
          <div className="text-[10px] text-tetsuo-400 uppercase tracking-[0.15em] font-medium mb-3">Channels</div>
          {status.channels.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 rounded-xl border border-dashed border-tetsuo-200">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-300" strokeWidth="1.5" strokeLinecap="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
              <span className="text-xs text-tetsuo-400">No channels connected</span>
            </div>
          ) : (
            <div className="space-y-2">
              {status.channels.map((ch, i) => (
                <div
                  key={ch}
                  className="animate-list-item flex items-center gap-3 px-4 py-3 bg-tetsuo-50 rounded-xl border border-tetsuo-200 hover:border-tetsuo-300 transition-all duration-200"
                  style={{ animationDelay: `${(idx + i) * 60}ms` }}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-sm font-medium text-tetsuo-700">{ch}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div></div>
    </div>
  );
}
