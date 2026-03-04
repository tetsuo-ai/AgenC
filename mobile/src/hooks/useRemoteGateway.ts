/**
 * React hook for WebSocket connection to Gateway with JWT auth,
 * offline queue, and automatic reconnection.
 *
 * Uses browser-native WebSocket (not ws npm package).
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { ConnectionStatus, GatewayConnection } from '../types';
import {
  computeReconnectDelayMs,
  DEFAULT_GATEWAY_SOCKET_BACKOFF,
  enqueueBounded,
  flushQueueIfOpen,
  parseJsonMessage,
  serializeAuthMessage,
  serializePingMessage,
} from '../../../runtime/src/channels/webchat/socket-client-core';

const MAX_OFFLINE_QUEUE = 1000;
const PING_INTERVAL_MS = 30_000;

interface UseRemoteGatewayOptions {
  connection: GatewayConnection | null;
  onMessage?: (data: unknown) => void;
  onAuthFailed?: (reason: string) => void;
}

interface UseRemoteGatewayResult {
  status: ConnectionStatus;
  send: (msg: Record<string, unknown>) => void;
  sendMessage: (content: string) => void;
  disconnect: () => void;
  switchGateway: (url: string, token: string) => void;
  queueSize: number;
}

export function useRemoteGateway({
  connection,
  onMessage,
  onAuthFailed,
}: UseRemoteGatewayOptions): UseRemoteGatewayResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const offlineQueueRef = useRef<string[]>([]);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const [queueSize, setQueueSize] = useState(0);

  // Store latest callbacks in refs to avoid reconnect on every render
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onAuthFailedRef = useRef(onAuthFailed);
  onAuthFailedRef.current = onAuthFailed;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

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
    }, PING_INTERVAL_MS);
  }, [stopPing]);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const flushQueue = useCallback(() => {
    const remaining = flushQueueIfOpen(
      wsRef.current,
      WebSocket.OPEN,
      offlineQueueRef.current,
    );
    setQueueSize(remaining);
  }, []);

  const enqueue = useCallback((msg: string) => {
    enqueueBounded(offlineQueueRef.current, msg, MAX_OFFLINE_QUEUE);
    setQueueSize(offlineQueueRef.current.length);
  }, []);

  const connect = useCallback(() => {
    const conn = connectionRef.current;
    if (!conn) return;

    intentionalCloseRef.current = false;
    setStatus('connecting');

    const ws = new WebSocket(conn.url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('authenticating');
      ws.send(serializeAuthMessage(conn.token));
    };

    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = parseJsonMessage(event.data as string);
      } catch {
        onMessageRef.current?.(event.data);
        return;
      }

      if (parsed && typeof parsed === 'object') {
        const msg = parsed as Record<string, unknown>;
        if (msg.type === 'auth') {
          if (msg.error) {
            offlineQueueRef.current.length = 0;
            setQueueSize(0);
            setStatus('disconnected');
            onAuthFailedRef.current?.(String(msg.error));
            ws.close();
            return;
          }
          reconnectAttemptRef.current = 0;
          setStatus('connected');
          startPing();
          flushQueue();
          return;
        }
      }

      onMessageRef.current?.(parsed);
    };

    ws.onclose = () => {
      stopPing();
      wsRef.current = null;

      if (intentionalCloseRef.current) {
        setStatus('disconnected');
        return;
      }

      setStatus('reconnecting');
      const delay = computeReconnectDelayMs(
        reconnectAttemptRef.current,
        DEFAULT_GATEWAY_SOCKET_BACKOFF,
      );
      reconnectAttemptRef.current++;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // Error handling is done in onclose
    };
  }, [startPing, stopPing, flushQueue]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    stopPing();
    clearReconnect();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, [stopPing, clearReconnect]);

  const switchGateway = useCallback((url: string, token: string) => {
    disconnect();
    connectionRef.current = { url, token };
    // Trigger reconnect on next tick so state settles
    setTimeout(() => {
      connect();
    }, 0);
  }, [disconnect, connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const serialized = JSON.stringify(msg);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(serialized);
    } else {
      enqueue(serialized);
    }
  }, [enqueue]);

  const sendMessage = useCallback((content: string) => {
    send({ type: 'chat.message', payload: { content } });
  }, [send]);

  // Connect when connection config changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (connection) {
      connect();
    } else {
      disconnect();
    }
    return () => {
      disconnect();
    };
  }, [connection?.url, connection?.token]);

  return { status, send, sendMessage, disconnect, switchGateway, queueSize };
}
