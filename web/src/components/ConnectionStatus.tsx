import type { ConnectionState } from '../types';

const STATE_CONFIG: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: 'bg-green-500', label: 'Connected' },
  connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
  authenticating: { color: 'bg-yellow-500', label: 'Authenticating...' },
  reconnecting: { color: 'bg-yellow-500', label: 'Reconnecting...' },
  disconnected: { color: 'bg-red-500', label: 'Disconnected' },
};

interface ConnectionStatusProps {
  state: ConnectionState;
  compact?: boolean;
}

export function ConnectionStatus({ state, compact }: ConnectionStatusProps) {
  const { color, label } = STATE_CONFIG[state];
  const pulse = state === 'connecting' || state === 'authenticating' || state === 'reconnecting' ? 'animate-pulse' : '';

  if (compact) {
    return (
      <div className="flex items-center justify-center" title={label}>
        <span className={`w-2.5 h-2.5 rounded-full ${color} ${pulse}`} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${color} ${pulse}`} />
      <span className="text-tetsuo-500">{label}</span>
    </div>
  );
}
