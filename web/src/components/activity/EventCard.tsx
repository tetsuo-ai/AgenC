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
    <div className="px-4 py-2.5 bg-tetsuo-800 rounded border border-tetsuo-700 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-accent-light font-medium">{event.eventType}</span>
        <span className="text-tetsuo-500">{time}</span>
      </div>
      {Object.keys(event.data).length > 0 && (
        <pre className="mt-1.5 text-tetsuo-400 whitespace-pre-wrap break-all">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
