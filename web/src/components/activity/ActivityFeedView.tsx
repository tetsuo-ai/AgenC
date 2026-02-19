import { useEffect, useRef } from 'react';
import type { ActivityEvent } from '../../types';
import { EventCard } from './EventCard';

interface ActivityFeedViewProps {
  events: ActivityEvent[];
  onClear: () => void;
}

export function ActivityFeedView({ events, onClear }: ActivityFeedViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Activity Feed</h2>
            {events.length > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-tetsuo-400 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {events.length} event{events.length !== 1 ? 's' : ''} captured
              </div>
            )}
          </div>
        </div>
        {events.length > 0 && (
          <button
            onClick={onClear}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-tetsuo-400 hover:text-red-500 hover:bg-red-500/5 transition-all duration-200"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Clear
          </button>
        )}
      </div>

      {/* Events */}
      <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl mx-auto space-y-2">
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <span className="text-sm text-tetsuo-400">No events yet</span>
            <span className="text-xs text-tetsuo-300">Activity will appear here in real-time</span>
          </div>
        ) : (
          events.map((event, i) => (
            <div key={i} className="animate-list-item" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
              <EventCard event={event} />
            </div>
          ))
        )}
        <div ref={endRef} />
      </div></div>
    </div>
  );
}
