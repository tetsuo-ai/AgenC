import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

const CONNECTING = 0;
const OPEN = 1;

interface WsMockInstance {
  readyState: number;
  sent: string[];
  onopen: ((ev?: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  triggerOpen: () => void;
  triggerMessage: (data: unknown) => void;
  triggerClose: () => void;
  close: ReturnType<typeof vi.fn>;
}

const instances: WsMockInstance[] = [];

class WsMock {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;

  readyState: number = CONNECTING;
  sent: string[] = [];
  onopen: ((ev?: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose();
    }
  });

  constructor() {
    instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  triggerOpen() {
    this.readyState = OPEN;
    if (this.onopen) {
      this.onopen();
    }
  }

  triggerMessage(data: unknown) {
    if (!this.onmessage) return;
    this.onmessage({ data: JSON.stringify(data) } as MessageEvent);
  }

  triggerClose() {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose();
    }
  }
}

describe('useWebSocket', () => {
  it('queues sends until connected then flushes', async () => {
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: typeof WsMock }).WebSocket = WsMock as never;

    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket({ onMessage }));

    expect(result.current.state).toBe('connecting');

    act(() => {
      result.current.send({ type: 'queued' });
    });
    expect(instances).toHaveLength(1);

    act(() => {
      instances[0].triggerOpen();
      instances[0].triggerMessage({ type: 'chat.response', payload: { ok: true } });
    });

    expect(result.current.state).toBe('connected');
    expect(instances[0].sent).toEqual([JSON.stringify({ type: 'queued' })]);
    expect(onMessage).toHaveBeenCalledWith({ type: 'chat.response', payload: { ok: true } });
    expect(result.current.lastMessage).toEqual({ type: 'chat.response', payload: { ok: true } });
    vi.useRealTimers();
  });

  it('reconnects after close with backoff', () => {
    vi.useFakeTimers();
    instances.length = 0;
    (globalThis as unknown as { WebSocket: typeof WsMock }).WebSocket = WsMock as never;

    const { result } = renderHook(() => useWebSocket());

    act(() => {
      result.current.send({ type: 'hello' });
      instances[0].triggerOpen();
      instances[0].triggerClose();
    });

    expect(result.current.state).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(instances.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});
