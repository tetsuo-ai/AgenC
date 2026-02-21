import { describe, it, expect, vi } from "vitest";
import { createDesktopAwarenessAction } from "./desktop-awareness.js";
import type { HeartbeatContext } from "../gateway/heartbeat.js";

function makeMockScreenshotTool(result = { content: "screenshot data", isError: false }) {
  return {
    name: "mcp.peekaboo.takeScreenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object" as const, properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  };
}

function makeMockLLM(response = "Normal desktop activity.") {
  return {
    name: "mock-llm",
    chat: vi.fn().mockResolvedValue({ content: response }),
    chatStream: vi.fn(),
  };
}

function makeMockMemory() {
  return {
    name: "mock-memory",
    addEntry: vi.fn().mockResolvedValue(undefined),
    getThread: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(): HeartbeatContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sendToChannels: vi.fn(),
  } as unknown as HeartbeatContext;
}

describe("createDesktopAwarenessAction", () => {
  // --------------------------------------------------------------------------
  // Basic properties
  // --------------------------------------------------------------------------

  it("creates action with correct name", () => {
    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: makeMockLLM() as any,
      memory: makeMockMemory() as any,
    });

    expect(action.name).toBe("desktop-awareness");
    expect(action.enabled).toBe(true);
  });

  it("respects enabled=false config", () => {
    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: makeMockLLM() as any,
      memory: makeMockMemory() as any,
      enabled: false,
    });

    expect(action.enabled).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Normal flow
  // --------------------------------------------------------------------------

  it("captures screenshot, analyzes with LLM, stores in memory", async () => {
    const tool = makeMockScreenshotTool();
    const llm = makeMockLLM("Normal desktop activity.");
    const memory = makeMockMemory();

    const action = createDesktopAwarenessAction({
      screenshotTool: tool,
      llm: llm as any,
      memory: memory as any,
    });

    const result = await action.execute(makeContext());

    // Screenshot captured with default quality
    expect(tool.execute).toHaveBeenCalledWith({ quality: "low" });

    // LLM called with screenshot data
    expect(llm.chat).toHaveBeenCalledOnce();
    const chatArgs = llm.chat.mock.calls[0][0];
    expect(chatArgs[0].role).toBe("user");
    expect(chatArgs[0].content).toContain("screenshot data");

    // Memory entry stored
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "desktop-awareness",
        role: "assistant",
        content: expect.stringContaining("Normal desktop activity."),
      }),
    );

    // Normal activity = quiet
    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("uses custom screenshot quality", async () => {
    const tool = makeMockScreenshotTool();
    const action = createDesktopAwarenessAction({
      screenshotTool: tool,
      llm: makeMockLLM() as any,
      memory: makeMockMemory() as any,
      screenshotQuality: "high",
    });

    await action.execute(makeContext());

    expect(tool.execute).toHaveBeenCalledWith({ quality: "high" });
  });

  // --------------------------------------------------------------------------
  // Noteworthy detection
  // --------------------------------------------------------------------------

  it.each([
    ["error dialog detected", "error"],
    ["There is a warning popup", "warning"],
    ["Process appears stuck", "stuck"],
    ["Application has crash", "crash"],
    ["AI should help with this", "should help"],
  ])("detects noteworthy: %s", async (analysis) => {
    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: makeMockLLM(analysis) as any,
      memory: makeMockMemory() as any,
    });

    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.quiet).toBe(false);
    expect(result.output).toContain(analysis);
  });

  it("does not alert on normal activity", async () => {
    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: makeMockLLM("User is browsing the web. Nothing unusual.") as any,
      memory: makeMockMemory() as any,
    });

    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  it("returns quiet when screenshot fails", async () => {
    const tool = makeMockScreenshotTool({ content: "permission denied", isError: true });
    const llm = makeMockLLM();

    const action = createDesktopAwarenessAction({
      screenshotTool: tool,
      llm: llm as any,
      memory: makeMockMemory() as any,
    });

    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
    // LLM should not be called when screenshot fails
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("returns quiet when LLM throws", async () => {
    const llm = makeMockLLM();
    llm.chat.mockRejectedValueOnce(new Error("LLM timeout"));

    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: llm as any,
      memory: makeMockMemory() as any,
    });

    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("returns quiet when memory.addEntry throws", async () => {
    const memory = makeMockMemory();
    memory.addEntry.mockRejectedValueOnce(new Error("DB full"));

    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: makeMockLLM() as any,
      memory: memory as any,
    });

    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("handles null LLM content gracefully", async () => {
    const llm = makeMockLLM();
    llm.chat.mockResolvedValueOnce({ content: null });

    const action = createDesktopAwarenessAction({
      screenshotTool: makeMockScreenshotTool(),
      llm: llm as any,
      memory: makeMockMemory() as any,
    });

    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });
});
