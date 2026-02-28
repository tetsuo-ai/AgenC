import { describe, it, expect, vi } from "vitest";
import type { ControlResponse } from "./types.js";
import type { ApprovalEngine } from "./approvals.js";
import { createSessionToolHandler } from "./tool-handler-factory.js";

describe("createSessionToolHandler", () => {
  it("reuses a single toolCallId for tool start/result and callbacks", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const baseHandler = vi.fn(async () => "result-value");
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      onToolStart,
      onToolEnd,
    });

    const result = await handler("system.health", { check: true });

    const executing = sentMessages.find((msg) => msg.type === "tools.executing");
    const toolResult = sentMessages.find((msg) => msg.type === "tools.result");

    expect(result).toBe("result-value");
    expect(baseHandler).toHaveBeenCalledWith("system.health", { check: true });
    expect(executing).toBeDefined();
    expect(toolResult).toBeDefined();

    const toolCallId = (executing!.payload as { toolCallId?: string }).toolCallId;
    const resultToolCallId = (toolResult!.payload as { toolCallId?: string }).toolCallId;

    expect(toolCallId).toBeDefined();
    expect(toolCallId).toBe(resultToolCallId);
    expect(onToolStart).toHaveBeenCalledWith("system.health", { check: true }, toolCallId);
    expect(onToolEnd).toHaveBeenCalledWith(
      "system.health",
      "result-value",
      expect.any(Number),
      toolCallId,
    );
  });

  it("reuses toolCallId when approval is denied and tool does not execute", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const baseHandler = vi.fn();
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        description: "Requires explicit approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      createRequest: vi.fn((toolName: string, args: Record<string, unknown>) => ({
        id: "approval-1",
        toolName,
        args,
        sessionId: "session-1",
        message: "Requires explicit approval",
        createdAt: 1_700_000_000_000,
        rule: { tool: "system.delete" },
      })),
      requestApproval: vi.fn().mockResolvedValue({
        requestId: "approval-1",
        disposition: "no",
      }),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      onToolStart,
      onToolEnd,
    });

    const result = await handler("system.delete", { target: "/tmp/file" });

    const executing = sentMessages.find((msg) => msg.type === "tools.executing");
    const approvalRequest = sentMessages.find((msg) => msg.type === "approval.request");
    const toolResult = sentMessages.find((msg) => msg.type === "tools.result");

    const expectedError = JSON.stringify({
      error: 'Tool "system.delete" denied by user',
    });

    expect(result).toBe(expectedError);
    expect(baseHandler).not.toHaveBeenCalled();
    expect(executing).toBeDefined();
    expect(approvalRequest).toBeDefined();
    expect(toolResult).toBeDefined();

    const toolCallId = (executing!.payload as { toolCallId?: string }).toolCallId;
    const resultToolCallId = (toolResult!.payload as { toolCallId?: string }).toolCallId;
    expect(resultToolCallId).toBe(toolCallId);
    expect(onToolStart).toHaveBeenCalledWith("system.delete", { target: "/tmp/file" }, toolCallId);
    expect(onToolEnd).toHaveBeenCalledWith(
      "system.delete",
      expectedError,
      0,
      toolCallId,
    );
  });

  it("generates a unique toolCallId for each separate invocation", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler: vi.fn(async () => "ok"),
      routerId: "router-a",
      send,
    });

    await handler("system.health", { check: "first" });
    await handler("system.health", { check: "second" });

    const toolCallIds = sentMessages
      .filter((msg) => msg.type === "tools.executing")
      .map((msg) => (msg.payload as { toolCallId?: string }).toolCallId);

    expect(toolCallIds).toHaveLength(2);
    expect(toolCallIds[0]).toBeDefined();
    expect(toolCallIds[1]).toBeDefined();
    expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
  });

  it("skips duplicate desktop GUI launches within the same handler turn", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", { command: "xfce4-terminal" });
    const second = await handler("desktop.bash", { command: "xfce4-terminal" });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(baseHandler).toHaveBeenCalledWith("desktop.bash", {
      command: "xfce4-terminal",
    });

    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
  });

  it("skips alternate terminal launcher commands within the same handler turn", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", { command: "xfce4-terminal" });
    const second = await handler("desktop.bash", { command: "gnome-terminal" });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(baseHandler).toHaveBeenCalledWith("desktop.bash", {
      command: "xfce4-terminal",
    });

    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
  });

  it("does not skip non-GUI desktop.bash commands", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => JSON.stringify({ stdout: "ok", exitCode: 0 }));
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    await handler("desktop.bash", { command: "whoami" });
    await handler("desktop.bash", { command: "whoami" });

    expect(baseHandler).toHaveBeenCalledTimes(2);

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });
});
