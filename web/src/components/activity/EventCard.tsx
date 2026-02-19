import type { ActivityEvent } from '../../types';

interface EventCardProps {
  event: ActivityEvent;
}

export function EventCard({ event }: EventCardProps) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="px-4 py-2.5 bg-tetsuo-50 rounded-lg border border-tetsuo-200 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-accent font-medium">{event.eventType}</span>
        <span className="text-tetsuo-400">{time}</span>
      </div>
      {Object.keys(event.data).length > 0 && (
        <pre className="mt-1.5 text-tetsuo-500 whitespace-pre-wrap break-all">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
