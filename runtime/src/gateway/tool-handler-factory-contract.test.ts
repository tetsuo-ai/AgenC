/**
 * Contract test for the createSessionToolHandler seam.
 *
 * This test validates the SessionToolHandlerConfig contract independently
 * of daemon or voice-bridge internals. It proves the seam is real:
 * consumers can create a fully functional session tool handler using
 * only the public contract interface.
 *
 * Gate 4 — First Proven Seam (REFACTOR-MASTER-PROGRAM.md)
 */
import { describe, it, expect, vi } from "vitest";
import type { ControlResponse } from "./types.js";
import {
  createSessionToolHandler,
  type SessionToolHandlerConfig,
} from "./tool-handler-factory.js";

describe("SessionToolHandler contract", () => {
  function createMinimalConfig(
    overrides?: Partial<SessionToolHandlerConfig>,
  ): SessionToolHandlerConfig {
    return {
      sessionId: "contract-test-session",
      baseHandler: vi.fn(async () => "ok"),
      routerId: "contract-test-router",
      send: vi.fn(),
      ...overrides,
    };
  }

  it("creates a handler from minimal required config", () => {
    const config = createMinimalConfig();
    const handler = createSessionToolHandler(config);
    expect(typeof handler).toBe("function");
  });

  it("routes tool calls through baseHandler and sends WS notifications", async () => {
    const sentMessages: ControlResponse[] = [];
    const baseHandler = vi.fn(async () => '{"result":"done"}');
    const send = vi.fn((msg: ControlResponse) => {
      sentMessages.push(msg);
    });

    const handler = createSessionToolHandler(
      createMinimalConfig({ baseHandler, send }),
    );

    const result = await handler("system.test_tool", { arg1: "value1" });

    // Contract: baseHandler was called with the tool name and args
    expect(baseHandler).toHaveBeenCalledWith(
      "system.test_tool",
      expect.objectContaining({ arg1: "value1" }),
    );

    // Contract: result is the baseHandler return value
    expect(result).toBe('{"result":"done"}');

    // Contract: tools.executing notification was sent
    const executing = sentMessages.find((m) => m.type === "tools.executing");
    expect(executing).toBeDefined();
    expect(executing?.payload).toMatchObject({
      toolName: "system.test_tool",
    });

    // Contract: tools.result notification was sent
    const resultMsg = sentMessages.find((m) => m.type === "tools.result");
    expect(resultMsg).toBeDefined();
    expect(resultMsg?.payload).toMatchObject({
      toolName: "system.test_tool",
      result: '{"result":"done"}',
    });
  });

  it("calls onToolStart and onToolEnd callbacks in order", async () => {
    const order: string[] = [];
    const onToolStart = vi.fn(() => order.push("start"));
    const onToolEnd = vi.fn(() => order.push("end"));
    const baseHandler = vi.fn(async () => {
      order.push("execute");
      return "ok";
    });

    const handler = createSessionToolHandler(
      createMinimalConfig({ baseHandler, onToolStart, onToolEnd }),
    );

    await handler("test.tool", {});

    expect(order).toEqual(["start", "execute", "end"]);
    expect(onToolStart).toHaveBeenCalledWith(
      "test.tool",
      expect.any(Object),
      expect.any(String),
    );
    expect(onToolEnd).toHaveBeenCalledWith(
      "test.tool",
      "ok",
      expect.any(Number),
      expect.any(String),
    );
  });

  it("integrates hooks when provided", async () => {
    const hookBeforeCalled = vi.fn();
    const hooks = {
      dispatch: vi.fn(async (event: string) => {
        hookBeforeCalled(event);
        return { completed: true, payload: {}, handlersRun: 1 };
      }),
    } as any;

    const handler = createSessionToolHandler(
      createMinimalConfig({ hooks }),
    );

    await handler("test.tool", {});

    // Contract: hooks.dispatch was called with tool:before
    expect(hookBeforeCalled).toHaveBeenCalledWith("tool:before");
  });

  it("blocks execution when hook returns not completed", async () => {
    const baseHandler = vi.fn(async () => "should not reach");
    const hooks = {
      dispatch: vi.fn(async (event: string) => {
        if (event === "tool:before") {
          return {
            completed: false,
            payload: { reason: "policy denied" },
            handlersRun: 1,
            abortedBy: "test-policy",
          };
        }
        return { completed: true, payload: {}, handlersRun: 1 };
      }),
    } as any;

    const handler = createSessionToolHandler(
      createMinimalConfig({ baseHandler, hooks }),
    );

    const result = await handler("blocked.tool", {});

    // Contract: baseHandler was NOT called
    expect(baseHandler).not.toHaveBeenCalled();

    // Contract: result contains error indication
    expect(result).toContain("policy denied");
  });

  it("accepts all optional config fields without error", () => {
    // Contract: all optional fields are accepted
    const config: SessionToolHandlerConfig = {
      sessionId: "full-config-test",
      baseHandler: vi.fn(async () => "ok"),
      routerId: "full-router",
      send: vi.fn(),
      desktopRouterFactory: vi.fn(() => vi.fn(async () => "desktop-ok")),
      hooks: undefined,
      approvalEngine: undefined,
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      delegation: undefined,
      availableToolNames: ["tool.a", "tool.b"],
      defaultWorkingDirectory: "/tmp/test",
      workspaceAliasRoot: "/workspace",
      scopedFilesystemRoot: "/tmp/scoped",
      resolveWorkspaceContext: undefined,
      hookMetadata: { key: "value" },
      credentialBroker: undefined,
      resolvePolicyScope: undefined,
    };

    const handler = createSessionToolHandler(config);
    expect(typeof handler).toBe("function");
  });
});
