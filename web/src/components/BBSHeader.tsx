import type { ConnectionState } from '../types';

interface BBSHeaderProps {
  connectionState: ConnectionState;
  approvalCount: number;
}

const CONNECTION_LABELS: Record<ConnectionState, { text: string; color: string }> = {
  connected: { text: '[ONLINE]', color: 'text-bbs-green' },
  connecting: { text: '[CONNECTING...]', color: 'text-bbs-yellow animate-pulse' },
  authenticating: { text: '[AUTH...]', color: 'text-bbs-yellow animate-pulse' },
  reconnecting: { text: '[RECONNECTING...]', color: 'text-bbs-yellow animate-pulse' },
  disconnected: { text: '[OFFLINE]', color: 'text-bbs-red' },
};

export function BBSHeader({ connectionState, approvalCount }: BBSHeaderProps) {
  const conn = CONNECTION_LABELS[connectionState];

  return (
    <div className="shrink-0 border-b border-bbs-purple-dim bg-bbs-black">
      <div className="flex items-center justify-between px-4 py-2">
        {/* Left: Logo + wordmark */}
        <div className="flex items-center gap-3">
          <img
            src="/assets/agenc-logo-purple.svg"
            alt=""
            className="h-5 w-5 md:h-6 md:w-6 shrink-0 select-none"
            draggable={false}
            aria-hidden="true"
          />
          <img
            src="/assets/agenc-wordmark-white.svg"
            alt="AgenC"
            className="h-[0.98rem] w-auto select-none opacity-95 translate-y-px"
            draggable={false}
          />
        </div>

        {/* Right: System info */}
        <div className="flex items-center gap-4 text-xs">
          <span className="text-bbs-gray hidden md:inline">NODE 01</span>
          <span className="text-bbs-gray hidden md:inline">SYSOP: tetsuo</span>
          <span className={conn.color}>{conn.text}</span>
          {approvalCount > 0 && (
            <span className="text-bbs-yellow animate-pulse">[!{approvalCount}]</span>
          )}
          <span className="text-bbs-gray hidden lg:inline">[F1] HELP</span>
        </div>
      </div>
    </div>
  );
}
