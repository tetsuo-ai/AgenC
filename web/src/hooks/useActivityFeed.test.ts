import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useActivityFeed } from './useActivityFeed';
import type { WSMessage } from '../types';

describe('useActivityFeed', () => {
  it('auto-subscribes when connected', () => {
    const send = vi.fn();
    const { rerender } = renderHook(({ connected }) => useActivityFeed({ send, connected }), {
      initialProps: { connected: false },
    });

    expect(send).not.toHaveBeenCalled();

    rerender({ connected: true });

    expect(send).toHaveBeenCalledWith({
      type: 'events.subscribe',
      payload: { filters: ['chat', 'tool', 'task', 'subagents'] },
    });
  });

  it('appends event payloads and can clear', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useActivityFeed({ send, connected: true }));

    act(() => {
      result.current.subscribe(['task']);
      result.current.handleMessage({ type: 'events.event', payload: { eventType: 'task.created', data: { taskId: '1' } } } as WSMessage);
      result.current.handleMessage({
        type: 'events.event',
        payload: {
          eventType: 'task.created',
          data: { taskId: '2' },
          traceId: 'trace-1',
          parentTraceId: 'parent-1',
        },
      } as WSMessage);
    });

    expect(send).toHaveBeenCalledWith({
      type: 'events.subscribe',
      payload: { filters: ['chat', 'tool', 'task', 'subagents'] },
    });
    expect(send).toHaveBeenCalledWith({ type: 'events.subscribe', payload: { filters: ['task'] } });
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[1]).toMatchObject({
      traceId: 'trace-1',
      parentTraceId: 'parent-1',
    });

    act(() => {
      result.current.unsubscribe();
      result.current.clear();
    });

    expect(result.current.events).toEqual([]);
    expect(send).toHaveBeenCalledWith({ type: 'events.unsubscribe' });
    expect(result.current.events).toHaveLength(0);
  });
});
