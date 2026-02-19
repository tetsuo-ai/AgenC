import type { TaskInfo } from '../../types';

interface TaskCardProps {
  task: TaskInfo;
  onCancel: (taskId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'text-green-600',
  in_progress: 'text-yellow-600',
  completed: 'text-blue-600',
  cancelled: 'text-tetsuo-400',
  disputed: 'text-red-600',
};

export function TaskCard({ task, onCancel }: TaskCardProps) {
  const statusColor = STATUS_COLORS[task.status.toLowerCase()] ?? 'text-tetsuo-500';

  return (
    <div className="px-4 py-3 bg-tetsuo-50 rounded-lg border border-tetsuo-200">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-tetsuo-800 truncate">{task.id}</div>
        <span className={`text-xs font-medium uppercase ${statusColor}`}>
          {task.status}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-tetsuo-500">
        {task.reward && <span>Reward: {task.reward}</span>}
        {task.worker && <span>Worker: {task.worker.slice(0, 8)}...</span>}
      </div>
      {task.status.toLowerCase() === 'open' && (
        <button
          onClick={() => onCancel(task.id)}
          className="mt-2 text-xs text-red-500 hover:text-red-600 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
