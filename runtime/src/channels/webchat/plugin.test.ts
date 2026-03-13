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
import { WebChatSessionStore } from "./session-store.js";

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
        backgroundRuns: {
          multiAgentEnabled: true,
          activeTotal: 1,
          queuedSignalsTotal: 2,
          stateCounts: {
            pending: 0,
            running: 0,
            working: 1,
            blocked: 0,
            paused: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            suspended: 0,
          },
          recentAlerts: [],
          metrics: {
            startedTotal: 1,
            completedTotal: 0,
            failedTotal: 0,
            blockedTotal: 0,
            recoveredTotal: 0,
            meanLatencyMs: 12,
            meanTimeToFirstAckMs: 2,
            meanTimeToFirstVerifiedUpdateMs: 5,
            falseCompletionRate: 0,
            blockedWithoutNoticeRate: 0,
            meanStopLatencyMs: 1,
            recoverySuccessRate: 1,
            verifierAccuracyRate: 1,
          },
        },
      }),
      config: { agent: { name: "test-agent" } },
    },
    getDaemonStatus: () => ({
      pid: 4242,
      uptimeMs: 60_000,
      memoryUsage: {
        heapUsedMB: 12.5,
        rssMB: 48.75,
      },
    }),
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

function findResponse(
  send: ReturnType<typeof vi.fn<(response: ControlResponse) => void>>,
  type: string,
  id?: string,
): ControlResponse | undefined {
  const match = send.mock.calls.find((call) => {
    const response = call[0] as ControlResponse;
    return response.type === type && (id === undefined || response.id === id);
  });
  return match?.[0] as ControlResponse | undefined;
}

function requireOwnerToken(
  send: ReturnType<typeof vi.fn<(response: ControlResponse) => void>>,
): string {
  const response = findResponse(send, "chat.owner");
  expect(response).toBeDefined();
  const payload = response?.payload as Record<string, unknown> | undefined;
  expect(payload?.ownerToken).toEqual(expect.any(String));
  return payload?.ownerToken as string;
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

function makeRunSummary(sessionId = "session-owned") {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    objective: "Watch a managed process until it exits.",
    state: "working",
    currentPhase: "active",
    explanation: "Run is active and waiting for the next verification cycle.",
    unsafeToContinue: false,
    createdAt: 1,
    updatedAt: 2,
    lastVerifiedAt: 2,
    nextCheckAt: 4_000,
    nextHeartbeatAt: 12_000,
    cycleCount: 1,
    contractKind: "finite",
    contractDomain: "generic",
    requiresUserStop: false,
    pendingSignals: 0,
    watchCount: 1,
    fenceToken: 1,
    lastUserUpdate: "Watching the process.",
    lastToolEvidence: "system.processStatus -> running",
    lastWakeReason: "tool_result",
    carryForwardSummary: "Continue observing the process.",
    blockerSummary: undefined,
    approvalRequired: false,
    approvalState: "none",
    checkpointAvailable: true,
    preferredWorkerId: "worker-a",
    workerAffinityKey: sessionId,
  };
}

function makeRunDetail(sessionId = "session-owned") {
  return {
    ...makeRunSummary(sessionId),
    policyScope: {
      tenantId: "tenant-a",
      projectId: "project-x",
      runId: `run-${sessionId}`,
    },
    contract: {
      domain: "generic",
      kind: "finite",
      successCriteria: ["Observe process completion."],
      completionCriteria: ["Verify terminal evidence."],
      blockedCriteria: ["Missing process evidence."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: "none" },
    },
    blocker: undefined,
    approval: { status: "none", summary: undefined },
    budget: {
      runtimeStartedAt: 1,
      lastActivityAt: 2,
      lastProgressAt: 2,
      totalTokens: 4,
      lastCycleTokens: 2,
      managedProcessCount: 1,
      maxRuntimeMs: 60_000,
      maxCycles: 32,
      maxIdleMs: 10_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: 1,
      firstVerifiedUpdateAt: 2,
      stopRequestedAt: undefined,
    },
    compaction: {
      lastCompactedAt: undefined,
      lastCompactedCycle: 0,
      refreshCount: 0,
      lastHistoryLength: 4,
      lastMilestoneAt: undefined,
      lastCompactionReason: undefined,
      repairCount: 0,
      lastProviderAnchorAt: undefined,
    },
    artifacts: [],
    observedTargets: [],
    watchRegistrations: [],
    recentEvents: [],
  };
}

