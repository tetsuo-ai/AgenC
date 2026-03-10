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

import { BaseChannelPlugin } from "../../gateway/channel.js";
import type { ChannelContext } from "../../gateway/channel.js";
import { randomUUID } from "node:crypto";
import type {
  OutboundMessage,
  MessageAttachment,
} from "../../gateway/message.js";
import { createGatewayMessage } from "../../gateway/message.js";
import { deriveSessionId } from "../../gateway/session.js";
import { DEFAULT_WORKSPACE_ID } from "../../gateway/workspace.js";
import type { ControlMessage, ControlResponse } from "../../gateway/types.js";
import { safeStringify } from "../../tools/types.js";
import { summarizeTracePayloadForPreview } from "../../utils/trace-payload-serialization.js";
import type {
  WebChatHandler,
  WebChatDeps,
  WebChatChannelConfig,
} from "./types.js";
import { HANDLER_MAP } from "./handlers.js";
import type { SendFn } from "./handlers.js";
import type { HandlerRequestContext } from "./handlers.js";
import {
  matchesEventFilters,
  type SocialMessagePayload,
} from "./protocol.js";
import {
  WebChatSessionStore,
  type PersistedWebChatOwnerCredential,
  type PersistedWebChatPolicyContext,
} from "./session-store.js";

const MESSAGE_ID_TTL_MS = 5 * 60_000;
const MAX_TRACKED_MESSAGE_IDS = 5_000;
const WS_TRACE_PAYLOAD_MAX_CHARS = 2_000;

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
 * counter. WebChat session IDs are intentionally salted with randomness so a
 * daemon restart cannot accidentally reuse old persisted memory by session ID.
 * Session continuity across reconnects is supported via explicit 'chat.resume'.
 */
