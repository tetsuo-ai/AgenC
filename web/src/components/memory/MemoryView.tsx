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
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        onSearch(query.trim());
        setTab('search');
      }
    },
    [query, onSearch],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Memory</h2>
        </div>
        <button
          onClick={onRefreshSessions}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90"
          title="Refresh"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="px-6 py-4 max-w-2xl mx-auto w-full">
        <form onSubmit={handleSearch} className="relative">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="absolute left-3 top-1/2 -translate-y-1/2 text-tetsuo-400" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory..."
            className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-xl pl-10 pr-20 py-2.5 text-sm text-tetsuo-700 placeholder:text-tetsuo-400 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200"
          />
          <button
            type="submit"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:opacity-90 transition-all duration-200"
          >
            Search
          </button>
        </form>
      </div>

      {/* Tabs */}
      <div className="flex px-6 gap-1 mb-1 max-w-2xl mx-auto w-full">
        <button
          onClick={() => setTab('sessions')}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
            tab === 'sessions'
              ? 'bg-accent text-white shadow-[0_0_8px_rgba(var(--accent),0.25)]'
              : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100'
          }`}
        >
          Sessions{sessions.length > 0 ? ` (${sessions.length})` : ''}
        </button>
        <button
          onClick={() => setTab('search')}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
            tab === 'search'
              ? 'bg-accent text-white shadow-[0_0_8px_rgba(var(--accent),0.25)]'
              : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100'
          }`}
        >
          Results{results.length > 0 ? ` (${results.length})` : ''}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4"><div className="max-w-2xl mx-auto space-y-2">
        {tab === 'sessions' ? (
          sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="text-sm text-tetsuo-400">No sessions found</span>
            </div>
          ) : (
            sessions.map((s, i) => (
              <div key={s.id} className="animate-list-item" style={{ animationDelay: `${i * 40}ms` }}>
                <SessionEntry session={s} />
              </div>
            ))
          )
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="text-sm text-tetsuo-400">No results</span>
          </div>
        ) : (
          results.map((entry, i) => (
            <div key={i} className="animate-list-item px-4 py-3.5 rounded-xl border border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-center gap-2 text-xs text-tetsuo-400 mb-2">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                  entry.role === 'user' ? 'bg-accent-bg text-accent' : 'bg-tetsuo-100 text-tetsuo-500'
                }`}>
                  {entry.role}
                </span>
                <span>{new Date(entry.timestamp).toLocaleString()}</span>
              </div>
              <div className="text-sm text-tetsuo-700 leading-relaxed">{entry.content}</div>
            </div>
          ))
        )}
      </div></div>
    </div>
  );
}
