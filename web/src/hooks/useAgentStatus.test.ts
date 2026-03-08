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
        payload: {
          state: 'running',
          uptimeMs: 1000,
          channels: ['chat'],
          activeSessions: 2,
          controlPlanePort: 4000,
          agentName: 'alpha',
          backgroundRuns: {
            activeTotal: 1,
            queuedSignalsTotal: 0,
            stateCounts: {
              pending: 0,
              running: 0,
              working: 1,
              blocked: 0,
              paused: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
              suspended: 0,
            },
            recentAlerts: [],
            metrics: {
              startedTotal: 1,
              completedTotal: 0,
              failedTotal: 0,
              blockedTotal: 0,
              recoveredTotal: 0,
            },
          },
        },
      } as never,
      );
    });

    expect(result.current.status?.state).toBe('running');
    expect(result.current.status?.agentName).toBe('alpha');
    expect(result.current.status?.backgroundRuns?.activeTotal).toBe(1);
  });
});