export class WebChatChannel
  extends BaseChannelPlugin
  implements WebChatHandler
{
  readonly name = "webchat";

  private deps: WebChatDeps;

  // clientId → sessionId mapping (for outbound routing)
  private readonly clientSessions = new Map<string, string>();
  // sessionId → clientId reverse mapping (for send())
  private readonly sessionClients = new Map<string, string>();
  // clientId → server-authenticated durable owner key
  private readonly clientOwnerKeys = new Map<string, string>();
  // clientId → send function (for pushing messages to specific clients)
  private readonly clientSenders = new Map<string, SendFn>();
  // Security: sessionId → durable owner key (or volatile client fallback)
  private readonly sessionOwners = new Map<string, string>();
  // sessionId → chat history for resume support
  private readonly sessionHistory = new Map<
    string,
    Array<{ content: string; sender: "user" | "agent"; timestamp: number }>
  >();
  private readonly sessionPolicyContexts = new Map<
    string,
    PersistedWebChatPolicyContext
  >();
  // clientIds subscribed to events and their optional filters
  private readonly eventSubscribers = new Map<string, readonly string[] | null>();
  // sessionId → AbortController for in-flight chat execution
  private readonly sessionAbortControllers = new Map<string, AbortController>();
  // Dedup replayed chat.message envelopes (e.g. reconnect flush/retry)
  // per durable owner so fresh clients/runs can safely reuse local counters.
  private readonly seenMessageIds = new Map<
    string,
    { seenAt: number; sessionId: string }
  >();
  private readonly sessionStore?: WebChatSessionStore;

  private healthy = true;

  constructor(deps: WebChatDeps, _config?: WebChatChannelConfig) {
    super();
    this.deps = deps;
    this.sessionStore =
      deps.memoryBackend &&
      typeof deps.memoryBackend.get === "function" &&
      typeof deps.memoryBackend.set === "function"
      ? new WebChatSessionStore({ memoryBackend: deps.memoryBackend })
      : undefined;
  }

  /** Create and track an AbortController for a session's in-flight execution. */
  createAbortController(sessionId: string): AbortController {
    // Abort any existing in-flight execution for this session
    this.sessionAbortControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    this.sessionAbortControllers.set(sessionId, controller);
    return controller;
  }

  /** Cancel the in-flight execution for a session. */
  cancelSession(sessionId: string): boolean {
    const controller = this.sessionAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionAbortControllers.delete(sessionId);
      return true;
    }
    return false;
  }

  /** Clean up the controller after execution completes. */
  clearAbortController(sessionId: string): void {
    this.sessionAbortControllers.delete(sessionId);
  }

  /** Replace the voice bridge at runtime (e.g. after config hot-reload). */
  updateVoiceBridge(
    bridge: import("../../gateway/voice-bridge.js").VoiceBridge | null,
  ): void {
    this.deps = { ...this.deps, voiceBridge: bridge ?? undefined };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  override async initialize(context: ChannelContext): Promise<void> {
    await super.initialize(context);
  }

  override async start(): Promise<void> {
    this.healthy = true;
    this.context.logger.info("WebChat channel started");
  }

  override async stop(): Promise<void> {
    this.clientSessions.clear();
    this.sessionClients.clear();
    this.clientOwnerKeys.clear();
    this.clientSenders.clear();
    this.sessionOwners.clear();
    this.sessionHistory.clear();
    this.sessionPolicyContexts.clear();
    this.eventSubscribers.clear();
    this.seenMessageIds.clear();
    this.healthy = false;
    this.context.logger.info("WebChat channel stopped");
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
    this.sendTracedControlResponse(clientId, sessionId, send, response);
  }

  /**
   * Surface an inbound peer-to-peer social message to every active session on
   * this daemon without replaying it as the daemon agent's own chat history.
   */
  pushSocialMessageToActiveSessions(payload: SocialMessagePayload): number {
    let delivered = 0;
    for (const [sessionId, clientId] of this.sessionClients.entries()) {
      const send = this.clientSenders.get(clientId);
      if (!send) continue;
      this.sendTracedControlResponse(clientId, sessionId, send, {
        type: "social.message",
        payload: {
          ...payload,
          sessionId,
        },
      });
      delivered += 1;
    }
    return delivered;
  }

  // --------------------------------------------------------------------------
  // Outbound (Gateway → WebSocket client)
  // --------------------------------------------------------------------------

  override async send(message: OutboundMessage): Promise<void> {
    const timestamp = Date.now();

    // Store in history for resume
    this.appendHistory(message.sessionId, {
      content: message.content,
      sender: "agent",
      timestamp,
    });
    await this.persistSessionActivity(message.sessionId, {
      content: message.content,
      sender: "agent",
      timestamp,
    });

    const clientId = this.sessionClients.get(message.sessionId);
    if (!clientId) {
      this.context.logger.debug?.(
        `WebChat: no client mapping for session "${message.sessionId}"`,
      );
      return;
    }

    const sendFn = this.clientSenders.get(clientId);
    if (!sendFn) {
      this.context.logger.debug?.(
        `WebChat: no send function for client "${clientId}"`,
      );
      return;
    }

    this.sendTracedControlResponse(clientId, message.sessionId, sendFn, {
      type: "chat.message",
      payload: {
        content: message.content,
        sender: "agent",
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
    const tracedSend: SendFn = (response) => {
      this.sendTracedControlResponse(
        clientId,
        this.clientSessions.get(clientId),
        send,
        response,
      );
    };

    const id = typeof msg.id === "string" ? msg.id : undefined;
    let payload = msg.payload as Record<string, unknown> | undefined;

    // Voice messages are routed to the voice bridge
    if (type.startsWith("voice.")) {
      this.handleVoiceMessage(clientId, type, payload, id, tracedSend);
      return;
    }

    // Event subscriptions need clientId — handled here, not in HANDLER_MAP
    if (type.startsWith("events.")) {
      this.handleEventMessage(clientId, type, payload, id, tracedSend);
      return;
    }

    // Chat messages are special — they go through the Gateway's message pipeline
    if (type === "chat.message") {
      this.handleChatMessage(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.typing") {
      // Typing indicators are noted but not forwarded
      return;
    }

    if (type === "chat.cancel") {
      const sessionId = this.clientSessions.get(clientId);
      const foregroundCancelled = sessionId ? this.cancelSession(sessionId) : false;
      const backgroundCancelled = sessionId
        ? this.deps.cancelBackgroundRun?.(sessionId)
        : false;
      void Promise.resolve(backgroundCancelled).then((result) => {
        tracedSend({
          type: "chat.cancelled",
          payload: { cancelled: foregroundCancelled || Boolean(result) },
          id,
        });
      });
      return;
    }

    if (type === "chat.new") {
      this.handleChatNew(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.history") {
      this.handleChatHistory(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.resume") {
      this.handleChatResume(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.sessions") {
      this.handleChatSessions(clientId, payload, id, tracedSend);
      return;
    }

    // Desktop create/attach should default to the active webchat session so
    // the chat pane and desktop pane point at the same sandbox.
    if (type === "desktop.create" || type === "desktop.attach") {
      const normalizedPayload =
        payload && typeof payload === "object" ? { ...payload } : {};
      if (
        typeof normalizedPayload.sessionId !== "string" ||
        normalizedPayload.sessionId.length === 0
      ) {
        const sessionId = this.ensureSession(
          clientId,
          this.currentOwnerKey(clientId),
        );
        normalizedPayload.sessionId = sessionId;
        tracedSend({ type: "chat.session", payload: { sessionId } });
      }
      payload = normalizedPayload;
    }

    // Delegate to subsystem handlers (may be async)
    const handler = HANDLER_MAP[type];
    if (handler) {
      const requestContext: HandlerRequestContext = {
        clientId,
        ownerKey: this.currentOwnerKey(clientId),
        actorId: this.currentActorId(clientId),
        channel: this.name,
        activeSessionId: this.clientSessions.get(clientId),
        listOwnedSessionIds: () => this.listOwnedSessionIds(clientId),
        isSessionOwned: (sessionId: string) =>
          this.sessionOwners.get(sessionId) === this.currentOwnerKey(clientId),
      };
      const result = handler(this.deps, payload, id, tracedSend, requestContext);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.context.logger.warn?.("WebChat handler error:", err);
          tracedSend({
            type: "error",
            error: `Handler error: ${(err as Error).message}`,
            id,
          });
        });
      }
      return;
    }

    tracedSend({ type: "error", error: `Unknown webchat message type: ${type}`, id });
  }

  private sendTracedControlResponse(
    clientId: string,
    sessionId: string | undefined,
    send: SendFn,
    response: ControlResponse,
  ): void {
    this.traceOutboundControlResponse(clientId, sessionId, response);
    send(response);
  }

  private traceOutboundControlResponse(
    clientId: string,
    sessionId: string | undefined,
    response: ControlResponse,
  ): void {
    const payload = response.payload;
    const payloadSessionId =
      payload &&
      typeof payload === "object" &&
      "sessionId" in payload &&
      typeof payload.sessionId === "string"
        ? payload.sessionId
        : undefined;
    const traceLine = {
      clientId,
      ...(payloadSessionId || sessionId
        ? { sessionId: payloadSessionId ?? sessionId }
        : {}),
      type: response.type,
      ...(typeof response.id === "string" ? { id: response.id } : {}),
      ...(typeof response.error === "string" ? { error: response.error } : {}),
      payloadPreview: summarizeTracePayloadForPreview(
        payload ?? null,
        WS_TRACE_PAYLOAD_MAX_CHARS,
      ),
    };
    this.context.logger.info(
      `[trace] webchat.ws.outbound ${safeStringify(traceLine)}`,
    );
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
      send({
        type: "voice.error",
        payload: {
          message:
            "Voice not available — no LLM provider with voice support configured",
        },
        id,
      });
      return;
    }

    switch (type) {
      case "voice.start": {
        // Pass the client's current sessionId so voice and text share history
        const voiceSessionId = this.ensureSession(
          clientId,
          this.currentOwnerKey(clientId),
        );
        void bridge.startSession(clientId, send, voiceSessionId).catch((error) => {
          this.context.logger?.warn?.("Failed to start voice session:", error);
          send({
            type: "voice.error",
            payload: { message: (error as Error).message },
            id,
          });
        });
        break;
      }
      case "voice.audio": {
        const audio = payload?.audio;
        if (typeof audio === "string") {
          bridge.sendAudio(clientId, audio);
        } else {
          send({
            type: "voice.error",
            payload: { message: "Invalid voice.audio payload" },
            id,
          });
        }
        break;
      }
      case "voice.commit":
        bridge.commitAudio(clientId);
        break;
      case "voice.stop":
        void bridge.stopSession(clientId);
        break;
      default:
        send({
          type: "voice.error",
          payload: {
            message: `Unknown voice message type: ${type}`,
          },
          id,
        });
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
    const content =
      (payload as Record<string, unknown> | undefined)?.content ??
      (payload as unknown);
    const rawAttachments = (payload as Record<string, unknown> | undefined)
      ?.attachments;

    // Allow empty content if attachments are present
    const hasAttachments =
      Array.isArray(rawAttachments) && rawAttachments.length > 0;
    if (
      typeof content !== "string" ||
      (content.trim().length === 0 && !hasAttachments)
    ) {
      send({
        type: "error",
        error: "Missing or empty content in chat.message",
        id,
      });
      return;
    }

    this.withResolvedOwner(
      clientId,
      payload,
      send,
      (ownerKey) => {
        const messageKey =
          typeof id === "string"
            ? this.buildSeenMessageKey(ownerKey, id)
            : undefined;
        const duplicateSessionId = messageKey
          ? this.getDuplicateSessionId(messageKey)
          : undefined;
        if (duplicateSessionId) {
          this.bindClientToSession(clientId, duplicateSessionId, ownerKey);
          send({
            type: "chat.session",
            payload: { sessionId: duplicateSessionId },
            id,
          });
          return;
        }

        const timestamp = Date.now();
        const sessionId = this.ensureSession(clientId, ownerKey);
        if (messageKey) {
          this.rememberMessageKey(messageKey, sessionId, timestamp);
        }
        const policyContext =
          this.parsePolicyContext(payload) ??
          this.sessionPolicyContexts.get(sessionId);

        if (policyContext) {
          this.sessionPolicyContexts.set(sessionId, policyContext);
        }

        // Notify the client of its session ID (needed for desktop viewer matching)
        send({ type: "chat.session", payload: { sessionId }, id });

        // Store user message in history
        this.appendHistory(sessionId, {
          content: content as string,
          sender: "user",
          timestamp,
        });
        void this.persistSessionActivity(sessionId, {
          content: content as string,
          sender: "user",
          timestamp,
          ...(policyContext ? { policyContext } : {}),
        });

        // Convert base64 attachments from the WebSocket payload to MessageAttachment[]
        let attachments: MessageAttachment[] | undefined;
        if (hasAttachments) {
          attachments = (rawAttachments as Array<Record<string, unknown>>)
            .map((att): MessageAttachment | null => {
              const filename =
                typeof att.filename === "string" ? att.filename : undefined;
              const mimeType =
                typeof att.mimeType === "string"
                  ? att.mimeType
                  : "application/octet-stream";
              const base64 = typeof att.data === "string" ? att.data : undefined;
              const sizeBytes =
                typeof att.sizeBytes === "number" ? att.sizeBytes : undefined;

              let data: Uint8Array | undefined;
              if (base64) {
                try {
                  const binary = Buffer.from(base64, "base64");
                  data = new Uint8Array(binary);
                } catch {
                  return null;
                }
              }

              const type = mimeType.startsWith("image/")
                ? "image"
                : mimeType.startsWith("audio/")
                  ? "audio"
                  : "file";

              return { type, mimeType, data, filename, sizeBytes };
            })
            .filter((a): a is MessageAttachment => a !== null);
        }

        // Create a GatewayMessage and deliver to the Gateway pipeline
        const gatewayMsg = createGatewayMessage({
          channel: "webchat",
          senderId: clientId,
          senderName: `WebClient(${clientId})`,
          sessionId,
          content: content as string,
          scope: "dm",
          ...(policyContext ? { metadata: { policyContext } } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
        this.context.onMessage(gatewayMsg).catch((err) => {
          this.context.logger.warn?.(
            "WebChat: error delivering message to gateway:",
            err,
          );
          send({
            type: "error",
            error: "Failed to process message",
            id,
          });
        });
      },
      (error) => {
        send({
          type: "error",
          error: `Failed to process chat message: ${error.message}`,
          id,
        });
      },
    );
  }

  private handleChatNew(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const oldSessionId = this.clientSessions.get(clientId);
    if (oldSessionId && this.deps.resetSessionContext) {
      void Promise.resolve(this.deps.resetSessionContext(oldSessionId)).catch(
        (error) => {
          this.context.logger.warn?.(
            `Failed to reset context for session ${oldSessionId}:`,
            error,
          );
        },
      );
    }

    this.withResolvedOwner(
      clientId,
      payload,
      send,
      (ownerKey) => {
        const sessionId = this.ensureSession(clientId, ownerKey, {
          forceNew: true,
        });
        send({ type: "chat.session", payload: { sessionId }, id });
        send({ type: "chat.history", payload: [], id });
      },
      (error) => {
        send({
          type: "error",
          error: `Failed to start chat session: ${error.message}`,
          id,
        });
      },
    );
  }

  private handleChatHistory(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleChatHistoryAsync(clientId, payload, id, send).catch((error) => {
      send({
        type: "error",
        error: `Failed to load chat history: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatResume(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleChatResumeAsync(clientId, payload, id, send).catch((error) => {
      send({
        type: "error",
        error: `Failed to resume chat session: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatSessions(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleChatSessionsAsync(clientId, payload, id, send).catch((error) => {
      send({
        type: "error",
        error: `Failed to list chat sessions: ${(error as Error).message}`,
        id,
      });
    });
  }

  private async handleChatHistoryAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const sessionId = this.clientSessions.get(clientId);
    if (!sessionId) {
      send({ type: "chat.history", payload: [], id });
      return;
    }

    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const authorized = await this.isAuthorizedSession(
      sessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({ type: "error", error: "Not authorized to access this session", id });
      return;
    }

    const limit = typeof payload?.limit === "number" ? payload.limit : 50;
    const history = await this.loadSessionHistory(sessionId, limit);
    send({ type: "chat.history", payload: history, id });
  }

  private async handleChatResumeAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const targetSessionId = payload?.sessionId;
    if (!targetSessionId || typeof targetSessionId !== "string") {
      send({ type: "error", error: "Missing sessionId in chat.resume", id });
      return;
    }

    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({
        type: "error",
        error: `Session "${targetSessionId}" not found`,
        id,
      });
      return;
    }

    const oldSession = this.clientSessions.get(clientId);
    if (oldSession) {
      this.sessionClients.delete(oldSession);
    }

    this.clientSessions.set(clientId, targetSessionId);
    this.sessionClients.set(targetSessionId, clientId);
    this.sessionOwners.set(targetSessionId, ownerKey);
    const persisted = await this.sessionStore?.loadSession(targetSessionId);
    const policyContext = persisted?.metadata?.policyContext;
    if (policyContext) {
      this.sessionPolicyContexts.set(targetSessionId, policyContext);
    }

    await Promise.resolve(this.deps.hydrateSessionContext?.(targetSessionId));
    const history = await this.loadSessionHistory(targetSessionId);

    send({
      type: "chat.resumed",
      payload: {
        sessionId: targetSessionId,
        messageCount: history.length,
      },
      id,
    });
  }

  private async handleChatSessionsAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    if (this.sessionStore && this.isDurableOwnerKey(ownerKey)) {
      const persistedSessions = await this.sessionStore.listSessionsForOwner(ownerKey);
      const sessions = persistedSessions
        .filter((session) => session.messageCount > 0)
        .map((session) => {
          this.sessionOwners.set(session.sessionId, session.ownerKey);
          return {
            sessionId: session.sessionId,
            label: session.label,
            messageCount: session.messageCount,
            lastActiveAt: session.lastActiveAt,
          };
        })
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      send({ type: "chat.sessions", payload: sessions, id });
      return;
    }

    const sessions: Array<{
      sessionId: string;
      label: string;
      messageCount: number;
      lastActiveAt: number;
    }> = [];

    for (const [sessionId, history] of this.sessionHistory) {
      if (history.length === 0) continue;
      // Security: Only show sessions owned by this client
      const owner = this.sessionOwners.get(sessionId);
      if (owner && owner !== ownerKey) continue;
      const firstUserMsg = history.find((m) => m.sender === "user");
      const label = firstUserMsg
        ? firstUserMsg.content.slice(0, 80)
        : "New conversation";
      const lastEntry = history[history.length - 1];
      sessions.push({
        sessionId,
        label,
        messageCount: history.length,
        lastActiveAt: lastEntry.timestamp,
      });
    }

    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    send({ type: "chat.sessions", payload: sessions, id });
  }

  // --------------------------------------------------------------------------
  // Event subscription handling
  // --------------------------------------------------------------------------

  private handleEventMessage(
    clientId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    switch (type) {
      case "events.subscribe": {
        const rawFilters = Array.isArray(payload?.filters)
          ? payload.filters
          : [];
        const normalizedFilters = Array.from(
          new Set(
            rawFilters
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        );
        const filters = normalizedFilters.length > 0 ? normalizedFilters : null;
        this.eventSubscribers.set(clientId, filters);
        send({
          type: "events.subscribed",
          payload: {
            active: true,
            filters: filters ?? [],
          },
          id,
        });
        break;
      }
      case "events.unsubscribe":
        this.eventSubscribers.delete(clientId);
        send({
          type: "events.unsubscribed",
          payload: { active: false, filters: [] },
          id,
        });
        break;
      default:
        send({
          type: "error",
          error: `Unknown events message type: ${type}`,
          id,
        });
    }
  }

  /**
   * Broadcast an event to all subscribed WS clients.
   */
  broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const traceId = typeof data.traceId === "string" ? data.traceId : undefined;
    const parentTraceId =
      typeof data.parentTraceId === "string" ? data.parentTraceId : undefined;
    const eventData =
      traceId || parentTraceId
        ? Object.fromEntries(
            Object.entries(data).filter(
              ([key]) => key !== "traceId" && key !== "parentTraceId",
            ),
          )
        : data;
    const response: ControlResponse = {
      type: "events.event",
      payload: {
        eventType,
        data: eventData,
        timestamp: Date.now(),
        ...(traceId ? { traceId } : {}),
        ...(parentTraceId ? { parentTraceId } : {}),
      },
    };
    for (const [clientId, filters] of this.eventSubscribers) {
      if (!matchesEventFilters(eventType, filters)) continue;
      const send = this.clientSenders.get(clientId);
      send?.(response);
    }
  }

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  private ensureSession(
    clientId: string,
    ownerKey: string,
    options?: { forceNew?: boolean },
  ): string {
    const existing = this.clientSessions.get(clientId);
    const forceNew = options?.forceNew === true;
    if (existing && !forceNew) return existing;

    if (existing && forceNew) {
      this.cancelSession(existing);
      this.sessionClients.delete(existing);
    }

    const sessionSalt = `${Date.now().toString(36)}:${randomUUID()}`;
    const sessionId = deriveSessionId(
      {
        channel: "webchat",
        senderId: `${clientId}:${sessionSalt}`,
        scope: "dm",
        workspaceId: DEFAULT_WORKSPACE_ID,
      },
      "per-channel-peer",
    );

    this.bindClientToSession(clientId, sessionId, ownerKey);
    if (this.isDurableOwnerKey(ownerKey)) {
      void this.sessionStore?.ensureSession({ sessionId, ownerKey });
    }

    return sessionId;
  }

  private bindClientToSession(
    clientId: string,
    sessionId: string,
    ownerKey: string,
  ): void {
    const existingSessionId = this.clientSessions.get(clientId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.sessionClients.delete(existingSessionId);
    }
    this.clientSessions.set(clientId, sessionId);
    this.sessionClients.set(sessionId, clientId);
    this.sessionOwners.set(sessionId, ownerKey);
  }

  private buildSeenMessageKey(ownerKey: string, messageId: string): string {
    return `${ownerKey}:${messageId}`;
  }

  private getDuplicateSessionId(messageKey: string): string | undefined {
    this.pruneMessageIds();
    return this.seenMessageIds.get(messageKey)?.sessionId;
  }

  private rememberMessageKey(
    messageKey: string,
    sessionId: string,
    now = Date.now(),
  ): void {
    this.pruneMessageIds(now);
    this.seenMessageIds.set(messageKey, { seenAt: now, sessionId });
    if (this.seenMessageIds.size > MAX_TRACKED_MESSAGE_IDS) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (typeof oldest === "string") {
        this.seenMessageIds.delete(oldest);
      }
    }
  }

  private pruneMessageIds(now = Date.now()): void {
    for (const [id, entry] of this.seenMessageIds) {
      if (now - entry.seenAt > MESSAGE_ID_TTL_MS) {
        this.seenMessageIds.delete(id);
      }
    }
  }

  private appendHistory(
    sessionId: string,
    entry: { content: string; sender: "user" | "agent"; timestamp: number },
  ): void {
    let history = this.sessionHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionHistory.set(sessionId, history);
    }
    history.push(entry);
  }

  private listOwnedSessionIds(clientId: string): string[] {
    const owned: string[] = [];
    const ownerKey = this.currentOwnerKey(clientId);
    for (const [sessionId, ownerId] of this.sessionOwners) {
      if (ownerId === ownerKey) {
        owned.push(sessionId);
      }
    }
    return owned;
  }

  private currentOwnerKey(clientId: string): string {
    return this.clientOwnerKeys.get(clientId) ?? `volatile:${clientId}`;
  }

  private currentActorId(clientId: string): string {
    return this.currentOwnerKey(clientId);
  }

  private isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof (value as Promise<T> | undefined)?.then === "function";
  }

  private withResolvedOwner(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    send: SendFn,
    onResolved: (ownerKey: string) => void,
    onRejected: (error: Error) => void,
  ): void {
    try {
      const ownerKey = this.resolveDurableOwner(clientId, payload, send);
      if (this.isPromiseLike(ownerKey)) {
        void ownerKey.then(onResolved).catch((error) => {
          onRejected(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
        return;
      }
      onResolved(ownerKey);
    } catch (error) {
      onRejected(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private issueDurableOwner(clientId: string, send: SendFn): string {
    if (!this.sessionStore) {
      return this.currentOwnerKey(clientId);
    }

    const issued = this.sessionStore.createOwnerCredential();
    this.clientOwnerKeys.set(clientId, issued.credential.ownerKey);
    send({
      type: "chat.owner",
      payload: {
        ownerToken: issued.ownerToken,
      },
    });
    this.persistOwnerCredential(clientId, issued.credential);
    return issued.credential.ownerKey;
  }

  private persistOwnerCredential(
    clientId: string,
    credential: PersistedWebChatOwnerCredential,
  ): void {
    void this.sessionStore?.persistOwnerCredential(credential).catch((error) => {
      this.context.logger.debug("Failed to persist webchat owner credential", {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private resolveDurableOwner(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    send: SendFn,
  ): string | Promise<string> {
    const ownerToken =
      typeof payload?.ownerToken === "string" ? payload.ownerToken.trim() : "";
    const existingOwnerKey = this.clientOwnerKeys.get(clientId);

    if (!this.sessionStore) {
      return existingOwnerKey ?? this.currentOwnerKey(clientId);
    }

    if (ownerToken.length > 0) {
      return this.sessionStore.resolveOwnerCredential(ownerToken).then((credential) => {
        if (credential) {
          this.clientOwnerKeys.set(clientId, credential.ownerKey);
          return credential.ownerKey;
        }
        return existingOwnerKey ?? this.issueDurableOwner(clientId, send);
      });
    }

    if (existingOwnerKey) {
      return existingOwnerKey;
    }

    return this.issueDurableOwner(clientId, send);
  }

  private isDurableOwnerKey(ownerKey: string): boolean {
    return !ownerKey.startsWith("volatile:");
  }

  private async persistSessionActivity(
    sessionId: string,
    entry: {
      content: string;
      sender: "user" | "agent";
      timestamp: number;
      policyContext?: PersistedWebChatPolicyContext;
    },
  ): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const ownerKey =
      this.sessionOwners.get(sessionId) ??
      (await this.sessionStore.loadSession(sessionId))?.ownerKey;
    if (!ownerKey || !this.isDurableOwnerKey(ownerKey)) {
      return;
    }
    this.sessionOwners.set(sessionId, ownerKey);
    try {
      await this.sessionStore.recordActivity({
        sessionId,
        ownerKey,
        sender: entry.sender,
        content: entry.content,
        timestamp: entry.timestamp,
        ...(entry.policyContext
          ? { metadata: { policyContext: entry.policyContext } }
          : {}),
      });
    } catch (error) {
      this.context.logger.debug("Failed to persist webchat session activity", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async isAuthorizedSession(
    sessionId: string,
    ownerKey: string,
    clientId: string,
  ): Promise<boolean> {
    const cachedOwner = this.sessionOwners.get(sessionId);
    if (cachedOwner) {
      return cachedOwner === ownerKey || cachedOwner === `volatile:${clientId}`;
    }
    const persisted = await this.sessionStore?.loadSession(sessionId);
    if (!persisted) {
      return false;
    }
    this.sessionOwners.set(sessionId, persisted.ownerKey);
    return persisted.ownerKey === ownerKey;
  }

  private async loadSessionHistory(
    sessionId: string,
    limit?: number,
  ): Promise<Array<{ content: string; sender: "user" | "agent"; timestamp: number }>> {
    if (this.deps.memoryBackend) {
      const entries = await this.deps.memoryBackend.getThread(sessionId, limit);
      const history = entries
        .filter((entry) => entry.role === "user" || entry.role === "assistant")
        .map((entry): { content: string; sender: "user" | "agent"; timestamp: number } => ({
          content: entry.content,
          sender: entry.role === "assistant" ? "agent" : "user",
          timestamp: entry.timestamp,
        }));
      if (history.length > 0) {
        this.sessionHistory.set(sessionId, history);
      }
      return history;
    }
    const history = this.sessionHistory.get(sessionId) ?? [];
    return typeof limit === "number" && limit > 0 ? history.slice(-limit) : history;
  }

  private parsePolicyContext(
    payload: Record<string, unknown> | undefined,
  ): PersistedWebChatPolicyContext | undefined {
    if (
      !payload ||
      typeof payload.policyContext !== "object" ||
      payload.policyContext === null
    ) {
      return undefined;
    }
    const raw = payload.policyContext as Record<string, unknown>;
    const tenantId =
      typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
        ? raw.tenantId.trim()
        : undefined;
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim().length > 0
        ? raw.projectId.trim()
        : undefined;
    if (!tenantId && !projectId) {
      return undefined;
    }
    return {
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
    };
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
    this.clientOwnerKeys.delete(clientId);
    this.clientSenders.delete(clientId);
  }
}
