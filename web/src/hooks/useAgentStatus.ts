import { useCallback, useEffect, useState } from 'react';
import type { GatewayStatus, WSMessage } from '../types';

const POLL_INTERVAL_MS = 10_000;

interface UseAgentStatusOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseAgentStatusReturn {
  status: GatewayStatus | null;
  refresh: () => void;
}

export function useAgentStatus({ send, connected }: UseAgentStatusOptions): UseAgentStatusReturn {
  const [status, setStatus] = useState<GatewayStatus | null>(null);

  const refresh = useCallback(() => {
    send({ type: 'status.get' });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'status.update' || msg.type === 'status') {
      setStatus(msg.payload as GatewayStatus);
    }
  }, []);

  // Poll on interval when connected
  useEffect(() => {
    if (!connected) return;
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  return { status, refresh, handleMessage } as UseAgentStatusReturn & { handleMessage: (msg: WSMessage) => void };
}
