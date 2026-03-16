import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState, WSMessage } from '../types';
import {
  classifyGatewayControlMessage,
  computeReconnectDelayMs,
  DEFAULT_GATEWAY_MAX_OFFLINE_QUEUE,
  DEFAULT_GATEWAY_PING_INTERVAL_MS,
  DEFAULT_GATEWAY_SOCKET_BACKOFF,
  enqueueBounded,
  flushQueueIfOpen,
  parseJsonMessage,
  serializeAuthMessage,
  serializePingMessage,
} from '@agenc/runtime';

function getDefaultWsUrl(): string {
  if (typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search);
    const queryWsUrl = query.get('ws');
    if (queryWsUrl) return queryWsUrl;
  }

  return (import.meta as { env?: Record<string, string | undefined> })?.env?.VITE_WEBCHAT_WS_URL
    ?? 'ws://127.0.0.1:3100';
}

const DEFAULT_URL = getDefaultWsUrl();

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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const intentionalCloseRef = useRef(false);
  const offlineQueueRef = useRef<string[]>([]);

  const stopPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const startPing = useCallback(() => {
    stopPing();
    pingTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(serializePingMessage());
      }
    }, DEFAULT_GATEWAY_PING_INTERVAL_MS);
  }, [stopPing]);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const flushQueue = useCallback(() => {
    flushQueueIfOpen(wsRef.current, WebSocket.OPEN, offlineQueueRef.current);
  }, []);

  const enqueue = useCallback((payload: string) => {
    enqueueBounded(
      offlineQueueRef.current,
      payload,
      DEFAULT_GATEWAY_MAX_OFFLINE_QUEUE,
    );
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
        ws.send(serializeAuthMessage(token));
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
        parsed = parseJsonMessage(event.data as string);
      } catch {
        return;
      }

      const control = classifyGatewayControlMessage(parsed);
      if (control.kind === 'auth_error') {
        offlineQueueRef.current.length = 0;
        setState('disconnected');
        ws.close();
        return;
      }
      if (control.kind === 'auth_ok') {
        reconnectAttemptRef.current = 0;
        setState('connected');
        startPing();
        flushQueue();
        return;
      }
      if (control.kind === 'pong') {
        return;
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
      const delay = computeReconnectDelayMs(
        reconnectAttemptRef.current,
        DEFAULT_GATEWAY_SOCKET_BACKOFF,
      );
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
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
