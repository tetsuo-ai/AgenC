import { useEffect, useMemo, useState } from 'react';
import type { TaskInfo } from '../../types';
import { TaskCard } from './TaskCard';
import { CreateTaskForm } from './CreateTaskForm';

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Open', value: 'open' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
] as const;

interface TasksViewProps {
  tasks: TaskInfo[];
  onRefresh: () => void;
  onCreate: (params: Record<string, unknown>) => void;
  onCancel: (taskId: string) => void;
}

export function TasksView({ tasks, onRefresh, onCreate, onCancel }: TasksViewProps) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  // Reverse order (newest first) and apply status filter
  const filtered = useMemo(() => {
    const reversed = [...tasks].reverse();
    if (!filter) return reversed;
    return reversed.filter((t) => t.status.toLowerCase() === filter);
  }, [tasks, filter]);

  // Count per status for filter badges
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of tasks) {
      const key = t.status.toLowerCase();
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  }, [tasks]);

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

      {/* Filter chips */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-1.5 px-6 py-2.5 border-b border-tetsuo-200 overflow-x-auto">
          {FILTERS.map((f) => {
            const count = f.value ? (counts[f.value] ?? 0) : tasks.length;
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-all duration-150 ${
                  active
                    ? 'bg-accent text-white shadow-sm'
                    : 'bg-tetsuo-100 text-tetsuo-500 hover:bg-tetsuo-200 hover:text-tetsuo-700'
                }`}
              >
                {f.label}
                {count > 0 && (
                  <span className={`text-[10px] ${active ? 'text-white/70' : 'text-tetsuo-400'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl mx-auto space-y-3">
        <div className="animate-list-item" style={{ animationDelay: '0ms' }}>
          <CreateTaskForm onCreate={onCreate} />
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className="text-sm text-tetsuo-400">
              {filter ? `No ${FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} tasks` : 'No tasks found'}
            </span>
          </div>
        ) : (
          filtered.map((task, i) => (
            <div key={task.id} className="animate-list-item" style={{ animationDelay: `${(i + 1) * 50}ms` }}>
              <TaskCard task={task} onCancel={onCancel} />
            </div>
          ))
        )}
      </div></div>
    </div>
  );
}
