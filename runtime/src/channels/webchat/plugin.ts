/**
 * WebChat channel plugin for the AgenC Gateway.
 *
 * Unlike Telegram/Discord, WebChat does not manage its own transport.
 * It hooks into the Gateway's existing WebSocket server. The Gateway routes
 * any message with a dotted-namespace type (e.g. 'chat.message', 'skills.list')
 * to this plugin via the WebChatHandler delegate interface.
 *
 * @module
 */

import { BaseChannelPlugin } from '../../gateway/channel.js';
import type { ChannelContext } from '../../gateway/channel.js';
import type { OutboundMessage } from '../../gateway/message.js';
import { createGatewayMessage } from '../../gateway/message.js';
import { deriveSessionId } from '../../gateway/session.js';
import { DEFAULT_WORKSPACE_ID } from '../../gateway/workspace.js';
import type { ControlMessage, ControlResponse } from '../../gateway/types.js';
import type { WebChatHandler, WebChatDeps, WebChatChannelConfig } from './types.js';
import { HANDLER_MAP } from './handlers.js';
import type { SendFn } from './handlers.js';

// ============================================================================
// WebChatChannel
// ============================================================================

/**
 * Channel plugin that bridges WebSocket clients to the AgenC Gateway.
 *
 * Implements both ChannelPlugin (for PluginCatalog compatibility) and
 * WebChatHandler (for Gateway WS message routing).
 *
 * Each WS connection gets a clientId from the Gateway's auto-incrementing
 * counter. This serves as the senderId for deriveSessionId(). Session
 * continuity across reconnects is supported via 'chat.resume'.
 */
export class WebChatChannel extends BaseChannelPlugin implements WebChatHandler {
  readonly name = 'webchat';

  private readonly deps: WebChatDeps;

  // clientId → sessionId mapping (for outbound routing)
  private readonly clientSessions = new Map<string, string>();
  // sessionId → clientId reverse mapping (for send())
  private readonly sessionClients = new Map<string, string>();
  // clientId → send function (for pushing messages to specific clients)
  private readonly clientSenders = new Map<string, SendFn>();
  // sessionId → chat history for resume support
  private readonly sessionHistory = new Map<string, Array<{ content: string; sender: 'user' | 'agent'; timestamp: number }>>();
  // clientIds that have subscribed to real-time events
  private readonly eventSubscribers = new Set<string>();

  private healthy = true;

