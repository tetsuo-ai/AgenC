import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState, WSMessage } from '../types';

const DEFAULT_URL = 'ws://127.0.0.1:3100';
const PING_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 8_000;

interface UseWebSocketOptions {
  url?: string;
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

  const [state, setState] = useState<ConnectionState>('disconnected');
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const pingTimer = useRef<ReturnType<typeof setInterval>>();
  const mountedRef = useRef(true);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setState('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setState('connected');
      reconnectDelay.current = INITIAL_RECONNECT_MS;

      // Start ping keepalive
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string) as WSMessage;
        if (msg.type === 'pong') return; // Swallow pong
        setLastMessage(msg);
        onMessageRef.current?.(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      cleanup();
      setState('reconnecting');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const cleanup = useCallback(() => {
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = undefined;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_MS);
      connect();
    }, reconnectDelay.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, cleanup]);

  return { state, send, lastMessage };
}
