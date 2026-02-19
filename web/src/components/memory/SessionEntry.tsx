import type { SessionInfo } from '../../types';

interface SessionEntryProps {
  session: SessionInfo;
}

export function SessionEntry({ session }: SessionEntryProps) {
  const lastActive = new Date(session.lastActiveAt).toLocaleString();

  return (
    <div className="px-4 py-3 bg-tetsuo-50 rounded-lg border border-tetsuo-200">
      <div className="text-sm text-tetsuo-800 font-mono truncate">{session.id}</div>
      <div className="mt-1 flex items-center gap-4 text-xs text-tetsuo-500">
        <span>{session.messageCount} messages</span>
        <span>Last active: {lastActive}</span>
      </div>
    </div>
  );
}
