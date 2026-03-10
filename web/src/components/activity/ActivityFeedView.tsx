import { useCallback, useEffect, useRef } from 'react';
import type { ActivityEvent } from '../../types';
import { EventCard } from './EventCard';

const AUTO_SCROLL_THRESHOLD_PX = 96;

interface ActivityFeedViewProps {
  events: ActivityEvent[];
  onClear: () => void;
}

export function ActivityFeedView({ events, onClear }: ActivityFeedViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const updateStickToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    updateStickToBottom();
  }, [updateStickToBottom]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="border-b border-bbs-border bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="text-bbs-purple">FEED&gt;</span>
              <span>runtime activity stream</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Event bus monitor
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              live operational telemetry from chat, tools, tasks, and delegated runtime activity
            </p>
          </div>

          {events.length > 0 ? (
            <button
              type="button"
              onClick={onClear}
              className="border border-bbs-red/40 bg-bbs-dark px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-red transition-colors hover:text-bbs-white"
            >
              [CLEAR]
            </button>
          ) : null}
        </div>
      </header>

      <div
        ref={scrollContainerRef}
        data-testid="activity-feed-scroll-container"
        className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6"
        onScroll={updateStickToBottom}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {events.length === 0 ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no events captured]
            </div>
          ) : (
            events.map((event, index) => (
              <div
                key={`${event.timestamp}-${index}`}
                className="animate-list-item"
                style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
              >
                <EventCard event={event} />
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