function makeTraceSummary(sessionId = 'session-owned') {
  return {
    traceId: `trace-${sessionId}`,
    sessionId,
    startedAt: 1,
    updatedAt: 2,
    eventCount: 3,
    errorCount: 0,
    status: 'completed' as const,
    lastEventName: 'webchat.chat.response',
    stopReason: 'completed',
  };
}

function makeTraceDetail(sessionId = 'session-owned') {
  const summary = makeTraceSummary(sessionId);
  return {
    summary,
    completeness: {
      complete: true,
      issues: [],
    },
    events: [
      {
        id: `${summary.traceId}:event-1`,
        eventName: 'webchat.provider.request',
        level: 'info' as const,
        traceId: summary.traceId,
        sessionId,
        timestampMs: 1,
        routingMiss: false,
        payloadPreview: { toolChoice: 'required' },
      },
      {
        id: `${summary.traceId}:event-2`,
        eventName: 'webchat.provider.response',
        level: 'info' as const,
        traceId: summary.traceId,
        sessionId,
        timestampMs: 2,
        routingMiss: false,
        payloadPreview: { finishReason: 'tool_calls' },
        artifact: {
          path: `/home/tetsuo/.agenc/trace-payloads/${summary.traceId}/artifact.json`,
          sha256: 'abc123',
          bytes: 42,
        },
      },
    ],
  };
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

  describe("social.message bridge", () => {
    it("pushes peer messages to active sessions without polluting chat history", async () => {
      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "hello one" }),
        send1,
      );
      channel.handleMessage(
        "client_2",
        "chat.message",
        msg("chat.message", { content: "hello two" }),
        send2,
      );

      vi.mocked(context.onMessage).mockClear();

      const delivered = channel.pushSocialMessageToActiveSessions({
        messageId: "social-1",
        sender: "sender-agent",
        recipient: "recipient-agent",
        content: "peer hello",
        mode: "off-chain",
        timestamp: 123,
        onChain: false,
        threadId: "thread-social-1",
      });

      expect(delivered).toBe(2);
      expect(context.onMessage).not.toHaveBeenCalled();
      expect(send1).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "social.message",
          payload: expect.objectContaining({
            messageId: "social-1",
            sender: "sender-agent",
            recipient: "recipient-agent",
            content: "peer hello",
            mode: "off-chain",
            onChain: false,
            threadId: "thread-social-1",
          }),
        }),
      );
      expect(send2).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "social.message",
          payload: expect.objectContaining({
            messageId: "social-1",
            sender: "sender-agent",
            recipient: "recipient-agent",
            content: "peer hello",
            mode: "off-chain",
            onChain: false,
            threadId: "thread-social-1",
          }),
        }),
      );

      const historySend = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.history",
        msg("chat.history", { limit: 10 }, "req-history"),
        historySend,
      );

      await vi.waitFor(() =>
        expect(findResponse(historySend, "chat.history", "req-history")).toEqual(
          expect.objectContaining({
            payload: [
              expect.objectContaining({
                content: "hello one",
                sender: "user",
              }),
            ],
          }),
        ),
      );
    });

    it("logs outbound social.message frames", async () => {
      const logger = {
        ...silentLogger,
        info: vi.fn(),
      };
      context = createContext({ logger });
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "hello one" }),
        send,
      );

      channel.pushSocialMessageToActiveSessions({
        messageId: "social-1",
        sender: "sender-agent",
        recipient: "recipient-agent",
        content: "peer hello",
        mode: "off-chain",
        timestamp: 123,
        onChain: false,
        threadId: "thread-social-1",
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[trace] webchat.ws.outbound "),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("\"type\":\"social.message\""),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("\"threadId\":\"thread-social-1\""),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Chat message handling
  // --------------------------------------------------------------------------

  describe("chat.message", () => {
    it("should deliver chat message to gateway pipeline", () => {
      const send = vi.fn<(response: ControlResponse) => void>();
      const requestId = "req-chat-1";

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello agent!" }, requestId),
        send,
      );

      expect(context.onMessage).toHaveBeenCalledTimes(1);
      expect(findResponse(send, "chat.session", requestId)).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            sessionId: expect.any(String),
          }),
        }),
      );
      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      expect(gatewayMsg.channel).toBe("webchat");
      expect(gatewayMsg.content).toBe("Hello agent!");
      expect(gatewayMsg.senderId).toBe("client_1");
      expect(gatewayMsg.scope).toBe("dm");
    });

    it("should forward and persist policy context for the session", async () => {
      const memoryBackend = new InMemoryBackend();
      deps = createDeps({ memoryBackend });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", {
          content: "hello tenant",
          clientKey: "browser-tenant",
          policyContext: {
            tenantId: "tenant-a",
            projectId: "project-x",
          },
        }),
        send,
      );

      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const ownerToken = requireOwnerToken(send);

      expect(context.onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            policyContext: {
              tenantId: "tenant-a",
              projectId: "project-x",
            },
          },
        }),
      );

      const sessionId = vi
        .mocked(context.onMessage)
        .mock.calls[0]?.[0]?.sessionId as string;
      const store = new WebChatSessionStore({ memoryBackend });
      await vi.waitFor(async () => {
        expect(await store.loadSession(sessionId)).toMatchObject({
          metadata: {
            policyContext: {
              tenantId: "tenant-a",
              projectId: "project-x",
            },
          },
        });
      });

      const resumedContext = createContext();
      const resumedChannel = new WebChatChannel(createDeps({ memoryBackend }));
      await resumedChannel.initialize(resumedContext);
      await resumedChannel.start();
      const resumedSend = vi.fn<(response: ControlResponse) => void>();

      resumedChannel.handleMessage(
        "client_2",
        "chat.resume",
        msg("chat.resume", {
          sessionId,
          ownerToken,
        }),
        resumedSend,
      );
      await vi.waitFor(() =>
        expect(resumedSend).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "chat.resumed",
            payload: expect.objectContaining({ sessionId }),
          }),
        ),
      );

      resumedChannel.handleMessage(
        "client_2",
        "chat.message",
        msg("chat.message", {
          content: "follow up",
          ownerToken,
        }),
        resumedSend,
      );

      await vi.waitFor(() =>
        expect(resumedContext.onMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: {
              policyContext: {
                tenantId: "tenant-a",
                projectId: "project-x",
              },
            },
          }),
        ),
      );
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

    it("should not dedupe the same request id across different durable owners", async () => {
      const memoryBackend = new InMemoryBackend();
      deps = createDeps({ memoryBackend });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      const messageId = "chat_msg_fixed";

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "open terminal" }, messageId),
        send1,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      channel.handleMessage(
        "client_2",
        "chat.message",
        msg("chat.message", { content: "open terminal" }, messageId),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(context.onMessage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(context.onMessage).mock.calls[0][0].sessionId).not.toBe(
        vi.mocked(context.onMessage).mock.calls[1][0].sessionId,
      );
    });

    it("should dedupe the same request id across reconnects for the same durable owner", async () => {
      const memoryBackend = new InMemoryBackend();
      deps = createDeps({ memoryBackend });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      const messageId = "chat_msg_fixed";

      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "open terminal" }, messageId),
        send1,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const ownerToken = requireOwnerToken(send1);
      const firstSessionId = vi.mocked(context.onMessage).mock.calls[0][0].sessionId;

      channel.handleMessage(
        "client_2",
        "chat.message",
        msg(
          "chat.message",
          { content: "open terminal", ownerToken },
          messageId,
        ),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(context.onMessage).toHaveBeenCalledTimes(1);
      expect(findResponse(send2, "chat.session", messageId)?.payload).toEqual({
        sessionId: firstSessionId,
      });
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

    it("logs outbound chat.message frames", async () => {
      const logger = {
        ...silentLogger,
        info: vi.fn(),
      };
      context = createContext({ logger });
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      channel.handleMessage(
        "client_1",
        "chat.message",
        msg("chat.message", { content: "Hello" }),
        send,
      );

      const gatewayMsg = vi.mocked(context.onMessage).mock.calls[0][0];
      await channel.send({ sessionId: gatewayMsg.sessionId, content: "Hi back!" });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[trace] webchat.ws.outbound "),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("\"type\":\"chat.message\""),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("\"content\":\"Hi back!\""),
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

    it("lists and resumes durable sessions across plugin restart with a server-issued owner token", async () => {
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
      const ownerToken = requireOwnerToken(send1);

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

      expect(findResponse(send2, "chat.sessions", "req-sessions")?.payload).toEqual([]);

      channel2.handleMessage(
        "client_2",
        "chat.resume",
        msg(
          "chat.resume",
          { sessionId, clientKey: "browser-1" },
          "req-resume-replay",
        ),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(findResponse(send2, "error", "req-resume-replay")?.error).toContain(
        `Session "${sessionId}" not found`,
      );

      send2.mockClear();

      channel2.handleMessage(
        "client_2",
        "chat.sessions",
        msg("chat.sessions", { ownerToken }, "req-sessions"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const sessionsCall = findResponse(send2, "chat.sessions", "req-sessions");
      expect(sessionsCall).toBeDefined();
      expect(sessionsCall?.payload).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, messageCount: 1 }),
        ]),
      );

      channel2.handleMessage(
        "client_2",
        "chat.resume",
        msg(
          "chat.resume",
          { sessionId, ownerToken },
          "req-resume",
        ),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(hydrateSessionContext).toHaveBeenCalledWith(sessionId);
      const resumedCall = findResponse(send2, "chat.resumed", "req-resume");
      expect(resumedCall).toBeDefined();

      channel2.handleMessage(
        "client_2",
        "chat.history",
        msg("chat.history", { ownerToken }, "req-history"),
        send2,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const historyCall = findResponse(send2, "chat.history", "req-history");
      expect(historyCall).toBeDefined();
      expect(historyCall?.payload).toEqual([
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
            pid: 4242,
            memoryUsage: expect.objectContaining({
              heapUsedMB: 12.5,
              rssMB: 48.75,
            }),
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

    it("should handle policy.simulate against the active owned session", async () => {
      const policyPreview = vi.fn(async () => ({
        toolName: "system.delete",
        sessionId: "session-override",
        policy: {
          allowed: false,
          mode: "normal",
          violations: [{ code: "tool_denied", message: "Tool is denied" }],
        },
        approval: {
          required: true,
          elevated: false,
          denied: false,
        },
      }));
      deps = createDeps({ policyPreview });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      const sessionId = openChatSession(channel, context, "client_1", send, "hello");

      channel.handleMessage(
        "client_1",
        "policy.simulate",
        msg(
          "policy.simulate",
          { toolName: "system.delete", args: { target: "/tmp/file" } },
          "req-policy-sim",
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "policy.simulate",
            id: "req-policy-sim",
            payload: expect.objectContaining({
              toolName: "system.delete",
              sessionId: "session-override",
            }),
          }),
        ),
      );
      expect(policyPreview).toHaveBeenCalledWith({
        sessionId,
        toolName: "system.delete",
        args: { target: "/tmp/file" },
      });
    });

    it("should handle approval.respond with a server-authenticated actor identity", async () => {
      const approvalEngine = {
        resolve: vi.fn(async () => true),
      } as unknown as NonNullable<WebChatDeps["approvalEngine"]>;
      deps = createDeps({
        approvalEngine,
        memoryBackend: new InMemoryBackend(),
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      const sessionId = openChatSession(channel, context, "client_1", send, "hello");
      await vi.waitFor(() => expect(send).toHaveBeenCalled());

      channel.handleMessage(
        "client_1",
        "approval.respond",
        msg(
          "approval.respond",
          { requestId: "req-1", approved: true },
          "req-approval-respond",
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "approval.respond",
            id: "req-approval-respond",
            payload: { requestId: "req-1", approved: true, acknowledged: true },
          }),
        ),
      );
      expect(approvalEngine.resolve).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({
          approvedBy: expect.stringMatching(/^web:/),
          resolver: expect.objectContaining({
            actorId: expect.stringMatching(/^web:/),
            sessionId,
            channel: "webchat",
          }),
        }),
      );
    });

    it("lists only runs owned by the requesting client", async () => {
      const listBackgroundRuns = vi.fn(async (sessionIds?: readonly string[]) =>
        (sessionIds ?? []).map((sessionId) => makeRunSummary(sessionId)),
      );
      deps = createDeps({ listBackgroundRuns });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send1 = vi.fn<(response: ControlResponse) => void>();
      const send2 = vi.fn<(response: ControlResponse) => void>();
      const sessionId1 = openChatSession(channel, context, "client_1", send1, "client one");
      openChatSession(channel, context, "client_2", send2, "client two");

      channel.handleMessage(
        "client_1",
        "runs.list",
        msg("runs.list", {}, "req-runs-list"),
        send1,
      );

      await vi.waitFor(() =>
        expect(send1).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "runs.list",
            id: "req-runs-list",
            payload: [expect.objectContaining({ sessionId: sessionId1 })],
          }),
        ),
      );
      expect(listBackgroundRuns).toHaveBeenCalledWith([sessionId1]);
    });

    it("inspects and controls only owned runs", async () => {
      const inspectBackgroundRun = vi.fn(async (sessionId: string) => makeRunDetail(sessionId));
      const controlBackgroundRun = vi.fn(async ({ action, actor }: any) =>
        makeRunDetail(action.sessionId ?? "session-owned"),
      );
      deps = createDeps({ inspectBackgroundRun, controlBackgroundRun });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      const ownedSessionId = openChatSession(channel, context, "client_1", send, "owned session");

      channel.handleMessage(
        "client_1",
        "run.inspect",
        msg("run.inspect", { sessionId: ownedSessionId }, "req-run-inspect"),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "run.inspect",
            id: "req-run-inspect",
            payload: expect.objectContaining({ sessionId: ownedSessionId }),
          }),
        ),
      );
      expect(inspectBackgroundRun).toHaveBeenCalledWith(ownedSessionId);

      channel.handleMessage(
        "client_1",
        "run.control",
        msg(
          "run.control",
          { action: "pause", sessionId: ownedSessionId, reason: "operator pause" },
          "req-run-control",
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "run.updated",
            id: "req-run-control",
            payload: expect.objectContaining({ sessionId: ownedSessionId }),
          }),
        ),
      );
      expect(controlBackgroundRun).toHaveBeenCalledWith({
        action: {
          action: "pause",
          sessionId: ownedSessionId,
          reason: "operator pause",
        },
        actor: "volatile:client_1",
        channel: "webchat",
      });

      channel.handleMessage(
        "client_1",
        "run.control",
        msg(
          "run.control",
          { action: "stop", sessionId: ownedSessionId, reason: "operator stop" },
          "req-run-stop",
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(controlBackgroundRun).toHaveBeenCalledWith({
          action: {
            action: "stop",
            sessionId: ownedSessionId,
            reason: "operator stop",
          },
          actor: "volatile:client_1",
          channel: "webchat",
        }),
      );

      channel.handleMessage(
        "client_1",
        "run.inspect",
        msg("run.inspect", { sessionId: "foreign-session" }, "req-run-inspect-foreign"),
        send,
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          id: "req-run-inspect-foreign",
          error: "Missing or unauthorized run sessionId",
        }),
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

  describe('observability handlers', () => {
    it('returns summary, trace list, trace detail, artifact, and logs for owned sessions', async () => {
      deps = createDeps();
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      const ownedSessionId = openChatSession(channel, context, 'client_1', send, 'owned session');
      const foreignSend = vi.fn<(response: ControlResponse) => void>();
      openChatSession(channel, context, 'client_2', foreignSend, 'foreign session');
      const traceDetail = makeTraceDetail(ownedSessionId);
      const getObservabilitySummary = vi.fn(async () => ({
        windowMs: 60_000,
        traces: {
          total: 1,
          completed: 1,
          errors: 0,
          open: 0,
          completenessRate: 1,
        },
        events: {
          providerErrors: 0,
          toolRejections: 0,
          routeMisses: 0,
          completionGateFailures: 0,
        },
        topTools: [{ name: 'mcp.doom.start_game', count: 1 }],
        topStopReasons: [{ name: 'completed', count: 1 }],
      }));
      const listObservabilityTraces = vi.fn(async () => [traceDetail.summary]);
      const getObservabilityTrace = vi.fn(async () => traceDetail);
      const getObservabilityArtifact = vi.fn(async () => ({
        path: traceDetail.events[1]!.artifact!.path,
        body: { payload: { ok: true } },
      }));
      const getObservabilityLogTail = vi.fn(async () => ({
        path: 'daemon.log',
        lines: [`${traceDetail.summary.traceId} line`],
      }));
      (channel as unknown as { deps: WebChatDeps }).deps = {
        ...deps,
        getObservabilitySummary,
        listObservabilityTraces,
        getObservabilityTrace,
        getObservabilityArtifact,
        getObservabilityLogTail,
      };

      channel.handleMessage(
        'client_1',
        'observability.summary',
        msg('observability.summary', {}, 'req-observability-summary'),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.summary',
            id: 'req-observability-summary',
          }),
        ),
      );
      expect(getObservabilitySummary).toHaveBeenCalledWith({
        windowMs: undefined,
        sessionIds: [ownedSessionId],
      });

      channel.handleMessage(
        'client_1',
        'observability.traces',
        msg('observability.traces', { limit: 50 }, 'req-observability-traces'),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.traces',
            id: 'req-observability-traces',
            payload: [expect.objectContaining({ traceId: traceDetail.summary.traceId })],
          }),
        ),
      );
      expect(listObservabilityTraces).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
          offset: undefined,
          search: undefined,
          status: undefined,
          sessionId: undefined,
          sessionIds: [ownedSessionId],
        }),
      );

      channel.handleMessage(
        'client_1',
        'observability.trace',
        msg('observability.trace', { traceId: traceDetail.summary.traceId }, 'req-observability-trace'),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.trace',
            id: 'req-observability-trace',
            payload: expect.objectContaining({
              summary: expect.objectContaining({ traceId: traceDetail.summary.traceId }),
            }),
          }),
        ),
      );

      channel.handleMessage(
        'client_1',
        'observability.artifact',
        msg(
          'observability.artifact',
          {
            traceId: traceDetail.summary.traceId,
            path: traceDetail.events[1]!.artifact!.path,
          },
          'req-observability-artifact',
        ),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.artifact',
            id: 'req-observability-artifact',
            payload: expect.objectContaining({
              path: traceDetail.events[1]!.artifact!.path,
            }),
          }),
        ),
      );

      channel.handleMessage(
        'client_1',
        'observability.logs',
        msg(
          'observability.logs',
          { traceId: traceDetail.summary.traceId, lines: 50 },
          'req-observability-logs',
        ),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.logs',
            id: 'req-observability-logs',
            payload: expect.objectContaining({
              path: 'daemon.log',
              lines: [`${traceDetail.summary.traceId} line`],
            }),
          }),
        ),
      );
    });

    it('rejects observability access for foreign sessions', async () => {
      const traceDetail = makeTraceDetail('foreign-session');
      const getObservabilityTrace = vi.fn(async () => traceDetail);

      deps = createDeps({ getObservabilityTrace });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      openChatSession(channel, context, 'client_1', send, 'owned session');

      channel.handleMessage(
        'client_1',
        'observability.trace',
        msg('observability.trace', { traceId: traceDetail.summary.traceId }, 'req-observability-foreign'),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            id: 'req-observability-foreign',
            error: 'Not authorized for target session trace data',
          }),
        ),
      );
    });

    it('returns empty observability results for clients without owned sessions', async () => {
      const getObservabilitySummary = vi.fn();
      const listObservabilityTraces = vi.fn();

      deps = createDeps({
        getObservabilitySummary,
        listObservabilityTraces,
      });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();

      channel.handleMessage(
        'client_1',
        'observability.summary',
        msg('observability.summary', {}, 'req-observability-empty-summary'),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.summary',
            id: 'req-observability-empty-summary',
            payload: expect.objectContaining({
              windowMs: 86_400_000,
              traces: expect.objectContaining({
                total: 0,
                completed: 0,
                errors: 0,
                open: 0,
                completenessRate: 1,
              }),
            }),
          }),
        ),
      );

      channel.handleMessage(
        'client_1',
        'observability.traces',
        msg('observability.traces', { limit: 50 }, 'req-observability-empty-traces'),
        send,
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'observability.traces',
            id: 'req-observability-empty-traces',
            payload: [],
          }),
        ),
      );

      expect(getObservabilitySummary).not.toHaveBeenCalled();
      expect(listObservabilityTraces).not.toHaveBeenCalled();
    });

    it('rejects foreign session filters for observability trace listings', async () => {
      const listObservabilityTraces = vi.fn(async () => []);

      deps = createDeps({ listObservabilityTraces });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      const foreignSend = vi.fn<(response: ControlResponse) => void>();
      openChatSession(channel, context, 'client_1', send, 'owned session');
      const foreignSessionId = openChatSession(
        channel,
        context,
        'client_2',
        foreignSend,
        'foreign session',
      );

      channel.handleMessage(
        'client_1',
        'observability.traces',
        msg(
          'observability.traces',
          { sessionId: foreignSessionId, limit: 50 },
          'req-observability-foreign-traces',
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            id: 'req-observability-foreign-traces',
            error: 'Not authorized for target session trace data',
          }),
        ),
      );
      expect(listObservabilityTraces).not.toHaveBeenCalled();
    });

    it('requires traceId for observability logs', async () => {
      const getObservabilityTrace = vi.fn();
      const getObservabilityLogTail = vi.fn();

      deps = createDeps({ getObservabilityTrace, getObservabilityLogTail });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      openChatSession(channel, context, 'client_1', send, 'owned session');

      channel.handleMessage(
        'client_1',
        'observability.logs',
        msg('observability.logs', { lines: 50 }, 'req-observability-logs-missing-trace'),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            id: 'req-observability-logs-missing-trace',
            error: 'Missing traceId in payload',
          }),
        ),
      );

      expect(getObservabilityTrace).not.toHaveBeenCalled();
      expect(getObservabilityLogTail).not.toHaveBeenCalled();
    });

    it('rejects observability logs for foreign traces', async () => {
      const traceDetail = makeTraceDetail('foreign-session');
      const getObservabilityTrace = vi.fn(async () => traceDetail);
      const getObservabilityLogTail = vi.fn();

      deps = createDeps({ getObservabilityTrace, getObservabilityLogTail });
      context = createContext();
      channel = new WebChatChannel(deps);
      await channel.initialize(context);
      await channel.start();

      const send = vi.fn<(response: ControlResponse) => void>();
      openChatSession(channel, context, 'client_1', send, 'owned session');

      channel.handleMessage(
        'client_1',
        'observability.logs',
        msg(
          'observability.logs',
          { traceId: traceDetail.summary.traceId, lines: 50 },
          'req-observability-logs-foreign',
        ),
        send,
      );

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            id: 'req-observability-logs-foreign',
            error: 'Not authorized for target session trace data',
          }),
        ),
      );

      expect(getObservabilityTrace).toHaveBeenCalledWith(traceDetail.summary.traceId);
      expect(getObservabilityLogTail).not.toHaveBeenCalled();
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
