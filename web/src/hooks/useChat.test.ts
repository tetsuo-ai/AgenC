import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WSMessage } from "../types";
import { useChat } from "./useChat";

describe("useChat tool result matching", () => {
  it("matches tools.result to the exact toolCallId", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "first" },
          toolCallId: "tool-1",
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "second" },
          toolCallId: "tool-2",
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-1",
          result: "first-done",
          durationMs: 12,
          isError: false,
        },
      } as WSMessage);
    });

    const message = result.current.messages[0];
    const toolCalls = message?.toolCalls ?? [];

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "completed",
      result: "first-done",
      toolCallId: "tool-1",
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: "system.task",
      status: "executing",
      toolCallId: "tool-2",
    });
  });

  it("ignores top-level tool events tagged for subagents", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "desktop.bash",
          toolCallId: "tc-sub-1",
          subagentSessionId: "subagent:child-1",
          args: { command: "echo hi" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "desktop.bash",
          toolCallId: "tc-sub-1",
          subagentSessionId: "subagent:child-1",
          result: "ok",
          durationMs: 18,
        },
      } as WSMessage);
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("does not match tool results by name when toolCallId is present", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "first-no-id" },
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-missing",
          result: "late-result",
          durationMs: 8,
        },
      } as WSMessage);
    });

    const message = result.current.messages[0];
    const toolCalls = message?.toolCalls ?? [];

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "executing",
      toolCallId: undefined,
    });
    expect(toolCalls[0].result).toBeUndefined();
  });

  it("falls back to tool name matching when tool result has no toolCallId", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { phase: "legacy" },
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          result: "legacy-done",
          durationMs: 5,
          isError: false,
        },
      } as WSMessage);
    });

    const toolCalls = (result.current.messages[0]?.toolCalls ?? []);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "completed",
      result: "legacy-done",
      toolCallId: undefined,
    });
  });

  it("correctly matches out-of-order tool results by toolCallId", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "A" },
          toolCallId: "tool-a",
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "B" },
          toolCallId: "tool-b",
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-b",
          result: "result-b",
          durationMs: 20,
          isError: false,
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-a",
          result: "result-a",
          durationMs: 15,
          isError: false,
        },
      } as WSMessage);
    });

    const toolCalls = result.current.messages[0]?.toolCalls ?? [];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      args: { round: "A" },
      toolCallId: "tool-a",
      status: "completed",
      result: "result-a",
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: "system.task",
      args: { round: "B" },
      toolCallId: "tool-b",
      status: "completed",
      result: "result-b",
    });
  });
});

describe("useChat session lifecycle", () => {
  it("startNewChat clears local state and requests a new server session", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    send.mockClear();

    act(() => {
      result.current.handleMessage({
        type: "chat.session",
        payload: { sessionId: "session-old" },
      } as WSMessage);
      result.current.injectMessage("hello", "user");
      result.current.injectMessage("world", "agent");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.sessionId).toBe("session-old");

    act(() => {
      result.current.startNewChat();
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.new",
        id: expect.any(String),
      }),
    );
    expect(result.current.messages).toEqual([]);
    expect(result.current.sessionId).toBeNull();
  });

  it("sendMessage includes a stable request id for replay dedupe", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.sendMessage("hello");
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.message",
        id: expect.any(String),
        payload: { content: "hello" },
      }),
    );
  });

  it("parses extended chat.usage payload for context breakdown", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "chat.usage",
        payload: {
          totalTokens: 1234,
          budget: 64_000,
          compacted: false,
          contextWindowTokens: 128_000,
          promptTokens: 2048,
          promptTokenBudget: 117_760,
          maxOutputTokens: 8192,
          safetyMarginTokens: 2048,
          sections: [
            { id: "memory", label: "Memory", tokens: 800, percent: 31.2 },
          ],
        },
      } as WSMessage);
    });

    expect(result.current.tokenUsage).toMatchObject({
      totalTokens: 1234,
      budget: 64_000,
      contextWindowTokens: 128_000,
      promptTokens: 2048,
      sections: [{ id: "memory", label: "Memory", tokens: 800, percent: 31.2 }],
    });
  });
});

describe("useChat subagent lifecycle timeline", () => {
  it("tracks delegated child lifecycle and nested tool activity", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "subagents.planned",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          timestamp: 1000,
          data: { stepName: "research", objective: "research target" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.spawned",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          timestamp: 1100,
          data: { stepName: "research", objective: "research target" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.tool.executing",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          toolName: "desktop.bash",
          timestamp: 1200,
          data: { toolCallId: "tc-1", args: { command: "echo hi" } },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.tool.result",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          toolName: "desktop.bash",
          timestamp: 1300,
          data: {
            toolCallId: "tc-1",
            result: "ok",
            durationMs: 25,
            isError: false,
          },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.completed",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          timestamp: 1400,
          data: { durationMs: 200, output: "done" },
        },
      } as WSMessage);
    });

    const agentMessage = result.current.messages.find((message) => message.sender === "agent");
    expect(agentMessage).toBeDefined();
    const subagents = agentMessage?.subagents ?? [];
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      subagentSessionId: "subagent:child-1",
      status: "completed",
      outputSummary: "done",
      elapsedMs: 200,
    });
    expect(subagents[0]?.tools).toHaveLength(1);
    expect(subagents[0]?.tools[0]).toMatchObject({
      toolName: "desktop.bash",
      toolCallId: "tc-1",
      status: "completed",
      result: "ok",
      durationMs: 25,
    });
  });

  it("hydrates subagent failures from events.event envelopes", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "events.event",
        payload: {
          eventType: "subagents.failed",
          timestamp: 2000,
          traceId: "trace-a",
          data: {
            sessionId: "session-parent",
            parentSessionId: "session-parent",
            subagentSessionId: "subagent:child-2",
            reason: "tool misuse",
          },
        },
      } as WSMessage);
    });

    const agentMessage = result.current.messages.find((message) => message.sender === "agent");
    const subagents = agentMessage?.subagents ?? [];
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      subagentSessionId: "subagent:child-2",
      status: "failed",
      errorReason: "tool misuse",
      traceId: "trace-a",
    });
  });
});
