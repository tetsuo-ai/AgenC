/**
 * Unit tests for WebChatChannel plugin.
 *
 * Tests session mapping, message normalization, send routing,
 * handler dispatch, error handling, and chat history/resume.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebChatChannel } from "./plugin.js";
import type { WebChatDeps } from "./types.js";
import type { ChannelContext } from "../../gateway/channel.js";
import type { ControlMessage, ControlResponse } from "../../gateway/types.js";
import { silentLogger } from "../../utils/logger.js";
import { InMemoryBackend } from "../../memory/in-memory/backend.js";

// ============================================================================
// Test helpers
// ============================================================================

type DesktopManager = NonNullable<WebChatDeps["desktopManager"]>;

function createDeps(overrides?: Partial<WebChatDeps>): WebChatDeps {
  return {
    gateway: {
      getStatus: () => ({
        state: "running",
        uptimeMs: 60_000,
        channels: ["webchat", "telegram"],
        activeSessions: 2,
        controlPlanePort: 9100,
      }),
      config: { agent: { name: "test-agent" } },
    },
    ...overrides,
  };
}

function createContext(overrides?: Partial<ChannelContext>): ChannelContext {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    logger: silentLogger,
    config: {},
    ...overrides,
  };
}

function msg(type: string, payload?: unknown, id?: string): ControlMessage {
  return { type: type as ControlMessage["type"], payload, id };
}

function openChatSession(
  channel: WebChatChannel,
  context: ChannelContext,
  clientId: string,
  send: (response: ControlResponse) => void,
  content: string,
): string {
  channel.handleMessage(
    clientId,
    "chat.message",
    msg("chat.message", { content }),
    send,
  );
  const calls = vi.mocked(context.onMessage).mock.calls;
  return calls[calls.length - 1][0].sessionId;
}

function createDesktopManager(
  overrides: Partial<DesktopManager> = {},
): DesktopManager {
  return {
    listAll: vi.fn().mockReturnValue([]),
    getHandleBySession: vi.fn(),
    getOrCreate: vi.fn(),
    destroy: vi.fn(),
    assignSession: vi.fn(),
    ...overrides,
  } as unknown as DesktopManager;
}

async function startDesktopChannel(
  desktopManager: DesktopManager,
  onMessage?: ChannelContext["onMessage"],
): Promise<{
  deps: WebChatDeps;
  context: ChannelContext;
  channel: WebChatChannel;
}> {
  const deps = createDeps({ desktopManager });
  const context = createContext(onMessage ? { onMessage } : undefined);
  const channel = new WebChatChannel(deps);
  await channel.initialize(context);
  await channel.start();
  return { deps, context, channel };
}

// ============================================================================
// Tests
// ============================================================================

describe("WebChatChannel", () => {
  let channel: WebChatChannel;
  let deps: WebChatDeps;
  let context: ChannelContext;

  beforeEach(async () => {
    deps = createDeps();
    context = createContext();
    channel = new WebChatChannel(deps);
    await channel.initialize(context);
    await channel.start();
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe("lifecycle", () => {
    it('should report name as "webchat"', () => {
      expect(channel.name).toBe("webchat");
    });

    it("should be healthy after start", () => {
      expect(channel.isHealthy()).toBe(true);
    });

    it("should not be healthy after stop", async () => {
      await channel.stop();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Chat message handling
  // --------------------------------------------------------------------------

  describe("chat.message", () => {
    it("should deliver chat message to gateway pipeline", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello agent!" }),
        send,
      );

      expect(context.onMessage).toHaveBeenCalledTimes(1);
      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      expect(gatewayMsg.channel).toBe("webchat");
      expect(gatewayMsg.content).toBe("Hello agent!");
      expect(gatewayMsg.senderId).toBe("client_1");
      expect(gatewayMsg.scope).toBe("dm");
    });

    it("should reject empty content", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "" }),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
      expect(context.onMessage).not.toHaveBeenCalled();
    });

    it("should reject missing content", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("should create consistent session for same client", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "msg1" }),
        send,
      );
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "msg2" }),
        send,
      );

      const calls = vi.mocked(context.onMessage).mock.calls;
      expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId);
    });

    it("should create different sessions for different clients", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "msg1" }),
        send,
      );
      channel.handleMessage(
        "client_2",
        "chat.message",
        msg("chat.message", { content: "msg2" }),
        send,
      );

      const calls = vi.mocked(context.onMessage).mock.calls;
      expect(calls[0][0].sessionId).not.toBe(calls[1][0].sessionId);
    });

    it("should dedupe replayed chat.message by request id", () => {
      const send = vi.fn<(response: ControlResponse) => void>();
      const messageId = "chat_msg_fixed";

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "open terminal" }, messageId),
        send,
      );
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "open terminal" }, messageId),
        send,
      );

      expect(context.onMessage).toHaveBeenCalledTimes(1);
    });

    it("should not reuse the same first session ID after channel restart", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "msg1" }),
        send,
      );
      const firstSessionId = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;

      // Simulate daemon/plugin restart and a new connection that gets the same
      // clientId counter value.
      const context2 = createContext();
      const channel2 = new WebChatChannel(deps);
      await channel2.initialize(context2);
      await channel2.start();

      channel2.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "msg2" }),
        send,
      );
      const secondSessionId = vi.mocked(context2.onMessage).mock.calls[0][0].sessionId;

      expect(secondSessionId).not.toBe(firstSessionId);
    });
  });

  describe("chat.new", () => {
    it("should create a fresh session for the same client", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "old-session-msg" }),
        send,
      );
      const firstSessionId = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;

      channel.handleMessage("client_1", "chat.new", msg("chat.new", {}, "new-1"), send);

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "new-session-msg" }),
        send,
      );
      const secondSessionId = vi.mocked(context.onMessage).mock.calls[1][0].sessionId;

      expect(secondSessionId).not.toBe(firstSessionId);

      const newSessionCall = send.mock.calls.find(
        (call) =>
          (call[0] as ControlResponse).type === "chat.session" &&
          (call[0] as ControlResponse).id === "new-1",
      );
      expect(newSessionCall).toBeDefined();
    });

    it("should reset backend context for the previous session", async () => {
      const resetSessionContext = vi.fn().mockResolvedValue(undefined);
      const context2 = createContext();
      const channel2 = new WebChatChannel(createDeps({ resetSessionContext }));
      const send = vi.fn<(response: ControlResponse) => void>();

      await channel2.initialize(context2);
      await channel2.start();

      channel2.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "old-session-msg" }),
        send,
      );
      const firstSessionId = vi.mocked(context2.onMessage).mock.calls[0][0].sessionId;

      channel2.handleMessage("client_1", "chat.new", msg("chat.new", {}, "new-2"), send);

      expect(resetSessionContext).toHaveBeenCalledWith(firstSessionId);
    });
  });

  describe("chat.cancel", () => {
    it("should report cancelled=true when an in-flight execution is aborted", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello agent!" }),
        send,
      );
      const sessionId = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;
      channel.createAbortController(sessionId);

      channel.handleMessage(
        "client_1",
        "chat.cancel",
        msg("chat.cancel", undefined, "cancel-1"),
        send,
      );
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith({
        type: "chat.cancelled",
        payload: { cancelled: true },
        id: "cancel-1",
      });
    });

    it("should report cancelled=false when there is nothing active to abort", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello agent!" }),
        send,
      );

      channel.handleMessage(
        "client_1",
        "chat.cancel",
        msg("chat.cancel", undefined, "cancel-2"),
        send,
      );
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith({
        type: "chat.cancelled",
        payload: { cancelled: false },
        id: "cancel-2",
      });
    });

    it("reports cancelled=true when a background run is cancelled", async () => {
      deps = createDeps({
        cancelBackgroundRun: vi.fn().mockResolvedValue(true),
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "keep monitoring this until I say stop" }),
        send,
      );

      channel.handleMessage(
        "client_1",
        "chat.cancel",
        msg("chat.cancel", undefined, "cancel-bg"),
        send,
      );
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith({
        type: "chat.cancelled",
        payload: { cancelled: true },
        id: "cancel-bg",
      });
    });
  });

  // --------------------------------------------------------------------------
  // Outbound (send)
  // --------------------------------------------------------------------------

  describe("send()", () => {
    it("should route outbound message to the correct client", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // First send an inbound message to establish the session mapping
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Now send outbound
      await channel.send({ sessionId, content: "Hi back!" });

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat.message",
          payload: expect.objectContaining({
            content: "Hi back!",
            sender: "agent",
          }),
        }),
      );
    });

    it("should not throw for unmapped session", async () => {
      // No prior messages — no session mapping
      await expect(
        channel.send({ sessionId: "nonexistent", content: "test" }),
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Chat history
  // --------------------------------------------------------------------------

  describe("chat.history", () => {
    it("should return empty history for new client", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.history",
        msg("chat.history", {}, "req-1"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat.history",
          payload: [],
          id: "req-1",
        }),
      );
    });

    it("should return chat history after messages", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // Send a message to establish session and history
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send,
      );

      // Now request history
      channel.handleMessage(
        "client_1",
        "chat.history",
        msg("chat.history", { limit: 10 }, "req-2"),
        send,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Find the history response
      const historyCall = send.mock.calls.find(
        (call) => (call[0] as ControlResponse).type === "chat.history",
      );
      expect(historyCall).toBeDefined();
      const response = historyCall![0] as ControlResponse;
      expect((response.payload as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // Chat resume
  // --------------------------------------------------------------------------

  describe("chat.resume", () => {
    it("should reject missing sessionId", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.resume",
        msg("chat.resume", {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("should reject unknown session", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.resume",
        msg("chat.resume", { sessionId: "nonexistent" }),
        send,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("should resume an existing session by same client", async () => {
      const send1 = vi.fn<(response: ControlResponse) => void>();

      // Client 1 creates a session with a message
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send1,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Same client resumes the session
      const send2 = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.resume",
        msg("chat.resume", { sessionId }, "req-3"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const resumeCall = send2.mock.calls.find(
        (call) =>
          (call[0] as ControlResponse).type === ("chat.resumed" as string),
      );
      expect(resumeCall).toBeDefined();
      const response = resumeCall![0] as ControlResponse;
      expect((response.payload as Record<string, unknown>).sessionId).toBe(
        sessionId,
      );
    });

    it("should reject resume from different client (session hijacking prevention)", async () => {
      const send1 = vi.fn<(response: ControlResponse) => void>();

      // Client 1 creates a session
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send1,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Client 2 tries to resume — should be rejected
      const send2 = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_2",
        "chat.resume",
        msg("chat.resume", { sessionId }, "req-3"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const errorCall = send2.mock.calls.find(
        (call) => (call[0] as ControlResponse).error !== undefined,
      );
      expect(errorCall).toBeDefined();
      expect((errorCall![0] as ControlResponse).error).toContain("Session");
    });

    it("lists and resumes durable sessions across plugin restart with a stable client key", async () => {
      const memoryBackend = new InMemoryBackend();
      const send1 = vi.fn<(response: ControlResponse) => void>();
      deps = createDeps({ memoryBackend });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello", clientKey: "browser-1" }),
        send1,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;
      await memoryBackend.addEntry({
        sessionId,
        role: "user",
        content: "Hello",
      });
      await memoryBackend.addEntry({
        sessionId,
        role: "assistant",
        content: "I am still working.",
      });

      await channel.stop();

      const hydrateSessionContext = vi.fn().mockResolvedValue(undefined);
      const send2 = vi.fn<(response: ControlResponse) => void>();
      const channel2 = new WebChatChannel(
        createDeps({ memoryBackend, hydrateSessionContext }),
      );
      const context2 = createContext();
      await channel2.initialize(context2);
      await channel2.start();

      channel2.handleMessage(
        "client_2",
        "chat.sessions",
        msg("chat.sessions", { clientKey: "browser-1" }, "req-sessions"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const sessionsCall = send2.mock.calls.find(
        (call) => (call[0] as ControlResponse).type === "chat.sessions",
      );
      expect(sessionsCall).toBeDefined();
      expect((sessionsCall![0] as ControlResponse).payload).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, messageCount: 1 }),
        ]),
      );

      channel2.handleMessage(
        "client_2",
        "chat.resume",
        msg(
          "chat.resume",
          { sessionId, clientKey: "browser-1" },
          "req-resume",
        ),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(hydrateSessionContext).toHaveBeenCalledWith(sessionId);
      const resumedCall = send2.mock.calls.find(
        (call) => (call[0] as ControlResponse).type === "chat.resumed",
      );
      expect(resumedCall).toBeDefined();

      channel2.handleMessage(
        "client_2",
        "chat.history",
        msg("chat.history", { clientKey: "browser-1" }, "req-history"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const historyCall = send2.mock.calls.find(
        (call) =>
          (call[0] as ControlResponse).type === "chat.history" &&
          (call[0] as ControlResponse).id === "req-history",
      );
      expect(historyCall).toBeDefined();
      expect((historyCall![0] as ControlResponse).payload).toEqual([
        expect.objectContaining({ content: "Hello", sender: "user" }),
        expect.objectContaining({
          content: "I am still working.",
          sender: "agent",
        }),
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Status handler
  // --------------------------------------------------------------------------

  describe("status.get", () => {
    it("should return gateway status", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "status.get",
        msg("status.get", undefined, "req-4"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status.update",
          id: "req-4",
          payload: expect.objectContaining({
            state: "running",
            agentName: "test-agent",
          }),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Subsystem handlers
  // --------------------------------------------------------------------------

  describe("subsystem handlers", () => {
    it("should handle skills.list", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "skills.list",
        msg("skills.list", undefined, "req-5"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "skills.list", payload: [] }),
      );
    });

    it("should handle tasks.list with informative error (no Solana connection)", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "tasks.list",
        msg("tasks.list", undefined, "req-6"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          error: expect.stringContaining("Solana connection"),
        }),
      );
    });

    it("should handle memory.sessions with error when no backend", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "memory.sessions",
        msg("memory.sessions", undefined, "req-7"),
        send,
      );

      // No memoryBackend in deps → error
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          error: "Memory backend not configured",
        }),
      );
    });

    it("should handle memory.search with missing query", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "memory.search",
        msg("memory.search", {}),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("memory handlers only return sessions owned by the requesting client", async () => {
      const threads = new Map<string, Array<{ content: string; timestamp: number; role: string }>>();
      const memoryBackend = {
        getThread: vi.fn(async (sessionId: string) => threads.get(sessionId) ?? []),
      } as unknown as NonNullable<WebChatDeps["memoryBackend"]>;
      deps = createDeps({ memoryBackend });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage("client_1", "chat.message", msg("chat.message", { content: "hello one" }), send1);
      channel.handleMessage("client_2", "chat.message", msg("chat.message", { content: "hello two" }), send2);
      const sessionId1 = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;
      const sessionId2 = vi.mocked(context.onMessage).mock.calls[1][0].sessionId;

      threads.set(sessionId1, [{ content: "alpha note", timestamp: 100, role: "user" }]);
      threads.set(sessionId2, [{ content: "beta note", timestamp: 200, role: "user" }]);

      channel.handleMessage(
        "client_1",
        "memory.search",
        msg("memory.search", { query: "beta" }, "req-memory-search"),
        send1,
      );
      await vi.waitFor(() =>
        expect(send1).toHaveBeenCalledWith(
          expect.objectContaining({ type: "memory.results", payload: [] }),
        ),
      );

      channel.handleMessage(
        "client_1",
        "memory.sessions",
        msg("memory.sessions", {}, "req-memory-sessions"),
        send1,
      );
      await vi.waitFor(() =>
        expect(send1).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "memory.sessions",
            payload: [expect.objectContaining({ id: sessionId1 })],
          }),
        ),
      );
    });

    it("should handle events.subscribe", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "events.subscribe",
        msg("events.subscribe", { filters: ["tasks.", "desktop.*"] }),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "events.subscribed",
          payload: {
            active: true,
            filters: ["tasks.", "desktop.*"],
          },
        }),
      );
    });
  });

  describe("event subscriptions", () => {
    it("broadcasts only to clients whose filters match the event", () => {
      const sendTasks = vi.fn<(response: ControlResponse) => void>();
      const sendDesktop = vi.fn<(response: ControlResponse) => void>();
      const sendAll = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_tasks",
        "events.subscribe",
        msg("events.subscribe", { filters: ["tasks"] }),
        sendTasks,
      );
      channel.handleMessage(
        "client_desktop",
        "events.subscribe",
        msg("events.subscribe", { filters: ["desktop.*"] }),
        sendDesktop,
      );
      channel.handleMessage(
        "client_all",
        "events.subscribe",
        msg("events.subscribe"),
        sendAll,
      );

      sendTasks.mockClear();
      sendDesktop.mockClear();
      sendAll.mockClear();

      channel.broadcastEvent("tasks.created", { id: "task-1" });

      expect(sendTasks).toHaveBeenCalledWith(
        expect.objectContaining({ type: "events.event" }),
      );
      expect(sendDesktop).not.toHaveBeenCalled();
      expect(sendAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: "events.event" }),
      );
    });

    it("stops delivering events after events.unsubscribe", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "events.subscribe",
        msg("events.subscribe"),
        send,
      );

      send.mockClear();
      channel.handleMessage(
        "client_1",
        "events.unsubscribe",
        msg("events.unsubscribe"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "events.unsubscribed",
          payload: {
            active: false,
            filters: [],
          },
        }),
      );

      send.mockClear();
      channel.broadcastEvent("tasks.updated", { id: "task-1" });
      expect(send).not.toHaveBeenCalled();
    });

    it("surfaces trace correlation fields separately from event data", () => {
      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_trace",
        "events.subscribe",
        msg("events.subscribe", { filters: ["subagents.*"] }),
        send,
      );
      send.mockClear();

      channel.broadcastEvent("subagents.progress", {
        sessionId: "session-parent",
        subagentSessionId: "subagent:abc",
        traceId: "trace-child-1",
        parentTraceId: "trace-parent-1",
        phase: "retry_backoff",
      });

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "events.event",
          payload: expect.objectContaining({
            eventType: "subagents.progress",
            traceId: "trace-child-1",
            parentTraceId: "trace-parent-1",
            data: expect.objectContaining({
              sessionId: "session-parent",
              subagentSessionId: "subagent:abc",
              phase: "retry_backoff",
            }),
          }),
        }),
      );
      const payload = (send.mock.calls[0]?.[0] as ControlResponse)?.payload as
        | Record<string, unknown>
        | undefined;
      const data = payload?.data as Record<string, unknown> | undefined;
      expect(data?.traceId).toBeUndefined();
      expect(data?.parentTraceId).toBeUndefined();
    });
  });

  describe("desktop handlers", () => {
    it("desktop.create binds to the client's active session when sessionId is omitted", async () => {
      const getOrCreate = vi.fn().mockResolvedValue({
        containerId: "ctr123",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6080,
        apiHostPort: 9990,
        createdAt: Date.now(),
        maxMemory: "4g",
        maxCpu: "2.0",
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession: vi.fn(),
          getOrCreate,
          destroy: vi.fn(),
          assignSession: vi.fn(),
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "desktop.create",
        msg("desktop.create", {}, "desktop-create-1"),
        send,
      );

      await vi.waitFor(() => expect(getOrCreate).toHaveBeenCalledTimes(1));
      const boundSessionId = getOrCreate.mock.calls[0][0] as string;
      expect(boundSessionId.startsWith("session:")).toBe(true);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat.session",
          payload: expect.objectContaining({ sessionId: boundSessionId }),
        }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "desktop.created" }),
      );
    });

    it("desktop.create forwards maxMemory/maxCpu overrides", async () => {
      const getOrCreate = vi.fn().mockResolvedValue({
        containerId: "ctr-resource",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6085,
        apiHostPort: 9995,
        createdAt: Date.now(),
        maxMemory: "8g",
        maxCpu: "4.0",
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession: vi.fn(),
          getOrCreate,
          destroy: vi.fn(),
          assignSession: vi.fn(),
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "desktop.create",
        msg(
          "desktop.create",
          { maxMemory: "8g", maxCpu: "4.0" },
          "desktop-create-resource-1",
        ),
        send,
      );

      await vi.waitFor(() => expect(getOrCreate).toHaveBeenCalledTimes(1));
      const sessionId = getOrCreate.mock.calls[0][0] as string;
      expect(getOrCreate).toHaveBeenCalledWith(sessionId, {
        maxMemory: "8g",
        maxCpu: "4.0",
      });
    });

    it("desktop.create accepts an owned explicit sessionId", async () => {
      const getOrCreate = vi.fn().mockResolvedValue({
        containerId: "ctr-explicit",
        sessionId: "session:client1",
        status: "ready",
        vncHostPort: 6087,
        apiHostPort: 9997,
        createdAt: Date.now(),
        maxMemory: "4g",
        maxCpu: "2.0",
      });
      ({ deps, context, channel } = await startDesktopChannel(
        createDesktopManager({ getOrCreate }),
        vi.fn().mockResolvedValueOnce({ sessionId: "session:client1" }),
      ));

      const send = vi.fn<(response: ControlResponse) => void>();
      const sessionId = openChatSession(channel, context, "client_1", send, "hello");

      channel.handleMessage(
        "client_1",
        "desktop.create",
        msg("desktop.create", { sessionId }, "desktop-create-explicit-1"),
        send,
      );

      await vi.waitFor(() => expect(getOrCreate).toHaveBeenCalledTimes(1));
      expect(getOrCreate).toHaveBeenCalledWith(sessionId, {
        maxMemory: undefined,
        maxCpu: undefined,
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "desktop.created" }),
      );
    });

    it("desktop.create normalizes bare integer maxMemory to gigabytes", async () => {
      const getOrCreate = vi.fn().mockResolvedValue({
        containerId: "ctr-resource-int",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6086,
        apiHostPort: 9996,
        createdAt: Date.now(),
        maxMemory: "16g",
        maxCpu: "4",
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession: vi.fn(),
          getOrCreate,
          destroy: vi.fn(),
          assignSession: vi.fn(),
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "desktop.create",
        msg(
          "desktop.create",
          { maxMemory: "16", maxCpu: "4" },
          "desktop-create-resource-int-1",
        ),
        send,
      );

      await vi.waitFor(() => expect(getOrCreate).toHaveBeenCalledTimes(1));
      const sessionId = getOrCreate.mock.calls[0][0] as string;
      expect(getOrCreate).toHaveBeenCalledWith(sessionId, {
        maxMemory: "16g",
        maxCpu: "4",
      });
    });

    it("desktop.create rejects foreign sessionId values", async () => {
      const getOrCreate = vi.fn();
      ({ deps, context, channel } = await startDesktopChannel(
        createDesktopManager({ getOrCreate }),
        vi
          .fn()
          .mockResolvedValueOnce({ sessionId: "session:client1" })
          .mockResolvedValueOnce({ sessionId: "session:client2" }),
      ));

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      const foreignSessionId = openChatSession(
        channel,
        context,
        "client_1",
        send1,
        "hello 1",
      );
      openChatSession(channel, context, "client_2", send2, "hello 2");

      channel.handleMessage(
        "client_2",
        "desktop.create",
        msg("desktop.create", { sessionId: foreignSessionId }, "desktop-create-foreign-1"),
        send2,
      );

      expect(send2).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "desktop.error",
          error: "Not authorized for target session",
        }),
      );
      expect(getOrCreate).not.toHaveBeenCalled();
    });

    it("desktop.attach binds container to the client's active session", async () => {
      const assignSession = vi.fn().mockReturnValue({
        containerId: "ctr777",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6081,
      });
      const getHandleBySession = vi.fn().mockReturnValue({
        containerId: "ctr777",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6081,
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession,
          getOrCreate: vi.fn(),
          destroy: vi.fn(),
          assignSession,
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "hello" }),
        send,
      );
      const sessionId = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;

      channel.handleMessage(
        "client_1",
        "desktop.attach",
        msg("desktop.attach", { containerId: "ctr777" }, "desktop-attach-1"),
        send,
      );

      await vi.waitFor(() =>
        expect(assignSession).toHaveBeenCalledWith("ctr777", sessionId),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "desktop.attached" }),
      );
    });

    it("desktop.attach rejects containers not owned by the client", async () => {
      const assignSession = vi.fn();
      const sessionToContainer = new Map<string, string>();
      const getHandleBySession = vi.fn((sessionId: string) => {
        const containerId = sessionToContainer.get(sessionId);
        if (!containerId) return undefined;
        return { containerId, sessionId, status: "ready", vncHostPort: 6080 };
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession,
          getOrCreate: vi.fn(),
          destroy: vi.fn(),
          assignSession,
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext({
        onMessage: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: "session:client1" })
          .mockResolvedValueOnce({ sessionId: "session:client2" }),
      });
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage("client_1", "chat.message", msg("chat.message", { content: "hello 1" }), send1);
      channel.handleMessage("client_2", "chat.message", msg("chat.message", { content: "hello 2" }), send2);
      const sessionId1 = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;
      const sessionId2 = vi.mocked(context.onMessage).mock.calls[1][0].sessionId;
      sessionToContainer.set(sessionId1, "ctr-owned");
      sessionToContainer.set(sessionId2, "ctr-other");

      channel.handleMessage(
        "client_2",
        "desktop.attach",
        msg("desktop.attach", { containerId: "ctr-owned", sessionId: sessionId2 }, "desktop-attach-2"),
        send2,
      );

      expect(send2).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "desktop.error",
          error: "Not authorized for target container",
        }),
      );
      expect(assignSession).not.toHaveBeenCalled();
    });

    it("desktop.destroy rejects containers not owned by the client", async () => {
      const destroy = vi.fn();
      const sessionToContainer = new Map<string, string>();
      const getHandleBySession = vi.fn((sessionId: string) => {
        const containerId = sessionToContainer.get(sessionId);
        if (!containerId) return undefined;
        return { containerId, sessionId, status: "ready", vncHostPort: 6080 };
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
          getHandleBySession,
          getOrCreate: vi.fn(),
          destroy,
          assignSession: vi.fn(),
        } as unknown as NonNullable<WebChatDeps["desktopManager"]>,
      });
      context = createContext({
        onMessage: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: "session:client1" })
          .mockResolvedValueOnce({ sessionId: "session:client2" }),
      });
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage("client_1", "chat.message", msg("chat.message", { content: "hello 1" }), send1);
      channel.handleMessage("client_2", "chat.message", msg("chat.message", { content: "hello 2" }), send2);
      const sessionId1 = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;
      const sessionId2 = vi.mocked(context.onMessage).mock.calls[1][0].sessionId;
      sessionToContainer.set(sessionId1, "ctr-owned");
      sessionToContainer.set(sessionId2, "ctr-other");

      channel.handleMessage(
        "client_2",
        "desktop.destroy",
        msg("desktop.destroy", { containerId: "ctr-owned" }, "desktop-destroy-2"),
        send2,
      );

      expect(send2).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "desktop.error",
          error: "Not authorized for target container",
        }),
      );
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("should return error for unknown dotted-namespace type", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "foo.bar",
        msg("foo.bar" as ControlMessage["type"]),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          error: expect.stringContaining("Unknown webchat message type"),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Client cleanup
  // --------------------------------------------------------------------------

  describe("removeClient", () => {
    it("should clean up client mappings", async () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      // Establish session
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      const sessionId = gatewayMsg.sessionId;

      // Remove client
      channel.removeClient("client_1");

      // Outbound should silently fail (no client mapping)
      await expect(
        channel.send({ sessionId, content: "test" }),
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Typing indicator
  // --------------------------------------------------------------------------

  describe("chat.typing", () => {
    it("should silently accept typing indicators", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.typing",
        msg("chat.typing", { active: true }),
        send,
      );

      // Should not send any response
      expect(send).not.toHaveBeenCalled();
    });
  });
});
