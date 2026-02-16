import { useCallback, useState } from 'react';
import type { TaskInfo, WSMessage } from '../types';

interface UseTasksOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseTasksReturn {
  tasks: TaskInfo[];
  refresh: () => void;
  create: (params: Record<string, unknown>) => void;
  cancel: (taskId: string) => void;
}

export function useTasks({ send }: UseTasksOptions): UseTasksReturn {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  const refresh = useCallback(() => {
    send({ type: 'tasks.list' });
  }, [send]);

  const create = useCallback((params: Record<string, unknown>) => {
    send({ type: 'tasks.create', payload: { params } });
  }, [send]);

  const cancel = useCallback((taskId: string) => {
    send({ type: 'tasks.cancel', payload: { taskId } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'tasks.list') {
      setTasks((msg.payload as TaskInfo[]) ?? []);
    }
  }, []);

  return { tasks, refresh, create, cancel, handleMessage } as UseTasksReturn & { handleMessage: (msg: WSMessage) => void };
}
