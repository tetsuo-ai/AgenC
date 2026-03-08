import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../utils/logger.js";
import {
  buildBackgroundRunSignalFromDesktopEvent,
  buildBackgroundRunSignalFromToolResult,
  createBackgroundRunToolAfterHook,
  createBackgroundRunWebhookRoute,
} from "./background-run-wake-adapters.js";

describe("background-run-wake-adapters", () => {
  it("maps managed process desktop exits to deterministic process_exit signals", () => {
    const signal = buildBackgroundRunSignalFromDesktopEvent({
      type: "managed_process.exited",
      timestamp: 123,
      payload: {
        processId: "proc_123",
        label: "watcher",
        pid: 42,
        pgid: 42,
        state: "exited",
        startedAt: 100,
        endedAt: 123,
        exitCode: 0,
        signal: null,
        logPath: "/tmp/watcher.log",
      },
    });

    expect(signal).toEqual({
      type: "process_exit",
      content: 'Managed process "watcher" (proc_123) exited (exitCode=0).',
      data: {
        processId: "proc_123",
        label: "watcher",
        pid: 42,
        pgid: 42,
        startedAt: 100,
        endedAt: 123,
        exitCode: 0,
        signal: null,
        logPath: "/tmp/watcher.log",
      },
    });
  });

  it("maps browser and filesystem desktop events into external wake signals", () => {
    const browserSignal = buildBackgroundRunSignalFromDesktopEvent({
      type: "browser.download.completed",
      timestamp: 123,
      payload: {
        path: "/tmp/export.pdf",
        url: "https://example.com/report",
      },
    });
    const fsSignal = buildBackgroundRunSignalFromDesktopEvent({
      type: "filesystem.changed",
      timestamp: 124,
      payload: {
        path: "/workspace/output.txt",
        change: "modified",
      },
    });

    expect(browserSignal).toMatchObject({
      type: "external_event",
      content: "Browser download completed at /tmp/export.pdf.",
      data: {
        eventType: "browser.download.completed",
        path: "/tmp/export.pdf",
      },
    });
    expect(fsSignal).toMatchObject({
      type: "external_event",
      content: "Filesystem watcher event filesystem.changed at /workspace/output.txt.",
      data: {
        eventType: "filesystem.changed",
        path: "/workspace/output.txt",
      },
    });
  });

  it("classifies external browser tool results and suppresses internal background tool calls", () => {
    const browserSignal = buildBackgroundRunSignalFromToolResult({
      sessionId: "session-1",
      toolName: "mcp.browser.browser_navigate",
      args: { url: "https://example.com" },
      result: '{"url":"https://example.com","title":"Example"}',
      durationMs: 20,
      toolCallId: "tool-1",
    });
    const suppressed = buildBackgroundRunSignalFromToolResult({
      sessionId: "session-1",
      toolName: "mcp.browser.browser_navigate",
      args: { url: "https://example.com" },
      result: '{"url":"https://example.com"}',
      durationMs: 20,
      toolCallId: "tool-2",
      backgroundRunId: "bg-run-1",
    });

    expect(browserSignal).toEqual({
      type: "tool_result",
      content: "Browser navigation completed for https://example.com.",
      data: {
        toolName: "mcp.browser.browser_navigate",
        toolCallId: "tool-1",
        category: "browser",
        failed: false,
        durationMs: 20,
        url: "https://example.com",
        title: "Example",
      },
    });
    expect(suppressed).toBeUndefined();
  });

  it("signals active runs from external tool results", async () => {
    const signalRun = vi.fn().mockResolvedValue(true);
    const hook = createBackgroundRunToolAfterHook({
      getSupervisor: () => ({
        hasActiveRun: () => true,
        signalRun,
      }),
      logger: silentLogger,
    });

    const result = await hook.handler({
      event: "tool:after",
      payload: {
        sessionId: "session-1",
        toolName: "system.writeFile",
        args: { path: "/tmp/output.txt" },
        result: '{"path":"/tmp/output.txt","bytesWritten":12}',
        durationMs: 8,
        toolCallId: "tool-3",
      },
      logger: silentLogger,
      timestamp: 123,
    });

    expect(result).toEqual({ continue: true });
    expect(signalRun).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "tool_result",
      content: "Filesystem change observed via system.writeFile at /tmp/output.txt.",
      data: {
        toolName: "system.writeFile",
        toolCallId: "tool-3",
        category: "filesystem",
        failed: false,
        durationMs: 8,
        path: "/tmp/output.txt",
      },
    });
  });

  it("authenticates and enqueues background-run webhook signals", async () => {
    const signalRun = vi.fn().mockResolvedValue(true);
    const route = createBackgroundRunWebhookRoute({
      getSupervisor: () => ({
        hasActiveRun: () => true,
        signalRun,
      }),
      authSecret: "super-secret",
      logger: silentLogger,
    });

    const response = await route.handler({
      method: "POST",
      path: "/webhooks/background-run",
      headers: {
        authorization: "Bearer super-secret",
      },
      body: {
        sessionId: "session-1",
        content: "File watcher detected a ready artifact.",
        source: "artifact-watcher",
        eventId: "evt-1",
        data: { artifactPath: "/tmp/out.json" },
      },
      query: {},
      remoteAddress: "10.0.0.10",
    });

    expect(response).toEqual({
      status: 202,
      body: {
        accepted: true,
        sessionId: "session-1",
      },
    });
    expect(signalRun).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "webhook",
      content: "Webhook event from artifact-watcher: File watcher detected a ready artifact.",
      data: {
        eventId: "evt-1",
        source: "artifact-watcher",
        artifactPath: "/tmp/out.json",
      },
    });
  });

  it("rejects non-loopback webhook ingress when no auth secret is configured", async () => {
    const route = createBackgroundRunWebhookRoute({
      getSupervisor: () => null,
      logger: silentLogger,
    });

    const response = await route.handler({
      method: "POST",
      path: "/webhooks/background-run",
      headers: {},
      body: {
        sessionId: "session-1",
        content: "should not matter",
      },
      query: {},
      remoteAddress: "10.0.0.20",
    });

    expect(response).toEqual({
      status: 403,
      body: {
        error: "Webhook ingress requires loopback access or auth.secret.",
      },
    });
  });
});
