import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo, WSMessage } from '../types';

interface UseAgentsOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseAgentsReturn {
  agents: AgentInfo[];
  refresh: () => void;
}

export function useAgents({ send, connected }: UseAgentsOptions): UseAgentsReturn & { handleMessage: (msg: WSMessage) => void } {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const refresh = useCallback(() => {
    send({ type: 'agents.list' });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'agents.list') {
      const payload = (msg.payload ?? []) as AgentInfo[];
      setAgents(Array.isArray(payload) ? payload : []);
    }
  }, []);

  // Auto-fetch on connect
  useEffect(() => {
    if (connected) refresh();
  }, [connected, refresh]);

  return { agents, refresh, handleMessage };
}
