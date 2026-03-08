import { describe, expect, it, vi } from "vitest";

import {
  VoiceBridge,
  createVoiceDelegationTool,
} from "./voice-bridge.js";

describe("createVoiceDelegationTool", () => {
  it("uses the xAI Voice Agent top-level function tool schema", () => {
    const tool = createVoiceDelegationTool();

    expect(tool).toMatchObject({
      type: "function",
      name: "execute_with_agent",
    });
    expect(tool.description).toContain("sub-agent");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["task"],
    });
    expect(tool).not.toHaveProperty("function");
  });
});

describe("VoiceBridge delegation", () => {
  it("resolves the current chat executor at delegation time", async () => {
    const staleExecute = vi.fn();
    const freshExecute = vi.fn(async () => ({
      content: "Opened the browser",
      provider: "fresh-grok",
      toolCalls: [],
      durationMs: 12,
      compacted: false,
      callUsage: [],
    }));

    let currentExecutor: {
      execute: typeof staleExecute | typeof freshExecute;
      getSessionTokenUsage: () => number;
    } | null = {
      execute: staleExecute,
      getSessionTokenUsage: () => 0,
    };

    const send = vi.fn();
    const bridge = new VoiceBridge({
      apiKey: "voice-key",
      toolHandler: vi.fn(async () => ""),
      systemPrompt: "You are a helpful assistant.",
      getChatExecutor: () => currentExecutor as any,
    });

    (bridge as any).sessions.set("client-1", {
      client: {} as any,
      send,
      toolHandler: vi.fn(async () => ""),
      sessionId: "session-1",
      managedSessionId: "session-1",
      delegationAbort: null,
    });

    currentExecutor = {
      execute: freshExecute,
      getSessionTokenUsage: () => 42,
    };

    const result = await (bridge as any).handleDelegation(
      "client-1",
      "session-1",
      JSON.stringify({ task: "Open a browser" }),
      send,
    );

    expect(staleExecute).not.toHaveBeenCalled();
    expect(freshExecute).toHaveBeenCalledTimes(1);
    expect(freshExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        systemPrompt: "You are a helpful assistant.",
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.usage",
      }),
    );
    expect(result).toContain("Task completed");
  });

  it("surfaces the concrete inbound hook block reason", async () => {
    const send = vi.fn();
    const bridge = new VoiceBridge({
      apiKey: "voice-key",
      toolHandler: vi.fn(async () => ""),
      systemPrompt: "You are a helpful assistant.",
      getChatExecutor: () => null,
      hooks: {
        dispatch: vi.fn(async () => ({
          completed: false,
          payload: {
            reason: 'Policy blocked message: tenant is suspended',
          },
        })),
      } as any,
    });

    const spoken = await (bridge as any).dispatchPolicyCheck(
      "client-1",
      "session-1",
      "Investigate the failing run",
      send,
    );

    expect(spoken).toBe("Policy blocked message: tenant is suspended");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "blocked",
          error: "Policy blocked message: tenant is suspended",
        }),
      }),
    );
  });
});
