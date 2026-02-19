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
      <div className="flex items-center justify-between px-4 py-3 border-b border-tetsuo-200">
        <h2 className="text-sm font-semibold text-tetsuo-800">
          Activity Feed
          {events.length > 0 && (
            <span className="ml-2 text-xs text-tetsuo-400 font-normal">
              ({events.length} events)
            </span>
          )}
        </h2>
        <button
          onClick={onClear}
          className="text-xs text-tetsuo-500 hover:text-tetsuo-700 transition-colors"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {events.length === 0 ? (
          <div className="text-center text-tetsuo-400 text-sm py-8">
            No events yet. Activity will appear here in real-time.
          </div>
        ) : (
          events.map((event, i) => <EventCard key={i} event={event} />)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
