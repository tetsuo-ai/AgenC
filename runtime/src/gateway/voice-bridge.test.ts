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
  it("logs direct voice turns under a single trace when trace logging is enabled", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const send = vi.fn();
    const bridge = new VoiceBridge({
      apiKey: "voice-key",
      toolHandler: vi.fn(async () => ""),
      systemPrompt: "You are a helpful assistant.",
      getChatExecutor: () => null,
      logger: logger as any,
      traceConfig: {
        enabled: true,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 8_000,
      },
    });

    (bridge as any).sessions.set("client-1", {
      client: {} as any,
      send,
      toolHandler: vi.fn(async () => ""),
      sessionId: "session-1",
      managedSessionId: "session-1",
      delegationAbort: null,
      currentTraceId: null,
      currentTurnDelegated: false,
    });

    const callbacks = (bridge as any).buildClientCallbacks(
      "client-1",
      "session-1",
      send,
    );

    callbacks.onSpeechStarted();
    callbacks.onInputTranscriptDone("Inspect the logs");
    callbacks.onTranscriptDone("I found the issue.");
    callbacks.onResponseDone();

    const lines = logger.info.mock.calls.map(([line]) => line as string);
    const inbound = lines.find((line) => line.includes("[trace] voice.inbound "));
    const response = lines.find((line) =>
      line.includes("[trace] voice.chat.response "),
    );

    expect(inbound).toBeTruthy();
    expect(response).toBeTruthy();
    const inboundTrace = inbound?.match(/"traceId":"([^"]+)"/)?.[1];
    const responseTrace = response?.match(/"traceId":"([^"]+)"/)?.[1];
    expect(inboundTrace).toBeTruthy();
    expect(responseTrace).toBe(inboundTrace);
  });

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
      currentTraceId: null,
      currentTurnDelegated: false,
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

  it("passes provider trace options to delegated chat execution when enabled", async () => {
    const execute = vi.fn(async () => ({
      content: "Opened the browser",
      provider: "fresh-grok",
      toolCalls: [],
      durationMs: 12,
      compacted: false,
      callUsage: [],
    }));

    const send = vi.fn();
    const bridge = new VoiceBridge({
      apiKey: "voice-key",
      toolHandler: vi.fn(async () => ""),
      systemPrompt: "You are a helpful assistant.",
      getChatExecutor: () => ({
        execute,
        getSessionTokenUsage: () => 0,
      } as any),
      traceProviderPayloads: true,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    (bridge as any).sessions.set("client-1", {
      client: {} as any,
      send,
      toolHandler: vi.fn(async () => ""),
      sessionId: "session-1",
      managedSessionId: "session-1",
      delegationAbort: null,
      currentTraceId: null,
      currentTurnDelegated: false,
    });

    await (bridge as any).handleDelegation(
      "client-1",
      "session-1",
      JSON.stringify({ task: "Open a browser" }),
      send,
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        trace: expect.objectContaining({
          includeProviderPayloads: true,
          onProviderTraceEvent: expect.any(Function),
          onExecutionTraceEvent: expect.any(Function),
        }),
      }),
    );
  });

  it("uses one trace for voice inbound, delegated tool calls, and the final response", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const baseToolHandler = vi.fn(async () => '{"cwd":"/tmp"}');
    const execute = vi.fn(async ({ toolHandler }: { toolHandler: (name: string, args: Record<string, unknown>) => Promise<string> }) => {
      const result = await toolHandler("system.bash", { command: "pwd" });
      return {
        content: "Opened the browser",
        provider: "fresh-grok",
        toolCalls: [
          {
            name: "system.bash",
            args: { command: "pwd" },
            result,
            durationMs: 7,
            isError: false,
          },
        ],
        durationMs: 12,
        compacted: false,
        callUsage: [],
      };
    });

    const send = vi.fn();
    const bridge = new VoiceBridge({
      apiKey: "voice-key",
      toolHandler: baseToolHandler,
      systemPrompt: "You are a helpful assistant.",
      getChatExecutor: () => ({
        execute,
        getSessionTokenUsage: () => 0,
      } as any),
      logger: logger as any,
      traceConfig: {
        enabled: true,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 8_000,
      },
    });

    (bridge as any).sessions.set("client-1", {
      client: {} as any,
      send,
      toolHandler: vi.fn(async () => ""),
      sessionId: "session-1",
      managedSessionId: "session-1",
      delegationAbort: null,
      currentTraceId: null,
      currentTurnDelegated: false,
    });

    const callbacks = (bridge as any).buildClientCallbacks(
      "client-1",
      "session-1",
      send,
    );
    callbacks.onSpeechStarted();
    callbacks.onInputTranscriptDone("Open a browser");

    await (bridge as any).handleDelegation(
      "client-1",
      "session-1",
      JSON.stringify({ task: "Open a browser" }),
      send,
    );

    const lines = logger.info.mock.calls.map(([line]) => line as string);
    const expectedEvents = [
      "[trace] voice.inbound ",
      "[trace] voice.delegation.started ",
      "[trace] voice.tool.call ",
      "[trace] voice.tool.result ",
      "[trace] voice.chat.response ",
    ];
    for (const marker of expectedEvents) {
      expect(lines.some((line) => line.includes(marker))).toBe(true);
    }

    const traceIds = lines
      .filter((line) => line.includes("[trace] voice."))
      .map((line) => line.match(/"traceId":"([^"]+)"/)?.[1])
      .filter((value): value is string => typeof value === "string");

    expect(new Set(traceIds).size).toBe(1);
    expect(baseToolHandler).toHaveBeenCalledWith("system.bash", {
      command: "pwd",
    });
  });
});
