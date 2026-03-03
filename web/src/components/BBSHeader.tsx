import type { ConnectionState } from '../types';

interface BBSHeaderProps {
  connectionState: ConnectionState;
  approvalCount: number;
}

const ASCII_LOGO = `██╗  ██╗██╗  ██╗
╚██╗██╔╝╚██╗██╔╝
 ╚███╔╝  ╚███╔╝
 ██╔██╗  ██╔██╗
██╔╝ ██╗██╔╝ ██╗
╚═╝  ╚═╝╚═╝  ╚═╝`;

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
        <div className="flex items-center gap-4">
          <pre className="text-bbs-purple text-[5px] leading-[5px] hidden sm:block select-none">{ASCII_LOGO}</pre>
          <span className="text-bbs-white font-bold text-lg tracking-[4px]">agenc</span>
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
