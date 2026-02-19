import type { SessionInfo } from '../../types';

interface SessionEntryProps {
  session: SessionInfo;
}

export function SessionEntry({ session }: SessionEntryProps) {
  const lastActive = new Date(session.lastActiveAt).toLocaleString();

  return (
    <div className="px-4 py-3.5 rounded-xl border border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 hover:shadow-sm">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-tetsuo-100 flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-400" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="text-sm text-tetsuo-700 font-mono truncate">{session.id}</div>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-tetsuo-400">
        <span className="flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {session.messageCount} messages
        </span>
        <span className="flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          {lastActive}
        </span>
      </div>
    </div>
  );
}