  constructor(deps: WebChatDeps, _config?: WebChatChannelConfig) {
    super();
    this.deps = deps;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  override async initialize(context: ChannelContext): Promise<void> {
    await super.initialize(context);
  }

  override async start(): Promise<void> {
    this.healthy = true;
    this.context.logger.info('WebChat channel started');
  }

  override async stop(): Promise<void> {
    this.clientSessions.clear();
    this.sessionClients.clear();
    this.clientSenders.clear();
    this.sessionHistory.clear();
    this.eventSubscribers.clear();
    this.healthy = false;
    this.context.logger.info('WebChat channel stopped');
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Push to session (daemon → specific WS client by sessionId)
  // --------------------------------------------------------------------------

  /**
   * Push a message to a specific session's WS client. Used by the daemon to
   * send tool events, typing indicators, and approval requests mid-execution.
   */
  pushToSession(sessionId: string, response: ControlResponse): void {
    const clientId = this.sessionClients.get(sessionId);
    if (!clientId) return;
    const send = this.clientSenders.get(clientId);
    if (!send) return;
    send(response);
  }

  // --------------------------------------------------------------------------
  // Outbound (Gateway → WebSocket client)
  // --------------------------------------------------------------------------

  override async send(message: OutboundMessage): Promise<void> {
    const clientId = this.sessionClients.get(message.sessionId);
    if (!clientId) {
      this.context.logger.warn?.(
        `WebChat: no client mapping for session "${message.sessionId}"`,
      );
      return;
    }

    const sendFn = this.clientSenders.get(clientId);
    if (!sendFn) {
      this.context.logger.warn?.(
        `WebChat: no send function for client "${clientId}"`,
      );
      return;
    }

    const timestamp = Date.now();

    // Store in history for resume
    this.appendHistory(message.sessionId, {
      content: message.content,
      sender: 'agent',
      timestamp,
    });

    sendFn({
      type: 'chat.message',
      payload: {
        content: message.content,
        sender: 'agent',
        timestamp,
      },
    });
  }

  // --------------------------------------------------------------------------
  // WebChatHandler (Gateway delegates dotted-namespace messages here)
  // --------------------------------------------------------------------------

  handleMessage(
    clientId: string,
    type: string,
    msg: ControlMessage,
    send: (response: ControlResponse) => void,
  ): void {
    // Store sender for outbound routing
    this.clientSenders.set(clientId, send);

    const id = typeof msg.id === 'string' ? msg.id : undefined;
    const payload = msg.payload as Record<string, unknown> | undefined;

    // Voice messages are routed to the voice bridge
    if (type.startsWith('voice.')) {
      this.handleVoiceMessage(clientId, type, payload, id, send);
      return;
    }

    // Event subscriptions need clientId — handled here, not in HANDLER_MAP
    if (type.startsWith('events.')) {
      this.handleEventMessage(clientId, type, id, send);
      return;
    }

    // Chat messages are special — they go through the Gateway's message pipeline
    if (type === 'chat.message') {
      this.handleChatMessage(clientId, payload, id, send);
      return;
    }

    if (type === 'chat.typing') {
      // Typing indicators are noted but not forwarded
      return;
    }

    if (type === 'chat.history') {
      this.handleChatHistory(clientId, payload, id, send);
      return;
    }

    if (type === 'chat.resume') {
      this.handleChatResume(clientId, payload, id, send);
      return;
    }

    // Delegate to subsystem handlers (may be async)
    const handler = HANDLER_MAP[type];
    if (handler) {
      const result = handler(this.deps, payload, id, send);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.context.logger.warn?.('WebChat handler error:', err);
          send({ type: 'error', error: `Handler error: ${(err as Error).message}`, id });
        });
      }
      return;
    }

