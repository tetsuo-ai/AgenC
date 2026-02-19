import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState, WSMessage } from '../types';

const DEFAULT_URL = 'ws://127.0.0.1:9100';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const JITTER_FACTOR = 0.2;
const MAX_OFFLINE_QUEUE = 1_000;

interface UseWebSocketOptions {
  url?: string;
  token?: string;
  onMessage?: (msg: WSMessage) => void;
}

export interface UseWebSocketReturn {
  state: ConnectionState;
  send: (msg: Record<string, unknown>) => void;
  lastMessage: WSMessage | null;
}

export function useWebSocket(options?: UseWebSocketOptions): UseWebSocketReturn {
  const url = options?.url ?? DEFAULT_URL;
  const onMessageRef = useRef(options?.onMessage);
  onMessageRef.current = options?.onMessage;
  const tokenRef = useRef(options?.token);
  tokenRef.current = options?.token;

  const [state, setState] = useState<ConnectionState>('disconnected');
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pingTimerRef = useRef<ReturnType<typeof setInterval>>();
  const reconnectAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const intentionalCloseRef = useRef(false);
  const offlineQueueRef = useRef<string[]>([]);

  const stopPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = undefined;
    }
  }, []);

  const startPing = useCallback(() => {
    stopPing();
    pingTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }, [stopPing]);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
  }, []);

  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (offlineQueueRef.current.length > 0) {
      const next = offlineQueueRef.current.shift();
      if (next) {
        ws.send(next);
      }
    }
  }, []);

  const enqueue = useCallback((payload: string) => {
    if (offlineQueueRef.current.length >= MAX_OFFLINE_QUEUE) {
      offlineQueueRef.current.shift();
    }
    offlineQueueRef.current.push(payload);
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    intentionalCloseRef.current = false;
    setState('connecting');
    clearReconnect();

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        return;
      }

      const token = tokenRef.current;
      if (token && token.length > 0) {
        setState('authenticating');
        ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
        return;
      }

      reconnectAttemptRef.current = 0;
      setState('connected');
      startPing();
      flushQueue();
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (parsed && typeof parsed === 'object') {
        const message = parsed as Record<string, unknown>;
        if (message.type === 'auth') {
          if (message.error) {
            offlineQueueRef.current.length = 0;
            setState('disconnected');
            ws.close();
            return;
          }
          reconnectAttemptRef.current = 0;
          setState('connected');
          startPing();
          flushQueue();
          return;
        }
        if (message.type === 'pong') {
          return;
        }
      }

      const typedMessage = parsed as WSMessage;
      setLastMessage(typedMessage);
      onMessageRef.current?.(typedMessage);
    };

    ws.onclose = () => {
      if (!mountedRef.current) {
        return;
      }

      stopPing();
      wsRef.current = null;

      if (intentionalCloseRef.current) {
        setState('disconnected');
        return;
      }

      setState('reconnecting');
      const base = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptRef.current),
        RECONNECT_MAX_DELAY_MS,
      );
      const jitter = 1 + Math.random() * JITTER_FACTOR;
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, Math.round(base * jitter));
    };

    ws.onerror = () => {
      // onclose handles reconnect and state transitions
    };
  }, [clearReconnect, flushQueue, startPing, stopPing, url]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const payload = JSON.stringify(msg);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload);
      return;
    }
    enqueue(payload);
  }, [enqueue]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      stopPing();
      clearReconnect();
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        wsRef.current = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
    };
  }, [clearReconnect, connect, stopPing]);

  return { state, send, lastMessage };
}
