import { useCallback, useEffect, useState } from 'react';
import type { WSMessage } from '../types';

export interface DesktopSandbox {
  containerId: string;
  sessionId: string;
  status: string;
  createdAt: number;
  lastActivityAt: number;
  vncUrl: string;
  uptimeMs: number;
}

interface UseDesktopOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseDesktopReturn {
  sandboxes: DesktopSandbox[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  create: (sessionId?: string) => void;
  destroy: (containerId: string) => void;
}

export function useDesktop({ send, connected }: UseDesktopOptions): UseDesktopReturn {
  const [sandboxes, setSandboxes] = useState<DesktopSandbox[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    send({ type: 'desktop.list' });
  }, [send]);

  const create = useCallback((sessionId?: string) => {
    setLoading(true);
    setError(null);
    send({ type: 'desktop.create', payload: { sessionId } });
  }, [send]);

  const destroy = useCallback((containerId: string) => {
    send({ type: 'desktop.destroy', payload: { containerId } });
  }, [send]);

  // Auto-refresh on mount when connected
  useEffect(() => {
    if (connected) {
      refresh();
    }
  }, [connected, refresh]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'desktop.list') {
      setSandboxes((msg.payload as DesktopSandbox[]) ?? []);
      setLoading(false);
    } else if (msg.type === 'desktop.created') {
      // Refresh the full list to get accurate state
      setLoading(false);
      send({ type: 'desktop.list' });
    } else if (msg.type === 'desktop.destroyed') {
      const destroyed = msg.payload as { containerId: string } | undefined;
      if (destroyed?.containerId) {
        setSandboxes((prev) => prev.filter((s) => s.containerId !== destroyed.containerId));
      }
      setLoading(false);
    } else if (msg.type === 'desktop.error') {
      setError(msg.error ?? 'Unknown desktop error');
      setLoading(false);
    }
  }, [send]);

  return { sandboxes, loading, error, refresh, create, destroy, handleMessage } as UseDesktopReturn & { handleMessage: (msg: WSMessage) => void };
}
