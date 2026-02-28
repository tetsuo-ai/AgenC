import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentStatus } from './useAgentStatus';
import type { WSMessage } from '../types';

type AgentStatusHook = ReturnType<typeof useAgentStatus> & { handleMessage: (msg: WSMessage) => void };

describe('useAgentStatus', () => {
  it('refreshes on connect and updates status messages', () => {
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ connected }) => useAgentStatus({ send, connected }),
      { initialProps: { connected: false } },
    );

    expect(send).not.toHaveBeenCalled();

    rerender({ connected: true });

    expect(send).toHaveBeenCalledWith({ type: 'status.get' });

    act(() => {
      (result.current as AgentStatusHook).handleMessage({
        type: 'status.update',
        payload: { state: 'running', uptimeMs: 1000, channels: ['chat'], activeSessions: 2, controlPlanePort: 4000, agentName: 'alpha' },
      } as never,
      );
    });

    expect(result.current.status?.state).toBe('running');
    expect(result.current.status?.agentName).toBe('alpha');
  });
});
