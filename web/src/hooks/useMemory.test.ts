import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMemory } from './useMemory';
import type { WSMessage } from '../types';

type UseMemoryHook = ReturnType<typeof useMemory> & { handleMessage: (msg: WSMessage) => void };

describe('useMemory', () => {
  it('sends search and refresh sessions commands', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useMemory({ send }));

    act(() => {
      result.current.search('hello');
      result.current.refreshSessions();
    });

    expect(send).toHaveBeenNthCalledWith(1, { type: 'memory.search', payload: { query: 'hello' } });
    expect(send).toHaveBeenNthCalledWith(2, { type: 'memory.sessions' });
  });

  it('handles memory responses', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useMemory({ send }));

    act(() => {
      (result.current as UseMemoryHook).handleMessage({ type: 'memory.results', payload: [{ content: 'c', timestamp: 1, role: 'user' }] });
      (result.current as UseMemoryHook).handleMessage({
        type: 'memory.sessions',
        payload: [{ id: 's', messageCount: 2, lastActiveAt: 5 }],
      });
    });

    expect(result.current.results).toHaveLength(1);
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.results[0].content).toBe('c');
  });
});
