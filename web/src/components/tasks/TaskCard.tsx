import type { TaskInfo } from '../../types';

interface TaskCardProps {
  task: TaskInfo;
  onCancel: (taskId: string) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  open: { bg: 'bg-emerald-500/10', text: 'text-emerald-600', dot: 'bg-emerald-500' },
  in_progress: { bg: 'bg-amber-500/10', text: 'text-amber-600', dot: 'bg-amber-500' },
  completed: { bg: 'bg-blue-500/10', text: 'text-blue-600', dot: 'bg-blue-500' },
  cancelled: { bg: 'bg-tetsuo-200/50', text: 'text-tetsuo-400', dot: 'bg-tetsuo-400' },
  disputed: { bg: 'bg-red-500/10', text: 'text-red-600', dot: 'bg-red-500' },
};

export function TaskCard({ task, onCancel }: TaskCardProps) {
  const style = STATUS_STYLES[task.status.toLowerCase()] ?? STATUS_STYLES.open;

  return (
    <div className="px-4 py-3.5 rounded-xl border border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 hover:shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {task.description ? (
            <div className="text-sm font-medium text-tetsuo-800 truncate">{task.description}</div>
          ) : (
            <div className="text-sm font-medium text-tetsuo-800 truncate font-mono">{task.id.slice(0, 16)}...</div>
          )}
          <div className="text-[10px] text-tetsuo-400 font-mono mt-0.5">{task.id.slice(0, 16)}...</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider shrink-0 ${style.bg} ${style.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
          {task.status}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-4 text-xs text-tetsuo-400">
        {task.reward && (
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 18V6" /></svg>
            {task.reward}
          </span>
        )}
        {task.worker && (
          <span className="flex items-center gap-1 font-mono">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            {task.worker.slice(0, 8)}...
          </span>
        )}
      </div>
      {task.status.toLowerCase() === 'open' && (
        <button
          onClick={() => onCancel(task.id)}
          className="mt-3 flex items-center gap-1 text-xs text-red-500 hover:text-red-600 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          Cancel task
        </button>
      )}
    </div>
  );
}
