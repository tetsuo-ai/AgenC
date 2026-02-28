import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useApprovals } from './useApprovals';
import type { WSMessage } from '../types';

type UseApprovalsHook = ReturnType<typeof useApprovals> & {
  handleMessage: (msg: WSMessage) => void;
};

describe('useApprovals', () => {
  it('adds incoming approval requests when not auto-approving', () => {
    const send = vi.fn();
    localStorage.setItem('agenc-auto-approve', 'false');

    const { result } = renderHook(() => useApprovals({ send }));

    act(() => {
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: {
          requestId: 'req-1',
          action: 'transfer',
          details: { amount: '1' },
        },
      });
    });

    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]).toMatchObject({ requestId: 'req-1', action: 'transfer' });
  });

  it('auto-approves when enabled and does not keep request in pending', () => {
    const send = vi.fn();
    localStorage.setItem('agenc-auto-approve', 'true');

    const { result } = renderHook(() => useApprovals({ send }));

    act(() => {
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: {
          requestId: 'req-auto',
          action: 'doit',
          details: {},
        },
      });
    });

    expect(result.current.pending).toHaveLength(0);
    expect(send).toHaveBeenCalledWith({
      type: 'approval.respond',
      payload: { requestId: 'req-auto', approved: true },
    });
  });

  it('responds and removes pending item', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useApprovals({ send }));

    act(() => {
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: { requestId: 'req-2', action: 'approve', details: {} },
      });
    });

    act(() => {
      result.current.respond('req-2', false);
    });

    expect(result.current.pending).toHaveLength(0);
    expect(send).toHaveBeenCalledWith({
      type: 'approval.respond',
      payload: { requestId: 'req-2', approved: false },
    });
  });

  it('ignores duplicate approval requests and already responded ones', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useApprovals({ send }));

    act(() => {
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: { requestId: 'req-dup', action: 'x', details: {} },
      });
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: { requestId: 'req-dup', action: 'x', details: {} },
      });
    });

    expect(result.current.pending).toHaveLength(1);

    act(() => {
      result.current.respond('req-dup', true);
      (result.current as UseApprovalsHook).handleMessage({
        type: 'approval.request',
        payload: { requestId: 'req-dup', action: 'x', details: {} },
      });
    });

    expect(result.current.pending).toHaveLength(0);
  });
});
