import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDesktopAwareToolHandler,
  destroySessionBridge,
} from "./session-router.js";
import type { DesktopSandboxManager } from "./manager.js";
import { DesktopRESTBridge } from "./rest-bridge.js";
import type { ToolHandler } from "../llm/types.js";

// Mock the DesktopRESTBridge constructor and instances
vi.mock("./rest-bridge.js", () => {
  const mockTools = [
    {
      name: "desktop.screenshot",
      description: "Take a screenshot",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"image":"abc","width":1024,"height":768,"dataUrl":"data:image/png;base64,abc"}',
      }),
    },
    {
      name: "desktop.mouse_click",
      description: "Click mouse",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"clicked":true}',
      }),
    },
    {
      name: "desktop.bash",
      description: "Run bash command",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"stdout":"hello","exitCode":0}',
      }),
    },
  ];

  return {
    DesktopRESTBridge: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue(mockTools),
    })),
  };
});

function mockManager(overrides: Partial<DesktopSandboxManager> = {}): DesktopSandboxManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      containerId: "test-container",
      apiHostPort: 32769,
      vncHostPort: 32768,
    }),
    getHandleBySession: vi.fn().mockReturnValue({
      containerId: "test-container",
    }),
    touchActivity: vi.fn(),
    ...overrides,
  } as unknown as DesktopSandboxManager;
}

describe("createDesktopAwareToolHandler", () => {
  let baseHandler: ToolHandler;
  let bridges: Map<string, DesktopRESTBridge>;

  beforeEach(() => {
    baseHandler = vi.fn().mockResolvedValue('{"result":"from base"}');
    bridges = new Map();
    vi.clearAllMocks();
  });

  it("delegates non-desktop tools to base handler", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("agenc.listTasks", {});
    expect(result).toBe('{"result":"from base"}');
    expect(baseHandler).toHaveBeenCalledWith("agenc.listTasks", {});
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  it("routes desktop.* tools to sandbox bridge", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.mouse_click", { x: 100, y: 200 });
    expect(baseHandler).not.toHaveBeenCalled();
    expect(manager.getOrCreate).toHaveBeenCalledWith("sess1");
    expect(result).toContain("clicked");
  });

  it("creates sandbox lazily on first desktop tool call", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    expect(bridges.size).toBe(0);
    await handler("desktop.screenshot", {});
    expect(bridges.size).toBe(1);
    expect(bridges.has("sess1")).toBe(true);
  });

  it("reuses existing bridge on subsequent calls", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.screenshot", {});
    await handler("desktop.mouse_click", { x: 0, y: 0 });

    // getOrCreate called only once (lazy init)
    expect(manager.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("resets idle timer on each tool call", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.screenshot", {});
    expect(manager.touchActivity).toHaveBeenCalledWith("test-container");
  });

  it("returns error when sandbox creation fails", async () => {
    const manager = mockManager({
      getOrCreate: vi.fn().mockRejectedValue(new Error("pool exhausted")),
    } as unknown as Partial<DesktopSandboxManager>);
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.screenshot", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Desktop sandbox unavailable");
  });

  it("returns error for unknown desktop tool", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.nonexistent", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Unknown desktop tool");
  });

  describe("auto-screenshot", () => {
    it("appends screenshot after action tool", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      const result = await handler("desktop.mouse_click", { x: 100, y: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.clicked).toBe(true);
      expect(parsed._screenshot).toBeDefined();
      expect(parsed._screenshot.dataUrl).toContain("data:image/png;base64");
    });

    it("skips for non-action tools", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      const result = await handler("desktop.screenshot", {});
      const parsed = JSON.parse(result);
      expect(parsed._screenshot).toBeUndefined();
    });

    it("returns original result when screenshot fails", async () => {
      // Override the mock so screenshot throws
      const failScreenshot = {
        name: "desktop.screenshot",
        description: "Take a screenshot",
        inputSchema: {},
        execute: vi.fn().mockRejectedValue(new Error("capture failed")),
      };
      const clickTool = {
        name: "desktop.mouse_click",
        description: "Click mouse",
        inputSchema: {},
        execute: vi.fn().mockResolvedValue({ content: '{"clicked":true}' }),
      };

      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      // Pre-populate bridge with failing screenshot tool
      await handler("desktop.mouse_click", { x: 0, y: 0 });
      const bridge = bridges.get("sess1")!;
      (bridge.getTools as ReturnType<typeof vi.fn>).mockReturnValue([
        failScreenshot,
        clickTool,
      ]);

      const result = await handler("desktop.mouse_click", { x: 0, y: 0 });
      const parsed = JSON.parse(result);
      expect(parsed.clicked).toBe(true);
      // No _screenshot since it failed
      expect(parsed._screenshot).toBeUndefined();
    });

    it("skips for bash commands (not a GUI action)", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      const result = await handler("desktop.bash", { command: "ls" });
      const parsed = JSON.parse(result);
      expect(parsed.stdout).toBe("hello");
      expect(parsed._screenshot).toBeUndefined();
    });

    it("disabled by default", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
      });

      const result = await handler("desktop.mouse_click", { x: 100, y: 200 });
      const parsed = JSON.parse(result);
      expect(parsed._screenshot).toBeUndefined();
    });
  });
});

describe("destroySessionBridge", () => {
  it("disconnects and removes bridge", () => {
    const mockBridge = {
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue([]),
      connect: vi.fn(),
    } as unknown as DesktopRESTBridge;

    const bridges = new Map<string, DesktopRESTBridge>();
    bridges.set("sess1", mockBridge);

    destroySessionBridge("sess1", bridges);
    expect(mockBridge.disconnect).toHaveBeenCalled();
    expect(bridges.has("sess1")).toBe(false);
  });

  it("is idempotent for unknown sessions", () => {
    const bridges = new Map<string, DesktopRESTBridge>();
    destroySessionBridge("unknown", bridges);
    expect(bridges.size).toBe(0);
  });
});
