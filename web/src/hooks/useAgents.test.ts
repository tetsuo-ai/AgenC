import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgents } from './useAgents';

describe('useAgents', () => {
  it('refreshes on connect and handles list responses', () => {
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ connected }) => useAgents({ send, connected }),
      { initialProps: { connected: false } },
    );

    expect(result.current.agents).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    rerender({ connected: true });

    expect(send).toHaveBeenCalledWith({ type: 'agents.list' });

    act(() => {
      result.current.handleMessage({
        type: 'agents.list',
        payload: [{ pda: 'A', status: 'running', capabilities: [], metadataUri: '', tasksCompleted: 0, reputation: 0, stake: '0', endpoint: '' }],
      } as never);
    });

    expect(result.current.agents).toHaveLength(1);
    expect(result.current.agents[0].pda).toBe('A');
  });
});
