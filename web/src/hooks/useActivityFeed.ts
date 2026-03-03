import { useCallback, useEffect, useState } from 'react';
import type { ActivityEvent, WSMessage } from '../types';
import {
  WS_EVENTS_SUBSCRIBE,
  WS_EVENTS_UNSUBSCRIBE,
  WS_EVENTS_EVENT,
} from '../constants';

const MAX_EVENTS = 200;
const DEFAULT_ACTIVITY_FILTERS = ['chat', 'tool', 'task', 'subagents'];

interface UseActivityFeedOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseActivityFeedReturn {
  events: ActivityEvent[];
  subscribe: (filters?: string[]) => void;
  unsubscribe: () => void;
  clear: () => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useActivityFeed({ send, connected }: UseActivityFeedOptions): UseActivityFeedReturn {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const subscribe = useCallback((filters?: string[]) => {
    send({ type: WS_EVENTS_SUBSCRIBE, payload: { filters } });
  }, [send]);

  const unsubscribe = useCallback(() => {
    send({ type: WS_EVENTS_UNSUBSCRIBE });
  }, [send]);

  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === WS_EVENTS_EVENT) {
      const payload = (msg.payload ?? msg) as Record<string, unknown>;
      const event: ActivityEvent = {
        eventType: (payload.eventType as string) ?? '',
        data: (payload.data as Record<string, unknown>) ?? {},
        timestamp: (payload.timestamp as number) ?? Date.now(),
        traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
        parentTraceId:
          typeof payload.parentTraceId === 'string'
            ? payload.parentTraceId
            : undefined,
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
      subscribe(DEFAULT_ACTIVITY_FILTERS);
    }
  }, [connected, subscribe]);

  return { events, subscribe, unsubscribe, clear, handleMessage };
}
