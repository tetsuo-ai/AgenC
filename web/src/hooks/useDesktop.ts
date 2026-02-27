import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WSMessage } from '../types';
import {
  WS_DESKTOP_LIST,
  WS_DESKTOP_CREATE,
  WS_DESKTOP_DESTROY,
  WS_DESKTOP_CREATED,
  WS_DESKTOP_DESTROYED,
  WS_DESKTOP_ERROR,
} from '../constants';

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
  activeVncUrl: string | null;
  vncUrlForSession: (sessionId: string | null | undefined) => string | null;
  refresh: () => void;
  create: (sessionId?: string) => void;
  destroy: (containerId: string) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useDesktop({ send, connected }: UseDesktopOptions): UseDesktopReturn {
  const [sandboxes, setSandboxes] = useState<DesktopSandbox[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    send({ type: WS_DESKTOP_LIST });
  }, [send]);

  const create = useCallback((sessionId?: string) => {
    setLoading(true);
    setError(null);
    send({ type: WS_DESKTOP_CREATE, payload: { sessionId } });
  }, [send]);

  const destroy = useCallback((containerId: string) => {
    send({ type: WS_DESKTOP_DESTROY, payload: { containerId } });
  }, [send]);

  // Auto-refresh on mount when connected
  useEffect(() => {
    if (connected) {
      refresh();
    }
  }, [connected, refresh]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === WS_DESKTOP_LIST) {
      setSandboxes((msg.payload as DesktopSandbox[]) ?? []);
      setLoading(false);
    } else if (msg.type === WS_DESKTOP_CREATED) {
      // Refresh the full list to get accurate state
      setLoading(false);
      send({ type: WS_DESKTOP_LIST });
    } else if (msg.type === WS_DESKTOP_DESTROYED) {
      const destroyed = msg.payload as { containerId: string } | undefined;
      if (destroyed?.containerId) {
        setSandboxes((prev) => prev.filter((s) => s.containerId !== destroyed.containerId));
      }
      setLoading(false);
    } else if (msg.type === WS_DESKTOP_ERROR) {
      setError(msg.error ?? 'Unknown desktop error');
      setLoading(false);
    }
  }, [send]);

  const activeVncUrl = useMemo(
    () => sandboxes.find((s) => s.status === 'ready')?.vncUrl ?? null,
    [sandboxes],
  );

  // Find VNC URL for a specific chat session (the agent's desktop tools
  // create containers keyed by the chat sessionId, so we match on that).
  // Returns null when no session-specific sandbox exists — avoids showing
  // an unrelated container from a different session.
  const vncUrlForSession = useCallback(
    (sessionId: string | null | undefined): string | null => {
      if (!sessionId) return null;
      const match = sandboxes.find(
        (s) => s.status === 'ready' && s.sessionId === sessionId,
      );
      return match?.vncUrl ?? null;
    },
    [sandboxes],
  );

  return { sandboxes, loading, error, activeVncUrl, vncUrlForSession, refresh, create, destroy, handleMessage };
}
