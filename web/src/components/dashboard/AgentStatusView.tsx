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

export function AgentStatusView({ status, onRefresh }: AgentStatusViewProps) {
  if (!status) {
    return (
      <div className="flex items-center justify-center h-full text-tetsuo-400 text-sm">
        Waiting for status...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-tetsuo-200">
        <h2 className="text-sm font-semibold text-tetsuo-800">Agent Status</h2>
        <button
          onClick={onRefresh}
          className="text-xs text-accent hover:text-accent-dark transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="p-4 space-y-6 overflow-y-auto">
        {status.agentName && (
          <div>
            <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-1">Agent</div>
            <div className="text-lg font-semibold text-tetsuo-800">{status.agentName}</div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <StatCard label="State" value={status.state} />
          <StatCard label="Uptime" value={formatUptime(status.uptimeMs)} />
          <StatCard label="Sessions" value={status.activeSessions} />
          <StatCard label="Port" value={status.controlPlanePort} />
        </div>

        <div>
          <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-2">Channels</div>
          {status.channels.length === 0 ? (
            <div className="text-sm text-tetsuo-400">No channels connected</div>
          ) : (
            <div className="space-y-1">
              {status.channels.map((ch) => (
                <div
                  key={ch}
                  className="flex items-center gap-2 px-3 py-2 bg-tetsuo-50 rounded-lg border border-tetsuo-200 text-sm"
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {ch}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
