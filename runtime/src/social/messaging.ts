/**
 * AgentMessaging - Agent-to-agent messaging via on-chain state and off-chain WebSocket.
 *
 * On-chain messages reuse the `update_state` instruction with MSG_MAGIC-prefixed state_key.
 * Off-chain messages are Ed25519-signed JSON envelopes delivered via WebSocket.
 *
 * @module
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { BN, utils } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../idl.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { findAgentPda, findProtocolPda } from '../agent/pda.js';
import { isAnchorError, AnchorErrorCodes } from '../types/errors.js';
import { ensureLazyModule } from '../utils/lazy-import.js';
import { signAgentMessage, verifyAgentSignature, buildSigningPayload } from './crypto.js';
import { MessagingSendError, MessagingConnectionError } from './messaging-errors.js';
import {
  MSG_MAGIC,
  MSG_CONTENT_MAX_ONCHAIN,
  encodeMessageStateKey,
  decodeMessageStateKey,
  encodeMessageStateValue,
  decodeMessageStateValue,
  type AgentMessage,
  type MessageMode,
  type MessageHandler,
  type PeerResolver,
  type MessagingConfig,
  type MessagingOpsConfig,
  type OffChainEnvelope,
} from './messaging-types.js';

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
  address(): { port: number } | null;
}

interface WsModule {
  default?: { WebSocketServer: new (opts: { port: number }) => WsWebSocketServer };
  WebSocket: new (url: string) => WsWebSocket;
  WebSocketServer: new (opts: { port: number }) => WsWebSocketServer;
}

// ============================================================================
// Default PeerResolver
// ============================================================================

function createDefaultPeerResolver(
  program: Program<AgencCoordination>,
): PeerResolver {
  return {
    async resolveEndpoint(agentPubkey: PublicKey): Promise<string | null> {
      try {
        const account = await program.account.agentRegistration.fetchNullable(agentPubkey);
        if (!account) return null;
        const endpoint = (account as Record<string, unknown>).endpoint as string | undefined;
        return endpoint && endpoint.length > 0 ? endpoint : null;
      } catch {
        return null;
      }
    },
  };
}

// ============================================================================
// AgentMessaging
// ============================================================================

export class AgentMessaging {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly wallet: Keypair;
  private readonly discovery: PeerResolver;
  private readonly config: Required<MessagingConfig>;
  private readonly logger: Logger;
  private readonly agentPda: PublicKey;
  private readonly protocolPda: PublicKey;

  private nonce: number;
  private readonly handlers: Set<MessageHandler> = new Set();
  private wss: WsWebSocketServer | null = null;
  private disposed = false;

  constructor(opsConfig: MessagingOpsConfig) {
    this.program = opsConfig.program;
    this.agentId = new Uint8Array(opsConfig.agentId);
    this.wallet = opsConfig.wallet;
    this.logger = opsConfig.logger ?? silentLogger;
    this.discovery = opsConfig.discovery ?? createDefaultPeerResolver(this.program);

    this.config = {
      defaultMode: opsConfig.config?.defaultMode ?? 'auto',
      maxOffChainSize: opsConfig.config?.maxOffChainSize ?? 65536,
      connectTimeoutMs: opsConfig.config?.connectTimeoutMs ?? 5000,
      offChainRetries: opsConfig.config?.offChainRetries ?? 3,
      offChainPort: opsConfig.config?.offChainPort ?? 0,
    };

    this.agentPda = findAgentPda(this.agentId, this.program.programId);
    this.protocolPda = findProtocolPda(this.program.programId);

    // Start nonce at Date.now() to avoid cross-session collisions
    this.nonce = Date.now();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Send a message to another agent.
   *
   * @param recipient - Recipient agent PDA public key
   * @param content - Message text
   * @param mode - Delivery mode override (defaults to config.defaultMode)
   * @returns The sent AgentMessage
   */
  async send(
    recipient: PublicKey,
    content: string,
    mode?: MessageMode,
  ): Promise<AgentMessage> {
    if (this.disposed) {
      throw new MessagingSendError(recipient.toBase58(), 'Messaging instance is disposed');
    }

    const effectiveMode = mode ?? this.config.defaultMode;

    switch (effectiveMode) {
      case 'on-chain':
        return this.sendOnChain(recipient, content);
      case 'off-chain':
        return this.sendOffChain(recipient, content);
      case 'auto':
        return this.sendAuto(recipient, content);
      default:
        throw new MessagingSendError(recipient.toBase58(), `Unknown mode: ${effectiveMode}`);
    }
  }

  /**
   * Register a handler for incoming messages.
   * @returns Unsubscribe function
   */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Query on-chain message history between this agent and a peer.
   * Returns messages sent in both directions, sorted by nonce.
   *
   * @param peerAuthority - Peer's wallet authority public key
   * @param limit - Maximum results (default: 50)
   */
  async getOnChainHistory(
    peerAuthority: PublicKey,
    limit = 50,
  ): Promise<AgentMessage[]> {
    const myAuthority = this.wallet.publicKey;
    const messages: AgentMessage[] = [];

    // Query 1: Messages sent by me to peer
    // State PDA seeds: ["state", my_authority, state_key]
    // memcmp on state_key field (offset 40) for MSG_MAGIC prefix
    try {
      const sentByMe = await this.program.account.coordinationState.all([
        { memcmp: { offset: 8, bytes: myAuthority.toBase58() } },
        { memcmp: { offset: 40, bytes: this.encodeBase58MagicPrefix() } },
      ]);

      for (const entry of sentByMe) {
        const account = entry.account as unknown as Record<string, unknown>;
        const stateKey = new Uint8Array(account.stateKey as number[]);
        const stateValue = new Uint8Array(account.stateValue as number[]);

        const decoded = decodeMessageStateKey(stateKey);
        if (!decoded) continue;

        // Check if this message was sent to the peer
        const peerBytes = peerAuthority.toBytes();
        let match = true;
        for (let i = 0; i < 20; i++) {
          if (decoded.recipientPrefix[i] !== peerBytes[i]) {
            match = false;
            break;
          }
        }
        if (!match) continue;

        messages.push({
          id: `${myAuthority.toBase58()}:${decoded.nonce}`,
          sender: myAuthority,
          recipient: peerAuthority,
          content: decodeMessageStateValue(stateValue),
          mode: 'on-chain',
          signature: new Uint8Array(0),
          timestamp: typeof (account.updatedAt as { toNumber?: () => number })?.toNumber === 'function'
            ? (account.updatedAt as { toNumber: () => number }).toNumber()
            : Number(account.updatedAt),
          nonce: decoded.nonce,
          onChain: true,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch sent messages: ${err}`);
    }

    // Query 2: Messages sent by peer to me
    // Filter on state_key starting with MSG_MAGIC + my_pubkey_prefix
    try {
      const sentByPeer = await this.program.account.coordinationState.all([
        { memcmp: { offset: 8, bytes: peerAuthority.toBase58() } },
        { memcmp: { offset: 40, bytes: this.encodeBase58MagicPrefix() } },
      ]);

      for (const entry of sentByPeer) {
        const account = entry.account as unknown as Record<string, unknown>;
        const stateKey = new Uint8Array(account.stateKey as number[]);
        const stateValue = new Uint8Array(account.stateValue as number[]);

        const decoded = decodeMessageStateKey(stateKey);
        if (!decoded) continue;

        // Check if this message was sent to me
        const myBytes = myAuthority.toBytes();
        let match = true;
        for (let i = 0; i < 20; i++) {
          if (decoded.recipientPrefix[i] !== myBytes[i]) {
            match = false;
            break;
          }
        }
        if (!match) continue;

        messages.push({
          id: `${peerAuthority.toBase58()}:${decoded.nonce}`,
          sender: peerAuthority,
          recipient: myAuthority,
          content: decodeMessageStateValue(stateValue),
          mode: 'on-chain',
          signature: new Uint8Array(0),
          timestamp: typeof (account.updatedAt as { toNumber?: () => number })?.toNumber === 'function'
            ? (account.updatedAt as { toNumber: () => number }).toNumber()
            : Number(account.updatedAt),
          nonce: decoded.nonce,
          onChain: true,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch received messages: ${err}`);
    }

    // Sort by nonce (ascending) and limit
    messages.sort((a, b) => a.nonce - b.nonce);
    return messages.slice(0, limit);
  }

  /**
   * Verify the Ed25519 signature on a message.
   */
  verifySignature(message: AgentMessage): boolean {
    const payload = buildSigningPayload(
      message.sender,
      message.recipient,
      message.nonce,
      message.content,
    );
    return verifyAgentSignature(message.sender, payload, message.signature);
  }

  /**
   * Start the off-chain WebSocket listener for incoming messages.
   */
  async startListener(port?: number): Promise<number> {
    if (this.disposed) {
      throw new MessagingConnectionError('localhost', 'Messaging instance is disposed');
    }
    if (this.wss) {
      throw new MessagingConnectionError('localhost', 'Listener already started');
    }

    const listenPort = port ?? this.config.offChainPort;
    const wsMod = await this.loadWs();

    const ServerClass = wsMod.WebSocketServer ?? (wsMod.default as unknown as WsModule)?.WebSocketServer;
    this.wss = new ServerClass({ port: listenPort });

    this.wss.on('connection', (...args: unknown[]) => {
      const socket = args[0] as WsWebSocket;
      socket.on('message', (data: unknown) => {
        void this.handleIncomingMessage(data);
      });
    });

    const addr = this.wss.address();
    const actualPort = addr ? addr.port : listenPort;
    this.logger.info(`Messaging listener started on port ${actualPort}`);
    return actualPort;
  }

  /**
   * Stop the off-chain WebSocket listener.
   */
  async stopListener(): Promise<void> {
    if (!this.wss) return;
    return new Promise<void>((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        this.logger.info('Messaging listener stopped');
        resolve();
      });
    });
  }

  /**
   * Dispose the messaging instance. Stops listener and clears handlers.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopListener();
    this.handlers.clear();
  }

  // ==========================================================================
  // Private: On-Chain Send
  // ==========================================================================

  /** Max retries on nonce collision (VersionMismatch with expected_version=0) */
  private static readonly MAX_NONCE_RETRIES = 3;

  private async sendOnChain(recipient: PublicKey, content: string): Promise<AgentMessage> {
    // Validate content byte length
    const contentBytes = new TextEncoder().encode(content);
    if (contentBytes.length === 0) {
      throw new MessagingSendError(recipient.toBase58(), 'Message content cannot be empty');
    }
    if (contentBytes.length > MSG_CONTENT_MAX_ONCHAIN) {
      throw new MessagingSendError(
        recipient.toBase58(),
        `Content exceeds ${MSG_CONTENT_MAX_ONCHAIN} bytes: ${contentBytes.length} bytes`,
      );
    }

    const authority = this.wallet.publicKey;
    let lastError: unknown;

    // Retry on nonce collision (VersionMismatch = state PDA already exists)
    for (let attempt = 0; attempt <= AgentMessaging.MAX_NONCE_RETRIES; attempt++) {
      const currentNonce = this.nextNonce();
      const stateKey = encodeMessageStateKey(recipient, currentNonce);
      const stateValue = encodeMessageStateValue(content);

      // Derive state PDA: ["state", authority, state_key]
      const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('state'), authority.toBuffer(), Buffer.from(stateKey)],
        this.program.programId,
      );

      // Sign the message payload for offline verification
      const payload = buildSigningPayload(authority, recipient, currentNonce, content);
      const signature = signAgentMessage(this.wallet, payload);

      try {
        await this.program.methods
          .updateState(
            Array.from(stateKey) as unknown as number[],
            Array.from(stateValue) as unknown as number[],
            new BN(0), // expected_version = 0 (new account)
          )
          .accountsPartial({
            state: statePda,
            agent: this.agentPda,
            authority,
            protocolConfig: this.protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        const message: AgentMessage = {
          id: `${authority.toBase58()}:${currentNonce}`,
          sender: authority,
          recipient,
          content,
          mode: 'on-chain',
          signature,
          timestamp: Math.floor(Date.now() / 1000),
          nonce: currentNonce,
          onChain: true,
        };

        this.logger.info(`On-chain message sent to ${recipient.toBase58()} (nonce: ${currentNonce})`);
        return message;
      } catch (err) {
        if (isAnchorError(err, AnchorErrorCodes.RateLimitExceeded)) {
          throw new MessagingSendError(
            recipient.toBase58(),
            'Rate limit exceeded — on-chain messaging is throttled by state_update_cooldown (~60s)',
          );
        }
        // Retry on VersionMismatch (nonce collision — state PDA already exists)
        if (isAnchorError(err, AnchorErrorCodes.VersionMismatch)) {
          this.logger.warn(
            `Nonce collision (VersionMismatch) on attempt ${attempt + 1}, retrying with new nonce`,
          );
          lastError = err;
          continue;
        }
        throw new MessagingSendError(
          recipient.toBase58(),
          `On-chain send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw new MessagingSendError(
      recipient.toBase58(),
      `On-chain send failed after ${AgentMessaging.MAX_NONCE_RETRIES + 1} nonce collision retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  // ==========================================================================
  // Private: Off-Chain Send
  // ==========================================================================

  private async sendOffChain(recipient: PublicKey, content: string): Promise<AgentMessage> {
    // Validate size
    const contentBytes = new TextEncoder().encode(content);
    if (contentBytes.length > this.config.maxOffChainSize) {
      throw new MessagingSendError(
        recipient.toBase58(),
        `Content exceeds max off-chain size: ${contentBytes.length} > ${this.config.maxOffChainSize}`,
      );
    }

    // Resolve peer endpoint
    const endpoint = await this.discovery.resolveEndpoint(recipient);
    if (!endpoint) {
      throw new MessagingConnectionError(
        recipient.toBase58(),
        'No endpoint found for recipient',
      );
    }

    const currentNonce = this.nextNonce();
    const authority = this.wallet.publicKey;

    // Sign message
    const signPayload = buildSigningPayload(authority, recipient, currentNonce, content);
    const signature = signAgentMessage(this.wallet, signPayload);

    const timestamp = Math.floor(Date.now() / 1000);
    const envelope: OffChainEnvelope = {
      type: 'message',
      sender: authority.toBase58(),
      recipient: recipient.toBase58(),
      content,
      nonce: currentNonce,
      timestamp,
      signature: Buffer.from(signature).toString('base64'),
    };

    // Send via WebSocket with retries
    let lastWsError: unknown;
    for (let attempt = 0; attempt <= this.config.offChainRetries; attempt++) {
      try {
        await this.sendWebSocket(endpoint, JSON.stringify(envelope));
        lastWsError = undefined;
        break;
      } catch (err) {
        lastWsError = err;
        if (attempt < this.config.offChainRetries) {
          this.logger.warn(
            `Off-chain send attempt ${attempt + 1} failed, retrying (${this.config.offChainRetries - attempt} left)`,
          );
        }
      }
    }
    if (lastWsError) {
      throw lastWsError instanceof MessagingConnectionError
        ? lastWsError
        : new MessagingConnectionError(
            endpoint,
            lastWsError instanceof Error ? lastWsError.message : String(lastWsError),
          );
    }

    const message: AgentMessage = {
      id: `${authority.toBase58()}:${currentNonce}`,
      sender: authority,
      recipient,
      content,
      mode: 'off-chain',
      signature,
      timestamp,
      nonce: currentNonce,
      onChain: false,
    };

    this.logger.info(`Off-chain message sent to ${recipient.toBase58()} via ${endpoint}`);
    return message;
  }

  // ==========================================================================
  // Private: Auto Mode
  // ==========================================================================

  private async sendAuto(recipient: PublicKey, content: string): Promise<AgentMessage> {
    // Try off-chain first
    try {
      return await this.sendOffChain(recipient, content);
    } catch (err) {
      // If no endpoint or connection failed, fall back to on-chain
      if (err instanceof MessagingConnectionError) {
        this.logger.info(
          `Off-chain unavailable for ${recipient.toBase58()}, falling back to on-chain`,
        );

        // Validate content fits on-chain
        const contentBytes = new TextEncoder().encode(content);
        if (contentBytes.length > MSG_CONTENT_MAX_ONCHAIN) {
          throw new MessagingSendError(
            recipient.toBase58(),
            `Content too large for on-chain fallback: ${contentBytes.length} > ${MSG_CONTENT_MAX_ONCHAIN} bytes`,
          );
        }

        return this.sendOnChain(recipient, content);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Private: WebSocket Helpers
  // ==========================================================================

  private async sendWebSocket(endpoint: string, data: string): Promise<void> {
    const wsMod = await this.loadWs();
    const WsClient = wsMod.WebSocket ?? (wsMod.default as unknown as WsModule)?.WebSocket;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new MessagingConnectionError(endpoint, 'Connection timed out'));
      }, this.config.connectTimeoutMs);

      const ws: WsWebSocket = new (WsClient as unknown as new (url: string) => WsWebSocket)(endpoint);

      ws.on('open', () => {
        ws.send(data);
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on('error', (err: unknown) => {
        clearTimeout(timeout);
        reject(
          new MessagingConnectionError(
            endpoint,
            err instanceof Error ? err.message : String(err),
          ),
        );
      });
    });
  }

  private async handleIncomingMessage(data: unknown): Promise<void> {
    let envelope: OffChainEnvelope;
    try {
      const text = typeof data === 'string' ? data : String(data);
      envelope = JSON.parse(text) as OffChainEnvelope;
    } catch {
      this.logger.warn('Received malformed message, ignoring');
      return;
    }

    if (envelope.type !== 'message') {
      this.logger.warn(`Unknown envelope type: ${envelope.type}`);
      return;
    }

    // Verify signature
    let senderPubkey: PublicKey;
    try {
      senderPubkey = new PublicKey(envelope.sender);
    } catch {
      this.logger.warn(`Invalid sender public key: ${envelope.sender}`);
      return;
    }

    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(envelope.recipient);
    } catch {
      this.logger.warn(`Invalid recipient public key: ${envelope.recipient}`);
      return;
    }

    const signature = Buffer.from(envelope.signature, 'base64');
    const payload = buildSigningPayload(
      senderPubkey,
      recipientPubkey,
      envelope.nonce,
      envelope.content,
    );

    if (!verifyAgentSignature(senderPubkey, payload, new Uint8Array(signature))) {
      this.logger.warn(`Invalid signature from ${envelope.sender}, ignoring`);
      return;
    }

    const message: AgentMessage = {
      id: `${envelope.sender}:${envelope.nonce}`,
      sender: senderPubkey,
      recipient: recipientPubkey,
      content: envelope.content,
      mode: 'off-chain',
      signature: new Uint8Array(signature),
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
      onChain: false,
    };

    // Dispatch to all handlers
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (err) {
        this.logger.warn(`Message handler error: ${err}`);
      }
    }
  }

  // ==========================================================================
  // Private: Utilities
  // ==========================================================================

  private nextNonce(): number {
    return this.nonce++;
  }

  private async loadWs(): Promise<WsModule> {
    return ensureLazyModule<WsModule>(
      'ws',
      (msg) => new MessagingConnectionError('localhost', msg),
      (mod) => mod as unknown as WsModule,
    );
  }

  /**
   * Encode the MSG_MAGIC prefix as base58 for memcmp filter on state_key field.
   */
  private encodeBase58MagicPrefix(): string {
    return utils.bytes.bs58.encode(Buffer.from(MSG_MAGIC));
  }
}
