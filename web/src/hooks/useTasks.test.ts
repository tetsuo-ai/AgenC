import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTasks } from './useTasks';
import type { WSMessage } from '../types';

type UseTasksHook = ReturnType<typeof useTasks> & { handleMessage: (msg: WSMessage) => void };

describe('useTasks', () => {
  it('sends refresh/create/cancel payloads', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useTasks({ send }));

    act(() => {
      result.current.refresh();
    });
    act(() => {
      result.current.create({ description: 'Build feature' });
    });
    act(() => {
      result.current.cancel('task-1');
    });

    expect(send).toHaveBeenNthCalledWith(1, { type: 'tasks.list' });
    expect(send).toHaveBeenNthCalledWith(2, { type: 'tasks.create', payload: { params: { description: 'Build feature' } } });
    expect(send).toHaveBeenNthCalledWith(3, { type: 'tasks.cancel', payload: { taskId: 'task-1' } });
  });

  it('handles tasks.list response', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useTasks({ send }));

    act(() => {
      (result.current as UseTasksHook).handleMessage({
        type: 'tasks.list',
        payload: [{ id: 't-1', status: 'open', description: 'A' }],
      });
    });

    expect(result.current.tasks).toEqual([{ id: 't-1', status: 'open', description: 'A' }]);
  });
});
