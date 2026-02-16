import type { TaskInfo } from '../../types';

interface TaskCardProps {
  task: TaskInfo;
  onCancel: (taskId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'text-green-400',
  in_progress: 'text-yellow-400',
  completed: 'text-blue-400',
  cancelled: 'text-tetsuo-500',
  disputed: 'text-red-400',
};

export function TaskCard({ task, onCancel }: TaskCardProps) {
  const statusColor = STATUS_COLORS[task.status.toLowerCase()] ?? 'text-tetsuo-400';

  return (
    <div className="px-4 py-3 bg-tetsuo-800 rounded-lg border border-tetsuo-700">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-tetsuo-100 truncate">{task.id}</div>
        <span className={`text-xs font-medium uppercase ${statusColor}`}>
          {task.status}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-tetsuo-400">
        {task.reward && <span>Reward: {task.reward}</span>}
        {task.worker && <span>Worker: {task.worker.slice(0, 8)}...</span>}
      </div>
      {task.status.toLowerCase() === 'open' && (
        <button
          onClick={() => onCancel(task.id)}
          className="mt-2 text-xs text-red-400 hover:text-red-300 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
