import type { TaskInfo } from '../../types';

interface TaskCardProps {
  task: TaskInfo;
  onCancel: (taskId: string) => void;
}

const STATUS_STYLES: Record<string, string> = {
  open: 'border-bbs-green/40 text-bbs-green',
  in_progress: 'border-bbs-yellow/40 text-bbs-yellow',
  completed: 'border-bbs-cyan/40 text-bbs-cyan',
  cancelled: 'border-bbs-border text-bbs-gray',
  disputed: 'border-bbs-red/40 text-bbs-red',
};

function truncateId(value: string) {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

export function TaskCard({ task, onCancel }: TaskCardProps) {
  const statusKey = task.status.toLowerCase();
  const statusClass = STATUS_STYLES[statusKey] ?? STATUS_STYLES.open;
  const description = task.description?.trim() || 'untitled task';

  return (
    <article className="border border-bbs-border bg-bbs-dark px-4 py-4 transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
            <span className="text-bbs-purple">TASK&gt;</span>
            <span className="text-bbs-lightgray">{truncateId(task.id)}</span>
          </div>
          <div className="mt-2 break-words text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
            {description}
          </div>
        </div>

        <span className={`shrink-0 border px-3 py-2 text-[10px] uppercase tracking-[0.16em] ${statusClass}`}>
          [{statusKey}]
        </span>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-bbs-gray md:grid-cols-3">
        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">task id</div>
          <div className="mt-1 break-all text-bbs-lightgray">{task.id}</div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">reward</div>
          <div className="mt-1 text-bbs-lightgray">{task.reward ?? '--'}</div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">worker</div>
          <div className="mt-1 break-all text-bbs-lightgray">{task.worker ?? '--'}</div>
        </div>
      </div>

      {statusKey === 'open' && (
        <div className="mt-4 flex justify-start">
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            className="border border-bbs-red/40 bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-red transition-colors hover:text-bbs-white"
          >
            [cancel task]
          </button>
        </div>
      )}
    </article>
  );
}
