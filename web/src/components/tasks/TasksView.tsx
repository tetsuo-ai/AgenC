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
      <div className="flex items-center justify-between px-4 py-3 border-b border-tetsuo-200">
        <h2 className="text-sm font-semibold text-tetsuo-800">Tasks</h2>
        <button
          onClick={onRefresh}
          className="text-xs text-accent hover:text-accent-dark transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <CreateTaskForm onCreate={onCreate} />

        {tasks.length === 0 ? (
          <div className="text-center text-tetsuo-400 text-sm py-8">
            No tasks found
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} onCancel={onCancel} />
          ))
        )}
      </div>
    </div>
  );
}
