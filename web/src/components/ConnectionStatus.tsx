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
}

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  const { color, label } = STATE_CONFIG[state];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${color} ${state === 'connecting' || state === 'authenticating' || state === 'reconnecting' ? 'animate-pulse' : ''}`} />
      <span className="text-tetsuo-400">{label}</span>
    </div>
  );
}
