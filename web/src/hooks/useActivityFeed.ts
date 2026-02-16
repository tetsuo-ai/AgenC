import { useCallback, useEffect, useState } from 'react';
import type { ActivityEvent, WSMessage } from '../types';

const MAX_EVENTS = 200;

interface UseActivityFeedOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseActivityFeedReturn {
  events: ActivityEvent[];
  subscribe: (filters?: string[]) => void;
  unsubscribe: () => void;
  clear: () => void;
}

export function useActivityFeed({ send, connected }: UseActivityFeedOptions): UseActivityFeedReturn {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const subscribe = useCallback((filters?: string[]) => {
    send({ type: 'events.subscribe', payload: { filters } });
  }, [send]);

  const unsubscribe = useCallback(() => {
    send({ type: 'events.unsubscribe' });
  }, [send]);

  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'events.event') {
      const payload = (msg.payload ?? msg) as Record<string, unknown>;
      const event: ActivityEvent = {
        eventType: (payload.eventType as string) ?? '',
        data: (payload.data as Record<string, unknown>) ?? {},
        timestamp: (payload.timestamp as number) ?? Date.now(),
      };
      setEvents((prev) => {
        const next = [...prev, event];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    }
  }, []);

  // Auto-subscribe when connected
  useEffect(() => {
    if (connected) {
      subscribe();
    }
  }, [connected, subscribe]);

  return { events, subscribe, unsubscribe, clear, handleMessage } as UseActivityFeedReturn & { handleMessage: (msg: WSMessage) => void };
}
