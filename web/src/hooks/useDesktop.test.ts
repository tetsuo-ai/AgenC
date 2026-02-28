import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDesktop } from './useDesktop';

describe('useDesktop', () => {
  it('refreshes when connected', () => {
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ connected }) => useDesktop({ send, connected }),
      { initialProps: { connected: false } },
    );

    expect(result.current.sandboxes).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    rerender({ connected: true });
    expect(send).toHaveBeenCalledWith({ type: 'desktop.list' });
  });

  it('handles list/created/destroyed/error messages', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useDesktop({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: 'desktop.list',
        payload: [{ containerId: 'c', sessionId: 's', status: 'ready', createdAt: 0, lastActivityAt: 0, vncUrl: 'http://example', uptimeMs: 100 }],
      } as never);
      result.current.create('session-1');
      result.current.handleMessage({ type: 'desktop.created' } as never);
      result.current.handleMessage({
        type: 'desktop.destroyed',
        payload: { containerId: 'c' },
      } as never);
      result.current.handleMessage({ type: 'desktop.error', error: 'failed' } as never);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.sandboxes).toEqual([]);
    expect(result.current.error).toBe('failed');
    expect(send).toHaveBeenCalledWith({ type: 'desktop.create', payload: { sessionId: 'session-1' } });
    expect(send).toHaveBeenCalledWith({ type: 'desktop.list' });
  });

  it('computes vnc helpers', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useDesktop({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: 'desktop.list',
        payload: [{ containerId: 'c', sessionId: 's', status: 'ready', createdAt: 1, lastActivityAt: 2, vncUrl: 'http://vnc', uptimeMs: 0 }],
      } as never);
    });

    expect(result.current.activeVncUrl).toBe('http://vnc');
    expect(result.current.vncUrlForSession('missing')).toBeNull();
    expect(result.current.vncUrlForSession('s')).toBe('http://vnc');
  });
});
