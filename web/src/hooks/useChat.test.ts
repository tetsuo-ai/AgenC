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
