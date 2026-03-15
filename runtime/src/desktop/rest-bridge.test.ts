import { describe, it, expect, vi, beforeEach } from "vitest";
import { DesktopRESTBridge } from "./rest-bridge.js";
import { DesktopSandboxConnectionError } from "./errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TOOL_DEFS = [
  {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "mouse_click",
    description: "Click mouse",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "bash",
    description: "Run bash command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function mockHealthAndTools(): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/health")) {
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          workingDirectory: "/workspace",
          workspaceRoot: "/workspace",
          features: ["foreground_bash_cwd"],
        }),
      };
    }
    if (url.endsWith("/tools") && !url.includes("/tools/")) {
      return { ok: true, json: async () => TOOL_DEFS };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  });
}

describe("DesktopRESTBridge", () => {
  let bridge: DesktopRESTBridge;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockFetch.mockReset();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    bridge = new DesktopRESTBridge({
      apiHostPort: 32769,
      containerId: "abc123",
      authToken: "test-token",
      logger: logger as any,
    });
  });

  describe("connect()", () => {
    it("fetches tools and becomes connected", async () => {
      mockHealthAndTools();
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getTools().length).toBe(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://localhost:32769/health",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    it("namespaces tools with desktop. prefix", async () => {
      mockHealthAndTools();
      await bridge.connect();
      const names = bridge.getTools().map((t) => t.name);
      expect(names).toEqual([
        "desktop.screenshot",
        "desktop.mouse_click",
        "desktop.bash",
      ]);
    });

    it("throws ConnectionError on health check failure", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });

    it("throws ConnectionError on unhealthy response", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });

    it("throws ConnectionError when tool list fails", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/health")) {
          return {
            ok: true,
            json: async () => ({
              status: "ok",
              workingDirectory: "/workspace",
              workspaceRoot: "/workspace",
              features: ["foreground_bash_cwd"],
            }),
          };
        }
        throw new Error("tool fetch failed");
      });
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });

    it("subscribes to the desktop event stream and forwards parsed events", async () => {
      const onEvent = vi.fn(async () => undefined);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                "event: managed_process.exited",
                'data: {"type":"managed_process.exited","timestamp":123,"payload":{"processId":"proc_123","state":"exited"}}',
                "",
                "",
              ].join("\n"),
            ),
          );
          controller.close();
        },
      });

      bridge = new DesktopRESTBridge({
        apiHostPort: 32769,
        containerId: "abc123",
        authToken: "test-token",
        logger: logger as any,
        onEvent,
      });

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/health")) {
          return {
            ok: true,
            json: async () => ({
              status: "ok",
              workingDirectory: "/workspace",
              workspaceRoot: "/workspace",
              features: ["foreground_bash_cwd"],
            }),
          };
        }
        if (url.endsWith("/tools") && !url.includes("/tools/")) {
          return { ok: true, json: async () => TOOL_DEFS };
        }
        if (url.endsWith("/events")) {
          return { ok: true, body: stream };
        }
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      });

      await bridge.connect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onEvent).toHaveBeenCalledWith({
        type: "managed_process.exited",
        timestamp: 123,
        payload: { processId: "proc_123", state: "exited" },
      });
      bridge.disconnect();
    });

    it("warns when the desktop server is missing required cwd features", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/health")) {
          return {
            ok: true,
            json: async () => ({
              status: "ok",
              workingDirectory: "/workspace",
              workspaceRoot: "/workspace",
              features: [],
            }),
          };
        }
        if (url.endsWith("/tools") && !url.includes("/tools/")) {
          return { ok: true, json: async () => TOOL_DEFS };
        }
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      });

      await bridge.connect();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("missing required features: foreground_bash_cwd"),
      );
    });
  });

  describe("disconnect()", () => {
    it("makes getTools return empty", async () => {
      mockHealthAndTools();
      await bridge.connect();
      expect(bridge.getTools().length).toBe(3);

      bridge.disconnect();
      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getTools().length).toBe(0);
    });
  });

  describe("tool execution", () => {
    it("routes tool calls to the REST API", async () => {
      mockHealthAndTools();
      await bridge.connect();

      // Mock the tool execution call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clicked: true, x: 100, y: 200, button: 1 }),
      });

      const clickTool = bridge.getTools().find((t) => t.name === "desktop.mouse_click")!;
      const result = await clickTool.execute({ x: 100, y: 200 });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.clicked).toBe(true);

      // Verify correct URL was called
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://localhost:32769/tools/mouse_click");
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("screenshot returns out-of-band artifact metadata instead of inline dataUrl", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          image: "iVBORw0KGgoAAAAN",
          width: 1024,
          height: 768,
        }),
      });

      const ssTool = bridge.getTools().find((t) => t.name === "desktop.screenshot")!;
      const result = await ssTool.execute({});
      const parsed = JSON.parse(result.content);
      expect(parsed.imageDigest).toMatch(/^sha256:/);
      expect(parsed.imageBytes).toBeGreaterThan(0);
      expect(parsed.imageMimeType).toBe("image/png");
      expect(parsed.artifactExternalized).toBe(true);
      expect(parsed.width).toBe(1024);
      expect(parsed.height).toBe(768);
    });

    it("returns isError on execution failure", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "xdotool not found",
          isError: true,
        }),
      });

      const tool = bridge.getTools().find((t) => t.name === "desktop.mouse_click")!;
      const result = await tool.execute({ x: 0, y: 0 });
      expect(result.isError).toBe(true);
    });

    it("handles fetch errors gracefully", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

      const tool = bridge.getTools().find((t) => t.name === "desktop.bash")!;
      const result = await tool.execute({ command: "ls" });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed.error).toContain("ECONNRESET");
    });
  });

  describe("getTools() before connect", () => {
    it("returns empty array", () => {
      expect(bridge.getTools()).toEqual([]);
    });
  });
});