    send({ type: 'error', error: `Unknown webchat message type: ${type}`, id });
  }

  // --------------------------------------------------------------------------
  // Voice message handling
  // --------------------------------------------------------------------------

  private handleVoiceMessage(
    clientId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const bridge = this.deps.voiceBridge;
    if (!bridge) {
      send({ type: 'error', error: 'Voice not available — no LLM provider with voice support configured', id });
      return;
    }

    switch (type) {
      case 'voice.start':
        void bridge.startSession(clientId, send);
        break;
      case 'voice.audio': {
        const audio = payload?.audio;
        if (typeof audio === 'string') {
          bridge.sendAudio(clientId, audio);
        }
        break;
      }
      case 'voice.commit':
        bridge.commitAudio(clientId);
        break;
      case 'voice.stop':
        void bridge.stopSession(clientId);
        break;
      default:
        send({ type: 'error', error: `Unknown voice message type: ${type}`, id });
    }
  }

  // --------------------------------------------------------------------------
  // Chat message handling
  // --------------------------------------------------------------------------

  private handleChatMessage(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const content = (payload as Record<string, unknown> | undefined)?.content ?? (payload as unknown);
    if (typeof content !== 'string' || content.trim().length === 0) {
      send({ type: 'error', error: 'Missing or empty content in chat.message', id });
      return;
    }

    // Ensure session mapping
    const sessionId = this.ensureSession(clientId);

    // Store user message in history
    this.appendHistory(sessionId, {
      content: content as string,
      sender: 'user',
      timestamp: Date.now(),
    });

    // Create a GatewayMessage and deliver to the Gateway pipeline
    const gatewayMsg = createGatewayMessage({
      channel: 'webchat',
      senderId: clientId,
      senderName: `WebClient(${clientId})`,
      sessionId,
      content: content as string,
      scope: 'dm',
    });

    this.context.onMessage(gatewayMsg).catch((err) => {
      this.context.logger.warn?.('WebChat: error delivering message to gateway:', err);
      send({
        type: 'error',
        error: 'Failed to process message',
        id,
      });
    });
  }

  private handleChatHistory(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const sessionId = this.clientSessions.get(clientId);
    if (!sessionId) {
      send({ type: 'chat.history', payload: [], id });
      return;
    }

    const limit = typeof payload?.limit === 'number' ? payload.limit : 50;
    const history = this.sessionHistory.get(sessionId) ?? [];
    const messages = history.slice(-limit);

    send({ type: 'chat.history', payload: messages, id });
  }

  private handleChatResume(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const targetSessionId = (payload as Record<string, unknown> | undefined)?.sessionId;
    if (!targetSessionId || typeof targetSessionId !== 'string') {
      send({ type: 'error', error: 'Missing sessionId in chat.resume', id });
      return;
    }

    const history = this.sessionHistory.get(targetSessionId);
    if (!history) {
      send({ type: 'error', error: `Session "${targetSessionId}" not found`, id });
      return;
    }

    // Remove old mapping if exists
    const oldSession = this.clientSessions.get(clientId);
    if (oldSession) {
      this.sessionClients.delete(oldSession);
    }

    // Map client to the resumed session
    this.clientSessions.set(clientId, targetSessionId);
    this.sessionClients.set(targetSessionId, clientId);

    send({
      type: 'chat.resumed',
      payload: {
        sessionId: targetSessionId,
        messageCount: history.length,
      },
      id,
    });
  }

  // --------------------------------------------------------------------------
  // Event subscription handling
  // --------------------------------------------------------------------------

  private handleEventMessage(
    clientId: string,
    type: string,
    id: string | undefined,
    send: SendFn,
  ): void {
    switch (type) {
      case 'events.subscribe':
        this.eventSubscribers.add(clientId);
        send({ type: 'events.subscribed', payload: { active: true }, id });
        break;
      case 'events.unsubscribe':
        this.eventSubscribers.delete(clientId);
        send({ type: 'events.unsubscribed', payload: { active: false }, id });
        break;
      default:
        send({ type: 'error', error: `Unknown events message type: ${type}`, id });
    }
  }

  /**
   * Broadcast an event to all subscribed WS clients.
   */
  broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const response: ControlResponse = {
      type: 'events.event',
      payload: { eventType, data, timestamp: Date.now() },
    };
    for (const clientId of this.eventSubscribers) {
      const send = this.clientSenders.get(clientId);
      send?.(response);
    }
  }

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  private ensureSession(clientId: string): string {
    const existing = this.clientSessions.get(clientId);
    if (existing) return existing;

    const sessionId = deriveSessionId(
      {
        channel: 'webchat',
        senderId: clientId,
        scope: 'dm',
        workspaceId: DEFAULT_WORKSPACE_ID,
      },
      'per-channel-peer',
    );

    this.clientSessions.set(clientId, sessionId);
    this.sessionClients.set(sessionId, clientId);

    return sessionId;
  }

  private appendHistory(
    sessionId: string,
    entry: { content: string; sender: 'user' | 'agent'; timestamp: number },
  ): void {
    let history = this.sessionHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionHistory.set(sessionId, history);
    }
    history.push(entry);
    // Keep history bounded
    if (history.length > 500) {
      history.splice(0, history.length - 500);
    }
  }

  // --------------------------------------------------------------------------
  // Client cleanup (called when a WS connection disconnects)
  // --------------------------------------------------------------------------

  /**
   * Clean up state for a disconnected client. The Gateway should call this
   * when a WS client disconnects.
   */
  removeClient(clientId: string): void {
    // Stop any active voice session for this client
    if (this.deps.voiceBridge?.hasSession(clientId)) {
      void this.deps.voiceBridge.stopSession(clientId);
    }

    // Remove from event subscribers
    this.eventSubscribers.delete(clientId);

    const sessionId = this.clientSessions.get(clientId);
    if (sessionId) {
      this.sessionClients.delete(sessionId);
      // Note: we keep sessionHistory for resume support
    }
    this.clientSessions.delete(clientId);
    this.clientSenders.delete(clientId);
  }
}
