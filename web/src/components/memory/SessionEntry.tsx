import type { SessionInfo } from '../../types';

interface SessionEntryProps {
  session: SessionInfo;
}

export function SessionEntry({ session }: SessionEntryProps) {
  const lastActive = new Date(session.lastActiveAt).toLocaleString();

  return (
    <article className="border border-bbs-border bg-bbs-dark px-4 py-4 transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
            <span className="text-bbs-purple">SESSION&gt;</span>
            <span className="truncate break-all text-bbs-lightgray">{session.id}</span>
          </div>
          <div className="mt-2 text-xs uppercase tracking-[0.14em] text-bbs-cyan">
            [messages:{session.messageCount}]
          </div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-gray">
          [last active]
        </div>
      </div>

      <div className="mt-3 border border-bbs-border bg-bbs-black/40 px-3 py-3 text-sm text-bbs-lightgray">
        {lastActive}
      </div>
    </article>
  );
}
