import { useCallback, useState } from 'react';
import type { MemoryEntry, SessionInfo, WSMessage } from '../types';

interface UseMemoryOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseMemoryReturn {
  results: MemoryEntry[];
  sessions: SessionInfo[];
  search: (query: string) => void;
  refreshSessions: () => void;
}

export function useMemory({ send }: UseMemoryOptions): UseMemoryReturn {
  const [results, setResults] = useState<MemoryEntry[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const search = useCallback((query: string) => {
    send({ type: 'memory.search', payload: { query } });
  }, [send]);

  const refreshSessions = useCallback(() => {
    send({ type: 'memory.sessions' });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'memory.results') {
      setResults((msg.payload as MemoryEntry[]) ?? []);
    } else if (msg.type === 'memory.sessions') {
      setSessions((msg.payload as SessionInfo[]) ?? []);
    }
  }, []);

  return { results, sessions, search, refreshSessions, handleMessage } as UseMemoryReturn & { handleMessage: (msg: WSMessage) => void };
}
