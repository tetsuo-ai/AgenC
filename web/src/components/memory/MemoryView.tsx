import { useCallback, useEffect, useState } from 'react';
import type { MemoryEntry, SessionInfo } from '../../types';
import { SessionEntry } from './SessionEntry';

interface MemoryViewProps {
  results: MemoryEntry[];
  sessions: SessionInfo[];
  onSearch: (query: string) => void;
  onRefreshSessions: () => void;
}

export function MemoryView({ results, sessions, onSearch, onRefreshSessions }: MemoryViewProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'search' | 'sessions'>('sessions');

  useEffect(() => {
    onRefreshSessions();
  }, [onRefreshSessions]);

  const handleSearch = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!query.trim()) return;
      onSearch(query.trim());
      setTab('search');
    },
    [query, onSearch],
  );

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="border-b border-bbs-border bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="text-bbs-purple">MEMORY&gt;</span>
              <span>conversation index</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Session archive and recall
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              inspect persisted sessions and search recalled fragments across prior runs
            </p>
          </div>

          <button
            type="button"
            onClick={onRefreshSessions}
            className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
          >
            [REFRESH]
          </button>
        </div>
      </header>

      <div className="border-b border-bbs-border bg-bbs-dark/80 px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          <form onSubmit={handleSearch} className="flex flex-col gap-2 md:flex-row">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search memory fragments, sessions, or recalled messages"
              className="min-w-0 flex-1 border border-bbs-border bg-bbs-surface px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
            />
            <button
              type="submit"
              className="border border-bbs-border bg-bbs-dark px-4 py-3 text-xs uppercase tracking-[0.14em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [SEARCH]
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em]">
            <button
              type="button"
              onClick={() => setTab('sessions')}
              className={[
                'border px-3 py-2 transition-colors',
                tab === 'sessions'
                  ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                  : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
              ].join(' ')}
            >
              [sessions:{sessions.length}]
            </button>
            <button
              type="button"
              onClick={() => setTab('search')}
              className={[
                'border px-3 py-2 transition-colors',
                tab === 'search'
                  ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                  : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
              ].join(' ')}
            >
              [results:{results.length}]
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {tab === 'sessions' ? (
            sessions.length === 0 ? (
              <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
                [no archived sessions]
              </div>
            ) : (
              sessions.map((session, index) => (
                <div key={session.id} className="animate-list-item" style={{ animationDelay: `${index * 40}ms` }}>
                  <SessionEntry session={session} />
                </div>
              ))
            )
          ) : results.length === 0 ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no recalled entries]
            </div>
          ) : (
            results.map((entry, index) => (
              <article
                key={`${entry.timestamp}-${index}`}
                className="animate-list-item border border-bbs-border bg-bbs-dark px-4 py-4"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
                  <span className="text-bbs-purple">ENTRY&gt;</span>
                  <span className={entry.role === 'user' ? 'text-bbs-cyan' : 'text-bbs-green'}>[{entry.role}]</span>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
                <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-bbs-lightgray">
                  {entry.content}
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
