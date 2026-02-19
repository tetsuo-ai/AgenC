import { useEffect } from 'react';
import type { TaskInfo } from '../../types';
import { TaskCard } from './TaskCard';
import { CreateTaskForm } from './CreateTaskForm';

interface TasksViewProps {
  tasks: TaskInfo[];
  onRefresh: () => void;
  onCreate: (params: Record<string, unknown>) => void;
  onCancel: (taskId: string) => void;
}

export function TasksView({ tasks, onRefresh, onCreate, onCancel }: TasksViewProps) {
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Tasks</h2>
            {tasks.length > 0 && (
              <div className="text-[10px] text-tetsuo-400 mt-0.5">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</div>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90"
          title="Refresh"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl mx-auto space-y-3">
        <div className="animate-list-item" style={{ animationDelay: '0ms' }}>
          <CreateTaskForm onCreate={onCreate} />
        </div>

        {tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className="text-sm text-tetsuo-400">No tasks found</span>
          </div>
        ) : (
          tasks.map((task, i) => (
            <div key={task.id} className="animate-list-item" style={{ animationDelay: `${(i + 1) * 50}ms` }}>
              <TaskCard task={task} onCancel={onCancel} />
            </div>
          ))
        )}
      </div></div>
    </div>
  );
}
