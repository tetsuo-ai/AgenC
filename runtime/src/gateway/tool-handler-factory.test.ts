import { describe, it, expect, vi } from "vitest";
import type { ControlResponse } from "./types.js";
import type { ApprovalEngine } from "./approvals.js";
import { ApprovalEngine as ApprovalEngineImpl } from "./approvals.js";
import { DelegationPolicyEngine } from "./delegation-runtime.js";
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
      isToolDenied: vi.fn().mockReturnValue(false),
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

  it("does not emit approval.request for system.bash under default approval rules", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => "build-complete");
    const approvalEngine = new ApprovalEngineImpl();

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
    });

    const result = await handler("system.bash", {
      command: "npm",
      args: ["run", "build"],
    });

    expect(result).toBe("build-complete");
    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command: "npm",
      args: ["run", "build"],
    });
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
  });

  it("includes parent subagent context in approval prompts for delegated sessions", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => "ok");
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        tool: "system.delete",
        description: "Deletion requires approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      isToolDenied: vi.fn().mockReturnValue(false),
      createRequest: vi.fn(
        (
          toolName: string,
          args: Record<string, unknown>,
          sessionId: string,
          message: string,
          rule: Record<string, unknown>,
          context?: { parentSessionId?: string; subagentSessionId?: string },
        ) => ({
          id: "approval-sub-1",
          toolName,
          args,
          sessionId,
          message,
          createdAt: 1_700_000_000_000,
          rule,
          ...context,
        }),
      ),
      requestApproval: vi.fn().mockResolvedValue({
        requestId: "approval-sub-1",
        disposition: "yes",
      }),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      delegation: () => ({
        subAgentManager: {
          getInfo: vi.fn(() => ({
            sessionId: "subagent:child-1",
            parentSessionId: "parent-1",
            depth: 2,
            status: "running",
            startedAt: 1,
            task: "Delete stale artifacts under /home/tetsuo/secrets.txt",
          })),
        } as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("system.delete", { target: "/tmp/file" });

    expect(approvalEngine.createRequest).toHaveBeenCalledWith(
      "system.delete",
      { target: "/tmp/file" },
      "subagent:child-1",
      expect.stringContaining("Parent session: parent-1"),
      expect.objectContaining({ tool: "system.delete" }),
      {
        parentSessionId: "parent-1",
        subagentSessionId: "subagent:child-1",
      },
    );

    const approvalRequest = sentMessages.find((msg) => msg.type === "approval.request");
    expect(approvalRequest).toBeDefined();
    expect((approvalRequest?.payload as Record<string, unknown>).parentSessionId).toBe(
      "parent-1",
    );
    expect((approvalRequest?.payload as Record<string, unknown>).subagentSessionId).toBe(
      "subagent:child-1",
    );
  });

  it("blocks delegated tool execution when action was denied earlier in parent tree", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => "should-not-run");
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        tool: "system.delete",
        description: "Deletion requires approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      isToolDenied: vi.fn().mockReturnValue(true),
      createRequest: vi.fn(),
      requestApproval: vi.fn(),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-2",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      delegation: () => ({
        subAgentManager: {
          getInfo: vi.fn(() => ({
            sessionId: "subagent:child-2",
            parentSessionId: "parent-2",
            depth: 2,
            status: "running",
            startedAt: 1,
            task: "Delete stale artifacts",
          })),
        } as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.delete", { target: "/tmp/file" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("denied earlier in the request tree");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(approvalEngine.createRequest).not.toHaveBeenCalled();
    expect(approvalEngine.requestApproval).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(true);
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

  it("does not skip browser launches when target URLs differ", async () => {
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

    const first = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser https://example.com",
    });

    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second).skippedDuplicate).toBeUndefined();

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });

  it("still skips identical browser launch commands", async () => {
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

    await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });
  });

  it("does not treat failed browser launch as seen for duplicate skipping", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          error:
            'Command "chromium-browser" is incomplete. Include a URL target.',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
      );

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", {
      command: "chromium-browser",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser",
    });

    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first).error).toContain("incomplete");
    expect(JSON.parse(second).backgrounded).toBe(true);
    expect(JSON.parse(second).skippedDuplicate).toBeUndefined();

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });

  it("emits subagent tool lifecycle events when delegation dependencies are wired", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const policyEngine = {
      evaluate: vi.fn(() => ({ allowed: true, threshold: 0.7 })),
      isDelegationTool: vi.fn(() => false),
      snapshot: vi.fn(() => ({ spawnDecisionThreshold: 0.7 })),
    };
    const verifier = {
      shouldVerifySubAgentResult: vi.fn(() => true),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const baseHandler = vi.fn(async () => "ok");
    const handler = createSessionToolHandler({
      sessionId: "subagent:test-session",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine: policyEngine as any,
        verifier: verifier as any,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("system.health", { verbose: true });

    expect(result).toBe("ok");
    expect(policyEngine.evaluate).toHaveBeenCalledWith({
      sessionId: "subagent:test-session",
      toolName: "system.health",
      args: { verbose: true },
      isSubAgentSession: true,
    });

    expect(lifecycleEmitter.emit).toHaveBeenCalledTimes(2);
    expect(lifecycleEvents[0].type).toBe("subagents.tool.executing");
    expect(lifecycleEvents[1].type).toBe("subagents.tool.result");
    expect((lifecycleEvents[1].payload as { verifyRequested?: boolean }).verifyRequested).toBe(
      true,
    );

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
    const executingPayload = sentMessages.find((m) => m.type === "tools.executing")?.payload as
      | { subagentSessionId?: string }
      | undefined;
    const resultPayload = sentMessages.find((m) => m.type === "tools.result")?.payload as
      | { subagentSessionId?: string }
      | undefined;
    expect(executingPayload?.subagentSessionId).toBe("subagent:test-session");
    expect(resultPayload?.subagentSessionId).toBe("subagent:test-session");
  });

  it("executes execute_with_agent via SubAgentManager instead of base handler", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-1",
        output: '{"summary":"child completed"}',
        success: true,
        durationMs: 42,
        toolCalls: [],
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Inspect file",
      })),
    };
    const verifier = {
      shouldVerifySubAgentResult: vi.fn(() => true),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: verifier as any,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Inspect file",
      tools: ["system.readFile"],
      timeoutMs: 12_000,
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      subagentSessionId?: string;
      objective?: string;
    };

    expect(baseHandler).not.toHaveBeenCalled();
    expect(subAgentManager.spawn).toHaveBeenCalledWith({
      parentSessionId: "session-parent",
      task: "Inspect file",
      timeoutMs: 12_000,
      tools: ["system.readFile"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(parsed.subagentSessionId).toBe("subagent:child-1");
    expect(parsed.objective).toBe("Inspect file");

    const executingCount = sentMessages.filter((msg) => msg.type === "tools.executing").length;
    const resultCount = sentMessages.filter((msg) => msg.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);

    expect(lifecycleEvents.some((event) => event.type === "subagents.spawned")).toBe(
      true,
    );
    expect(lifecycleEvents.some((event) => event.type === "subagents.started")).toBe(
      true,
    );
    expect(lifecycleEvents.some((event) => event.type === "subagents.completed")).toBe(
      true,
    );
  });

  it("returns structured error when execute_with_agent spawn fails", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const subAgentManager = {
      spawn: vi.fn(async () => {
        throw new Error("max concurrent sub-agents reached (2)");
      }),
      getResult: vi.fn(() => null),
      getInfo: vi.fn(() => null),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Run child",
    });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("Failed to spawn sub-agent");
    expect(parsed.error).toContain("max concurrent sub-agents reached");
    expect(lifecycleEvents.some((event) => event.type === "subagents.failed")).toBe(
      true,
    );
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(true);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(true);
  });

  it("returns delegation policy error without executing tool when policy blocks", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const policyEngine = {
      evaluate: vi.fn(() => ({
        allowed: false,
        reason: "Delegation tool is not allowlisted",
        threshold: 0.8,
      })),
      isDelegationTool: vi.fn(() => true),
      snapshot: vi.fn(() => ({ spawnDecisionThreshold: 0.8 })),
    };

    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine: policyEngine as any,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", { task: "run tests" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("not allowlisted");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(false);
  });

  it("blocks delegation tools from sub-agent sessions to prevent privilege expansion", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const policyEngine = new DelegationPolicyEngine({
      enabled: true,
      spawnDecisionThreshold: 0.1,
      fallbackBehavior: "continue_without_delegation",
    });
    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", { task: "expand scope" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("cannot invoke delegation tools");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(false);
  });
});
