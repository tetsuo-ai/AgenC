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

// ============================================================================
// Test helpers
// ============================================================================

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

    it("should reject unknown session", () => {
      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.resume",
        msg("chat.resume", { sessionId: "nonexistent" }),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("should resume an existing session by same client", () => {
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

    it("should reject resume from different client (session hijacking prevention)", () => {
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

      const errorCall = send2.mock.calls.find(
        (call) => (call[0] as ControlResponse).error !== undefined,
      );
      expect(errorCall).toBeDefined();
      expect((errorCall![0] as ControlResponse).error).toContain(
        "Not authorized",
      );
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

    it("desktop.attach binds container to the client's active session", async () => {
      const assignSession = vi.fn().mockReturnValue({
        containerId: "ctr777",
        sessionId: "session:auto",
        status: "ready",
        vncHostPort: 6081,
      });
      deps = createDeps({
        desktopManager: {
          listAll: vi.fn().mockReturnValue([]),
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
