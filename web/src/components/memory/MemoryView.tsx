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
      <div className="px-4 py-3 border-b border-tetsuo-200">
        <h2 className="text-sm font-semibold text-tetsuo-800">Memory</h2>
      </div>

      <div className="p-4">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory..."
            className="flex-1 bg-surface text-tetsuo-800 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent placeholder:text-tetsuo-400"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent-dark transition-colors"
          >
            Search
          </button>
        </form>
      </div>

      <div className="flex px-4 gap-2 mb-3">
        <button
          onClick={() => setTab('sessions')}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            tab === 'sessions' ? 'bg-accent text-white' : 'bg-tetsuo-100 text-tetsuo-500 hover:text-tetsuo-700'
          }`}
        >
          Sessions
        </button>
        <button
          onClick={() => setTab('search')}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            tab === 'search' ? 'bg-accent text-white' : 'bg-tetsuo-100 text-tetsuo-500 hover:text-tetsuo-700'
          }`}
        >
          Search Results
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {tab === 'sessions' ? (
          sessions.length === 0 ? (
            <div className="text-center text-tetsuo-400 text-sm py-8">No sessions found</div>
          ) : (
            sessions.map((s) => <SessionEntry key={s.id} session={s} />)
          )
        ) : results.length === 0 ? (
          <div className="text-center text-tetsuo-400 text-sm py-8">No results</div>
        ) : (
          results.map((entry, i) => (
            <div key={i} className="px-4 py-3 bg-tetsuo-50 rounded-lg border border-tetsuo-200">
              <div className="text-xs text-tetsuo-400 mb-1">
                {entry.role} &middot; {new Date(entry.timestamp).toLocaleString()}
              </div>
              <div className="text-sm text-tetsuo-700">{entry.content}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
