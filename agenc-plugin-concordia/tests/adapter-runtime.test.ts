import { describe, expect, it, vi } from "vitest";
import { ConcordiaChannelAdapter } from "../src/adapter.js";

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on_message: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ConcordiaChannelAdapter pending response handling", () => {
  it("resolves a pending act via session fallback when request_id is missing", async () => {
    const adapter = new ConcordiaChannelAdapter();
    const context = makeContext();
    await adapter.initialize(context as never);

    const pending = (adapter as any).createPendingResponse(
      "req-1",
      "session-1",
      "agent-a",
      5_000,
      "timeout",
      "world-a",
      1,
    ) as Promise<string>;

    await adapter.send({
      session_id: "session-1",
      content: "resolved action",
      is_partial: false,
      metadata: {},
    } as never);

    await expect(pending).resolves.toBe("resolved action");
    expect((adapter as any).pendingResponses.size).toBe(0);
    expect(context.logger.warn).toHaveBeenCalled();
  });

  it("rejects the pending act immediately on session mismatch", async () => {
    const adapter = new ConcordiaChannelAdapter();
    const context = makeContext();
    await adapter.initialize(context as never);

    const pending = (adapter as any).createPendingResponse(
      "req-2",
      "expected-session",
      "agent-a",
      5_000,
      "timeout",
      "world-a",
      2,
    ) as Promise<string>;

    await adapter.send({
      session_id: "other-session",
      content: "resolved action",
      is_partial: false,
      metadata: { request_id: "req-2" },
    } as never);

    await expect(pending).rejects.toThrow(/session mismatch/);
    expect((adapter as any).pendingResponses.size).toBe(0);
  });

  it("cleans up a pending act when dispatch into the daemon pipeline fails", async () => {
    const onMessage = vi.fn().mockImplementation(async () => {
      throw new Error("dispatch exploded");
    });
    const adapter = new ConcordiaChannelAdapter();
    const context = makeContext({ on_message: onMessage });
    await adapter.initialize(context as never);

    const session = (adapter as any).sessionManager.getOrCreate({
      agentId: "agent-a",
      agentName: "Agent A",
      worldId: "world-a",
      workspaceId: "ws-a",
    });

    await expect(
      (adapter as any).handleAct("agent-a", session.sessionId, "What do you do?", "req-3"),
    ).rejects.toThrow("dispatch exploded");

    expect((adapter as any).pendingResponses.size).toBe(0);
    expect(onMessage).toHaveBeenCalledOnce();
  });
});
