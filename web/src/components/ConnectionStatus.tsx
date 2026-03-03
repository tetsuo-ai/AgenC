import type { ConnectionState } from '../types';

const STATE_CONFIG: Record<ConnectionState, { text: string; color: string }> = {
  connected: { text: '[CONNECTED]', color: 'text-bbs-green' },
  connecting: { text: '[CONNECTING...]', color: 'text-bbs-yellow animate-pulse' },
  authenticating: { text: '[AUTH...]', color: 'text-bbs-yellow animate-pulse' },
  reconnecting: { text: '[RECONNECTING...]', color: 'text-bbs-yellow animate-pulse' },
  disconnected: { text: '[DISCONNECTED]', color: 'text-bbs-red' },
};

interface ConnectionStatusProps {
  state: ConnectionState;
  compact?: boolean;
}

export function ConnectionStatus({ state, compact }: ConnectionStatusProps) {
  const { text, color } = STATE_CONFIG[state];

  if (compact) {
    return (
      <div className="flex items-center justify-center" title={text}>
        <span className={`text-[10px] font-bold ${color}`}>{text}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className={`font-bold ${color}`}>{text}</span>
    </div>
  );
}
