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
  WebChatHandler,
} from './types.js';
import {
  GatewayStateError,
  GatewayLifecycleError,
  GatewayValidationError,
  GatewayConnectionError,
} from './errors.js';
import { verifyToken } from './jwt.js';
import {
  ConfigWatcher,
  diffGatewayConfig,
  validateGatewayConfig,
  loadGatewayConfig,
} from './config-watcher.js';
import { isRecord } from '../utils/type-guards.js';

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
  private readonly authenticatedClients = new Set<string>();
  private webChatHandler: WebChatHandler | null = null;

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
  // WebChat Handler
  // --------------------------------------------------------------------------

  /**
   * Set (or clear) the WebChat handler for routing dotted-namespace
   * messages from the WS control plane to the WebChat channel plugin.
   */
  setWebChatHandler(handler: WebChatHandler | null): void {
    this.webChatHandler = handler;
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

    // Only apply safe changes — merge from newConfig, preserving unsafe fields
    if (diff.safe.length > 0) {
      this._config = mergeSafeConfig(this._config, newConfig, diff);
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
      const request = args[1] as { socket?: { remoteAddress?: string } } | undefined;
      const clientId = `client_${++this.clientCounter}`;
      this.wsClients.set(clientId, socket);
      this.logger.debug(`Control plane client connected: ${clientId}`);

      // Auto-authenticate local connections
      const remoteAddress = request?.socket?.remoteAddress;
      const authSecret = this._config.auth?.secret;
      const localBypass = this._config.auth?.localBypass !== false;
      const isLocal = !remoteAddress
        || remoteAddress === '127.0.0.1'
        || remoteAddress === '::1'
        || remoteAddress === '::ffff:127.0.0.1';

      if (!authSecret || (isLocal && localBypass)) {
        this.authenticatedClients.add(clientId);
      }

      socket.on('message', (data: unknown) => {
        this.handleControlMessage(clientId, socket, data);
      });

      socket.on('close', () => {
        this.wsClients.delete(clientId);
        this.authenticatedClients.delete(clientId);
        this.logger.debug(`Control plane client disconnected: ${clientId}`);
      });

      socket.on('error', (err: unknown) => {
        this.logger.error(`WebSocket error for ${clientId}:`, err);
        this.wsClients.delete(clientId);
        this.authenticatedClients.delete(clientId);
      });
    });

    this.wss.on('error', (err: unknown) => {
      this.logger.error('WebSocket server error:', err);
      this.emit('error', err);
    });
  }

  // Intentionally resolves (never rejects) — shutdown should not throw.
  // Errors are logged but swallowed to avoid blocking the stop() sequence.
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
      this.authenticatedClients.clear();

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
    clientId: string,
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
      this.sendResponse(socket, { type: 'error', error: 'Missing message type' });
      return;
    }

    // Sanitize id: only echo back if it's a string
    const id = typeof msg.id === 'string' ? msg.id : undefined;

    // Auth guard: if auth is configured and client is not authenticated,
    // only allow 'auth' and 'ping' messages
    if (
      this._config.auth?.secret &&
      !this.authenticatedClients.has(clientId) &&
      msg.type !== 'auth' &&
      msg.type !== 'ping'
    ) {
      this.sendResponse(socket, { type: 'error', error: 'Authentication required', id });
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.sendResponse(socket, { type: 'pong', id });
        break;

      case 'auth': {
        const authSecret = this._config.auth?.secret;
        if (!authSecret) {
          // No auth configured — auto-accept
          this.authenticatedClients.add(clientId);
          this.sendResponse(socket, { type: 'auth', payload: { authenticated: true }, id });
          break;
        }
        const token = isRecord(msg.payload) ? String(msg.payload.token ?? '') : '';
        if (!token) {
          this.sendResponse(socket, { type: 'auth', error: 'Missing token', id });
          socket.close();
          break;
        }
        const payload = verifyToken(authSecret, token);
        if (!payload) {
          this.sendResponse(socket, { type: 'auth', error: 'Invalid or expired token', id });
          socket.close();
          break;
        }
        this.authenticatedClients.add(clientId);
        this.sendResponse(socket, {
          type: 'auth',
          payload: { authenticated: true, sub: payload.sub },
          id,
        });
        break;
      }

      case 'status':
        this.sendResponse(socket, {
          type: 'status',
          payload: this.getStatus(),
          id,
        });
        break;

      case 'reload':
        if (!this.configPath) {
          this.sendResponse(socket, {
            type: 'reload',
            error: 'No config path configured for file-based reload',
            id,
          });
        } else {
          // Async reload — load from disk and apply
          void this.handleReloadCommand(socket, id);
        }
        break;

      case 'channels':
        this.sendResponse(socket, {
          type: 'channels',
          payload: [...this.channels.entries()].map(([name, ch]) => ({
            name,
            healthy: ch.isHealthy(),
          })),
          id,
        });
        break;

      case 'sessions':
        this.sendResponse(socket, {
          type: 'sessions',
          payload: [...this.wsClients.keys()].map((clientId) => ({
            id: clientId,
            connected: true,
          })),
          id,
        });
        break;

      case 'sessions.kill': {
        const targetId = isRecord(msg.payload) ? String(msg.payload.sessionId ?? '') : '';
        if (!targetId) {
          this.sendResponse(socket, {
            type: 'sessions.kill',
            error: 'Missing sessionId in payload',
            id,
          });
          break;
        }
        const target = this.wsClients.get(targetId);
        if (!target) {
          this.sendResponse(socket, {
            type: 'sessions.kill',
            error: `Session '${targetId}' not found`,
            id,
          });
          break;
        }
        // Send response before closing — if the target is the requesting
        // client, the close() call would prevent delivery.
        this.sendResponse(socket, {
          type: 'sessions.kill',
          payload: { killed: targetId },
          id,
        });
        target.close();
        this.wsClients.delete(targetId);
        break;
      }

      case 'config.get':
        this.sendResponse(socket, {
          type: 'config.get',
          payload: maskConfigSecrets(this._config),
          id,
        });
        break;

      case 'config.set':
        if (!this.configPath) {
          this.sendResponse(socket, {
            type: 'config.set',
            error: 'No config path configured',
            id,
          });
        } else {
          void this.handleConfigSet(socket, msg.payload, id);
        }
        break;

      case 'wallet.info':
        void this.handleWalletInfo(socket, id);
        break;

      case 'wallet.airdrop':
        void this.handleWalletAirdrop(socket, msg.payload, id);
        break;

      case 'ollama.models':
        void this.handleOllamaModels(socket, id);
        break;

      default: {
        // msg.type is narrowed to `never` here by exhaustive switch,
        // but at runtime unknown types arrive as plain strings.
        const rawType = msg.type as string;
        if (rawType.includes('.') && this.webChatHandler) {
          this.webChatHandler.handleMessage(
            clientId,
            rawType,
            msg,
            (response) => this.sendResponse(socket, response),
          );
        } else {
          this.sendResponse(socket, {
            type: 'error',
            error: `Unknown message type: ${rawType}`,
            id,
          });
        }
      }
    }
  }

  private sendResponse(socket: WsWebSocket, response: ControlResponse): void {
    try {
      socket.send(safeStringify(response));
    } catch (err) {
      this.logger.error('Failed to send WebSocket response:', err);
    }
  }

  private async handleReloadCommand(socket: WsWebSocket, id?: string): Promise<void> {
    try {
      const newConfig = await loadGatewayConfig(this.configPath!);
      const diff = this.reloadConfig(newConfig);
      this.sendResponse(socket, {
        type: 'reload',
        payload: diff,
        id,
      });
    } catch (err) {
      this.sendResponse(socket, {
        type: 'reload',
        error: (err as Error).message,
        id,
      });
    }
  }

  private async handleConfigSet(socket: WsWebSocket, payload: unknown, id?: string): Promise<void> {
    try {
      if (!isRecord(payload)) {
        this.sendResponse(socket, { type: 'config.set', error: 'Payload must be an object', id });
        return;
      }
      // Strip masked secrets (****...) so they don't overwrite real values on disk
      const cleaned = stripMaskedSecrets(payload as Record<string, unknown>);
      // Read current config from disk
      const current = await loadGatewayConfig(this.configPath!);
      // Deep-merge payload into current (only known top-level sections)
      const merged = { ...current } as Record<string, unknown>;
      for (const key of Object.keys(cleaned)) {
        if (isRecord(cleaned[key]) && isRecord(merged[key])) {
          merged[key] = { ...(merged[key] as Record<string, unknown>), ...(cleaned[key] as Record<string, unknown>) };
        } else {
          merged[key] = cleaned[key];
        }
      }
      // Validate
      const result = validateGatewayConfig(merged);
      if (!result.valid) {
        this.sendResponse(socket, { type: 'config.set', error: result.errors.join('; '), id });
        return;
      }
      // Write to disk
      const { writeFile } = await import('node:fs/promises');
      await writeFile(this.configPath!, JSON.stringify(merged, null, 2), 'utf-8');
      // Reload in-place
      const diff = this.reloadConfig(merged as unknown as import('./types.js').GatewayConfig);
      this.sendResponse(socket, {
        type: 'config.set',
        payload: { applied: true, diff, config: maskConfigSecrets(merged as unknown as import('./types.js').GatewayConfig) },
        id,
      });
    } catch (err) {
      this.sendResponse(socket, { type: 'config.set', error: (err as Error).message, id });
    }
  }

  // --------------------------------------------------------------------------
  // Wallet
  // --------------------------------------------------------------------------

  private async handleWalletInfo(socket: WsWebSocket, id?: string): Promise<void> {
    try {
      const { Connection, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const { loadKeypairFromFile, getDefaultKeypairPath } = await import('../types/wallet.js');

      const keypairPath = this._config.connection.keypairPath || getDefaultKeypairPath();
      const keypair = await loadKeypairFromFile(keypairPath);
      const rpcUrl = this._config.connection.rpcUrl;
      const connection = new Connection(rpcUrl, 'confirmed');
      const lamports = await connection.getBalance(keypair.publicKey);

      const isDevnet = rpcUrl.includes('devnet');
      const isMainnet = rpcUrl.includes('mainnet');
      const network = isMainnet ? 'mainnet-beta' : isDevnet ? 'devnet' : 'custom';

      this.sendResponse(socket, {
        type: 'wallet.info',
        payload: {
          address: keypair.publicKey.toBase58(),
          lamports,
          sol: lamports / LAMPORTS_PER_SOL,
          network,
          rpcUrl,
          explorerUrl: `https://explorer.solana.com/address/${keypair.publicKey.toBase58()}?cluster=${network}`,
        },
        id,
      });
    } catch (err) {
      this.sendResponse(socket, { type: 'wallet.info', error: (err as Error).message, id });
    }
  }

  private async handleWalletAirdrop(socket: WsWebSocket, payload: unknown, id?: string): Promise<void> {
    try {
      const { Connection, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const { loadKeypairFromFile, getDefaultKeypairPath } = await import('../types/wallet.js');

      const rpcUrl = this._config.connection.rpcUrl;
      if (rpcUrl.includes('mainnet')) {
        this.sendResponse(socket, { type: 'wallet.airdrop', error: 'Airdrop not available on mainnet', id });
        return;
      }

      const amount = isRecord(payload) ? Number(payload.amount ?? 1) : 1;
      const lamports = Math.floor(Math.min(amount, 2) * LAMPORTS_PER_SOL); // max 2 SOL per airdrop

      const keypairPath = this._config.connection.keypairPath || getDefaultKeypairPath();
      const keypair = await loadKeypairFromFile(keypairPath);
      const connection = new Connection(rpcUrl, 'confirmed');

      const sig = await connection.requestAirdrop(keypair.publicKey, lamports);
      await connection.confirmTransaction(sig, 'confirmed');

      // Fetch updated balance
      const newLamports = await connection.getBalance(keypair.publicKey);

      this.sendResponse(socket, {
        type: 'wallet.airdrop',
        payload: {
          signature: sig,
          amount: lamports / LAMPORTS_PER_SOL,
          newBalance: newLamports / LAMPORTS_PER_SOL,
          newLamports,
        },
        id,
      });
    } catch (err) {
      this.sendResponse(socket, { type: 'wallet.airdrop', error: (err as Error).message, id });
    }
  }

  private async handleOllamaModels(socket: WsWebSocket, id?: string): Promise<void> {
    try {
      // Always use the Ollama default URL — the current config.llm.baseUrl may point to a different provider
      const ollamaUrl = 'http://localhost:11434';
      const res = await fetch(`${ollamaUrl}/api/tags`);
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
      const data = await res.json() as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m: { name: string }) => m.name);
      this.sendResponse(socket, { type: 'ollama.models', payload: { models }, id });
    } catch (err) {
      this.sendResponse(socket, { type: 'ollama.models', error: (err as Error).message, id });
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Merge only safe fields from newConfig into oldConfig, preserving unsafe fields
 * from the running config to avoid state/status drift.
 */
function mergeSafeConfig(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig,
  diff: ConfigDiff,
): GatewayConfig {
  // If there are no unsafe changes, the new config is safe wholesale
  if (diff.unsafe.length === 0) {
    return newConfig;
  }

  // Deep-clone old config as the base, then overlay safe sections from new
  const merged = JSON.parse(JSON.stringify(oldConfig)) as GatewayConfig;

  // Apply safe top-level sections from new config
  const safeSections = new Set(diff.safe.map((key) => key.split('.')[0]));
  const unsafeSections = new Set(diff.unsafe.map((key) => key.split('.')[0]));

  for (const section of safeSections) {
    // Only merge sections that have NO unsafe keys
    if (!unsafeSections.has(section)) {
      (merged as unknown as Record<string, unknown>)[section] =
        (newConfig as unknown as Record<string, unknown>)[section];
    }
  }

  return merged;
}

/** Returns a copy of config with sensitive fields (API keys, passwords) masked. */
function maskConfigSecrets(config: GatewayConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const llm = clone.llm as Record<string, unknown> | undefined;
  if (llm?.apiKey && typeof llm.apiKey === 'string') {
    llm.apiKey = llm.apiKey.length > 8
      ? '****' + llm.apiKey.slice(-4)
      : '********';
  }
  if (Array.isArray(llm?.fallback)) {
    for (const fb of llm.fallback as Record<string, unknown>[]) {
      if (fb.apiKey && typeof fb.apiKey === 'string') {
        fb.apiKey = fb.apiKey.length > 8 ? '****' + fb.apiKey.slice(-4) : '********';
      }
    }
  }
  const mem = clone.memory as Record<string, unknown> | undefined;
  if (mem?.password) mem.password = '********';
  if (mem?.encryptionKey) mem.encryptionKey = '********';
  const voice = clone.voice as Record<string, unknown> | undefined;
  if (voice?.apiKey && typeof voice.apiKey === 'string') {
    voice.apiKey = voice.apiKey.length > 8
      ? '****' + voice.apiKey.slice(-4)
      : '********';
  }
  const auth = clone.auth as Record<string, unknown> | undefined;
  if (auth?.secret) auth.secret = '********';
  return clone;
}

/** Strip values that look like masked secrets (****...) so they don't overwrite real values on disk. */
function stripMaskedSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('****')) continue;
    if (isRecord(value)) {
      result[key] = stripMaskedSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
