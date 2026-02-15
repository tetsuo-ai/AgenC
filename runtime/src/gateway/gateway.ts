/**
 * Gateway — persistent process managing lifecycle, channels, config, and
 * a WebSocket control plane for local clients (CLI, web UI).
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { safeStringify } from '../tools/types.js';
import { ensureLazyModule } from '../utils/lazy-import.js';
import type {
  GatewayConfig,
  GatewayState,
  GatewayStatus,
  GatewayEvent,
  GatewayEventHandler,
  GatewayEventSubscription,
  ControlMessage,
  ControlResponse,
  ChannelHandle,
  ConfigDiff,
} from './types.js';
import {
  GatewayStateError,
  GatewayLifecycleError,
  GatewayValidationError,
  GatewayConnectionError,
} from './errors.js';
import {
  ConfigWatcher,
  diffGatewayConfig,
  validateGatewayConfig,
} from './config-watcher.js';

// ============================================================================
// WebSocket type shims (loaded lazily)
// ============================================================================

interface WsWebSocket {
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  readyState: number;
}

interface WsWebSocketServer {
  close(cb?: (err?: Error) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  clients: Set<WsWebSocket>;
}

interface WsModule {
  WebSocketServer: new (opts: { port: number; host?: string }) => WsWebSocketServer;
}

// ============================================================================
// Gateway
// ============================================================================

export interface GatewayOptions {
  logger?: Logger;
  configPath?: string;
}

export class Gateway {
  private _state: GatewayState = 'stopped';
  private _config: GatewayConfig;
  private readonly logger: Logger;
  private readonly configPath?: string;

  private startedAt = 0;
  private wss: WsWebSocketServer | null = null;
  private configWatcher: ConfigWatcher | null = null;
  private readonly channels = new Map<string, ChannelHandle>();
  private readonly listeners = new Map<GatewayEvent, Set<GatewayEventHandler>>();
  private clientCounter = 0;
  private readonly wsClients = new Map<string, WsWebSocket>();

  constructor(config: GatewayConfig, options?: GatewayOptions) {
    this._config = config;
    this.logger = options?.logger ?? silentLogger;
    this.configPath = options?.configPath;
  }

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  get state(): GatewayState {
    return this._state;
  }

  get config(): GatewayConfig {
    return this._config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._state !== 'stopped') {
      throw new GatewayStateError(
        `Cannot start gateway: current state is '${this._state}', expected 'stopped'`,
      );
    }

    this._state = 'starting';

    try {
      await this.startControlPlane();
      this.startConfigWatcher();
      this.startedAt = Date.now();
      this._state = 'running';
      this.emit('started');
      this.logger.info(`Gateway started on port ${this._config.gateway.port}`);
    } catch (err) {
      this._state = 'stopped';
      throw new GatewayLifecycleError(
        `Failed to start gateway: ${(err as Error).message}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped') return;

    if (this._state !== 'running') {
      throw new GatewayStateError(
        `Cannot stop gateway: current state is '${this._state}', expected 'running'`,
      );
    }

    this._state = 'stopping';

    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
    }

    // Stop all channels
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        this.logger.error(`Error stopping channel '${name}':`, err);
      }
    }
    this.channels.clear();

    // Close WebSocket server
    await this.stopControlPlane();

    this._state = 'stopped';
    this.startedAt = 0;
    this.emit('stopped');
    this.logger.info('Gateway stopped');
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getStatus(): GatewayStatus {
    return Object.freeze({
      state: this._state,
      uptimeMs: this._state === 'running' ? Date.now() - this.startedAt : 0,
      channels: [...this.channels.keys()],
      activeSessions: this.wsClients.size,
      controlPlanePort: this._config.gateway.port,
    });
  }

  // --------------------------------------------------------------------------
  // Channel Registry
  // --------------------------------------------------------------------------

  registerChannel(channel: ChannelHandle): void {
    if (this.channels.has(channel.name)) {
      throw new GatewayValidationError(
        'channel',
        `Channel '${channel.name}' is already registered`,
      );
    }
    this.channels.set(channel.name, channel);
    this.emit('channelConnected', channel.name);
    this.logger.info(`Channel '${channel.name}' registered`);
  }

  async unregisterChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) return;

    try {
      await channel.stop();
    } catch (err) {
      this.logger.error(`Error stopping channel '${name}':`, err);
    }
    this.channels.delete(name);
    this.emit('channelDisconnected', name);
    this.logger.info(`Channel '${name}' unregistered`);
  }

  // --------------------------------------------------------------------------
  // Config Hot-Reload
  // --------------------------------------------------------------------------

  reloadConfig(newConfig: GatewayConfig): ConfigDiff {
    const validation = validateGatewayConfig(newConfig);
    if (!validation.valid) {
      const err = new GatewayValidationError('config', validation.errors.join('; '));
      this.emit('configError', err);
      throw err;
    }

    const diff = diffGatewayConfig(this._config, newConfig);

    if (diff.unsafe.length > 0) {
      this.logger.warn(
        `Unsafe config changes detected (require restart): ${diff.unsafe.join(', ')}`,
      );
    }

    // Apply safe changes immediately
    if (diff.safe.length > 0) {
      this._config = newConfig;
      this.emit('configReloaded', diff);
      this.logger.info(`Config reloaded. Safe changes: ${diff.safe.join(', ')}`);
    }

    return diff;
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  on(event: GatewayEvent, handler: GatewayEventHandler): GatewayEventSubscription {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return {
      unsubscribe: () => {
        handlers!.delete(handler);
      },
    };
  }

  off(event: GatewayEvent, handler: GatewayEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: GatewayEvent, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        this.logger.error(`Error in event handler for '${event}':`, err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // WebSocket Control Plane
  // --------------------------------------------------------------------------

  private async startControlPlane(): Promise<void> {
    const wsMod = await ensureLazyModule<WsModule>(
      'ws',
      (msg) => new GatewayConnectionError(msg),
      (mod) => mod as unknown as WsModule,
    );

    const { port, bind } = this._config.gateway;

    this.wss = new wsMod.WebSocketServer({
      port,
      host: bind ?? '127.0.0.1',
    });

    this.wss.on('connection', (...args: unknown[]) => {
      const socket = args[0] as WsWebSocket;
      const clientId = `client_${++this.clientCounter}`;
      this.wsClients.set(clientId, socket);
      this.logger.debug(`Control plane client connected: ${clientId}`);

      socket.on('message', (data: unknown) => {
        this.handleControlMessage(clientId, socket, data);
      });

      socket.on('close', () => {
        this.wsClients.delete(clientId);
        this.logger.debug(`Control plane client disconnected: ${clientId}`);
      });

      socket.on('error', (err: unknown) => {
        this.logger.error(`WebSocket error for ${clientId}:`, err);
        this.wsClients.delete(clientId);
      });
    });

    this.wss.on('error', (err: unknown) => {
      this.logger.error('WebSocket server error:', err);
      this.emit('error', err);
    });
  }

  private stopControlPlane(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const [id, ws] of this.wsClients) {
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        this.wsClients.delete(id);
      }

      if (!this.wss) {
        resolve();
        return;
      }

      this.wss.close((err) => {
        if (err) {
          this.logger.error('Error closing WebSocket server:', err);
        }
        this.wss = null;
        resolve();
      });
    });
  }

  private handleControlMessage(
    _clientId: string,
    socket: WsWebSocket,
    rawData: unknown,
  ): void {
    let msg: ControlMessage;
    try {
      const text = typeof rawData === 'string' ? rawData : String(rawData);
      msg = JSON.parse(text) as ControlMessage;
    } catch {
      this.sendResponse(socket, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (!msg.type || typeof msg.type !== 'string') {
      this.sendResponse(socket, { type: 'error', error: 'Missing message type', id: msg.id });
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.sendResponse(socket, { type: 'pong', id: msg.id });
        break;

      case 'status':
        this.sendResponse(socket, {
          type: 'status',
          payload: this.getStatus(),
          id: msg.id,
        });
        break;

      case 'reload':
        try {
          // Reload from disk requires configPath
          if (!this.configPath) {
            this.sendResponse(socket, {
              type: 'reload',
              error: 'No config path configured for file-based reload',
              id: msg.id,
            });
          } else {
            // For WS-triggered reload, we just report the current config diff info
            this.sendResponse(socket, {
              type: 'reload',
              payload: { message: 'Reload triggered via config watcher' },
              id: msg.id,
            });
          }
        } catch (err) {
          this.sendResponse(socket, {
            type: 'reload',
            error: (err as Error).message,
            id: msg.id,
          });
        }
        break;

      case 'channels':
        this.sendResponse(socket, {
          type: 'channels',
          payload: [...this.channels.entries()].map(([name, ch]) => ({
            name,
            healthy: ch.healthy,
          })),
          id: msg.id,
        });
        break;

      default:
        this.sendResponse(socket, {
          type: 'error',
          error: `Unknown message type: ${msg.type}`,
          id: msg.id,
        });
    }
  }

  private sendResponse(socket: WsWebSocket, response: ControlResponse): void {
    try {
      socket.send(safeStringify(response));
    } catch (err) {
      this.logger.error('Failed to send WebSocket response:', err);
    }
  }

  // --------------------------------------------------------------------------
  // Config Watcher
  // --------------------------------------------------------------------------

  private startConfigWatcher(): void {
    if (!this.configPath) return;

    this.configWatcher = new ConfigWatcher(this.configPath);
    this.configWatcher.start(
      (newConfig) => {
        try {
          this.reloadConfig(newConfig);
        } catch (err) {
          this.logger.error('Config reload failed:', err);
        }
      },
      (err) => {
        this.logger.error('Config watcher error:', err);
        this.emit('configError', err);
      },
    );
  }
}
