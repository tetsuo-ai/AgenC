import type { ActivityEvent } from '../../types';

interface EventCardProps {
  event: ActivityEvent;
}

const EVENT_COLORS: Record<string, string> = {
  taskCreated: 'text-emerald-500 bg-emerald-500/10',
  taskCompleted: 'text-blue-500 bg-blue-500/10',
  taskCancelled: 'text-red-500 bg-red-500/10',
  taskClaimed: 'text-amber-500 bg-amber-500/10',
  disputeInitiated: 'text-red-500 bg-red-500/10',
  disputeResolved: 'text-blue-500 bg-blue-500/10',
  agentRegistered: 'text-emerald-500 bg-emerald-500/10',
  agentUpdated: 'text-amber-500 bg-amber-500/10',
};

export function EventCard({ event }: EventCardProps) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const colorClass = EVENT_COLORS[event.eventType] ?? 'text-accent bg-accent-bg';

  return (
    <div className="px-4 py-3 rounded-xl border border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 hover:shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${colorClass}`}>
          {event.eventType}
        </span>
        <span className="text-[10px] text-tetsuo-400 font-mono shrink-0">{time}</span>
      </div>
      {Object.keys(event.data).length > 0 && (
        <pre className="mt-2 text-xs text-tetsuo-500 whitespace-pre-wrap break-all font-mono leading-relaxed bg-tetsuo-100/50 rounded-lg p-2.5">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
