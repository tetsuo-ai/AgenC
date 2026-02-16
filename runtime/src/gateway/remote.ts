/**
 * Remote Gateway client for connecting to a Gateway control plane over WebSocket.
 *
 * Provides JWT authentication, automatic reconnection with exponential backoff,
 * offline message queueing, and ping keepalive.
 *
 * Uses `ws` package (loaded lazily via `ensureLazyModule`).
 *
 * @module
 */

import { ensureLazyModule } from '../utils/lazy-import.js';
import { GatewayAuthError } from './errors.js';
import type {
  RemoteGatewayConfig,
  RemoteGatewayState,
  RemoteGatewayEvents,
  OfflineQueueEntry,
} from './remote-types.js';

// ============================================================================
// WebSocket type shim (matches ws package interface)
// ============================================================================

interface WsInstance {
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  readyState: number;
}

interface WsModule {
  default: new (url: string) => WsInstance;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_OFFLINE_QUEUE_SIZE = 1_000;
const JITTER_FACTOR = 0.2;

// ============================================================================
// RemoteGatewayClient
// ============================================================================

type EventKey = keyof RemoteGatewayEvents;

export class RemoteGatewayClient {
  private ws: WsInstance | null = null;
  private _state: RemoteGatewayState = 'disconnected';
  private config: RemoteGatewayConfig;
  private readonly listeners = new Map<EventKey, Set<(...args: unknown[]) => void>>();
  private readonly offlineQueue: OfflineQueueEntry[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private readonly maxQueueSize: number;

  constructor(config: RemoteGatewayConfig) {
    this.config = config;
    this.maxQueueSize = config.maxOfflineQueueSize ?? DEFAULT_MAX_OFFLINE_QUEUE_SIZE;
  }

  get state(): RemoteGatewayState {
    return this._state;
  }

  // --------------------------------------------------------------------------
  // Event emitter
  // --------------------------------------------------------------------------

  on<K extends EventKey>(event: K, handler: RemoteGatewayEvents[K]): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as (...args: unknown[]) => void);
    return () => {
      handlers!.delete(handler as (...args: unknown[]) => void);
    };
  }

  private emit<K extends EventKey>(event: K, ...args: Parameters<RemoteGatewayEvents[K]>): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch {
        // Swallow listener errors
      }
    }
  }

  // --------------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------------

  private setState(state: RemoteGatewayState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('stateChanged', state);
  }

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting' || this._state === 'authenticating') {
      return;
    }

    this.intentionalClose = false;
    this.setState('connecting');

    const wsMod = await ensureLazyModule<WsModule>(
      'ws',
      (msg) => new GatewayAuthError(msg),
      (mod) => mod as unknown as WsModule,
    );

    const WsConstructor = wsMod.default;
    this.ws = new WsConstructor(this.config.url);

    this.ws.on('open', () => {
      this.setState('authenticating');
      this.ws!.send(JSON.stringify({
        type: 'auth',
        payload: { token: this.config.token },
      }));
    });

    this.ws.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.emit('message', text);
        return;
      }

      if (parsed && typeof parsed === 'object') {
        const msg = parsed as Record<string, unknown>;

        // Handle auth response
        if (msg.type === 'auth') {
          if (msg.error) {
            this.offlineQueue.length = 0;
            this.setState('disconnected');
            this.emit('authFailed', String(msg.error));
            this.ws?.close();
            return;
          }
          this.reconnectAttempt = 0;
          this.setState('connected');
          this.emit('connected');
          this.startPing();
          this.flushOfflineQueue();
          return;
        }
      }

      this.emit('message', parsed);
    });

    this.ws.on('close', () => {
      this.stopPing();
      const wasConnected = this._state === 'connected';
      this.ws = null;

      if (this.intentionalClose) {
        this.setState('disconnected');
        this.emit('disconnected', 'intentional');
        return;
      }

      const shouldReconnect = this.config.reconnect !== false;
      if (shouldReconnect) {
        this.setState('reconnecting');
        this.emit('disconnected', wasConnected ? 'connection lost' : 'failed to connect');
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
        this.emit('disconnected', 'connection closed');
      }
    });

    this.ws.on('error', (err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  async switchGateway(url: string, token: string): Promise<void> {
    this.disconnect();
    this.config = { ...this.config, url, token };
    await this.connect();
  }

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  send(msg: Record<string, unknown>): void {
    const serialized = JSON.stringify(msg);
    if (this._state === 'connected' && this.ws) {
      this.ws.send(serialized);
    } else {
      this.enqueue(serialized);
    }
  }

  sendMessage(content: string): void {
    this.send({ type: 'chat.message', payload: { content } });
  }

  // --------------------------------------------------------------------------
  // Offline queue
  // --------------------------------------------------------------------------

  private enqueue(message: string): void {
    if (this.offlineQueue.length >= this.maxQueueSize) {
      this.offlineQueue.shift(); // Drop oldest
    }
    this.offlineQueue.push({ message, enqueuedAt: Date.now() });
  }

  private flushOfflineQueue(): void {
    while (this.offlineQueue.length > 0) {
      const entry = this.offlineQueue.shift()!;
      if (this.ws && this._state === 'connected') {
        this.ws.send(entry.message);
      }
    }
  }

  get queueSize(): number {
    return this.offlineQueue.length;
  }

  clearQueue(): void {
    this.offlineQueue.length = 0;
  }

  // --------------------------------------------------------------------------
  // Ping keepalive
  // --------------------------------------------------------------------------

  private startPing(): void {
    this.stopPing();
    const interval = this.config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      if (this.ws && this._state === 'connected') {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Reconnection
  // --------------------------------------------------------------------------

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const baseDelay = this.config.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const maxDelay = this.config.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const base = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), maxDelay);
    const jitter = 1 + Math.random() * JITTER_FACTOR;
    const delay = Math.round(base * jitter);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
